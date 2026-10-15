"""Замороженный eval-набор (этап 5, Т9; TOKEN_ECONOMY.md, 2.2; LLM_LEARNING.md, 3.4).

Набор — 200–300 сыгранных матчей основного тура из архива (sackmann, tennis_data) с днем
от since (не раньше 1 августа 2026 и даты среза знаний модели анализа: модель не могла
видеть их исход) до вчера. 15–20% — «трудный хвост» (hard): близкие вероятности
(базовая модель или рынок архива дают фавориту не больше CLOSE_MAX) или неожиданный исход
(победил тот, кому модель или рынок давали меньше UPSET_BELOW). Модель — прогноз до матча:
рейтинги Эло строго до дня матча с весом покрытия и калибровкой, как в досье; рынок —
кэфы архива без маржи (эталон Р17, степенной метод; момент снятия не проверен).

Выбор детерминирован: события упорядочены по sha256(«код:id матча»), берутся первые
трудные до доли eval_hard_share, остальные — из обычных. Список (id матча и метка
трудного, по id) и его sha256 записываются в eval_sets и eval_set_items; повторная
заморозка того же кода — отказ (409 eval.set_exists). Досье события — на день матча, без
новостей и без данных этого дня; оно строится при первом прогоне (или быстрой проверке) и
дальше общее для всех прогонов набора (одни и те же досье у сравниваемых версий).

Калибровка базовой модели закрепляется за набором при заморозке (rules.calibration, m4
волны 3; model_versions.pinned_for_set): версия, обученная до первого дня набора. Досье
набора строятся с ней, сколько бы перекалибровок ни прошло до первого прогона: p_base и
«трудный хвост» не подобраны на исходах матчей набора. Досье не строятся при заморозке:
250 досье — десятки секунд в запросе администратора, а данные до дня матча после
заморозки не меняются (рейтинги — строго до дня матча).

Заморозка денег не тратит: администратор (без 2FA) или команда терминала eval-freeze.
"""

import hashlib
from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.config import load_agent_config
from app.core.errors import AppError
from app.db.models import Dossier, EvalSet, EvalSetItem, Match, OddsSnapshot, Tournament
from app.ml import model_versions
from app.ml.backtest import BacktestConfig, side_flip
from app.ml.elo import MODEL_ID, win_probability
from app.ml.lesson_scope import ARCHIVE_SOURCES, ratings_select
from app.ml.market import REFERENCE_ORDER, pick_reference
from app.ml.metrics import brier, log_loss
from app.ml.sets import MARKET_ML, PROBS3_FIELDS, Probs3
from app.schemas.learning import EvalSetIn, EvalSetOut, EvalSetsOut
from app.services import smoke_eval
from app.services.audit import write_audit
from app.services.dossier import calibrated_p1, canonical_json
from app.services.lesson_check import elo_model, elo_model_of, read_only
from app.services.sessions import utcnow

# Не раньше этого дня (Р25, сводка 2.2 п. 9): после среза знаний модели анализа
EVAL_SINCE = date(2026, 8, 1)
MIN_EVENTS = 200
MAX_EVENTS = 300
# Близкие вероятности: фаворит не выше 57%; неожиданный исход: победителю давали меньше 40%
CLOSE_MAX = 0.57
UPSET_BELOW = 0.40
FREEZE_LOCK = 0x6576616C73657401


def since_floor(model: str) -> date:
    """Самый ранний день набора: 1 августа 2026 или позже даты среза знаний модели."""
    return max(EVAL_SINCE, smoke_eval.safe_since(model))


@dataclass(frozen=True)
class Candidate:
    """Сыгранный матч архива: день, исход для игрока 1 (y1), модель (p1) и рынок без
    маржи (q1, None — кэфов нет) для игрока 1, трудный ли."""

    match_id: int
    day: date
    y1: int
    p1: float
    q1: float | None

    @property
    def hard(self) -> bool:
        if max(self.p1, 1.0 - self.p1) <= CLOSE_MAX:
            return True
        if self.q1 is not None and max(self.q1, 1.0 - self.q1) <= CLOSE_MAX:
            return True
        p_winner = self.p1 if self.y1 else 1.0 - self.p1
        q_winner = None if self.q1 is None else (self.q1 if self.y1 else 1.0 - self.q1)
        return p_winner < UPSET_BELOW or (q_winner is not None and q_winner < UPSET_BELOW)


async def archive_market(db: AsyncSession, match_ids: list[int]) -> dict[int, float]:
    """Вероятность победы игрока 1 без маржи по кэфам архива (эталон Р17)."""
    if not match_ids:
        return {}
    rows = await db.execute(
        select(
            OddsSnapshot.match_id,
            OddsSnapshot.selection,
            OddsSnapshot.bookmaker,
            OddsSnapshot.odds,
        ).where(
            OddsSnapshot.match_id.in_(match_ids),
            OddsSnapshot.kind == "archive",
            OddsSnapshot.market == MARKET_ML,
            OddsSnapshot.bookmaker.in_(REFERENCE_ORDER),
        )
    )
    pairs: dict[int, dict[str, list[Decimal | None]]] = defaultdict(dict)
    for match_id, selection, bookmaker, odds in rows:
        pair = pairs[match_id].setdefault(bookmaker, [None, None])
        if selection in (1, 2):
            pair[selection - 1] = odds
    found: dict[int, float] = {}
    for match_id, books in pairs.items():
        picked = pick_reference(
            {bookmaker: (pair[0], pair[1]) for bookmaker, pair in books.items()},
            REFERENCE_ORDER,
        )
        if picked is not None:
            found[match_id] = picked[1][0]
    return found


async def candidates(
    db: AsyncSession,
    *,
    since: date,
    until: date,
    model: model_versions.ModelSnapshot | None = None,
) -> list[Candidate]:
    """Сыгранные матчи основного тура архива с днем в [since, until) с прогнозом модели до
    матча (снимок model, нет — активная версия) и рынком архива."""
    elo, platt = elo_model_of(model.params) if model is not None else await elo_model(db)
    rows = await read_only(
        db,
        ratings_select(model=elo, since=since, until=until, levels=BacktestConfig().levels),
    )
    market = await archive_market(db, [int(row["match_id"]) for row in rows])
    found: list[Candidate] = []
    for row in rows:
        p1 = calibrated_p1(win_probability(float(row["r1"]), float(row["r2"])), platt)
        match_id = int(row["match_id"])
        found.append(
            Candidate(
                match_id=match_id,
                day=row["day"],
                y1=1 if row["winner_id"] == row["p1"] else 0,
                p1=p1,
                q1=market.get(match_id),
            )
        )
    return found


def _order_key(code: str, match_id: int) -> str:
    return hashlib.sha256(f"{code}:{match_id}".encode()).hexdigest()


def choose(pool: list[Candidate], *, code: str, size: int, hard_share: float) -> list[Candidate]:
    """Детерминированный выбор: трудные до доли hard_share, остальные — обычные; по ключу
    sha256(«код:id»), чтобы выбор не зависел от порядка строк в базе."""
    ordered = sorted(pool, key=lambda item: _order_key(code, item.match_id))
    hard = [item for item in ordered if item.hard]
    plain = [item for item in ordered if not item.hard]
    hard_target = round(size * hard_share)
    picked = hard[:hard_target]
    picked += plain[: size - len(picked)]
    if len(picked) < size:
        picked += hard[hard_target : hard_target + size - len(picked)]
    return sorted(picked, key=lambda item: item.match_id)


def list_sha256(items: list[tuple[int, bool]]) -> str:
    """sha256 списка событий набора: «id:трудный» по id матча, по строке."""
    body = "\n".join(f"{match_id}:{int(hard)}" for match_id, hard in sorted(items))
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


def _market_metrics(picked: list[Candidate]) -> dict[str, Any]:
    with_market = [item for item in picked if item.q1 is not None]
    if not with_market:
        return {"market_n": 0, "market_log_loss": None, "market_brier": None}
    q = [float(item.q1 or 0) for item in with_market]
    y = [item.y1 for item in with_market]
    return {
        "market_n": len(with_market),
        "market_log_loss": log_loss(q, y),
        "market_brier": brier(q, y),
    }


async def freeze(
    db: AsyncSession,
    body: EvalSetIn,
    *,
    actor_id: int | None,
    ip: str | None = None,
    today: date | None = None,
) -> EvalSet:
    """Заморозка набора: выбор событий, список и sha256, журнал eval_set. Код уже есть —
    409 eval.set_exists; since раньше среза знаний — 422 eval.set_seen; сыгранных матчей
    меньше 200 — 422 eval.set_too_small. commit."""
    config = await load_agent_config(db)
    day = today or utcnow().date()
    floor = since_floor(config.analysis_model)
    since = body.since or floor
    if since < floor:
        raise AppError(422, "eval.set_seen", since=floor.isoformat())
    size = body.size or config.eval_set_size
    code = body.code or f"eval-{since:%Y-%m}"
    await db.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": FREEZE_LOCK})
    if await db.scalar(select(EvalSet.id).where(EvalSet.code == code)) is not None:
        raise AppError(409, "eval.set_exists", name=code)
    pinned = await model_versions.pinned_for_set(db, since)
    pool = await candidates(db, since=since, until=day, model=pinned)
    if len(pool) < MIN_EVENTS:
        raise AppError(422, "eval.set_too_small", n=len(pool), min=MIN_EVENTS)
    size = min(size, len(pool))
    picked = choose(pool, code=code, size=size, hard_share=config.eval_hard_share)
    hard = sum(1 for item in picked if item.hard)
    moment = utcnow()
    eval_set = EvalSet(
        code=code,
        frozen_at=moment,
        sha256=list_sha256([(item.match_id, item.hard) for item in picked]),
        n_events=len(picked),
        since=since,
        rules={
            "until": max(item.day for item in picked).isoformat(),
            "size": size,
            "hard": hard,
            "hard_share": config.eval_hard_share,
            "close_max": CLOSE_MAX,
            "upset_below": UPSET_BELOW,
            "levels": list(BacktestConfig().levels),
            "model": config.analysis_model,
            "calibration": pinned.to_json(),
            "with_news": False,
            "candidates": len(pool),
            **_market_metrics(picked),
        },
    )
    db.add(eval_set)
    await db.flush()
    db.add_all(
        EvalSetItem(
            eval_set_id=eval_set.id,
            match_id=item.match_id,
            split="test",
            hard=item.hard,
            with_news=False,
        )
        for item in picked
    )
    await write_audit(
        db,
        action="eval_set",
        actor_id=actor_id,
        details={"code": code, "events": len(picked), "hard": hard, "sha256": eval_set.sha256},
        ip=ip,
    )
    await db.commit()
    return eval_set


async def latest_set(db: AsyncSession) -> EvalSet | None:
    found: EvalSet | None = await db.scalar(
        select(EvalSet)
        .where(EvalSet.frozen_at.is_not(None))
        .order_by(EvalSet.frozen_at.desc(), EvalSet.id.desc())
        .limit(1)
    )
    return found


def set_out(eval_set: EvalSet) -> EvalSetOut:
    rules = eval_set.rules or {}
    hard = int(rules.get("hard") or 0)
    until = rules.get("until")
    return EvalSetOut(
        id=eval_set.id,
        code=eval_set.code,
        frozen_at=eval_set.frozen_at,
        sha256=eval_set.sha256,
        n_events=eval_set.n_events,
        hard=hard,
        hard_share=hard / eval_set.n_events if eval_set.n_events else 0.0,
        since=eval_set.since,
        until=date.fromisoformat(until) if isinstance(until, str) else None,
        with_news=bool(rules.get("with_news", False)),
        market_n=int(rules.get("market_n") or 0),
        market_log_loss=rules.get("market_log_loss"),
        market_brier=rules.get("market_brier"),
    )


async def list_sets(db: AsyncSession, *, today: date | None = None) -> EvalSetsOut:
    """Наборы (новые первыми) и сколько матчей доступно для следующего набора."""
    config = await load_agent_config(db)
    day = today or utcnow().date()
    since = since_floor(config.analysis_model)
    sets = list(
        await db.scalars(select(EvalSet).order_by(EvalSet.created_at.desc(), EvalSet.id.desc()))
    )
    played = func.coalesce(Match.match_date, Tournament.start_date)
    available = await db.scalar(
        select(func.count())
        .select_from(Match)
        .join(Tournament, Tournament.id == Match.tournament_id)
        .where(
            Match.status == "finished",
            Match.winner_id.is_not(None),
            Match.source.in_(ARCHIVE_SOURCES),
            Tournament.category.in_(BacktestConfig().levels),
            played >= since,
            played < day,
        )
    )
    return EvalSetsOut(
        items=[set_out(item) for item in sets],
        available=int(available or 0),
        since=since,
        size=config.eval_set_size,
        hard_share=config.eval_hard_share,
    )


def match_day_start(day: date) -> datetime:
    """Момент досье события: начало дня матча по UTC — данные строго до этого дня."""
    return datetime.combine(day, datetime.min.time(), UTC)


# --- досье набора ---


async def set_model(db: AsyncSession, eval_set: EvalSet) -> model_versions.ModelSnapshot:
    """Снимок базовой модели набора: закрепленный при заморозке (rules.calibration); у
    набора без записи (заморожен до m4) — закрепляется сейчас по тому же правилу и
    записывается в rules (flush): все прогоны набора дальше видят одну калибровку."""
    rules = dict(eval_set.rules or {})
    base = await model_versions.snapshot(db, MODEL_ID)
    found = model_versions.stored_snapshot(rules.get("calibration"), base.params)
    if found is not None:
        return found
    since = eval_set.since or EVAL_SINCE
    pinned = await model_versions.pinned_for_set(db, since)
    eval_set.rules = {**rules, "calibration": pinned.to_json()}
    await db.flush()
    return pinned


async def set_matches(db: AsyncSession, ids: Sequence[int]) -> dict[int, smoke_eval.SmokeMatch]:
    """Матчи набора по id: день, покрытие, формат."""
    if not ids:
        return {}
    day = func.coalesce(Match.match_date, Tournament.start_date)
    rows = await db.execute(
        select(Match, day, Tournament.surface, Tournament.best_of)
        .join(Tournament, Tournament.id == Match.tournament_id)
        .where(Match.id.in_(list(ids)))
    )
    return {
        match.id: smoke_eval.SmokeMatch(
            match=match,
            day=match_day,
            surface=surface or "hard",
            best_of=match.best_of or tour_best_of or 3,
        )
        for match, match_day, surface, tour_best_of in rows
    }


def stored_event(
    item: smoke_eval.SmokeMatch, dossier: Dossier, model_id: str | None
) -> smoke_eval.SmokeEvent:
    """Событие по уже построенному досье набора (то же, что видели прошлые прогоны)."""
    content = dossier.content or {}
    match = item.match
    flip = side_flip(match.id)
    first = match.player2_id if flip else match.player1_id
    shown = content.get("p_base") or {}
    return smoke_eval.SmokeEvent(
        match_id=match.id,
        day=item.day,
        flip=flip,
        y=1 if match.winner_id == first else 0,
        p1=str((content.get("p1") or {}).get("name") or first),
        p2=str((content.get("p2") or {}).get("name") or ""),
        dossier_id=dossier.id,
        dossier_text=canonical_json(content),
        as_of=dossier.as_of,
        p_base=Probs3(**{name: float(shown.get(name, 0.5)) for name in PROBS3_FIELDS}),
        refs=tuple(sorted((content.get("refs") or {}).keys())),
        features={"ml_model_id": model_id},
    )


async def prepare_events(
    db: AsyncSession, eval_set: EvalSet, items: Sequence[EvalSetItem]
) -> list[smoke_eval.SmokeEvent]:
    """События набора: досье набора (есть — то же), иначе — на день матча без новостей
    (строго до этого дня) с калибровкой набора, и запоминается в eval_set_items. Прогоны
    версий и быстрая проверка урока видят одни и те же досье. commit — за вызывающим."""
    model = await set_model(db, eval_set)
    matches = await set_matches(db, [item.match_id for item in items])
    stored = {
        row.id: row
        for row in await db.scalars(
            select(Dossier).where(
                Dossier.id.in_([item.dossier_id for item in items if item.dossier_id])
            )
        )
    }
    events: list[smoke_eval.SmokeEvent] = []
    for item in items:
        match = matches.get(item.match_id)
        if match is None or match.match.winner_id is None:
            continue
        dossier = stored.get(item.dossier_id) if item.dossier_id else None
        if dossier is not None:
            events.append(stored_event(match, dossier, model.model_id))
            continue
        [event] = await smoke_eval.prepare_events(db, [match], model=model)
        item.dossier_id = event.dossier_id
        events.append(event)
    return events
