"""Схемы рынков (Р28): статус семейств и общий счетчик «для сравнения» (GET /markets),
перевод семейства в экспресс администратором (PUT /admin/markets/{family}).

ROI и CLV — доли (0.042 = 4,2%), с 95% ДИ (low, high). Тексты — ключами локали фронтенда.
"""

from pydantic import BaseModel

from app.schemas.analyses import MarketFamily, MarketStatus, ModelState


class MarketFamilyOut(BaseModel):
    """Семейство рынков: status — express (идет в экспресс), suspended (на проверке, рынки
    — suspended_markets), compare («для сравнения»). promoted — администратор перевел
    новое семейство в экспресс. has_model — есть вероятность модели; model_state — ok,
    failed (модель семейства не прошла проверку на истории: вероятности нет, в экспресс
    нельзя) или none (модели нет). events — события (исход с кэфом из ввода и известным
    итогом матча, общий счетчик всех участников); roi — как ординары на равную сумму по
    кэфам из ввода; clv — средний CLV по закрытию, которое внесли участники, clv_n —
    событий с закрытием. ROI показывается от private_min событий, CLV — от private_min
    значений с закрытием (счетчик общий: иначе по одной ставке видно чужой кэф), до того —
    null. ready — порог пройден у
    семейства «для сравнения» с вероятностью модели (событий ≥ need, с закрытием ≥
    clv_need и нижняя граница ДИ CLV выше нуля), can_promote — кнопка «Перевести в
    экспресс» доступна. Числа семейств могут отставать от ставок до 10 минут (кэш)."""

    family: MarketFamily
    status: MarketStatus
    suspended_markets: list[str]
    has_model: bool
    model_state: ModelState
    promoted: bool
    events: int
    roi: float | None
    roi_low: float | None
    roi_high: float | None
    clv: float | None
    clv_low: float | None
    clv_high: float | None
    clv_n: int
    ready: bool
    can_promote: bool


class MarketsOut(BaseModel):
    """Рынки по семействам (порядок экрана: ml, h15, shcp, stot, ghcp, gtot). need — порог
    событий (150), need_max — верхняя граница диапазона решения (200), clv_need — сколько
    из них нужно с закрытием (50), private_min — с какого числа значений видны ROI и CLV
    семейства (10)."""

    need: int
    need_max: int
    clv_need: int
    private_min: int
    families: list[MarketFamilyOut]


class MarketExpressIn(BaseModel):
    """express true — перевести семейство в экспресс, false — вернуть «для сравнения»."""

    express: bool
