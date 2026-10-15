"""Подготовка стека e2e для сценария «Обучение модели» (frontend/e2e/flows/learning-*.spec.ts).

Запускается из e2e/support/learning.ts интерпретатором backend против базы стека (окружение
— как у scripts/e2e-stack.sh: CAPPER_DATABASE_URL и остальное). Не часть приложения: только
то, что в настоящей работе делает время и архив. Сыгранные матчи после даты среза знаний
модели для быстрой проверки уже есть: маленький мир стека (seed_world в scripts/e2e-stack.sh).

  ready КОД        — урок-гипотеза прошел проверку на истории (это делает код по архиву за
                     годы, на стеке архива нет): статус ready, числа проверки; знак смещения и
                     поправки — по направлению условия урока.
  collect          — дождаться отправки пакета быстрой проверки и собрать готовые пакеты тем
                     же кодом, что задача воркера (поддельный Claude отвечает сразу).
  cleanup КОД      — убрать след сценария со стека, чтобы его можно было гонять повторно на
                     одном стеке: версии инструкций, созданные включением и выключением урока,
                     удаляются, активной снова становится версия до них; прогоны быстрой
                     проверки урока с их вызовами Claude (расход бюджета проверок) и пакетами
                     удаляются; урок удаляется. Чего нет — пропускается.
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


async def ready(code: str) -> None:
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
            lesson.validated_at = now - timedelta(minutes=5)
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


def main() -> None:
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    if command == "ready" and len(sys.argv) == 3:
        asyncio.run(ready(sys.argv[2]))
    elif command == "collect":
        asyncio.run(collect())
    elif command == "cleanup" and len(sys.argv) == 3:
        asyncio.run(cleanup(sys.argv[2]))
    else:
        raise SystemExit("ready КОД | collect | cleanup КОД")


if __name__ == "__main__":
    main()
