"""Настройки агента: модели, effort, лимиты токенов и поиска, таймауты, оценки стоимости;
еще потолок анализа новых участников по умолчанию (своей колонки в app_settings нет).

Значения по умолчанию — в AgentConfig (код). Администратор меняет их командой терминала
agent-config (app/admin/cli.py), измененные значения лежат в app_settings.agent_config.
Неизвестное имя или неверное значение — ошибка при сохранении. При чтении такие ключи
пропускаются (с записью в лог): после обновления кода старые настройки не роняют анализ.
"""

from collections.abc import Mapping, Sequence
from decimal import Decimal
from typing import Annotated, Any, Literal, get_origin

import structlog
from pydantic import (
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    StringConstraints,
    ValidationError,
)
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.db.models import AppSettings
from app.services.app_settings import SETTINGS_ROW_ID, get_app_settings
from app.services.audit import write_audit

log = structlog.get_logger(__name__)

Effort = Literal["low", "medium", "high", "xhigh", "max"]
# Идентификатор модели без даты: claude-opus-5-5
ModelId = Annotated[str, StringConstraints(pattern=r"^claude-[a-z0-9-]{1,56}$")]


def _normalize_domain(value: Any) -> Any:
    return value.strip().lower() if isinstance(value, str) else value


# Домен для allowed_domains веб-поиска: без схемы, только ASCII, путь — по желанию
Domain = Annotated[
    str,
    BeforeValidator(_normalize_domain),
    StringConstraints(max_length=253, pattern=r"^[a-z0-9-]+(\.[a-z0-9-]+)+(/[a-z0-9._~/*-]*)?$"),
]

DEFAULT_NEWS_DOMAINS = (
    "atptour.com",
    "ausopen.com",
    "rolandgarros.com",
    "wimbledon.com",
    "usopen.org",
    "tennis.com",
    "tennismajors.com",
    "espn.com",
)
# bbc.com, reuters.com и apnews.com закрыты для робота Anthropic: запрос поиска с ними
# отклоняется целиком (400, проверено на живом API 12 октября 2026)


class AgentConfig(BaseModel):
    """Настройки шагов агента. Время — в секундах, деньги считаются по model_prices.

    news_domains пустой — поиск без ограничения доменов. estimate_* — оценка одного
    вызова для резерва бюджета и проверки лимитов до запуска анализа.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    # Разбор введенного текста
    parse_model: ModelId = "claude-haiku-5-5"
    parse_effort: Effort = "low"
    parse_max_tokens: int = Field(default=4096, ge=256, le=64000)
    parse_timeout_s: int = Field(default=60, ge=5, le=600)
    # Новости и свежие результаты (веб-поиск)
    news_enabled: bool = True
    news_model: ModelId = "claude-sonnet-5-5"
    news_effort: Effort = "low"
    news_max_tokens: int = Field(default=8000, ge=256, le=64000)
    news_timeout_s: int = Field(default=180, ge=5, le=600)
    # Один поиск на игрока: запрос новостей идет на матч, в нем два игрока
    news_max_uses: int = Field(default=2, ge=1, le=10)
    news_max_searches_per_analysis: int = Field(default=6, ge=0, le=100)
    news_max_searches_per_day: int = Field(default=30, ge=0, le=1000)
    news_ttl_hours: int = Field(default=12, ge=1, le=168)
    news_lookback_days: int = Field(default=14, ge=1, le=90)
    news_max_pause_continuations: int = Field(default=3, ge=0, le=10)
    news_domains: tuple[Domain, ...] = DEFAULT_NEWS_DOMAINS
    # Варианты для сравнения на живом ключе (agent-smoke --only news), качество не
    # проверено. news_dynamic_filtering — поиск с фильтрацией результатов кодом на стороне
    # Anthropic (у web_search не задается allowed_callers): нужна модель с programmatic
    # tool calling. news_prompt_cache — точка кэша на system шага новостей; с ней сервер
    # сам пишет в кэш результаты поиска (TOKEN_ECONOMY.md, 4.8)
    news_dynamic_filtering: bool = False
    news_prompt_cache: bool = True
    # Анализ матча
    analysis_model: ModelId = "claude-opus-5-5"
    analysis_effort: Effort = "medium"
    analysis_max_tokens: int = Field(default=16000, ge=1024, le=128000)
    # Меньше этого max_tokens вызов оценки не урезается, когда остатка потолка или лимита
    # не хватает на весь analysis_max_tokens (app/services/ai_access.py, fit_call)
    analysis_min_tokens: int = Field(default=6000, ge=1024, le=128000)
    analysis_stream_timeout_s: int = Field(default=120, ge=10, le=600)
    analysis_step_timeout_s: int = Field(default=300, ge=30, le=900)
    analysis_max_iterations: int = Field(default=3, ge=1, le=5)
    analysis_parallel: int = Field(default=3, ge=1, le=5)
    assessment_reuse_hours: int = Field(default=6, ge=0, le=72)
    # Оценка стоимости до запуска
    estimate_analysis_input_tokens: int = Field(default=7000, ge=0, le=1_000_000)
    estimate_analysis_output_tokens: int = Field(default=4000, ge=0, le=128000)
    # Новости одного матча по живой проверке 12 октября 2026: весь вход запроса с двумя
    # поисками — 37 204 токена (262 без кэша, 32 444 запись, 4 498 чтение), выход 1 076
    estimate_news_input_tokens: int = Field(default=37000, ge=0, le=1_000_000)
    estimate_news_output_tokens: int = Field(default=1500, ge=0, le=64000)
    estimate_news_searches: int = Field(default=2, ge=0, le=100)
    # Потолок одного анализа по умолчанию для новых участников (на ключе администратора и
    # потолок своего ключа, Р13). Меняется в кабинете администратора («Лимиты по
    # умолчанию»); у зарегистрированных не меняется. Это не жесткий потолок программы
    # (app_settings.per_analysis_hard_usd): тот действует на анализы администратора.
    default_per_analysis_usd: Decimal = Field(
        default=Decimal(1), ge=Decimal("0.10"), le=500, max_digits=10, decimal_places=2
    )

    def models(self) -> tuple[str, ...]:
        """Модели, которые нужны анализу: их проверяет ключ участника и ищут цены."""
        used = [self.parse_model, self.analysis_model]
        if self.news_enabled:
            used.insert(1, self.news_model)
        return tuple(dict.fromkeys(used))


DEFAULT_CONFIG = AgentConfig()
SETTING_NAMES = tuple(AgentConfig.model_fields)


def config_from_overrides(raw: Mapping[str, Any]) -> AgentConfig:
    """Настройки из app_settings.agent_config поверх значений по умолчанию.
    Неизвестные имена и неверные значения пропускаются: анализ идет на значениях по
    умолчанию, а в лог пишется, что пропущено."""
    known = {name: value for name, value in raw.items() if name in AgentConfig.model_fields}
    unknown = sorted(set(raw) - set(known))
    if unknown:
        log.warning("agent_config.unknown_skipped", names=unknown)
    while True:
        try:
            return AgentConfig.model_validate(known)
        except ValidationError as exc:
            bad = {str(err["loc"][0]) for err in exc.errors() if err["loc"]}
            log.warning("agent_config.invalid_skipped", names=sorted(bad))
            if not bad & set(known):
                return DEFAULT_CONFIG
            known = {name: value for name, value in known.items() if name not in bad}


def default_per_analysis(settings: AppSettings) -> Decimal:
    """Потолок анализа по умолчанию для новых участников из настроек программы."""
    return config_from_overrides(settings.agent_config or {}).default_per_analysis_usd


async def load_agent_config(db: AsyncSession) -> AgentConfig:
    """Действующие настройки агента."""
    row = await get_app_settings(db)
    return config_from_overrides(row.agent_config or {})


def parse_setting(name: str, raw: str) -> Any:
    """Значение из командной строки: список — через запятую, остальное проверит
    AgentConfig при сохранении (числа и true/false из строки он понимает сам)."""
    field = AgentConfig.model_fields.get(name)
    if field is None:
        raise AppError(400, "agent_config.unknown", name=name)
    if get_origin(field.annotation) is tuple:
        return [part.strip() for part in raw.split(",") if part.strip()]
    return raw


def _effective(config: AgentConfig) -> dict[str, Any]:
    return config.model_dump(mode="json")


async def save_agent_config(
    db: AsyncSession,
    *,
    changes: Mapping[str, Any],
    reset: Sequence[str] = (),
    actor_id: int | None,
    ip: str | None = None,
) -> AgentConfig:
    """Меняет настройки агента: changes — новые значения, reset — вернуть к значениям по
    умолчанию. Неизвестное имя или неверное значение — AppError 400, ничего не меняется.
    Изменение пишется в журнал (agent_config_change: что было и что стало) одним commit."""
    row = await db.scalar(
        select(AppSettings)
        .where(AppSettings.id == SETTINGS_ROW_ID)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if row is None:
        raise AppError(500, "admin.settings_missing")
    for name in (*changes, *reset):
        if name not in AgentConfig.model_fields:
            raise AppError(400, "agent_config.unknown", name=name)
    stored = {k: v for k, v in (row.agent_config or {}).items() if k in AgentConfig.model_fields}
    before = config_from_overrides(stored)
    overrides = {k: v for k, v in stored.items() if k not in reset}
    overrides.update(changes)
    try:
        after = AgentConfig.model_validate(overrides)
    except ValidationError as exc:
        err = exc.errors()[0]
        name = str(err["loc"][0]) if err["loc"] else ""
        raise AppError(400, "agent_config.invalid", name=name) from None
    old, new = _effective(before), _effective(after)
    diff = {name: {"from": old[name], "to": new[name]} for name in new if old[name] != new[name]}
    row.agent_config = after.model_dump(mode="json", include=set(overrides))
    if diff:
        await write_audit(
            db,
            action="agent_config_change",
            actor_id=actor_id,
            details={"changes": diff},
            ip=ip,
        )
    await db.commit()
    return after
