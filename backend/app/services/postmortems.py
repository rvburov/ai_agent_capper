"""Разбор рассчитанных ставок ИИ (этап 5, В3 Р25; макет bets.js, блок «Разбор ИИ»).

После расчета ставки (вручную или по архиву) ее матчи встают в очередь разбора: один
разбор на матч, общий для всех участников, кто на него ставил. Только ставки,
рассчитанные с postmortem_since (настройка агента; не задана — очередь при первом
запуске записывает в нее свой момент): история и ставки копии базы, рассчитанные
раньше, не разбираются (на карточке — «Разбора нет», причина before_start). Разбор
строится только по общему (М5 и замечание №2 проверки волны 2): исход и счет матча —
только из архива (пока исхода архива нет, матч ждет), разбирается прогноз базовой модели
на победу в матче — сторона-фаворит по p_base досье (нет досье — Эло до дня матча, как в
проверке уроков). Досье — в порядке игроков анализа, сторона и исход — по матчу архива:
после слияния матчей порядок бывает обратным, тогда досье переворачивается кодом в
порядок архива (flip_dossier), p_base и оценка Claude — 1 − p; порядок не понять — досье в
факты не идет, только архив и Эло;
вероятности — p_base, общая оценка Claude по тому же досье (match_assessments, общая для
всех) и рынок без маржи по архиву (q_close, эталон Р17). Ставок, сумм, кэфов, исходов и
текстов анализов участников в фактах нет. Возвраты, ставки старого бота и проверочные
прогнозы матч в очередь не ставят. Раз в postmortem_every_minutes задача воркера собирает
пакет Batch (не больше postmortem_batch_max разборов, Sonnet 5.5, app/agent/postmortem.py).
Платит общий бюджет ключа администратора (в лимит участника не входит): до отправки
худший случай пакета должен поместиться в остаток бюджета вместе с резервами анализов и
других пакетов — под той же блокировкой строки app_settings, что резерв анализа, до
commit строки пакета (М1); не помещается — разборы ждут, администраторам — уведомление
раз в сутки.

Результаты собирает задача раз в 15 минут (app/agent/batches.py): строка agent_runs на
каждый ответ (kind postmortem, без участника), разбор done или failed. Истекший запрос
или сбой у Anthropic — разбор снова в очереди (не больше MAX_ATTEMPTS попыток). Гипотеза
с условием из словаря — урок-гипотеза (app/services/lessons.py): новый или еще одно
основание того же урока. Победитель по архиву изменился (исправлен архив) — разбор
устарел и снова в очереди (refresh_stale; после исправления результата ставки — сразу).

Вердикт по своей ставке каждому участнику считает код на лету (GET /bets/{id}/review,
чужая — 404): своя сторона и исход своей ноги, CLV своей ноги, вывод общего разбора —
только если нога на ту же сторону, что разбирали (Р14, Т21).
"""

from collections.abc import Callable, Sequence
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any

import anthropic
import structlog
from anthropic.types.messages.batch_create_params import Request
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import distinct_on, insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent import batches
from app.agent import postmortem as agent_pm
from app.agent.calls import estimate_tokens
from app.agent.client import client_for
from app.agent.config import AgentConfig, config_from_overrides, load_agent_config
from app.agent.errors import ClaudeStepError
from app.agent.runs import price_for
from app.core.errors import AppError
from app.db.models import (
    AgentRun,
    AppSettings,
    BatchJob,
    Bet,
    BetLeg,
    Dossier,
    Lesson,
    Match,
    MatchAssessment,
    Notification,
    OddsSnapshot,
    Player,
    Postmortem,
    Prediction,
    User,
)
from app.ingest.names import fold
from app.ml.lesson_scope import ARCHIVE_SOURCES, RESULT_STATUSES, ROUNDS
from app.ml.market import REFERENCE_ORDER, OddsPair, pick_reference
from app.ml.metrics import clv, clv_parlay
from app.ml.sets import MARKET_ML, score_for
from app.schemas.lessons import BetReviewOut, LegReviewOut, ReviewLessonOut, ReviewVerdict
from app.services import lesson_check
from app.services import lessons as lessons_service
from app.services.ai_access import shared_budget_left, usd_text
from app.services.app_settings import SETTINGS_ROW_ID
from app.services.bets import verdict
from app.services.claude_key import key_for
from app.services.dossier import archive_tournament, dossier_flipped, flip_dossier
from app.services.notifications import notify
from app.services.sessions import utcnow

log = structlog.get_logger(__name__)

# pg_advisory_xact_lock: очередь разборов пополняет одна задача
QUEUE_LOCK = 0x706D5F7175657565  # "pm_queue"
QUEUE_LIMIT = 500
MAX_ATTEMPTS = 2
BUDGET_NOTE_EVERY = timedelta(hours=23)
BUDGET_LINK = "/admin/key"
BATCH_TIMEOUT_S = 120.0
ClientFactory = Callable[[str], anthropic.AsyncAnthropic]


def _client(key: str) -> anthropic.AsyncAnthropic:
    return client_for(key, timeout=BATCH_TIMEOUT_S)


def _archive_outcome() -> Any:
    """Матч с исходом архива: сыгран (или снятие по ходу) и победитель известен."""
    return (
        Match.source.in_(ARCHIVE_SOURCES),
        Match.status.in_(RESULT_STATUSES),
        Match.winner_id.is_not(None),
    )


def winner_side(match: Match) -> int | None:
    """Победитель по архиву: 1 или 2; матч не из архива или без победителя — None."""
    if match.source not in ARCHIVE_SOURCES or match.status not in RESULT_STATUSES:
        return None
    if match.winner_id is not None and match.winner_id == match.player1_id:
        return 1
    if match.winner_id is not None and match.winner_id == match.player2_id:
        return 2
    return None


# --- очередь ---


def _reset(pm: Postmortem) -> None:
    pm.status = "queued"
    pm.batch_job_id = None
    pm.agent_run_id = None
    pm.verdict = None
    pm.summary = None
    pm.why = None
    pm.hypothesis = None
    pm.scope = None
    pm.lesson_id = None
    pm.side = None
    pm.winner = None


async def refresh_stale(db: AsyncSession, match_ids: Sequence[int] | None = None) -> int:
    """Разборы, построенные на другом победителе архива (архив исправлен), — снова в
    очередь (замечание m5). Разбор в пакете тоже: его ответ при сборе не примется.
    flush; commit — за вызывающим. → сколько разборов поставлено заново."""
    stmt = (
        select(Postmortem, Match)
        .join(Match, Match.id == Postmortem.match_id)
        .where(Postmortem.winner.is_not(None))
    )
    if match_ids is not None:
        if not match_ids:
            return 0
        stmt = stmt.where(Postmortem.match_id.in_(list(match_ids)))
    rows = (await db.execute(stmt.with_for_update(of=Postmortem))).all()
    count = 0
    for pm, match in rows:
        if winner_side(match) != pm.winner:
            _reset(pm)
            count += 1
    if count:
        await db.flush()
    return count


async def review_since(db: AsyncSession, now: datetime) -> datetime:
    """С какого момента расчета ставки разбираются: postmortem_since; не задан — now,
    и он записывается в настройки агента (первый запуск очереди). Строка app_settings —
    FOR UPDATE: сохранение настроек администратором не затрет запись. flush; commit — за
    вызывающим."""
    config = await load_agent_config(db)
    if config.postmortem_since is not None:
        return config.postmortem_since
    row = await db.scalar(
        select(AppSettings)
        .where(AppSettings.id == SETTINGS_ROW_ID)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if row is None:
        raise RuntimeError("app_settings: нет строки id = 1, примените миграции")
    stored = dict(row.agent_config or {})
    found = config_from_overrides(stored).postmortem_since
    if found is not None:
        return found
    stored["postmortem_since"] = now.isoformat()
    row.agent_config = stored
    await db.flush()
    log.info("postmortems.since_set", since=stored["postmortem_since"])
    return now


async def queue(db: AsyncSession, *, now: datetime | None = None) -> int:
    """Матчи рассчитанных с review_since ставок приложения с исходом архива и без разбора
    — в очередь (queued); устаревшие разборы — заново. commit. → сколько добавлено."""
    await db.execute(select(func.pg_advisory_xact_lock(QUEUE_LOCK)))
    since = await review_since(db, now or utcnow())
    await refresh_stale(db)
    reviewed = select(Postmortem.id).where(Postmortem.match_id == BetLeg.match_id).exists()
    rows = (
        await db.execute(
            select(BetLeg.match_id, BetLeg.prediction_id, Bet.id, Bet.user_id)
            .join(Bet, Bet.id == BetLeg.bet_id)
            .join(Prediction, Prediction.id == BetLeg.prediction_id)
            .join(Match, Match.id == BetLeg.match_id)
            .where(
                Bet.source == "app",
                Bet.status.in_(("won", "lost")),
                Bet.settled_at >= since,
                BetLeg.result.in_(("win", "loss")),
                Prediction.is_eval.is_(False),
                *_archive_outcome(),
                ~reviewed,
            )
            .order_by(BetLeg.match_id, Bet.settled_at, Bet.id, BetLeg.id)
            .ext(distinct_on(BetLeg.match_id))
            .limit(QUEUE_LIMIT)
        )
    ).all()
    added = 0
    for match_id, prediction_id, bet_id, user_id in rows:
        result = await db.execute(
            insert(Postmortem)
            .values(
                match_id=match_id,
                prediction_id=prediction_id,
                bet_id=bet_id,
                user_id=user_id,
                status="queued",
            )
            .on_conflict_do_nothing(index_elements=[Postmortem.prediction_id])
        )
        added += int(getattr(result, "rowcount", 0) or 0)
    await db.commit()
    return added


# --- факты для Claude ---


async def _q_close(db: AsyncSession, match_id: int, selection: int) -> float | None:
    """Вероятность исхода П1/П2 без маржи по архиву (эталон Р17; момент снятия не
    проверен, Т1)."""
    rows = await db.execute(
        select(OddsSnapshot.bookmaker, OddsSnapshot.selection, OddsSnapshot.odds).where(
            OddsSnapshot.match_id == match_id,
            OddsSnapshot.market == MARKET_ML,
            OddsSnapshot.kind == "archive",
            OddsSnapshot.bookmaker.in_(REFERENCE_ORDER),
        )
    )
    books: dict[str, list[Decimal | None]] = {}
    for bookmaker, side, odds in rows:
        books.setdefault(bookmaker, [None, None])[side - 1] = odds
    pairs: dict[str, OddsPair] = {name: (pair[0], pair[1]) for name, pair in books.items()}
    found = pick_reference(pairs, REFERENCE_ORDER)
    if found is None:
        return None
    return found[1][selection - 1]


def _round(value: float | None, digits: int = 3) -> float | None:
    return round(value, digits) if value is not None else None


async def _dossier(db: AsyncSession, pm: Postmortem, match: Match) -> Dossier | None:
    """Досье до матча: прогноза, поставившего матч в очередь, иначе последнее досье матча
    (досье общее для всех: в нем нет кэфов и банка)."""
    prediction = await db.get(Prediction, pm.prediction_id)
    if prediction is not None and prediction.dossier_id is not None:
        found = await db.get(Dossier, prediction.dossier_id)
        if found is not None:
            return found
    latest: Dossier | None = await db.scalar(
        select(Dossier)
        .where(Dossier.match_id == match.id)
        .order_by(Dossier.as_of.desc(), Dossier.id.desc())
        .limit(1)
    )
    return latest


def _p1(raw: Any) -> float | None:
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return None
    return value if 0.0 <= value <= 1.0 else None


async def _shared_claude(db: AsyncSession, dossier_id: int) -> float | None:
    """Общая оценка Claude по этому досье (match_assessments: одна на досье и версии,
    общая для всех): p1_win последней."""
    output = await db.scalar(
        select(MatchAssessment.output)
        .where(MatchAssessment.dossier_id == dossier_id)
        .order_by(MatchAssessment.created_at.desc(), MatchAssessment.id.desc())
        .limit(1)
    )
    return _p1(output.get("p1_win")) if isinstance(output, dict) else None


def _dossier_order(
    content: dict[str, Any], match: Match, players: dict[int, Player]
) -> bool | None:
    """Обратный ли порядок игроков досье относительно матча (dossier_flipped): по id, а
    если игроков досье с тех пор слили с другими — по имени (имя слитого игрока остается
    в name, name_ru или aliases игрока архива). None — не понять."""
    found = dossier_flipped(content, match.player1_id, match.player2_id)
    if found is not None:
        return found

    def known(player_id: int) -> set[str]:
        player = players.get(player_id)
        if player is None:
            return set()
        return {fold(value) for value in (player.name, player.name_ru, *player.aliases) if value}

    first, second = known(match.player1_id), known(match.player2_id)
    shown = []
    for key in ("p1", "p2"):
        block = content.get(key)
        name = block.get("name") if isinstance(block, dict) else None
        shown.append(fold(name) if isinstance(name, str) and name else None)
    straight = shown[0] in first or shown[1] in second
    reverse = shown[0] in second or shown[1] in first
    if straight != reverse:
        return reverse
    return None


def _for_side(p1: float | None, side: int) -> float | None:
    if p1 is None:
        return None
    return p1 if side == 1 else 1.0 - p1


async def facts_for(
    db: AsyncSession, pm: Postmortem, sides: dict[tuple[int, int], lesson_check.MatchSide]
) -> tuple[dict[str, Any], bool, int, int] | None:
    """Факты общего разбора матча (только архив, досье и общая оценка): → (факты, сыграла
    ли разбираемая сторона, сторона, победитель) или None — исхода архива нет."""
    match = await db.get(Match, pm.match_id)
    if match is None:
        return None
    winner = winner_side(match)
    first = sides.get((match.id, 1))
    if winner is None or first is None:
        return None
    dossier = await _dossier(db, pm, match)
    content = dict(dossier.content) if dossier is not None else None
    players = {
        player.id: player
        for player in await db.scalars(
            select(Player).where(Player.id.in_((match.player1_id, match.player2_id)))
        )
    }
    names = {player_id: player.name for player_id, player in players.items()}
    # Досье — в порядке игроков анализа, сторона и исход — по матчу архива: после слияния
    # матчей порядок может быть обратным (в tennis-data первым идет победитель)
    flipped = _dossier_order(content, match, players) if content is not None else None
    shown = (content or {}).get("p_base") or {}
    p1_base = _p1(shown.get("p1_win")) if isinstance(shown, dict) else None
    p1_claude = await _shared_claude(db, dossier.id) if dossier is not None else None
    if flipped is None:
        # Порядок не понять (или досье нет) — досье в факты не идет: только архив и Эло
        if content is not None:
            log.warning("postmortems.dossier_order_unknown", match_id=match.id, pm_id=pm.id)
        content, p1_base, p1_claude = None, None, None
    elif flipped:
        # Досье — в порядок матча архива целиком: весь факт для Claude в одном порядке
        assert content is not None
        content = flip_dossier(content)
        p1_base = 1.0 - p1_base if p1_base is not None else None
        p1_claude = 1.0 - p1_claude if p1_claude is not None else None
    if p1_base is None:
        p1_base = first.p_base
    side = 1 if p1_base >= 0.5 else 2
    tour, level = await archive_tournament(db, match.tournament_id)
    won = winner == side
    p_base = _for_side(p1_base, side)
    q_close = await _q_close(db, match.id, side)
    info = (content or {}).get("match") or {}
    subject = sides.get((match.id, side))
    facts: dict[str, Any] = {
        "match": {
            "p1": names.get(match.player1_id),
            "p2": names.get(match.player2_id),
            "day": match.match_date.isoformat() if match.match_date else None,
            "tour": tour,
            "level": level,
            "round": match.round if match.round in ROUNDS else None,
            "surface": info.get("surface") if isinstance(info, dict) else None,
            "bo": (info.get("bo") if isinstance(info, dict) else None) or match.best_of,
            # Счет архива — со стороны игрока 1
            "score": score_for(match.score, won=winner == 1) if match.score else None,
            "winner": winner,
            "status": match.status,
        },
        "subject": {"market": MARKET_ML, "side": side, "won": won},
        "model": {
            "p_base": _round(p_base),
            "p_claude": _round(_for_side(p1_claude, side)),
            "q_close": _round(q_close),
            "close_gap": _round(q_close - p_base)
            if q_close is not None and p_base is not None
            else None,
        },
        "features": subject.features if subject is not None else {},
        "dossier": content,
    }
    return facts, won, side, winner


# --- отправка пакета ---


async def _notify_budget(
    db: AsyncSession, *, count: int, need: Decimal, left: Decimal, now: datetime
) -> int:
    """Разборы ждут бюджета: администраторам, не чаще раза в сутки. flush."""
    recent = await db.scalar(
        select(Notification.id)
        .where(
            Notification.kind == "learning",
            Notification.params["variant"].astext == "postmortem_budget",
            Notification.created_at >= now - BUDGET_NOTE_EVERY,
        )
        .limit(1)
    )
    if recent is not None:
        return 0
    admins = list(
        await db.scalars(select(User.id).where(User.role == "admin", User.status == "active"))
    )
    sent = 0
    for admin_id in admins:
        note = await notify(
            db,
            user_id=admin_id,
            kind="learning",
            variant="postmortem_budget",
            link=BUDGET_LINK,
            count=count,
            need=usd_text(need),
            left=usd_text(left),
        )
        sent += note is not None
    return sent


async def _due(db: AsyncSession, config: AgentConfig, now: datetime) -> bool:
    """Пора собирать пакет: прошлый пакет разборов отправлен не раньше чем
    postmortem_every_minutes назад."""
    last = await db.scalar(
        select(func.max(BatchJob.created_at)).where(BatchJob.kind == agent_pm.KIND)
    )
    return last is None or now - last >= timedelta(minutes=config.postmortem_every_minutes)


async def submit(
    db: AsyncSession,
    *,
    now: datetime | None = None,
    client_factory: ClientFactory | None = None,
    force: bool = False,
) -> dict[str, Any]:
    """Очередь и пакет разборов (задача воркера раз в 15 минут, пакет — раз в
    postmortem_every_minutes; force — без ожидания). → итог для журнала задачи."""
    moment = now or utcnow()
    config = await load_agent_config(db)
    if not config.postmortem_enabled:
        return {"skipped": "disabled"}
    added = await queue(db, now=moment)
    result: dict[str, Any] = {"queued": added}
    if not force and not await _due(db, config, moment):
        return {**result, "skipped": "cadence"}
    pms = list(
        await db.scalars(
            select(Postmortem)
            .where(Postmortem.status == "queued")
            .order_by(Postmortem.id)
            .limit(config.postmortem_batch_max)
            .with_for_update(skip_locked=True)
        )
    )
    if not pms:
        await db.commit()
        return {**result, "sent": 0}
    try:
        price = await price_for(db, config.postmortem_model)
        key = await key_for(db, key_source="admin", user_id=0)
    except ClaudeStepError as exc:
        await db.commit()
        return {**result, "skipped": exc.code}
    sides = await lesson_check.match_sides(db, sorted({pm.match_id for pm in pms}))
    system = agent_pm.prompt().text
    today = moment.date().isoformat()
    prepared: list[tuple[Postmortem, Request, bool, int, int, Decimal]] = []
    for pm in pms:
        found = await facts_for(db, pm, sides)
        if found is None:
            pm.status = "failed"
            continue
        facts, won, side, winner = found
        request = agent_pm.batch_request(pm.id, facts, today=today, config=config)
        worst = batches.request_worst_usd(
            price,
            input_tokens=estimate_tokens(
                system, agent_pm.facts_text(facts), agent_pm.request_text(today)
            ),
            max_tokens=config.postmortem_max_tokens,
        )
        prepared.append((pm, request, won, side, winner, worst))
    # Остаток общего бюджета и строка пакета — под FOR UPDATE app_settings до commit: два
    # пакета (cron и команда терминала) или пакет и анализ не займут один остаток (М1)
    left = await shared_budget_left(db, moment, lock=True)
    planned: list[tuple[Postmortem, Request, bool, int, int, Decimal]] = []
    need = Decimal(0)
    skipped_budget = 0
    for item in prepared:
        worst = item[5]
        if need + worst > left:
            skipped_budget += 1
            continue
        need += worst
        planned.append(item)
    if skipped_budget:
        waiting = skipped_budget + len(planned)
        await _notify_budget(
            db,
            count=waiting,
            need=batches.round_usd(need),
            left=batches.round_usd(left),
            now=moment,
        )
    if not planned:
        await db.commit()
        return {**result, "sent": 0, "waiting": skipped_budget}
    meta = batches.RunMeta(
        kind=agent_pm.KIND,
        model=config.postmortem_model,
        effort=config.postmortem_effort,
        prompt_version=agent_pm.prompt().version_id,
        schema_version=agent_pm.SCHEMA_VERSION,
    )
    requests = [request for _, request, *_ in planned]
    job = await batches.open_job(
        db,
        kind=agent_pm.KIND,
        requests=len(planned),
        worst_usd=need,
        params=meta.to_params(
            won={agent_pm.custom_id(pm.id): won for pm, _, won, *_ in planned},
            max_tokens=config.postmortem_max_tokens,
        ),
        custom_ids=[str(request["custom_id"]) for request in requests],
    )
    for pm, _, _, side, winner, _ in planned:
        pm.status = "submitted"
        pm.batch_job_id = job.id
        pm.side = side
        pm.winner = winner
    await db.commit()
    client = (client_factory or _client)(key)
    try:
        batch_id = await batches.send_job(db, client, job, requests)
    except ClaudeStepError as exc:
        if job.status == batches.FAILED:
            await requeue_job(db, job.id)
        return {**result, "sent": 0, "error": exc.code}
    return {
        **result,
        "sent": len(planned),
        "waiting": skipped_budget,
        "batch_id": batch_id,
        "worst_usd": str(job.worst_usd),
    }


async def requeue_job(db: AsyncSession, job_id: int) -> int:
    """Разборы пакета, который не ушел или потерян, — снова в очередь. commit."""
    pms = list(
        await db.scalars(
            select(Postmortem)
            .where(Postmortem.batch_job_id == job_id, Postmortem.status == "submitted")
            .with_for_update()
        )
    )
    for pm in pms:
        pm.status = "queued"
        pm.batch_job_id = None
    await db.commit()
    return len(pms)


# --- сбор ---


async def _attempts(db: AsyncSession, custom: str) -> int:
    count = await db.scalar(
        select(func.count())
        .select_from(AgentRun)
        .where(
            AgentRun.kind == agent_pm.KIND,
            AgentRun.request_id.endswith(f"/{custom}", autoescape=True),
        )
    )
    return int(count or 0)


async def collect(
    db: AsyncSession, client: anthropic.AsyncAnthropic, job: BatchJob
) -> tuple[batches.Collected, set[int]]:
    """Сбор пакета разборов: agent_runs, разборы done или failed (или снова в очередь),
    гипотезы — в уроки. commit. → итог и уроки, у которых прибавилось основание."""
    won = dict((job.params or {}).get("won") or {})
    touched: set[int] = set()

    async def handle(session: AsyncSession, item: batches.BatchItem, agent_run: AgentRun) -> None:
        pm_id = agent_pm.postmortem_id_of(item.custom_id)
        pm = (
            await session.get(Postmortem, pm_id, with_for_update=True, populate_existing=True)
            if pm_id is not None
            else None
        )
        if pm is None or pm.status != "submitted" or pm.batch_job_id != job.id:
            # Разбор устарел, пока пакет был в работе (refresh_stale): ответ не принимается
            return
        pm.agent_run_id = agent_run.id
        if item.message is None:
            await session.flush()
            if item.retryable and await _attempts(session, item.custom_id) < MAX_ATTEMPTS:
                _reset(pm)
            else:
                pm.status = "failed"
            return
        judged = agent_pm.judge(item.message, won=bool(won.get(item.custom_id)))
        agent_run.error = judged.detail
        answer = judged.answer
        if answer is None:
            pm.status = "failed"
            return
        pm.status = "done"
        pm.verdict = answer.verdict
        pm.summary = answer.what
        pm.why = answer.why
        pm.hypothesis = answer.hypothesis.text if answer.hypothesis is not None else None
        pm.scope = judged.scope.to_json() if judged.scope is not None else None
        if judged.scope is not None and answer.hypothesis is not None:
            lesson = await lessons_service.attach_hypothesis(
                session,
                scope=judged.scope,
                text=answer.hypothesis.text,
                prediction_id=pm.prediction_id,
                bet_id=pm.bet_id,
            )
            pm.lesson_id = lesson.id
            touched.add(lesson.id)

    meta = batches.RunMeta.from_params(agent_pm.KIND, job.params or {})
    collected = await batches.collect_job(db, client, job.id, meta=meta, handle=handle)
    return collected, touched


# --- разбор для участника ---


def leg_verdict(
    *, won: bool, leg_clv: float | None, same_side: bool, shared: str | None
) -> ReviewVerdict:
    """Вердикт по своей ноге (код, на лету): выиграла — fine, а против рынка (CLV меньше
    нуля) — lucky; проиграла на той же стороне, что разбирали, и разбираемая сторона тоже
    проиграла — вывод общего разбора (невезение, ошибка модели, не хватило данных); иначе —
    по CLV: меньше нуля — model_error (рынок ушел против), иначе luck."""
    if won:
        return "lucky" if leg_clv is not None and leg_clv < 0 else "fine"
    if same_side and shared in agent_pm.LOST_VERDICTS:
        return shared  # type: ignore[return-value]
    return "model_error" if leg_clv is not None and leg_clv < 0 else "luck"


async def bet_review(db: AsyncSession, user: User, bet_id: int) -> BetReviewOut:
    """Разбор ИИ своей ставки; чужая или несуществующая — 404 (как карточка ставки). На
    каждую ногу с исходом — общий разбор ее матча и вердикт кодом по своей ноге: своя
    сторона, свой исход (как внесен или рассчитан), CLV своей ноги."""
    bet = await db.scalar(select(Bet).where(Bet.id == bet_id, Bet.user_id == user.id))
    if bet is None:
        raise AppError(404, "bet.not_found")
    legs = list(await db.scalars(select(BetLeg).where(BetLeg.bet_id == bet.id).order_by(BetLeg.id)))
    live = [leg for leg in legs if leg.result != "void"]
    clv_verdict = verdict(
        bet, legs, clv_parlay([(leg.odds_taken, leg.closing_odds) for leg in live])
    )
    out = BetReviewOut(bet_id=bet.id, state="open", reason=None, clv_verdict=clv_verdict, legs=[])
    if bet.status == "open":
        return out
    if bet.source == "legacy":
        return out.model_copy(update={"state": "not_reviewed", "reason": "legacy"})
    if bet.status == "void":
        return out.model_copy(update={"state": "not_reviewed", "reason": "void"})
    reviewed = [
        leg for leg in legs if leg.result in ("win", "loss") and leg.prediction_id is not None
    ]
    if not reviewed:
        return out.model_copy(update={"state": "not_reviewed", "reason": "no_prediction"})
    config = await load_agent_config(db)
    found = {
        pm.match_id: pm
        for pm in await db.scalars(
            select(Postmortem)
            .where(Postmortem.match_id.in_({leg.match_id for leg in reviewed}))
            .order_by(Postmortem.id.desc())
        )
    }
    lessons = {
        lesson.id: lesson
        for lesson in await db.scalars(
            select(Lesson).where(
                Lesson.id.in_([pm.lesson_id for pm in found.values() if pm.lesson_id]),
                Lesson.user_id.is_(None),
            )
        )
    }
    # Случаи урока — как на «Уроках»: общее число с порога, свои отдельно (Р14)
    own_cases = await lessons_service.own_cases(db, user, list(lessons.values()))
    runs = {
        run.id: run
        for run in await db.scalars(
            select(AgentRun).where(
                AgentRun.id.in_([pm.agent_run_id for pm in found.values() if pm.agent_run_id])
            )
        )
    }
    # Ставка рассчитана до начала разборов (postmortem_since): своих разборов у нее не
    # будет, показываются только разборы ее матчей по чужим новым ставкам
    since = config.postmortem_since
    if bet.settled_at is None or since is None or bet.settled_at < since:
        reviewed = [leg for leg in reviewed if leg.match_id in found]
        if not reviewed:
            return out.model_copy(update={"state": "not_reviewed", "reason": "before_start"})
    items: list[LegReviewOut] = []
    for leg in reviewed:
        pm = found.get(leg.match_id)
        own_won = leg.result == "win"
        leg_clv = clv(leg.odds_taken, leg.closing_odds) if leg.closing_odds is not None else None
        done = pm is not None and pm.status == "done" and pm.side is not None
        if pm is None or not done:
            items.append(
                LegReviewOut(
                    leg_id=leg.id,
                    match_id=leg.match_id,
                    market=leg.market,
                    selection=leg.selection,
                    same_pick=True,
                    won=own_won,
                    clv=leg_clv,
                    status=pm.status if pm is not None else "queued",  # type: ignore[arg-type]
                    verdict=None,
                    what=None,
                    why=None,
                    hypothesis=None,
                    lesson=None,
                    model=None,
                    cost_usd=None,
                    done_at=None,
                )
            )
            continue
        assert pm.side is not None
        same_side = leg.market == MARKET_ML and leg.selection == pm.side
        lesson = lessons.get(pm.lesson_id) if pm.lesson_id else None
        run = runs.get(pm.agent_run_id) if pm.agent_run_id else None
        items.append(
            LegReviewOut(
                leg_id=leg.id,
                match_id=leg.match_id,
                market="ML",
                selection=pm.side,
                same_pick=same_side,
                won=own_won,
                clv=leg_clv,
                status="done",
                verdict=leg_verdict(
                    won=own_won, leg_clv=leg_clv, same_side=same_side, shared=pm.verdict
                ),
                what=pm.summary,
                why=pm.why,
                hypothesis=pm.hypothesis,
                lesson=ReviewLessonOut(
                    id=lesson.id,
                    code=lesson.code,
                    status=lesson.status,  # type: ignore[arg-type]
                    in_prompt=lesson.in_prompt,
                    n_cases=lessons_service.public_cases(user, lesson),
                    n_cases_few=lessons_service.public_cases(user, lesson) is None,
                    own_cases=own_cases.get(lesson.id, 0),
                    need_cases=lessons_service.need_cases(lesson, config),
                    text=lesson.text,
                )
                if lesson is not None
                else None,
                model=run.model if run is not None else None,
                cost_usd=run.cost_usd if run is not None else None,
                done_at=run.created_at if run is not None else None,
            )
        )
    statuses = {item.status for item in items}
    if statuses & {"queued", "submitted"}:
        state = "pending"
    elif statuses == {"failed"}:
        state = "failed"
    else:
        state = "done"
    return out.model_copy(update={"state": state, "legs": items})
