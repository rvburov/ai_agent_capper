"""Файлы tennis-data.co.uk для тестов и сквозных сценариев: строки и xlsx через openpyxl.

Без pytest: модуль импортируют и сценарии Playwright на стеке, где ставятся только
зависимости приложения.
"""

from datetime import date, datetime
from io import BytesIO
from pathlib import Path
from typing import Any

from openpyxl import Workbook

HEADER = [
    "ATP",
    "Location",
    "Tournament",
    "Date",
    "Series",
    "Court",
    "Surface",
    "Round",
    "Best of",
    "Winner",
    "Loser",
    "WRank",
    "LRank",
    "WPts",
    "LPts",
    "W1",
    "L1",
    "W2",
    "L2",
    "W3",
    "L3",
    "W4",
    "L4",
    "W5",
    "L5",
    "Wsets",
    "Lsets",
    "Comment",
    "B365W",
    "B365L",
    "PSW",
    "PSL",
    "MaxW",
    "MaxL",
    "AvgW",
    "AvgL",
]
# Год без колонок Pinnacle, с лишними пробелами в заголовках и колонкой Betfair
HEADER_NO_PS = [
    " ATP",
    "Location",
    "Tournament",
    "Date",
    "Series",
    "Court",
    "Surface",
    "Round",
    "Best of ",
    "Winner",
    "Loser",
    "W1",
    "L1",
    "W2",
    "L2",
    "W3",
    "L3",
    " Comment ",
    "B365W",
    "B365L",
    "BFEW",
    "BFEL",
    "EXW",
    "EXL",
]
ODDS = {"B365W": 1.5, "B365L": 2.5, "PSW": 1.52, "PSL": 2.61, "MaxW": 1.6, "MaxL": 2.75}


def make_row(
    atp: int,
    tournament: str,
    day: datetime | date | int | str,
    winner: str,
    loser: str,
    *,
    round_label: str = "1st Round",
    series: str = "ATP250",
    court: str = "Outdoor",
    surface: str = "Hard",
    location: str = "City",
    best_of: int = 3,
    sets: tuple[tuple[int, int], ...] = ((6, 4), (6, 4)),
    comment: str = "Completed",
    odds: dict[str, Any] | None = None,
) -> dict[str, Any]:
    row: dict[str, Any] = {
        "ATP": atp,
        "Location": location,
        "Tournament": tournament,
        "Date": day,
        "Series": series,
        "Court": court,
        "Surface": surface,
        "Round": round_label,
        "Best of": best_of,
        "Winner": winner,
        "Loser": loser,
        "Comment": comment,
    }
    for number, (won, lost) in enumerate(sets, start=1):
        row[f"W{number}"], row[f"L{number}"] = won, lost
    row.update(ODDS if odds is None else odds)
    return row


def xlsx(rows: list[dict[str, Any]], header: list[str] = HEADER) -> bytes:
    workbook = Workbook()
    sheet = workbook.active
    assert sheet is not None
    sheet.append(header)
    for row in rows:
        sheet.append([row.get(name.strip()) for name in header])
    buffer = BytesIO()
    workbook.save(buffer)
    return buffer.getvalue()


def write_year(
    folder: Path, year: int, rows: list[dict[str, Any]], header: list[str] = HEADER
) -> Path:
    path = folder / str(year) / f"{year}.xlsx"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(xlsx(rows, header))
    return path
