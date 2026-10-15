"""Расчет по архиву (этап 5, задача settle_from_archive в сводке): шаг обновления данных
после загрузчиков, привязки старого бота и Эло (app/ingest/update.py, шаг settle) — и
ночью, и после загрузки файла tennis-data на сайте (app/services/data_uploads.py).

По порядку, каждый шаг своей транзакцией:
1. привязка матчей из ввода к архиву (app/ingest/match_link.py);
2. закрытие из архива у ног П1/П2 (app/services/archive_closing.py);
3. авторасчет открытых ставок и сверка рассчитанных с архивом
   (app/services/auto_settlement.py);
4. исходы ног экспрессов старого бота (app/services/legacy_results.py);
5. прогрев аналитики тем, чьи ставки изменились (app/services/analytics_cache.py).

Журнал — ingestion_runs (source = settle): отчет без сумм и имен участников (Р14) —
сколько рассчитано ставок и у скольких участников, закрытий, привязано и не привязано
матчей, расхождений, ставок со снятием или неявкой и с ногой на прошлой встрече пары.
Игроки и день — только у матчей, которые нужно разобрать руками (несколько кандидатов,
конфликт слияния); «нет в архиве» — только числом: по ним видно, на что ставили. Ставка помнит этот
запуск (bets.settle_run_id): по нему экран «Ставки» пишет «авто · архив ‹дата›».
"""

from collections.abc import Callable
from typing import Any

import structlog
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.i18n import t
from app.ingest.match_link import archive_last_day, link_user_matches
from app.ingest.runs import IngestReport, ingestion_run
from app.services import analytics_cache
from app.services.archive_closing import close_from_archive
from app.services.auto_settlement import check_settled_bets, settle_open_bets
from app.services.legacy_results import fill_legacy_legs

log = structlog.get_logger(__name__)

SOURCE = "settle"


async def settle_from_archive(
    db_factory: Callable[[], AsyncSession], *, warm: bool = True
) -> tuple[IngestReport, int]:
    """Все шаги расчета по архиву (см. docstring модуля). Возвращает отчет и id запуска в
    ingestion_runs. warm — поставить прогрев аналитики участникам с изменениями."""
    async with ingestion_run(db_factory, SOURCE) as run:
        report = run.report
        async with db_factory() as db:
            linked = await link_user_matches(db)
            await db.commit()
        async with db_factory() as db:
            closing, closing_users = await close_from_archive(db)
        async with db_factory() as db:
            settled = await settle_open_bets(db, run_id=run.id)
        async with db_factory() as db:
            checked = await check_settled_bets(db)
        async with db_factory() as db:
            legacy = await fill_legacy_legs(db)
        async with db_factory() as db:
            last = await archive_last_day(db)
        counts = report.counts
        counts["matches.linked"] = linked.linked
        counts["matches.flipped"] = linked.flipped
        counts["matches.waiting"] = linked.waiting
        counts["matches.unlinked"] = linked.unlinked_total
        counts["matches.not_found"] = linked.not_found
        counts["closing.legs"] = closing
        counts["bets.settled"] = settled.settled
        counts["bets.people"] = len(settled.users)
        counts["bets.legs"] = settled.legs
        counts["bets.manual"] = settled.manual
        counts["bets.early"] = settled.early
        counts["bets.overflow"] = settled.overflow
        counts["bets.reminded"] = settled.reminded
        counts["bets.conflicts"] = checked.conflicts
        counts["legacy.legs"] = legacy
        report.updated = settled.settled + closing + legacy
        report.created = linked.linked
        for row in linked.unlinked:
            report.add_unmatched(
                str(row["reason"]), **{k: v for k, v in row.items() if k != "reason"}
            )
        report.freshness = {"archive_to": last}
        changed = closing_users | settled.users | checked.users
    if warm:
        for user_id in sorted(changed):
            await analytics_cache.request_warm(user_id)
    log.info("settle.archive", run_id=run.id, **_log(counts))
    return report, run.id


def _log(counts: Any) -> dict[str, int]:
    return {key.replace(".", "_"): int(value) for key, value in counts.items()}


def summary_lines(report: IngestReport) -> list[str]:
    """Итог расчета по архиву для терминала (без сумм и имен участников)."""
    counts = report.counts
    archive_to = report.freshness.get("archive_to")
    lines = [
        t(
            "settle.summary.bets",
            settled=counts["bets.settled"],
            people=counts["bets.people"],
            legs=counts["bets.legs"],
            closing=counts["closing.legs"],
            archive_to=archive_to or "—",
        ),
        t(
            "settle.summary.matches",
            linked=counts["matches.linked"],
            waiting=counts["matches.waiting"],
            unlinked=counts["matches.unlinked"],
            not_found=counts["matches.not_found"],
        ),
    ]
    if counts["bets.conflicts"] or counts["bets.manual"] or counts["bets.overflow"]:
        lines.append(
            t(
                "settle.summary.attention",
                conflicts=counts["bets.conflicts"],
                manual=counts["bets.manual"],
                early=counts["bets.early"],
                overflow=counts["bets.overflow"],
            )
        )
    if counts["legacy.legs"]:
        lines.append(t("settle.summary.legacy", legs=counts["legacy.legs"]))
    for row in report.unmatched[:20]:
        lines.append(
            "  "
            + t(
                "settle.summary.unlinked_row",
                match_id=row.get("match_id"),
                player1=row.get("player1"),
                player2=row.get("player2"),
                day=row.get("day"),
                reason=t(f"settle.unlinked.{row.get('kind')}"),
            )
        )
    return lines
