"""Подсказка исхода по новостям (этап 5, В1-Г Р25): для ставки, которая ждет результата,
в карточке ставки — «исход и счет по новостям», если шаг новостей перед анализом нашел
результат этого матча (player_news, вид result: соперник, счет, дата, победа).

Только подсказка: деньги по ней не считаются, исход вносит участник («Подставить 2:0» в
окне расчета). Факт подходит, если он про одного из игроков матча, соперник в нем —
второй игрок (по фамилии латиницей или по-русски) и день результата — день матча ±1
(пояс источника неизвестен). Несколько фактов — берется найденный последним.

Р28: у ног по геймам окно расчета подставляет счет по геймам — поле games, первым всегда
игрок 1 матча (как и sets), иначе фора по геймам считается за другого игрока.
"""

import re
from collections.abc import Sequence
from datetime import date, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Player, PlayerNews
from app.ingest.names import fold
from app.ml.markets import parse_games
from app.schemas.bets import NewsResultOut

# Сет в счете из новости: «6-3», «6:3», «7–6(5)», «7-6(10-8)»
_SET = re.compile(r"(\d{1,2})\s*[-:–]\s*(\d{1,2})(?:\s*\(\d+(?:[-:–]\d+)?\))?")
_RETIRED = re.compile(r"\b(ret|retired|retd|w/o|walkover|отказ|снял)", re.IGNORECASE)
# Сет по геймам: «6-4», «7-6(5)», «7-6(7-5)», супер-тай-брейк «[10-8]»
_GAME_SET = re.compile(
    r"(\[)?(\d{1,2})\s*[-:–]\s*(\d{1,2})"
    r"(?:\s*\((\d{1,2})(?:\s*[-:–]\s*(\d{1,2}))?\))?(\])?"
)
DAY_WINDOW = timedelta(days=1)
SCORE_MAX = 80


def _is_opponent(text: str, player: Player) -> bool:
    """Соперник из новости — этот игрок: фамилия (последнее слово имени) есть в тексте."""
    words = set(fold(text).split())
    surnames = {
        fold(name).split()[-1]
        for name in (player.name, player.name_ru)
        if name and fold(name).split()
    }
    return bool(surnames & words)


def set_score(score: str, best_of: int | None) -> tuple[int, int] | None:
    """Сеты победителя и проигравшего по счету из новости; неполный — None."""
    first = second = 0
    for left, right in _SET.findall(score):
        a, b = int(left), int(right)
        if a > b:
            first += 1
        elif b > a:
            second += 1
    winner, loser = max(first, second), min(first, second)
    need = {3: (2,), 5: (3,)}.get(best_of or 0, (2, 3))
    if winner not in need or loser >= winner:
        return None
    return winner, loser


def games_score(score: str, winner: int, number: int) -> str | None:
    """Счет по геймам из новости, первым — игрок 1 матча («6:4 7:6(5)»); не счет — None.

    С чьей стороны записан счет, решает сам счет: кто взял больше сетов, тот победитель
    (winner). Счет без перевеса по сетам (снятие) — со стороны игрока новости (number), как
    просит промпт новостей. Очки тай-брейка — меньшее число, как в записи «7-6(5)»."""
    found = [m for m in _GAME_SET.finditer(score) if bool(m.group(1)) == bool(m.group(6))]
    if not found:
        return None
    sets = [(int(m.group(2)), int(m.group(3))) for m in found]
    left = sum(a > b for a, b in sets)
    right = sum(b > a for a, b in sets)
    # Слева победитель или проигравший — по сетам; поровну — сторона игрока новости
    left_player = number if left == right else (winner if left > right else 3 - winner)
    parts = []
    for m, (a, b) in zip(found, sets, strict=True):
        if left_player == 2:
            a, b = b, a
        points = [int(x) for x in (m.group(4), m.group(5)) if x is not None]
        tiebreak = f"({min(points)})" if points else ""
        parts.append(f"[{a}:{b}]" if m.group(1) else f"{a}:{b}{tiebreak}")
    text = " ".join(parts)
    return text if parse_games(text) is not None else None


def _day(details: dict[str, Any]) -> date | None:
    raw = details.get("date")
    if not isinstance(raw, str):
        return None
    try:
        return date.fromisoformat(raw[:10])
    except ValueError:
        return None


async def news_results(
    db: AsyncSession, legs: Sequence[tuple[int, int, int, date, int | None]]
) -> dict[int, NewsResultOut]:
    """Подсказки для ног (id ноги, игрок 1, игрок 2, день матча, формат) → нога →
    подсказка."""
    if not legs:
        return {}
    player_ids = {pid for _, first, second, _, _ in legs for pid in (first, second)}
    players = {
        player.id: player
        for player in await db.scalars(select(Player).where(Player.id.in_(player_ids)))
    }
    earliest = min(day for *_, day, _ in legs) - DAY_WINDOW
    rows = list(
        await db.scalars(
            select(PlayerNews)
            .where(
                PlayerNews.kind == "result",
                PlayerNews.player_id.in_(player_ids),
                PlayerNews.published_at >= earliest,
            )
            .order_by(PlayerNews.fetched_at.desc(), PlayerNews.id.desc())
        )
    )
    found: dict[int, NewsResultOut] = {}
    for leg_id, first, second, day, best_of in legs:
        for news in rows:
            details = news.details or {}
            if news.player_id not in (first, second):
                continue
            played = _day(details)
            if played is None or abs((played - day).days) > DAY_WINDOW.days:
                continue
            other = players.get(second if news.player_id == first else first)
            opponent = details.get("opponent")
            if other is None or not isinstance(opponent, str) or not _is_opponent(opponent, other):
                continue
            won = details.get("won")
            if not isinstance(won, bool):
                continue
            number = 1 if news.player_id == first else 2
            winner = number if won else 3 - number
            score = " ".join(str(details.get("score") or "").split())[:SCORE_MAX]
            retired = bool(_RETIRED.search(score))
            sets = None if retired else set_score(score, best_of)
            sets_text = None
            if sets is not None:
                top, low = sets
                sets_text = f"{top}:{low}" if winner == 1 else f"{low}:{top}"
            found[leg_id] = NewsResultOut(
                winner=winner,  # type: ignore[arg-type]
                sets=sets_text,
                games=None if retired else games_score(score, winner, number),
                score=score,
                retired=retired,
                source_name=news.source_name,
                source_url=news.source_url,
                published_on=news.published_at.date(),
                found_at=news.fetched_at,
            )
            break
    return found
