"""Модель сетов: рынки на форы ±1.5 из вероятности победы в матче (LLM_LEARNING.md, 1.4).

Сеты считаются независимыми, игрок 1 выигрывает сет с вероятностью s. Тогда
- до двух побед (best_of = 3): p = s²(3 − 2s), победа с разницей в 2 сета (2:0) — s²;
- до трех побед (best_of = 5): p = s³(10 − 15s + 6s²), с разницей ≥ 2 сета (3:0 или
  3:1) — s³ + 3s³(1 − s).
Обе функции p(s) строго возрастают на (0, 1), поэтому s по p находится бисекцией.

Анализ оперирует тремя числами матча (Probs3): p1_win — П1 выигрывает матч, p1_cover —
П1 выигрывает с разницей ≥ 2 сета (П1(−1.5)), p2_cover — то же для П2. Остальные исходы
выводятся: П2 = 1 − p1_win, П2(+1.5) = 1 − p1_cover, П1(+1.5) = 1 − p2_cover.
"""

from dataclasses import dataclass

from app.core.i18n import t

MARKET_ML = "ML"
MARKET_MINUS = "HCP_-1.5"
MARKET_PLUS = "HCP_+1.5"
MARKETS: tuple[str, ...] = (MARKET_ML, MARKET_MINUS, MARKET_PLUS)
BEST_OF: tuple[int, ...] = (3, 5)

# Точность s при бисекции
SET_TOLERANCE = 1e-12
_MAX_ITERATIONS = 200


def _check_best_of(best_of: int) -> None:
    if best_of not in BEST_OF:
        raise ValueError(t("ml.sets.best_of", best_of=best_of))


def _check_probability(value: float) -> None:
    if not 0.0 <= value <= 1.0:
        raise ValueError(t("ml.sets.bad_probability", p=value))


def match_prob_from_set(s: float, best_of: int) -> float:
    """Вероятность победы в матче при вероятности s выиграть сет."""
    _check_best_of(best_of)
    _check_probability(s)
    if best_of == 3:
        return s * s * (3.0 - 2.0 * s)
    return s**3 * (10.0 - 15.0 * s + 6.0 * s * s)


def set_prob_from_match(p: float, best_of: int) -> float:
    """Вероятность выиграть сет, при которой вероятность победы в матче равна p
    (обратная к match_prob_from_set, бисекция)."""
    _check_best_of(best_of)
    _check_probability(p)
    if p in (0.0, 1.0):
        return p
    low, high = 0.0, 1.0
    for _ in range(_MAX_ITERATIONS):
        middle = (low + high) / 2.0
        if match_prob_from_set(middle, best_of) < p:
            low = middle
        else:
            high = middle
        if high - low <= SET_TOLERANCE:
            break
    return (low + high) / 2.0


def cover_prob(s: float, best_of: int) -> float:
    """Вероятность выиграть матч с разницей не меньше 2 сетов (фора −1.5) при
    вероятности s выиграть сет: s² до двух побед; s³ + 3s³(1 − s) до трех."""
    _check_best_of(best_of)
    _check_probability(s)
    if best_of == 3:
        return s * s
    return s**3 + 3.0 * s**3 * (1.0 - s)


@dataclass(frozen=True)
class Probs3:
    """Три числа матча, из которых выводятся все шесть исходов (см. docstring модуля)."""

    p1_win: float
    p1_cover: float
    p2_cover: float

    def as_dict(self) -> dict[str, float]:
        return {"p1_win": self.p1_win, "p1_cover": self.p1_cover, "p2_cover": self.p2_cover}

    def markets(self) -> dict[tuple[str, int], float]:
        return market_probs(self.p1_win, self.p1_cover, self.p2_cover)

    def shown(self) -> "Probs3":
        """Числа, как их видит Claude в досье (SHOWN_DIGITS знаков): с ними сравнивается
        его ответ (расхождение больше 8 п.п.), иначе правило промпта и проверка кода
        расходятся на округлении."""
        return Probs3(
            round(self.p1_win, SHOWN_DIGITS),
            round(self.p1_cover, SHOWN_DIGITS),
            round(self.p2_cover, SHOWN_DIGITS),
        )


PROBS3_FIELDS: tuple[str, ...] = ("p1_win", "p1_cover", "p2_cover")
# Знаков после запятой у вероятностей в досье (app/services/dossier.py)
SHOWN_DIGITS = 3


def base_probs(p1_win: float, best_of: int) -> Probs3:
    """Три числа матча по модели сетов из вероятности победы игрока 1."""
    s = set_prob_from_match(p1_win, best_of)
    return Probs3(
        p1_win=p1_win,
        p1_cover=cover_prob(s, best_of),
        p2_cover=cover_prob(1.0 - s, best_of),
    )


def market_probs(p1_win: float, p1_cover: float, p2_cover: float) -> dict[tuple[str, int], float]:
    """Вероятности всех исходов: (рынок, selection) → p. selection 1 — ставка на игрока 1,
    2 — на игрока 2."""
    return {
        (MARKET_ML, 1): p1_win,
        (MARKET_ML, 2): 1.0 - p1_win,
        (MARKET_MINUS, 1): p1_cover,
        (MARKET_MINUS, 2): p2_cover,
        (MARKET_PLUS, 1): 1.0 - p2_cover,
        (MARKET_PLUS, 2): 1.0 - p1_cover,
    }
