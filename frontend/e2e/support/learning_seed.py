"""Подготовка стека e2e для сценария «Обучение модели» (frontend/e2e/flows/learning-*.spec.ts).

Запускается из e2e/support/learning.ts интерпретатором backend против базы стека (окружение
— как у scripts/e2e-stack.sh: CAPPER_DATABASE_URL и остальное). Не часть приложения: только
то, что в настоящей работе делает время и архив. Сыгранные матчи после даты среза знаний
модели для быстрой проверки уже есть: маленький мир стека (seed_world в scripts/e2e-stack.sh).

  ready КОД [now]  — урок-гипотеза прошел проверку на истории (это делает код по архиву за
                     годы, на стеке архива нет): статус ready, числа проверки; знак смещения и
                     поправки — по направлению условия урока.
  collect          — дождаться отправки пакета быстрой проверки и собрать готовые пакеты тем
                     же кодом, что задача воркера (поддельный Claude отвечает сразу).
  cleanup КОД      — убрать след сценария со стека, чтобы его можно было гонять повторно на
                     одном стеке: версии инструкций, созданные включением и выключением урока,
                     удаляются, активной снова становится версия до них; прогоны быстрой
                     проверки урока с их вызовами Claude (расход бюджета проверок) и пакетами
                     удаляются; урок удаляется. Чего нет — пропускается.
  eval-world       — архив для замороженного набора: на стеке сыгранных матчей после 1 августа
                     2026 мало (нужно 200–300), поэтому — синтетический основной тур
                     2025–2026 (игроки «E2E Набор N», кэфы архива); есть — не трогается.
  eval-collect     — довести идущий прогон версии на наборе до конца тем же кодом, что
                     задачи воркера (поддельный Claude отвечает сразу): пакет за пакетом.
  eval-cleanup     — убрать след сценария «Версии стратегии»: прогоны на наборе с их вызовами
                     Claude, пакетами и прогнозами, сравнения, наборы, досье и синтетический
                     архив; рейтинги пересчитываются заново.
  weekly EMAIL     — отчет прошлой недели участнику (задача воркера по понедельникам) и его
                     уведомление weekly_report.
  postmortem-start — начало разборов (postmortem_since), как при первом запуске очереди
                     задачей воркера: на стеке воркер без расписания, а первая команда
                     postmortems записала бы «сейчас» и не взяла бы ставку, рассчитанную до нее.
                     Уже задано — не меняется.
  postmortem-cleanup СТАВКА
                   — убрать след сквозного сценария «ставка → архив → разбор → урок»
                     (learning-loop.spec.ts): разборы матчей ставки с их вызовами Claude и
                     пакетами и уроки из этих разборов — как cleanup КОД. Матчи архива
                     остаются: повторная загрузка того же файла снова рассчитывает новую
                     ставку, а разбор матча встает в очередь заново.
"""

import asyncio
import sys
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, select

from app.agent.config import load_agent_config
from app.db.models import AgentRun, BatchJob, EvalRun, Lesson, StrategyVersion
from app.db.session import create_engine, create_sessionmaker
from app.services.strategy_versions import ACTIVE, lock_shared

# Числа «проверки на истории» стека: смещение модели в условии — доля, знак — по направлению
# урока (raise: модель занижает, факт выше прогноза — плюс); поправка с усадкой — как у кода
# проверки: bias · n / (n + k), n — случаи истории архива (n_shrink), k — из настроек
BIAS = 0.05
BIAS_CI = (0.029, 0.071)
N_HISTORY = 309


async def ready(code: str, *, fresh: bool = False) -> None:
    engine = create_engine()
    try:
        async with create_sessionmaker(engine)() as db:
            lesson = await db.scalar(
                select(Lesson).where(Lesson.code == code, Lesson.user_id.is_(None))
            )
            if lesson is None:
                raise SystemExit(f"нет урока {code}")
            now = datetime.now(UTC)
            sign = 1 if (lesson.scope or {}).get("direction") == "raise" else -1
            low, high = sorted((sign * BIAS_CI[0], sign * BIAS_CI[1]))
            shrink_k = (await load_agent_config(db)).lesson_shrink_k
            shift = round(sign * BIAS * N_HISTORY / (N_HISTORY + shrink_k), 4)
            history = {
                "status": "ready",
                "reason": None,
                "checked_at": now.isoformat(),
                "method": "p_base",
                "n_hist": 412,
                "n_history": N_HISTORY,
                "n_holdout": 103,
                "n_shrink": N_HISTORY,
                "holdout_since": "2025-04-01",
                "bias": {"value": sign * BIAS, "low": low, "high": high, "n": N_HISTORY},
                "shift": shift,
                "log_loss_without": 0.634,
                "log_loss_with": 0.612,
                "gain": {"value": 0.022, "low": 0.012, "high": 0.031, "n": N_HISTORY},
                "holdout_gain": {"value": 0.009, "low": 0.001, "high": 0.018, "n": 103},
                "seed": 20261015,
            }
            lesson.status = "ready"
            lesson.n_cases = max(lesson.n_cases, 21)
            lesson.n_hist = 412
            lesson.effect = sign * BIAS
            lesson.effect_ci = [low, high]
            lesson.effect_shrunk = shift
            lesson.holdout_effect = 0.009
            lesson.holdout_ci = [0.001, 0.018]
            # fresh: проверка «сейчас» — позже заморозки набора (иначе план прогона откажет
            # eval.lesson_overlap: урок проверялся и на матчах набора)
            lesson.validated_at = now if fresh else now - timedelta(minutes=5)
            lesson.metrics = {**(lesson.metrics or {}), "history": history}
            await db.commit()
            print(f"ready: {code}")
    finally:
        await engine.dispose()


async def collect() -> None:
    # Задачи воркера тянут сервисы анализа: грузим только здесь (как команда postmortems)
    from app.workers.jobs import collect_all

    engine = create_engine()
    try:
        factory = create_sessionmaker(engine)
        deadline = asyncio.get_running_loop().time() + 60
        while True:
            async with factory() as db:
                waiting = await db.scalar(
                    select(EvalRun.id).where(
                        EvalRun.metrics["kind"].astext == "quick",
                        EvalRun.status.in_(("pending", "running")),
                        EvalRun.batch_job_id.is_(None),
                    )
                )
            if waiting is None:
                break
            if asyncio.get_running_loop().time() > deadline:
                raise SystemExit("пакет быстрой проверки не ушел за минуту")
            await asyncio.sleep(0.5)
        async with factory() as db:
            summary = await collect_all(db)
        print(f"collected: {summary.get('collected', 0)}")
    finally:
        await engine.dispose()


async def cleanup(code: str) -> None:
    engine = create_engine()
    try:
        async with create_sessionmaker(engine)() as db:
            # Изменения общей линии — по одному, как у решений администратора
            await lock_shared(db)
            lesson = await db.scalar(
                select(Lesson).where(Lesson.code == code, Lesson.user_id.is_(None))
            )
            if lesson is None:
                print(f"cleanup: нет урока {code}")
                return
            # Версии общей линии со времени включения урока: первая — с ним в наборе уроков,
            # остальные — ее потомки (выключение урока дает еще одну). Активной снова
            # становится версия, от которой пошла первая
            shared = list(
                await db.scalars(
                    select(StrategyVersion)
                    .where(StrategyVersion.user_id.is_(None))
                    .order_by(StrategyVersion.id)
                )
            )
            first = next((v for v in shared if code in (v.lessons or [])), None)
            removed: list[str] = []
            if first is not None:
                chain = {first.id}
                for version in shared:
                    if version.parent_id in chain:
                        chain.add(version.id)
                parent = next((v for v in shared if v.id == first.parent_id), None)
                removed = [v.code for v in shared if v.id in chain]
                await db.execute(delete(StrategyVersion).where(StrategyVersion.id.in_(chain)))
                if parent is not None:
                    parent.status = ACTIVE
                    parent.archived_at = None
                await db.flush()
            # Быстрые проверки урока: вызовы Claude (расход бюджета проверок), пакеты, прогоны
            runs = list(
                await db.scalars(
                    select(EvalRun).where(EvalRun.metrics["lesson_id"].astext == str(lesson.id))
                )
            )
            run_ids = [run.id for run in runs]
            batch_ids = [run.batch_job_id for run in runs if run.batch_job_id is not None]
            if run_ids:
                await db.execute(delete(AgentRun).where(AgentRun.eval_run_id.in_(run_ids)))
                await db.execute(delete(EvalRun).where(EvalRun.id.in_(run_ids)))
            if batch_ids:
                await db.execute(delete(BatchJob).where(BatchJob.id.in_(batch_ids)))
            await db.delete(lesson)
            await db.commit()
            print(f"cleanup: {code}, версии {removed}, прогонов {len(run_ids)}")
    finally:
        await engine.dispose()


# --- «Версии стратегии»: замороженный набор и прогоны версий ---

WORLD_REF = "e2e-eval"


async def eval_world() -> None:
    from app.db.models import Match, OddsSnapshot, Player, Tournament
    from app.ml.elo import rebuild_ratings
    from tests.ml_world import make_world

    engine = create_engine()
    try:
        factory = create_sessionmaker(engine)
        async with factory() as db:
            exists = await db.scalar(
                select(Tournament.id).where(Tournament.source_ref.like(f"{WORLD_REF}-%")).limit(1)
            )
            if exists is not None:
                print("eval-world: уже есть")
                return
            world = make_world(
                players=96,
                years=range(2025, 2027),
                tournaments_per_year=30,
                draw=64,
                seed=11,
                odds_from=2025,
                dated_from=2025,
                retired_share=0.0,
            )
            # Только сыгранные: турниры, начавшиеся не позже чем две недели назад
            last = datetime.now(UTC).date() - timedelta(days=14)
            keep = {key for key, item in world.tournaments.items() if item.start <= last}
            people = [Player(name=f"E2E Набор {n}") for n in range(1, world.players + 1)]
            db.add_all(people)
            await db.flush()
            tournaments = {
                key: Tournament(
                    name=f"E2E {item.name}",
                    surface=item.surface,
                    category=item.level,
                    start_date=item.start,
                    source="sackmann",
                    source_ref=f"{WORLD_REF}-{key}",
                )
                for key, item in world.tournaments.items()
                if key in keep
            }
            db.add_all(tournaments.values())
            await db.flush()
            rows: dict[int, Match] = {}
            for match in world.matches:
                if match.tournament_id not in keep:
                    continue
                rows[match.match_id] = Match(
                    tournament_id=tournaments[match.tournament_id].id,
                    round=match.round,
                    match_date=match.match_date,
                    player1_id=people[match.player1_id - 1].id,
                    player2_id=people[match.player2_id - 1].id,
                    winner_id=people[match.winner_id - 1].id,
                    score="6-4 6-4",
                    status=match.status,
                    best_of=3,
                    source="sackmann",
                    source_ref=f"{WORLD_REF}-{match.tournament_id}-{match.match_id}",
                )
            db.add_all(rows.values())
            await db.flush()
            for match_id, row in rows.items():
                source = next(m for m in world.matches if m.match_id == match_id)
                day = source.match_date or source.day
                taken = datetime.combine(day, datetime.min.time(), tzinfo=UTC)
                for book, pair in world.odds.get(match_id, {}).items():
                    for selection, value in enumerate(pair, start=1):
                        db.add(
                            OddsSnapshot(
                                match_id=row.id,
                                market="ML",
                                selection=selection,
                                bookmaker=book,
                                odds=value,
                                kind="archive",
                                taken_at=taken,
                            )
                        )
            await db.commit()
        await rebuild_ratings(db_factory=factory)
        print(f"eval-world: матчей {len(rows)}")
    finally:
        await engine.dispose()


async def eval_collect() -> None:
    from app.services import eval_runs
    from app.workers.jobs import advance_eval_runs, collect_all

    engine = create_engine()
    try:
        factory = create_sessionmaker(engine)
        deadline = asyncio.get_running_loop().time() + 150
        while True:
            async with factory() as db:
                run = await db.scalar(
                    select(EvalRun)
                    .where(EvalRun.metrics["kind"].astext == "eval")
                    .order_by(EvalRun.id.desc())
                    .limit(1)
                )
                if run is None:
                    raise SystemExit("прогона на наборе нет")
                if run.status in ("done", "failed", "abandoned"):
                    print(f"eval-collect: прогон {run.id} {run.status}")
                    return
                if run.status == "pending" and run.batch_job_id is None:
                    await eval_runs.advance(db, run.id)
            async with factory() as db:
                await collect_all(db)
            async with factory() as db:
                await advance_eval_runs(db)
            if asyncio.get_running_loop().time() > deadline:
                raise SystemExit("прогон на наборе не закончился")
            await asyncio.sleep(0.3)
    finally:
        await engine.dispose()


async def eval_cleanup() -> None:
    from app.db.models import EvalSet, Match, Player, Prediction, Tournament
    from app.ml.elo import rebuild_ratings

    engine = create_engine()
    try:
        factory = create_sessionmaker(engine)
        async with factory() as db:
            runs = list(
                await db.scalars(select(EvalRun).where(EvalRun.metrics["kind"].astext == "eval"))
            )
            run_ids = [run.id for run in runs]
            batch_ids = [run.batch_job_id for run in runs if run.batch_job_id is not None]
            if run_ids:
                await db.execute(delete(AgentRun).where(AgentRun.eval_run_id.in_(run_ids)))
                batch_ids += list(
                    await db.scalars(
                        select(BatchJob.id).where(
                            BatchJob.kind == "eval", BatchJob.params["eval_kind"].astext == "eval"
                        )
                    )
                )
                await db.execute(delete(EvalRun).where(EvalRun.id.in_(run_ids)))
            if batch_ids:
                await db.execute(delete(BatchJob).where(BatchJob.id.in_(set(batch_ids))))
            await db.execute(delete(EvalSet))
            tournaments = select(Tournament.id).where(Tournament.source_ref.like(f"{WORLD_REF}-%"))
            matches = select(Match.id).where(Match.tournament_id.in_(tournaments))
            await db.execute(delete(Prediction).where(Prediction.match_id.in_(matches)))
            players = list(
                await db.scalars(select(Player.id).where(Player.name.like("E2E Набор %")))
            )
            await db.execute(delete(Match).where(Match.tournament_id.in_(tournaments)))
            await db.execute(delete(Tournament).where(Tournament.source_ref.like(f"{WORLD_REF}-%")))
            if players:
                await db.execute(delete(Player).where(Player.id.in_(players)))
            await db.commit()
        await rebuild_ratings(db_factory=factory)
        print(f"eval-cleanup: прогонов {len(run_ids)}, игроков {len(players)}")
    finally:
        await engine.dispose()


async def weekly(email: str) -> None:
    from app.db.models import User
    from app.services import weekly_report

    engine = create_engine()
    try:
        async with create_sessionmaker(engine)() as db:
            user = await db.scalar(select(User).where(User.email == email))
            if user is None:
                raise SystemExit(f"нет участника {email}")
            week = weekly_report.due_week(datetime.now(UTC), user.tz)
            report = await weekly_report.make_report(db, user, week)
            print(f"weekly: {report.id if report else 'уже есть'}")
    finally:
        await engine.dispose()


async def postmortem_start() -> None:
    from app.services.postmortems import review_since

    engine = create_engine()
    try:
        async with create_sessionmaker(engine)() as db:
            since = await review_since(db, datetime.now(UTC))
            await db.commit()
            print(f"postmortem-start: {since.isoformat()}")
    finally:
        await engine.dispose()


async def postmortem_cleanup(bet_id: int) -> None:
    from app.db.models import BetLeg, Postmortem

    engine = create_engine()
    try:
        async with create_sessionmaker(engine)() as db:
            matches = list(await db.scalars(select(BetLeg.match_id).where(BetLeg.bet_id == bet_id)))
            pms = list(await db.scalars(select(Postmortem).where(Postmortem.match_id.in_(matches))))
            lesson_ids = {pm.lesson_id for pm in pms if pm.lesson_id is not None}
            runs = [pm.agent_run_id for pm in pms if pm.agent_run_id is not None]
            jobs = {pm.batch_job_id for pm in pms if pm.batch_job_id is not None}
            codes = list(await db.scalars(select(Lesson.code).where(Lesson.id.in_(lesson_ids))))
            if pms:
                await db.execute(delete(Postmortem).where(Postmortem.id.in_([p.id for p in pms])))
            if runs:
                await db.execute(delete(AgentRun).where(AgentRun.id.in_(runs)))
            # Пакет удаляется целиком, даже если в нем были разборы других матчей (у них
            # batch_job_id станет NULL): после сценария на стенде не остается его пакетов
            if jobs:
                await db.execute(delete(BatchJob).where(BatchJob.id.in_(jobs)))
            await db.commit()
            print(f"postmortem-cleanup: разборов {len(pms)}, уроки {codes}")
    finally:
        await engine.dispose()
    for code in codes:
        await cleanup(code)


def main() -> None:
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    if command == "ready" and len(sys.argv) in (3, 4):
        asyncio.run(ready(sys.argv[2], fresh=sys.argv[3:] == ["now"]))
    elif command == "collect":
        asyncio.run(collect())
    elif command == "cleanup" and len(sys.argv) == 3:
        asyncio.run(cleanup(sys.argv[2]))
    elif command == "eval-world":
        asyncio.run(eval_world())
    elif command == "eval-collect":
        asyncio.run(eval_collect())
    elif command == "eval-cleanup":
        asyncio.run(eval_cleanup())
    elif command == "weekly" and len(sys.argv) == 3:
        asyncio.run(weekly(sys.argv[2]))
    elif command == "postmortem-start":
        asyncio.run(postmortem_start())
    elif command == "postmortem-cleanup" and len(sys.argv) == 3:
        asyncio.run(postmortem_cleanup(int(sys.argv[2])))
    else:
        raise SystemExit(
            "ready КОД | collect | cleanup КОД | eval-world | eval-collect | eval-cleanup"
            " | weekly EMAIL | postmortem-start | postmortem-cleanup СТАВКА"
        )


if __name__ == "__main__":
    main()
