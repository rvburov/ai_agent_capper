"""Настройки программы (app_settings, одна строка id = 1): чтение, «Администрирование →
Настройки» (часовой пояс по умолчанию) и смена валюты программы (Р17, Т30).

Строку создает миграция, поэтому она есть всегда. Меняют настройки кабинет
администратора и команды терминала.

Смена валюты — одна транзакция под исключительной блокировкой CURRENCY_LOCK: расчет,
сторно, закрытие, движение банка, ставка, смена лимитов и запуск анализа берут ее
разделяемо (bank.lock_member_money), поэтому ни одна сумма не запишется в старой валюте
после смены. Форма, открытая до смены, присылает валюту, в которой участник видел суммы
(currency): не та — 409 common.currency_changed (check_currency), форма перечитывает данные.

Пересчитываются по курсу все суммы всех участников: ставки (stake, profit), журнал банка,
лимиты ответственной игры (и ждущая сумма), банк из ввода анализа (bank_input и
confirmed.bank — его берет воркер), рекомендация готового анализа (result.express.stake
и суммы вариантов ставки result.variants[].stake_calc, Р29: банк по курсу, сумма — заново
по округлению стратегии в новой валюте) и суммы
предупреждения «банк из ввода не равен учету». Каждая сумма округляется до копеек
отдельно, половина — от нуля (как ROUND_HALF_UP в Decimal и round в PostgreSQL). Сумма,
которая округлилась бы до нуля, становится ±0,01: журнал и ставки нулевых сумм не
допускают. Остаток от округления строк журнала — одна корректировка участнику
(«Округление при смене валюты»): банк после смены равен round(старый банк × курс), и
выведенный в ноль банк не уходит в минус. Расходы на Claude остаются в долларах. Курс,
автор и итоги — в журнале администратора (currency_change), кэш аналитики всех участников
удаляется.

Сумм участников администратор не видит (Р14): отказ «сумма не поместится» — без суммы.
"""

from collections.abc import Mapping
from dataclasses import dataclass
from decimal import ROUND_FLOOR, ROUND_HALF_UP, Decimal, localcontext
from typing import Any

import structlog
from redis.asyncio import Redis
from sqlalchemy import (
    ColumnElement,
    Numeric,
    Text,
    bindparam,
    case,
    cast,
    func,
    literal,
    or_,
    select,
    update,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, array
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.core.errors import AppError
from app.core.i18n import t
from app.core.redis import redis_key
from app.db.models import (
    AdminAuditLog,
    Analysis,
    AppSettings,
    BankrollLedger,
    Bet,
    PlayLimit,
    StrategyVersion,
    User,
)
from app.ml.markets import NEW_FAMILIES
from app.ml.strategy import StrategyParams
from app.schemas.admin_settings import (
    AdminSettingsOut,
    CurrencyChangeOut,
    CurrencyPreviewOut,
    MoneyChangeOut,
)

log = structlog.get_logger(__name__)

SETTINGS_ROW_ID = 1
MONEY_MAX = Decimal("9999999999.99")
_CENT = Decimal("0.01")
# Примеры «до и после» в окне смены (в прежней валюте)
SAMPLE_AMOUNTS = (Decimal(100), Decimal(1000), Decimal(10000))
# Ключи кэша аналитики: redis_key("analytics", <участник>, ...) (app/services/analytics_cache.py)
_ANALYTICS_PATTERN = "analytics:*"
_SCAN_COUNT = 500
# Предупреждение анализа с суммами банка (app/services/analysis_result.py, _bank)
BANK_DIFFERS = "analysis.warnings.bank_differs"


def express_families(settings: AppSettings) -> tuple[str, ...]:
    """Семейства новых рынков Р28, которые администратор перевел в экспресс."""
    return tuple(family for family in settings.express_markets or () if family in NEW_FAMILIES)


async def get_app_settings(db: AsyncSession) -> AppSettings:
    row = await db.get(AppSettings, SETTINGS_ROW_ID)
    if row is None:
        raise RuntimeError("app_settings: нет строки id = 1, примените миграции")
    return row


def check_currency(settings: AppSettings, given: str | None) -> None:
    """Форма прислала валюту, в которой участник видел суммы. Не валюта программы —
    валюту сменили, пока форма была открыта: 409 common.currency_changed (сумма в старой
    валюте не запишется как новая). None — форма валюту не прислала. Вызывать под
    разделяемой CURRENCY_LOCK (bank.lock_member_money), иначе смена пройдет между
    проверкой и записью."""
    if given is not None and given != settings.currency:
        raise AppError(409, "common.currency_changed", currency=settings.currency)


async def locked_settings(db: AsyncSession) -> AppSettings:
    """Строка настроек под FOR UPDATE (смена настроек одной транзакцией)."""
    return await _locked_settings(db)


async def _locked_settings(db: AsyncSession) -> AppSettings:
    row = await db.scalar(
        select(AppSettings)
        .where(AppSettings.id == SETTINGS_ROW_ID)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if row is None:
        raise RuntimeError("app_settings: нет строки id = 1, примените миграции")
    return row


# --- настройки для кабинета администратора ---


async def _last_currency_change(db: AsyncSession) -> CurrencyChangeOut | None:
    from app.services.access_codes import person_name

    actor = aliased(User)
    row = (
        await db.execute(
            select(AdminAuditLog, actor.display_name, actor.status)
            .outerjoin(actor, actor.id == AdminAuditLog.actor_id)
            .where(AdminAuditLog.action == "currency_change")
            .order_by(AdminAuditLog.id.desc())
            .limit(1)
        )
    ).first()
    if row is None:
        return None
    entry, name, status = row
    details = entry.details or {}
    try:
        return CurrencyChangeOut(
            at=entry.at,
            actor_name=person_name(entry.actor_id, name, status) or None,
            from_currency=details["from"],
            to_currency=details["to"],
            rate=Decimal(str(details["rate"])),
            rate_base=details["rate_base"],
        )
    except (KeyError, ValueError, ArithmeticError):
        return None


async def admin_settings(db: AsyncSession) -> AdminSettingsOut:
    row = await db.get_one(AppSettings, SETTINGS_ROW_ID, populate_existing=True)
    return AdminSettingsOut(
        currency=row.currency,  # type: ignore[arg-type]
        default_tz=row.default_tz,
        currency_changed=await _last_currency_change(db),
        updated_at=row.updated_at,
    )


async def update_settings(
    db: AsyncSession, *, default_tz: str, actor: User, ip: str | None = None
) -> AdminSettingsOut:
    """Часовой пояс по умолчанию для новых участников (у зарегистрированных свой).
    Смена — в журнале (settings_change, {field, from, to}); тот же пояс — без записи.
    Делает commit."""
    from app.services.audit import write_audit

    row = await _locked_settings(db)
    if row.default_tz != default_tz:
        previous = row.default_tz
        row.default_tz = default_tz
        row.updated_by = actor.id
        await write_audit(
            db,
            action="settings_change",
            actor_id=actor.id,
            details={"field": "default_tz", "from": previous, "to": default_tz},
            ip=ip,
        )
        await db.commit()
        log.info("settings.default_tz", actor_id=actor.id, before=previous, after=default_tz)
    else:
        await db.commit()
    return await admin_settings(db)


# --- смена валюты ---


@dataclass(frozen=True)
class Rate:
    """Курс смены: 1 base = rate второй валюты. factor — множитель для сумм (только для
    показа: суммы считаются умножением или делением на rate, без промежуточного
    округления множителя)."""

    old: str
    new: str
    rate: Decimal
    base: str

    @property
    def multiply(self) -> bool:
        return self.base == self.old

    @property
    def factor(self) -> Decimal:
        with localcontext() as ctx:
            ctx.prec = 28
            return self.rate if self.multiply else Decimal(1) / self.rate

    def convert(self, amount: Decimal) -> Decimal:
        """Одна сумма в новой валюте — как в SQL (_convert_sql)."""
        with localcontext() as ctx:
            ctx.prec = 40
            raw = amount * self.rate if self.multiply else amount / self.rate
            value = raw.quantize(_CENT, rounding=ROUND_HALF_UP)
        if value == 0 and amount != 0:
            return _CENT if amount > 0 else -_CENT
        return value


def _round_sql(value: Any, rate: Rate) -> ColumnElement[Any]:
    """round(x × курс, 2) или round(x ÷ курс, 2) в SQL, половина — от нуля."""
    factor = cast(literal(rate.rate), Numeric(18, 8))
    raw = value * factor if rate.multiply else value / factor
    return func.round(cast(raw, Numeric), 2)


def _convert_sql(column: Any, rate: Rate) -> ColumnElement[Any]:
    """Сумма в новой валюте в SQL (как Rate.convert): round(x × курс, 2) или
    round(x ÷ курс, 2); до нуля не округляется — ±0,01."""
    rounded = _round_sql(column, rate)
    return case(
        (rounded == 0, func.sign(column) * literal(_CENT)),
        else_=rounded,
    )


async def _max_abs(db: AsyncSession, column: Any) -> Decimal:
    found = await db.scalar(select(func.max(func.abs(column))))
    return Decimal(found or 0)


async def _overflows(db: AsyncSession, rate: Rate) -> bool:
    """Самая большая сумма в новой валюте не помещается в NUMERIC(12, 2). Ответ — только да
    или нет, без самой суммы: это деньги участника, а их администратор не видит (Р14)."""
    for column in (
        Bet.stake,
        Bet.profit,
        BankrollLedger.amount,
        PlayLimit.stake_per_day,
        PlayLimit.pending_stake_per_day,
        Analysis.bank_input,
    ):
        biggest = await _max_abs(db, column)
        if biggest and rate.convert(biggest) > MONEY_MAX:
            return True
    return False


async def _check_overflow(db: AsyncSession, rate: Rate) -> None:
    if await _overflows(db, rate):
        raise AppError(409, "admin.currency_overflow")


def _stake_currency() -> ColumnElement[Any]:
    """Валюта рекомендации готового анализа (result.express.stake.currency)."""
    path: ColumnElement[Any] = Analysis.result[("express", "stake", "currency")].astext
    return path


def _variants_currency() -> ColumnElement[Any]:
    """Валюта сумм вариантов ставки (result.variants[0].stake_calc.currency, Р29): у всех
    вариантов анализа она одна."""
    path: ColumnElement[Any] = Analysis.result[("variants", "0", "stake_calc", "currency")].astext
    return path


def _has_bank_warning() -> ColumnElement[bool]:
    return Analysis.result["warnings"].contains([{"key": BANK_DIFFERS}])


def _analyses_to_convert(rate: Rate) -> ColumnElement[bool]:
    """Анализы с суммами: банк из ввода (колонка и confirmed.bank), рекомендация в прежней
    валюте, предупреждение с банком."""
    return or_(
        Analysis.bank_input.is_not(None),
        Analysis.confirmed["bank"].astext.is_not(None),
        _stake_currency() == rate.old,
        _variants_currency() == rate.old,
        _has_bank_warning(),
    )


async def _corrections(db: AsyncSession, rate: Rate) -> list[tuple[int, Decimal]]:
    """Остаток от округления строк журнала у каждого участника: round(банк × курс) минус
    сумма пересчитанных строк. Не ноль — одна корректировка при смене."""
    rows = await db.execute(
        select(
            BankrollLedger.user_id,
            _round_sql(func.sum(BankrollLedger.amount), rate)
            - func.sum(_convert_sql(BankrollLedger.amount, rate)),
        )
        .group_by(BankrollLedger.user_id)
        .order_by(BankrollLedger.user_id)
    )
    return [(int(user_id), Decimal(diff)) for user_id, diff in rows if diff]


async def _counts(db: AsyncSession, rate: Rate, *, corrections: int) -> dict[str, int]:
    async def count(stmt: Any) -> int:
        return int(await db.scalar(stmt) or 0)

    return {
        "bets": await count(select(func.count()).select_from(Bet)),
        "ledger_entries": await count(select(func.count()).select_from(BankrollLedger)),
        "play_limits": await count(
            select(func.count())
            .select_from(PlayLimit)
            .where(
                (PlayLimit.stake_per_day.is_not(None))
                | (PlayLimit.pending_stake_per_day.is_not(None))
            )
        ),
        "analyses": await count(
            select(func.count()).select_from(Analysis).where(_analyses_to_convert(rate))
        ),
        "members": await count(
            select(func.count(func.distinct(BankrollLedger.user_id))).select_from(BankrollLedger)
        ),
        "corrections": corrections,
    }


async def _own_bank(db: AsyncSession, user_id: int, rate: Rate) -> MoneyChangeOut | None:
    """Банк администратора с учетом ставок в игре: сейчас и после смены (те же формулы,
    что при записи: банк — round(журнал × курс), ставки в игре — каждая отдельно)."""
    ledger = (
        await db.execute(
            select(
                func.count(),
                func.coalesce(func.sum(BankrollLedger.amount), 0),
                func.coalesce(_round_sql(func.sum(BankrollLedger.amount), rate), 0),
            ).where(BankrollLedger.user_id == user_id)
        )
    ).one()
    if not ledger[0]:
        return None
    open_bets = (
        await db.execute(
            select(
                func.coalesce(func.sum(Bet.stake), 0),
                func.coalesce(func.sum(_convert_sql(Bet.stake, rate)), 0),
            ).where(Bet.user_id == user_id, Bet.status == "open")
        )
    ).one()
    return MoneyChangeOut(
        before=Decimal(ledger[1]) + Decimal(open_bets[0]),
        after=Decimal(ledger[2]) + Decimal(open_bets[1]),
    )


def _rate(settings: AppSettings, currency: str, rate: Decimal, base: str) -> Rate:
    if currency == settings.currency:
        raise AppError(409, "admin.currency_same", currency=currency)
    if base not in (settings.currency, currency):
        raise AppError(422, "admin.currency_rate_base", base=base)
    return Rate(old=settings.currency, new=currency, rate=rate, base=base)


def _preview_out(
    rate: Rate,
    counts: dict[str, int],
    own_bank: MoneyChangeOut | None,
    *,
    applied: bool,
    overflow: bool = False,
) -> CurrencyPreviewOut:
    return CurrencyPreviewOut(
        applied=applied,
        overflow=overflow,
        from_currency=rate.old,  # type: ignore[arg-type]
        to_currency=rate.new,  # type: ignore[arg-type]
        rate=rate.rate,
        rate_base=rate.base,  # type: ignore[arg-type]
        factor=rate.factor.quantize(Decimal("0.00000001")),
        own_bank=own_bank,
        samples=[MoneyChangeOut(before=x, after=rate.convert(x)) for x in SAMPLE_AMOUNTS],
        **counts,
    )


# --- рекомендация готового анализа в новой валюте ---

_ROUND_STEPS = ("round", "below_min")


def _round_stake(
    bank: Decimal, pct: Decimal, currency: str, params: StrategyParams
) -> tuple[Decimal | None, str | None, list[dict[str, Any]]]:
    """Сумма от банка и доли — как последние шаги strategy.stake: вниз до шага округления
    валюты, меньше минимальной ставки — без суммы. Доля от валюты не зависит."""
    if currency not in params.rounding or currency not in params.min_stake:
        return None, "currency", []
    if bank <= 0:
        return None, "no_bank", []
    step = params.rounding[currency]
    raw = bank * pct
    amount = ((raw / step).to_integral_value(rounding=ROUND_FLOOR) * step).quantize(_CENT)
    steps: list[dict[str, Any]] = [
        {
            "kind": "round",
            "pct": str(pct),
            "params": {
                "bank": str(bank),
                "raw": str(raw.quantize(_CENT)),
                "step": str(step),
                "amount": str(amount),
            },
        }
    ]
    minimum = params.min_stake[currency]
    if amount < minimum:
        steps.append(
            {
                "kind": "below_min",
                "pct": str(pct),
                "params": {"min": str(minimum), "amount": str(amount)},
            }
        )
        return None, "below_min", steps
    return amount, None, steps


def converted_stake(stake: Mapping[str, Any], rate: Rate, params: StrategyParams) -> dict[str, Any]:
    """Рекомендация анализа (result.express.stake) в новой валюте: банк — по курсу, как
    bank_input; сумма — заново от банка и той же доли с округлением новой валюты (не
    курс × прежняя сумма: шаг и минимум у валют свои). Остальное — как было."""
    out = dict(stake)
    out["currency"] = rate.new
    bank = rate.convert(Decimal(str(stake.get("bank") or 0)))
    out["bank"] = str(bank)
    if stake.get("reason") in (None, "below_min"):
        pct = Decimal(str(stake.get("pct") or 0))
        amount, reason, steps = _round_stake(bank, pct, rate.new, params)
        kept = [
            step
            for step in stake.get("steps") or []
            if not (isinstance(step, Mapping) and step.get("kind") in _ROUND_STEPS)
        ]
        out["amount"] = str(amount) if amount is not None else None
        out["reason"] = reason
        out["steps"] = kept + steps
    elif stake.get("amount") is not None:
        out["amount"] = str(rate.convert(Decimal(str(stake["amount"]))))
    return out


def converted_variants(variants: list[Any], rate: Rate, params: StrategyParams) -> list[Any] | None:
    """Суммы вариантов ставки (Р29) в новой валюте — как рекомендация экспресса
    (converted_stake): stake_calc заново, stake — его сумма. None — пересчитывать нечего."""
    out: list[Any] = []
    changed = False
    for item in variants:
        calc = item.get("stake_calc") if isinstance(item, Mapping) else None
        if isinstance(calc, Mapping) and calc.get("currency") == rate.old:
            new_calc = converted_stake(calc, rate, params)
            out.append({**item, "stake_calc": new_calc, "stake": new_calc.get("amount")})
            changed = True
        else:
            out.append(item)
    return out if changed else None


def _converted_warnings(warnings: list[Any], rate: Rate) -> list[Any] | None:
    """Суммы предупреждения «банк из ввода не равен учету» в новой валюте. None — таких
    предупреждений нет."""
    out: list[Any] = []
    changed = False
    for item in warnings:
        if isinstance(item, Mapping) and item.get("key") == BANK_DIFFERS:
            params = dict(item.get("params") or {})
            for name in ("input", "ledger"):
                if params.get(name) is not None:
                    params[name] = str(rate.convert(Decimal(str(params[name]))))
            out.append({**item, "params": params})
            changed = True
        else:
            out.append(item)
    return out if changed else None


def _path(*keys: str) -> ColumnElement[Any]:
    return cast(array(list(keys)), ARRAY(Text))


async def _convert_results(db: AsyncSession, rate: Rate) -> None:
    """Рекомендации и предупреждения готовых анализов, строки — под блокировкой. Воркер,
    который как раз записывает итог, держит разделяемую CURRENCY_LOCK (analysis_run,
    шаг compose): смена начинается после его commit, и итог тоже пересчитается."""
    from app.services.strategy_versions import params_of

    rows = (
        await db.execute(
            select(
                Analysis.id,
                Analysis.strategy_version_id,
                Analysis.result[("express", "stake")],
                Analysis.result["warnings"],
                Analysis.result["variants"],
            )
            .where(
                or_(
                    _stake_currency() == rate.old,
                    _variants_currency() == rate.old,
                    _has_bank_warning(),
                )
            )
            .order_by(Analysis.id)
            .with_for_update(of=Analysis)
        )
    ).all()
    params: dict[int | None, StrategyParams] = {}
    for analysis_id, version_id, stake, warnings, variants in rows:
        value: Any = Analysis.result
        changed = False
        if version_id not in params:
            version = await db.get(StrategyVersion, version_id) if version_id is not None else None
            params[version_id] = params_of(version)
        if isinstance(stake, Mapping) and stake.get("currency") == rate.old:
            new_stake = converted_stake(stake, rate, params[version_id])
            value = func.jsonb_set(
                value, _path("express", "stake"), bindparam(None, new_stake, type_=JSONB)
            )
            changed = True
        if isinstance(variants, list):
            new_variants = converted_variants(variants, rate, params[version_id])
            if new_variants is not None:
                value = func.jsonb_set(
                    value, _path("variants"), bindparam(None, new_variants, type_=JSONB)
                )
                changed = True
        if isinstance(warnings, list):
            new_warnings = _converted_warnings(warnings, rate)
            if new_warnings is not None:
                value = func.jsonb_set(
                    value, _path("warnings"), bindparam(None, new_warnings, type_=JSONB)
                )
                changed = True
        if changed:
            await db.execute(
                update(Analysis)
                .where(Analysis.id == analysis_id)
                .values(result=value)
                .execution_options(synchronize_session=False)
            )


async def _apply(db: AsyncSession, rate: Rate, corrections: list[tuple[int, Decimal]]) -> None:
    """Пересчет всех сумм (UPDATE в той же транзакции) и корректировки округления."""
    new = rate.new
    await db.execute(
        update(Bet).values(
            stake=_convert_sql(Bet.stake, rate),
            profit=case((Bet.profit.is_(None), None), else_=_convert_sql(Bet.profit, rate)),
            currency=new,
        )
    )
    await db.execute(
        update(BankrollLedger).values(
            amount=_convert_sql(BankrollLedger.amount, rate), currency=new
        )
    )
    # После пересчета строк, иначе корректировку пересчитало бы тоже
    note = t("bets.currency_rounding")
    db.add_all(
        BankrollLedger(user_id=user_id, kind="correction", amount=diff, currency=new, note=note)
        for user_id, diff in corrections
    )
    await db.flush()
    await db.execute(
        update(PlayLimit)
        .where(
            (PlayLimit.stake_per_day.is_not(None)) | (PlayLimit.pending_stake_per_day.is_not(None))
        )
        .values(
            stake_per_day=case(
                (PlayLimit.stake_per_day.is_(None), None),
                else_=_convert_sql(PlayLimit.stake_per_day, rate),
            ),
            pending_stake_per_day=case(
                (PlayLimit.pending_stake_per_day.is_(None), None),
                else_=_convert_sql(PlayLimit.pending_stake_per_day, rate),
            ),
            currency=new,
        )
    )
    await db.execute(
        update(Analysis)
        .where(Analysis.bank_input.is_not(None))
        .values(bank_input=_convert_sql(Analysis.bank_input, rate))
        .execution_options(synchronize_session=False)
    )
    # Банк подтвержденного ввода: из него считает сумму воркер (анализ в очереди и
    # перезапуск после сбоя). Та же формула, что у bank_input
    bank_text = Analysis.confirmed["bank"].astext
    await db.execute(
        update(Analysis)
        .where(bank_text.is_not(None))
        .values(
            confirmed=func.jsonb_set(
                Analysis.confirmed,
                _path("bank"),
                func.to_jsonb(cast(_convert_sql(cast(bank_text, Numeric), rate), Text)),
            )
        )
        .execution_options(synchronize_session=False)
    )
    await _convert_results(db, rate)


async def _clear_analytics_cache(redis: Redis) -> int:
    """Кэш аналитики и главной всех участников: суммы в нем — в прежней валюте."""
    removed = 0
    batch: list[str] = []
    async for key in redis.scan_iter(match=redis_key(_ANALYTICS_PATTERN), count=_SCAN_COUNT):
        batch.append(str(key))
        if len(batch) >= _SCAN_COUNT:
            removed += int(await redis.delete(*batch))
            batch = []
    if batch:
        removed += int(await redis.delete(*batch))
    return removed


async def change_currency(
    db: AsyncSession,
    redis: Redis,
    *,
    from_currency: str,
    currency: str,
    rate: Decimal,
    rate_base: str,
    actor: User,
    preview: bool,
    confirm: Any,
    ip: str | None,
) -> CurrencyPreviewOut:
    """Смена валюты программы (Т30). preview — только итоги «что станет», без записи и
    без кода 2FA; сумма, которая не поместится, — признак overflow, а не отказ. Иначе:
    код 2FA администратора (admin_confirm, неверный — 403, действие не выполняется),
    исключительная блокировка CURRENCY_LOCK, пересчет, журнал currency_change, commit,
    сброс кэша аналитики. from_currency (валюта, от которой считало окно) не валюта
    программы — 409 common.currency_changed до кода 2FA и еще раз под блокировкой: курс
    чужой пары не применяется. Та же валюта — 409 admin.currency_same,
    курс не к прежней или новой валюте — 422 admin.currency_rate_base, сумма не
    помещается в NUMERIC(12, 2) — 409 admin.currency_overflow (без суммы, Р14)."""
    from app.services.admin_confirm import check_totp
    from app.services.audit import write_audit
    from app.services.bank import CURRENCY_LOCK

    settings = await get_app_settings(db)
    check_currency(settings, from_currency)
    found = _rate(settings, currency, rate, rate_base)
    if preview:
        overflow = await _overflows(db, found)
        corrections = await _corrections(db, found)
        out = _preview_out(
            found,
            await _counts(db, found, corrections=len(corrections)),
            await _own_bank(db, actor.id, found),
            applied=False,
            overflow=overflow,
        )
        await db.rollback()
        return out
    await check_totp(db, actor, confirm, action="currency_change")
    # Ставки, расчеты, движение банка и запуск анализа ждут конца смены (их блокировка —
    # разделяемая)
    await db.execute(select(func.pg_advisory_xact_lock(CURRENCY_LOCK)))
    settings = await _locked_settings(db)
    check_currency(settings, from_currency)
    found = _rate(settings, currency, rate, rate_base)
    await _check_overflow(db, found)
    corrections = await _corrections(db, found)
    counts = await _counts(db, found, corrections=len(corrections))
    own_bank = await _own_bank(db, actor.id, found)
    await _apply(db, found, corrections)
    settings.currency = found.new
    settings.updated_by = actor.id
    await write_audit(
        db,
        action="currency_change",
        actor_id=actor.id,
        details={
            "from": found.old,
            "to": found.new,
            "rate": str(found.rate),
            "rate_base": found.base,
            "factor": str(found.factor.quantize(Decimal("0.00000001"))),
            **counts,
        },
        ip=ip,
    )
    await db.commit()
    removed = await _clear_analytics_cache(redis)
    log.info(
        "settings.currency_changed",
        actor_id=actor.id,
        before=found.old,
        after=found.new,
        cache_removed=removed,
    )
    return _preview_out(found, counts, own_bank, applied=True)
