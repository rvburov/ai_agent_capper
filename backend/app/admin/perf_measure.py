"""Замер времени ответа маршрутов этапов 4 и 5 на сиде (app/admin/perf_seed.py): p50, p95 и
максимум по каждому маршруту, сравнение с целью (PLAN.md, «Целевые показатели»).

Запросы идут в приложение в том же процессе (ASGI, без сети), время берется из записи
middleware времени ответа (app/core/timing.py: до последнего байта, без фоновых задач) —
так же, как его считает лог на сервере. Ключ строки отчета — метод и шаблон маршрута, у
вариантов — метка в скобках: cold — кэш аналитики пуст (расчет с нуля), dense — участник
с плотным месяцем вызовов Claude, admin — администратор, loop — легкий запрос, пока в
том же процессе идет холодный расчет «Аналитики» (держит ли расчет цикл событий).

Изменяющие маршруты замеряются парами, которые возвращают данные назад: расчет и сторно
одной ставки, закрывающий кэф и его стирание, букмекер добавлен и удален, согласие Р15
включено и выключено, запрос удаления аккаунта и его отмена, смена валюты туда и обратно
(курс 1: суммы после пары те же, а пересчитываются все строки, как при настоящей смене).
Пополнение банка на 1,00, сообщение и пауза на 1 день остаются (сид после замера не
нужен). Для подтверждений кодом 2FA замер сам включает 2FA администратору и участнику
сида и перед каждым кодом стирает шаг последнего принятого кода (только в базе сида:
код одного шага иначе принимается один раз за 30 с).

Цель маршрута — TARGETS (мс, p95), по умолчанию DEFAULT_TARGET. Замер не пройден, если
p95 выше цели × slack (в CI slack = 1,5: раннер медленнее).
"""

import asyncio
import json
import math
from collections import defaultdict
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import httpx
from fastapi import FastAPI
from redis.asyncio import Redis
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.admin.perf_seed import ADMIN_ID, DENSE_ID, MEMBER_ID, PERF_PASSWORD
from app.admin.terminal import table
from app.core import timing
from app.core.config import get_settings
from app.core.cookies import CSRF_HEADER, cookie_name
from app.core.i18n import t
from app.core.security import crypto
from app.core.security.tokens import new_token
from app.core.security.totp import code_at_step, current_step, new_totp_secret
from app.db.models import Bet, BetLeg, Bookmaker, Player, User
from app.services import analytics_cache
from app.services.sessions import create_session

BASE_URL = "http://perf.test"
COOKIE_DOMAIN = "perf.test"
USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) capper-perf"
DEFAULT_TARGET = 200
# Участники сида для изменений, которые не возвращаются назад или завершают сеансы:
# пауза, сообщение и согласие — OTHER_ID, удаление аккаунта и отмена — LEAVING_ID
OTHER_ID = 4
LEAVING_ID = 5
SAMPLES = 20
HEAVY_SAMPLES = 3
# Цели p95, мс (PLAN.md, «Целевые показатели»): чтение — 200; изменение — 300; холодный
# расчет «Аналитики» с фильтром и главной — 1 500; без фильтра за все время на 10 тыс.
# ставок — 5 000 (бутстрэп 10 000 пересэмплирований, Т15; обычно его заранее считает
# прогрев воркера после изменения данных и в полночь участника); выгрузки всех ставок и
# всех данных — 5 000 (файл отдается частями, первые байты приходят сразу); смена
# валюты — 5 000 (пересчет всех сумм всех участников под исключительной блокировкой: деньги
# участников ждут); запрос удаления аккаунта — 500 (проверка пароля Argon2id)
TARGETS: dict[str, int] = {
    "GET /api/analytics [cold]": 5000,
    "GET /api/analytics [filter cold]": 1500,
    "GET /api/dashboard [cold]": 1500,
    "GET /api/bets/export.csv": 5000,
    "GET /api/analytics/export.csv": 5000,
    "GET /api/analytics/export.zip": 5000,
    "GET /api/me/export [json]": 5000,
    "GET /api/me/export [csv]": 5000,
    "PUT /api/bets/{bet_id}/result": 300,
    "POST /api/bets/{bet_id}/reverse": 300,
    "PUT /api/bets/{bet_id}/legs/{leg_id}/closing": 300,
    "POST /api/me/bank/entries": 300,
    "PUT /api/me/notification-prefs": 300,
    "PUT /api/me/play-limits": 300,
    "POST /api/me/bookmakers": 300,
    "PATCH /api/me/bookmakers/{bookmaker_id}": 300,
    "DELETE /api/me/bookmakers/{bookmaker_id}": 300,
    "PUT /api/admin/settings": 300,
    "PUT /api/admin/settings/currency [preview]": 300,
    "PUT /api/admin/settings/currency": 5000,
    "POST /api/admin/messages [preview]": 300,
    "POST /api/admin/messages": 300,
    "PATCH /api/me": 300,
    "POST /api/me/pause": 300,
    "POST /api/me/deletion": 500,
    "DELETE /api/me/deletion": 300,
}


# --- статистика и отчет ---


def percentile(values: Sequence[float], share: float) -> float:
    """Перцентиль по ближайшему рангу: наименьшее значение, не меньше которого доля share
    всех значений (p95 из 20 значений — 19-е по возрастанию)."""
    if not values:
        raise ValueError("пустой ряд")
    ordered = sorted(values)
    rank = max(1, math.ceil(share * len(ordered)))
    return ordered[rank - 1]


@dataclass(frozen=True)
class RouteStat:
    key: str
    n: int
    p50: float
    p95: float
    max: float
    target: int
    slack: float

    @property
    def ok(self) -> bool:
        return self.p95 <= self.target * self.slack


def summarize(
    samples: dict[str, list[float]],
    *,
    targets: dict[str, int] | None = None,
    slack: float = 1.0,
) -> list[RouteStat]:
    """Строки отчета по ключам (в порядке ключа)."""
    goals = TARGETS if targets is None else targets
    return [
        RouteStat(
            key=key,
            n=len(values),
            p50=percentile(values, 0.5),
            p95=percentile(values, 0.95),
            max=max(values),
            target=goals.get(key, DEFAULT_TARGET),
            slack=slack,
        )
        for key, values in sorted(samples.items())
        if values
    ]


def _ms(value: float) -> str:
    return f"{value:.1f}"


def report_table(stats: Sequence[RouteStat]) -> str:
    """Таблица для терминала и лога CI."""
    header = [t(f"cli.perf.column.{name}") for name in _COLUMNS]
    rows = [
        [
            item.key,
            str(item.n),
            _ms(item.p50),
            _ms(item.p95),
            _ms(item.max),
            str(round(item.target * item.slack)),
            t("cli.perf.ok") if item.ok else t("cli.perf.over"),
        ]
        for item in stats
    ]
    return table(header, rows)


def report_markdown(stats: Sequence[RouteStat]) -> str:
    """Та же таблица в Markdown (для PLAN.md и сводки задания CI)."""
    header = [t(f"cli.perf.column.{name}") for name in _COLUMNS]
    lines = ["| " + " | ".join(header) + " |", "|" + "---|" * len(header)]
    for item in stats:
        cells = [
            f"`{item.key}`",
            str(item.n),
            _ms(item.p50),
            _ms(item.p95),
            _ms(item.max),
            str(round(item.target * item.slack)),
            t("cli.perf.ok") if item.ok else t("cli.perf.over"),
        ]
        lines.append("| " + " | ".join(cells) + " |")
    return "\n".join(lines)


def report_json(stats: Sequence[RouteStat]) -> str:
    return json.dumps(
        [
            {
                "key": item.key,
                "n": item.n,
                "p50": item.p50,
                "p95": item.p95,
                "max": item.max,
                "target": item.target,
                "limit": round(item.target * item.slack),
                "ok": item.ok,
            }
            for item in stats
        ],
        ensure_ascii=False,
        indent=2,
    )


_COLUMNS = ("route", "n", "p50", "p95", "max", "limit", "result")


# --- запросы ---


class PerfError(RuntimeError):
    """Запрос замера ответил не 2xx: замер неверен, а не медленный."""


@dataclass
class Ids:
    """Строки сида, на которых идет замер."""

    open_bet: int = 0
    open_legs: list[int] = field(default_factory=list)
    closing_bet: int = 0
    closing_leg: int = 0
    settled_bet: int = 0
    last_bet: int = 0
    bookmaker: int = 0
    top_player: int = 1
    mid_player: int = 400
    rival: int = 2
    # Этап 5: урок, версии (общая линия и свои правила), прогон, отчет, ставка с разбором,
    # загрузка файла
    lesson: int = 0
    ready_lesson: int = 0
    shared_active: int = 0
    shared_candidate: int = 0
    rules_candidate: int = 0
    eval_run: int = 0
    report: int = 0
    reviewed_bet: int = 0
    upload: int = 0


class Runner:
    """Клиенты администратора, участника и участника с плотным месяцем; каждый запрос
    с record — в samples по ключу «метод шаблон [метка]»."""

    def __init__(self, app: FastAPI, cookies: dict[str, str]) -> None:
        self.app = app
        self.samples: dict[str, list[float]] = defaultdict(list)
        self._records: list[dict[str, Any]] = []
        self._clients: dict[str, httpx.AsyncClient] = {}
        for who, token in cookies.items():
            self.sign_in(who, token)

    def sign_in(self, who: str, token: str) -> None:
        """Клиент who с сеансом token (новый клиент или новый сеанс у прежнего)."""
        client = self._clients.get(who)
        if client is None:
            client = httpx.AsyncClient(
                transport=httpx.ASGITransport(app=self.app, client=("10.9.0.1", 51000)),
                base_url=BASE_URL,
                headers={"Origin": get_settings().public_origin, "User-Agent": USER_AGENT},
                timeout=120,
            )
            self._clients[who] = client
        csrf = new_token()
        client.headers[CSRF_HEADER] = csrf
        client.cookies.clear()
        client.cookies.set(cookie_name("session"), token, domain=COOKIE_DOMAIN)
        client.cookies.set(cookie_name("csrf"), csrf, domain=COOKIE_DOMAIN)

    def record(self, entry: dict[str, Any]) -> None:
        self._records.append(entry)

    async def close(self) -> None:
        for client in self._clients.values():
            await client.aclose()

    async def call(
        self,
        who: str,
        method: str,
        url: str,
        *,
        body: Any = None,
        tag: str | None = None,
        record: bool = True,
    ) -> httpx.Response:
        start = len(self._records)
        response = await self._clients[who].request(method, url, json=body)
        if response.status_code >= 300:
            raise PerfError(f"{method} {url}: {response.status_code} {response.text[:300]}")
        if record:
            found = [entry for entry in self._records[start:] if entry["method"] == method.upper()]
            if not found or found[-1]["route"] is None:
                raise PerfError(f"{method} {url}: нет записи времени ответа")
            entry = found[-1]
            key = f"{entry['method']} {entry['route']}" + (f" [{tag}]" if tag else "")
            self.samples[key].append(float(entry["ms"]))
        return response

    async def repeat(
        self,
        who: str,
        method: str,
        url: str,
        *,
        count: int,
        tag: str | None = None,
        warm: bool = True,
    ) -> None:
        # Первый запрос — прогрев (соединения, кэш аналитики, индекс поиска), не в счет;
        # выгрузкам прогревать нечего, а каждая идет секунды
        if warm:
            await self.call(who, method, url, record=False)
        for _ in range(count):
            await self.call(who, method, url, tag=tag)


# --- сценарий замера ---


async def find_ids(db: AsyncSession) -> Ids:
    """Открытая одиночная ставка (расчет и сторно), открытая нога для закрывающего кэфа,
    рассчитанный экспресс (карточка), последняя ставка (курсор), свой букмекер."""
    ids = Ids()
    open_bets = list(
        (
            await db.execute(
                select(Bet.id)
                .join(BetLeg, BetLeg.bet_id == Bet.id)
                .where(Bet.user_id == MEMBER_ID, Bet.status == "open")
                .group_by(Bet.id)
                .order_by(Bet.id)
            )
        ).scalars()
    )
    if len(open_bets) < 2:
        raise PerfError("в сиде меньше двух открытых ставок")
    ids.open_bet, ids.closing_bet = open_bets[0], open_bets[1]
    ids.open_legs = list(
        (await db.execute(select(BetLeg.id).where(BetLeg.bet_id == ids.open_bet))).scalars()
    )
    ids.closing_leg = int(
        await db.scalar(select(BetLeg.id).where(BetLeg.bet_id == ids.closing_bet).limit(1)) or 0
    )
    ids.settled_bet = int(
        await db.scalar(
            select(Bet.id)
            .where(Bet.user_id == MEMBER_ID, Bet.status == "won")
            .order_by(Bet.total_odds.desc(), Bet.id)
            .limit(1)
        )
        or 0
    )
    ids.last_bet = int(
        await db.scalar(
            select(Bet.id).where(Bet.user_id == MEMBER_ID).order_by(Bet.id.desc()).offset(40)
        )
        or 0
    )
    players = int(await db.scalar(select(func.count(Player.id))) or 0)
    ids.mid_player = max(3, players // 7)
    ids.bookmaker = int(
        await db.scalar(
            select(Bookmaker.id).where(Bookmaker.user_id == MEMBER_ID).order_by(Bookmaker.id)
        )
        or 0
    )
    await _learning_ids(db, ids)
    return ids


async def _learning_ids(db: AsyncSession, ids: Ids) -> None:
    """Строки этапа 5 из сида (app/admin/perf_seed.py, _LEARNING_SQL)."""

    async def one(sql: str) -> int:
        found = await db.scalar(text(sql))
        if found is None:
            raise PerfError(f"в сиде нет строки: {sql}")
        return int(found)

    ids.lesson = await one("SELECT min(id) FROM lessons WHERE status = 'confirmed'")
    ids.ready_lesson = await one(
        "SELECT min(id) FROM lessons WHERE status = 'ready' AND user_id IS NULL"
    )
    ids.shared_active = await one(
        "SELECT id FROM strategy_versions WHERE user_id IS NULL AND status = 'active'"
    )
    ids.shared_candidate = await one(
        "SELECT id FROM strategy_versions WHERE user_id IS NULL AND status = 'candidate'"
    )
    ids.rules_candidate = await one(
        f"SELECT id FROM strategy_versions WHERE user_id = {MEMBER_ID} AND status = 'candidate'"
    )
    ids.eval_run = await one("SELECT max(id) FROM eval_runs WHERE eval_set_id IS NOT NULL")
    ids.report = await one(f"SELECT max(id) FROM weekly_reports WHERE user_id = {MEMBER_ID}")
    ids.reviewed_bet = await one(f"SELECT max(bet_id) FROM postmortems WHERE user_id = {MEMBER_ID}")
    ids.upload = await one("SELECT max(id) FROM data_uploads")


async def _reads(run: Runner, ids: Ids, samples: int) -> None:
    member = "member"
    for url, tag in (
        ("/api/dashboard?period=30d", None),
        ("/api/analytics", None),
        ("/api/analytics?period=90d&market=ML", "filter"),
        ("/api/bets", None),
        (f"/api/bets?status=settled&before={ids.last_bet}", "page2"),
        ("/api/bets?q=Sinner", "q"),
        ("/api/bets/summary", None),
        ("/api/bets/summary?period=30d", "30d"),
        (f"/api/bets/{ids.settled_bet}", None),
        ("/api/me/bank", None),
        ("/api/me/bank/history?period=all", None),
        ("/api/me/bank/entries", None),
        ("/api/strategy/active", None),
        ("/api/me/notifications", None),
        ("/api/me/notification-prefs", None),
        ("/api/me/bookmakers", None),
        ("/api/me/bookmakers/list", None),
        ("/api/me/play-limits", None),
        ("/api/me/export/summary", None),
        ("/api/players/ranking", None),
        ("/api/players/ranking?q=Sinner", "q"),
        ("/api/players/ranking?q=%D0%A1%D0%B8%D0%BD%D0%BD%D0%B5%D1%80", "q ru"),
        ("/api/players/ranking?surface=clay&sort=elo&data=all&offset=1000", "clay"),
        ("/api/players?q=Sinner", None),
        (f"/api/players/{ids.top_player}", None),
        (f"/api/players/{ids.mid_player}", "mid"),
        (f"/api/players/{ids.top_player}/matches", None),
        (f"/api/players/{ids.top_player}/news", None),
        (f"/api/players/{ids.top_player}/h2h/{ids.rival}", None),
        ("/api/ai/budget", None),
        ("/api/ai/usage", None),
        ("/api/ai/runs", None),
        # Этап 5: «Обучение модели», уроки, версии, базовая модель, отчеты, разбор ставки
        ("/api/learning", None),
        ("/api/lessons", None),
        ("/api/lessons/dictionary", None),
        (f"/api/lessons/{ids.lesson}", None),
        ("/api/strategy/versions", None),
        (f"/api/strategy/versions/{ids.shared_candidate}", None),
        (f"/api/strategy/versions/{ids.rules_candidate}", "rules"),
        ("/api/ml/model", None),
        ("/api/learning/reports", None),
        (f"/api/learning/reports/{ids.report}", None),
        (f"/api/bets/{ids.reviewed_bet}/review", None),
    ):
        await run.repeat(member, "GET", url, count=samples, tag=tag)
    for url in ("/api/ai/budget", "/api/ai/usage", "/api/ai/runs"):
        await run.repeat("dense", "GET", url, count=samples, tag="dense")
    for url, tag in (
        ("/api/dashboard?period=30d", "admin"),
        ("/api/ai/usage", "admin"),
        ("/api/admin/ai/usage", None),
        ("/api/admin/activity?period=90d", None),
        ("/api/admin/settings", None),
        ("/api/admin/messages", None),
        ("/api/admin/attention", None),
        ("/api/admin/users", None),
        # Этап 5: набор и прогоны, план прогона, сравнение версий (у участника — предел
        # 20 в минуту, замер — у администратора), загрузки файла tennis-data
        ("/api/admin/eval/sets", None),
        ("/api/admin/eval/runs", None),
        (f"/api/admin/eval/runs/{ids.eval_run}", None),
        (f"/api/admin/eval/runs/preview?version_id={ids.shared_candidate}", None),
        (
            f"/api/strategy/versions/compare?a={ids.shared_active}&b={ids.shared_candidate}",
            "admin",
        ),
        ("/api/learning", "admin"),
        # План быстрой проверки урока: подбор матчей и готовые ответы базы
        (f"/api/lessons/{ids.ready_lesson}/quick-check", None),
        ("/api/admin/data/uploads", None),
        (f"/api/admin/data/uploads/{ids.upload}", None),
    ):
        await run.repeat("admin", "GET", url, count=samples, tag=tag)


async def _cold(run: Runner, redis: Redis, samples: int) -> None:
    """Холодный кэш: перед каждым запросом ответы участника из кэша удаляются."""
    for url, tag in (
        ("/api/analytics", "cold"),
        ("/api/analytics?period=90d&market=ML", "filter cold"),
        ("/api/dashboard?period=30d", "cold"),
    ):
        for _ in range(samples):
            await analytics_cache.forget_user(redis, MEMBER_ID)
            await run.call("member", "GET", url, tag=tag)


async def _loop(run: Runner, redis: Redis, samples: int) -> None:
    """Легкие запросы, пока идет холодный расчет «Аналитики» (цикл событий не должен
    стоять): GET /api/me каждые 20 мс до конца расчета."""
    for _ in range(samples):
        await analytics_cache.forget_user(redis, MEMBER_ID)
        heavy = asyncio.create_task(run.call("member", "GET", "/api/analytics", record=False))
        await asyncio.sleep(0)
        while not heavy.done():
            await run.call("admin", "GET", "/api/me", tag="loop")
            await asyncio.sleep(0.02)
        await heavy


async def _exports(run: Runner, samples: int) -> None:
    for url, tag in (
        ("/api/bets/export.csv", None),
        ("/api/analytics/export.csv?part=events", None),
        ("/api/analytics/export.zip", None),
        ("/api/me/export?format=json", "json"),
        ("/api/me/export?format=csv", "csv"),
    ):
        await run.repeat("member", "GET", url, count=samples, tag=tag, warm=False)


async def _bet(run: Runner, bet_id: int) -> dict[str, Any]:
    response = await run.call("member", "GET", f"/api/bets/{bet_id}", record=False)
    found: dict[str, Any] = response.json()
    return found


async def _writes(run: Runner, ids: Ids, samples: int) -> None:
    for _ in range(samples):
        bet = await _bet(run, ids.open_bet)
        legs = [{"leg_id": leg, "result": "win"} for leg in ids.open_legs]
        body = {"expected_updated_at": bet["updated_at"], "legs": legs}
        await run.call("member", "PUT", f"/api/bets/{ids.open_bet}/result", body=body)
        bet = await _bet(run, ids.open_bet)
        body = {"expected_updated_at": bet["updated_at"]}
        await run.call("member", "POST", f"/api/bets/{ids.open_bet}/reverse", body=body)
    closing_url = f"/api/bets/{ids.closing_bet}/legs/{ids.closing_leg}/closing"
    for number in range(samples):
        closing = {"odds": "1.85", "opp_odds": "2.05", "by": "pinnacle"}
        body = {"closing": closing if number % 2 == 0 else None}
        await run.call("member", "PUT", closing_url, body=body)
    for _ in range(samples):
        entries = (await run.call("member", "GET", "/api/me/bank/entries", record=False)).json()
        body = {"kind": "deposit", "amount": "1.00", "expected_last_id": entries["last_id"]}
        await run.call("member", "POST", "/api/me/bank/entries", body=body)
    for number in range(samples):
        on = number % 2 == 0
        body = {"items": [{"kind": "limit_80", "on_site": on}]}
        await run.call("member", "PUT", "/api/me/notification-prefs", body=body)
        limits = {"bets_per_day": 20, "stake_per_day": "50000.00"}
        await run.call("member", "PUT", "/api/me/play-limits", body=limits)
        created = await run.call(
            "member", "POST", "/api/me/bookmakers", body={"name": f"Perf {number}"}
        )
        await run.call("member", "DELETE", f"/api/me/bookmakers/{created.json()['id']}")
        name = "Pinnacle" if number % 2 else "Pinnacle Perf"
        await run.call(
            "member", "PATCH", f"/api/me/bookmakers/{ids.bookmaker}", body={"name": name}
        )
    for _ in range(samples):
        await run.call(
            "admin", "PUT", "/api/admin/settings", body={"default_tz": "Europe/Helsinki"}
        )
        preview = {
            "from_currency": "RUB",
            "currency": "EUR",
            "rate": "0.0105",
            "rate_base": "RUB",
            "preview": True,
        }
        await run.call("admin", "PUT", "/api/admin/settings/currency", body=preview, tag="preview")
        message = {"text": "Perf", "preview": True}
        await run.call("admin", "POST", "/api/admin/messages", body=message, tag="preview")
        message = {"text": "Perf", "user_id": OTHER_ID}
        await run.call("admin", "POST", "/api/admin/messages", body=message)
    for number in range(samples):
        consent = {"consent_training": number % 2 == 0}
        await run.call("other", "PATCH", "/api/me", body=consent)
        await run.call("other", "POST", "/api/me/pause", body={"days": 1})


async def _confirmed_writes(
    run: Runner, maker: async_sessionmaker[AsyncSession], samples: int
) -> None:
    """Изменения с кодом 2FA: запрос удаления аккаунта и отмена (запрос завершает все
    сеансы — для отмены и следующего запроса нужен новый вход), смена валюты туда и
    обратно по курсу 1."""
    codes = await _enable_totp(maker, (ADMIN_ID, LEAVING_ID))
    for _ in range(samples):
        body = {"password": PERF_PASSWORD, "code": await codes(LEAVING_ID)}
        await run.call("leaving", "POST", "/api/me/deletion", body=body)
        run.sign_in("leaving", await _new_session(maker, LEAVING_ID))
        await run.call("leaving", "DELETE", "/api/me/deletion")
    for _ in range(samples):
        for old, new in (("RUB", "EUR"), ("EUR", "RUB")):
            body = {
                "from_currency": old,
                "currency": new,
                "rate": "1",
                "rate_base": old,
                "totp_code": await codes(ADMIN_ID),
            }
            await run.call("admin", "PUT", "/api/admin/settings/currency", body=body)


async def _enable_totp(
    maker: async_sessionmaker[AsyncSession], user_ids: Sequence[int]
) -> Callable[[int], Awaitable[str]]:
    """Включает 2FA пользователям сида; возвращает функцию «текущий код» (шаг последнего
    принятого кода перед этим стирается, чтобы код текущего шага приняли снова)."""
    secrets: dict[int, str] = {}
    async with maker() as db:
        for user_id in user_ids:
            user = await db.get_one(User, user_id)
            secret = new_totp_secret()
            aad = crypto.aad_for(crypto.AAD_TOTP_SECRET, user_id)
            user.totp_secret_enc, user.totp_key_version = crypto.encrypt_str(secret, aad)
            user.totp_enabled = True
            secrets[user_id] = secret
        await db.commit()

    async def code(user_id: int) -> str:
        async with maker() as db:
            await db.execute(
                text("UPDATE users SET totp_last_step = NULL WHERE id = :id"), {"id": user_id}
            )
            await db.commit()
        return code_at_step(secrets[user_id], current_step())

    return code


async def _new_session(maker: async_sessionmaker[AsyncSession], user_id: int) -> str:
    async with maker() as db:
        created = await create_session(db, user_id=user_id, ip="10.9.0.1", user_agent=USER_AGENT)
        await db.commit()
    return created.token


async def _all_writes(
    run: Runner,
    maker: async_sessionmaker[AsyncSession],
    ids: Ids,
    samples: int,
    heavy_samples: int,
) -> None:
    await _writes(run, ids, max(1, samples // 2))
    await _confirmed_writes(run, maker, heavy_samples)


async def _sessions(maker: async_sessionmaker[AsyncSession]) -> dict[str, str]:
    """Сеансы администратора и участников прямо в базе (как вход в тестах)."""
    people = (
        ("admin", ADMIN_ID),
        ("member", MEMBER_ID),
        ("dense", DENSE_ID),
        ("other", OTHER_ID),
        ("leaving", LEAVING_ID),
    )
    return {who: await _new_session(maker, user_id) for who, user_id in people}


async def measure(
    app: FastAPI,
    *,
    samples: int = SAMPLES,
    heavy_samples: int = HEAVY_SAMPLES,
    progress: Callable[[str], None] | None = None,
    steps: Sequence[str] = ("reads", "cold", "loop", "exports", "writes"),
) -> dict[str, list[float]]:
    """Все замеры на приложении app с открытым lifespan; ключ → времена ответов, мс."""
    maker: async_sessionmaker[AsyncSession] = app.state.sessionmaker
    redis: Redis = app.state.redis
    # Индекс поиска игроков строится при старте в фоне: замер — после него
    await app.state.search_warm
    async with maker() as db:
        ids = await find_ids(db)
        await db.execute(text("SELECT 1"))
    run = Runner(app, await _sessions(maker))
    actions: dict[str, Callable[[], Awaitable[None]]] = {
        "reads": lambda: _reads(run, ids, samples),
        "cold": lambda: _cold(run, redis, heavy_samples),
        "loop": lambda: _loop(run, redis, heavy_samples),
        "exports": lambda: _exports(run, heavy_samples),
        "writes": lambda: _all_writes(run, maker, ids, samples, heavy_samples),
    }
    try:
        with timing.observe(run.record):
            for step in steps:
                started = datetime.now(UTC)
                await actions[step]()
                if progress is not None:
                    seconds = (datetime.now(UTC) - started).total_seconds()
                    progress(t("cli.perf.step_done", step=step, seconds=f"{seconds:.1f}"))
    finally:
        await run.close()
    return dict(run.samples)
