"""Сид для замера скорости API (этап 4, PLAN.md, «Целевые показатели»): синтетические данные
размера живой программы — только в отдельную базу capper_perf*, никогда в рабочую.

Что кладется (числа — Sizes, по умолчанию):
- 2 790 игроков (латиницей и по-русски), 1 440 турниров за 12 лет (последний начался
  вчера: его матчи с сегодняшнего дня — запланированы) и около 80 тыс. матчей с неравным
  числом матчей у игроков (у первых — сотни), статистика подачи, новости; Эло и
  player_elo_current считает настоящий шаг elo (app/ml/elo.py) по этим матчам;
- администратор и 30 участников. У участника load (id 2) — 10 тыс. ставок за 2 года:
  одиночные и экспрессы до 3 событий, все исходы, возвраты, открытые, ставки старого бота,
  закрывающие кэфы с одной и двух сторон, исправления результата (сторно), прогнозы с
  заменами, журнал банка с пополнениями, выводами и корректировками. У остальных — по
  100 ставок за год;
- 100 тыс. вызовов Claude (agent_runs) за год с разбросом по месяцам и участникам, общие
  задачи и проверки (eval) отдельно; у участника dense (id 3) — «плотный месяц»: 14 тыс.
  вызовов в текущем месяце;
- уведомления, входы за 90 дней, журнал администратора, лимиты, букмекеры.

Детерминированно: случайные числа — хеш (hashint8extended) номера строки и соли seed, а не
random(); даты — от дня today. Одинаковые seed и today дают одинаковые строки (кроме меток
времени записи: created_at по умолчанию, журнал загрузок) — это проверяет seed_digest.
INSERT … SELECT без явного id (номер дает последовательность) — всегда с ORDER BY по
уникальному ключу: иначе порядок строк, а с ним и номера, зависит от плана запроса, то есть
от статистики таблиц, которую оставили прежние данные базы (ANALYZE, autovacuum).

Быстро: строки пишет сам PostgreSQL (generate_series, INSERT … SELECT), Python готовит
только имена игроков; полный сид — около 30 с.

Защита рабочей базы (check_target): имя базы — capper_perf или capper_perf_<буквы и
цифры>, явный флаг подтверждения, не prod, база пустая (ни одного пользователя).
"""

import json
import re
from collections.abc import Sequence
from dataclasses import dataclass, replace
from datetime import UTC, date, datetime, time, timedelta
from typing import Any

from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.admin.terminal import CliError
from app.core.config import get_settings
from app.core.security.passwords import hash_password_async
from app.ml import elo
from app.ml.strategy import StrategyParams
from app.services.strategy_versions import current_prompt_version

PERF_DB = re.compile(r"^capper_perf(_[a-z0-9_]{1,40})?$")
# Пароль пользователей сида: входить в замере не нужно (сеанс пишется в базу), но пароль у
# действующего пользователя должен быть
PERF_PASSWORD = "perf-load-password-2026"
ADMIN_ID = 1
MEMBER_ID = 2
DENSE_ID = 3
PERF_TZ = "Europe/Helsinki"
# Условие урока сида (словарь, app/ml/lesson_scope.py)
PERF_SCOPE = {
    "v": 1,
    "direction": "lower",
    "conditions": [{"feature": "role", "op": "eq", "values": ["favorite"]}],
}


def _report_payload() -> dict[str, Any]:
    """Снимок еженедельного отчета (форма app/services/weekly_report.py)."""
    return {
        "version": 1,
        "tz": PERF_TZ,
        "currency": "RUB",
        "empty": False,
        "bets": {
            "settled": 95,
            "auto": 70,
            "manual": 25,
            "won": 50,
            "lost": 42,
            "void": 3,
            "turnover": "95000.00",
            "profit": "1840.00",
            "roi": 0.0194,
            "placed": 96,
            "open": 4,
        },
        "clv": {"mean": 0.012, "n": 80, "positive": 47},
        "accuracy": {"n": 120, "model": 0.205, "market": 0.201, "diff": 0.004, "source": "pred"},
        "calibration": {"n": 120, "mean_p": 0.61, "hit_rate": 0.58},
        "reviews": {"done": 60, "pending": 2, "cost_usd": "0.60"},
        "lessons": {
            "new": ["L-003"],
            "confirmed": ["L-002"],
            "enabled": [],
            "retired": [],
            "in_prompt": 3,
        },
        "eval": {"spent_usd": "3.10", "runs": 1, "budget_usd": "30", "month_spent_usd": "6.20"},
        "model": {
            "id": "elo-v1@perf",
            "brier": 0.2,
            "log_loss": 0.58,
            "recalibrated_at": None,
            "recalibration_activated": None,
        },
        "shared": None,
    }


@dataclass(frozen=True)
class Sizes:
    """Объем сида. scaled — для тестов (доля полного)."""

    players: int = 2790
    tournaments: int = 1440
    matches_per_tournament: int = 56
    years: int = 12
    members: int = 30
    member_bets: int = 10_000
    member_days: int = 730
    other_bets: int = 100
    # Анализы в год: у участника load (сверх анализов своих ставок), у остальных — в
    # среднем; у каждого анализа 5 вызовов (разбор, 2 новостей, 2 анализа)
    member_skip_analyses: int = 1000
    other_analyses: int = 450
    admin_analyses: int = 600
    shared_runs: int = 2000
    eval_runs: int = 2000
    dense_runs: int = 14_000
    news_players: int = 300

    def scaled(self, factor: float) -> "Sizes":
        def part(value: int, low: int) -> int:
            return max(low, round(value * factor))

        return replace(
            self,
            players=part(self.players, 40),
            tournaments=part(self.tournaments, 24),
            members=part(self.members, 4),
            member_bets=part(self.member_bets, 60),
            other_bets=part(self.other_bets, 10),
            member_skip_analyses=part(self.member_skip_analyses, 10),
            other_analyses=part(self.other_analyses, 10),
            admin_analyses=part(self.admin_analyses, 5),
            shared_runs=part(self.shared_runs, 10),
            eval_runs=part(self.eval_runs, 10),
            dense_runs=part(self.dense_runs, 50),
            news_players=part(self.news_players, 5),
        )


@dataclass(frozen=True)
class SeedResult:
    counts: dict[str, int]
    digest: str


# --- защита рабочей базы ---


def check_target(database_url: str, *, confirmed: bool) -> str:
    """Имя базы сида. Без флага подтверждения, с именем не capper_perf*, в prod и в
    рабочую базу из настроек — CliError."""
    if not confirmed:
        raise CliError("perf.confirm_required")
    name = make_url(database_url).database or ""
    if not PERF_DB.match(name):
        raise CliError("perf.db_name", name=name or "—")
    settings = get_settings()
    if settings.env == "prod":
        raise CliError("perf.prod")
    working = make_url(settings.database_url).database
    if working == name and not PERF_DB.match(working or ""):
        raise CliError("perf.db_name", name=name)
    return name


async def check_empty(db: AsyncSession) -> None:
    """Сид — только в пустую базу после alembic upgrade head."""
    users = await db.scalar(text("SELECT count(*) FROM users"))
    if users:
        raise CliError("perf.db_not_empty", users=int(users))


# --- имена игроков ---

_FIRST = [
    "Jannik",
    "Carlos",
    "Novak",
    "Daniil",
    "Andrey",
    "Holger",
    "Alexander",
    "Casper",
    "Taylor",
    "Stefanos",
    "Hubert",
    "Grigor",
    "Tommy",
    "Alex",
    "Frances",
    "Lorenzo",
    "Felix",
    "Karen",
    "Sebastian",
    "Ben",
    "Ugo",
    "Nicolas",
    "Arthur",
    "Jack",
    "Jiri",
    "Tomas",
    "Matteo",
    "Flavio",
    "Alejandro",
    "Francisco",
    "Roman",
    "Pavel",
    "Denis",
    "Marton",
    "Mariano",
    "Diego",
    "Cameron",
    "Brandon",
    "Adrian",
    "Miomir",
    "Laslo",
    "Dusan",
    "Jordan",
    "Botic",
    "Mackenzie",
    "Christopher",
    "Zizou",
]
_LAST = [
    "Sinner",
    "Alcaraz",
    "Djokovic",
    "Medvedev",
    "Rublev",
    "Rune",
    "Zverev",
    "Ruud",
    "Fritz",
    "Tsitsipas",
    "Hurkacz",
    "Dimitrov",
    "Paul",
    "Minaur",
    "Tiafoe",
    "Musetti",
    "Auger",
    "Khachanov",
    "Korda",
    "Shelton",
    "Humbert",
    "Jarry",
    "Fils",
    "Draper",
    "Lehecka",
    "Machac",
    "Berrettini",
    "Cobolli",
    "Davidovich",
    "Cerundolo",
    "Safiullin",
    "Kotov",
    "Shapovalov",
    "Fucsovics",
    "Navone",
    "Schwartzman",
    "Norrie",
    "Nakashima",
    "Mannarino",
    "Kecmanovic",
    "Djere",
    "Lajovic",
    "Thompson",
    "Zandschulp",
    "McDonald",
    "Eubanks",
    "Bergs",
    "Tabilo",
    "Griekspoor",
    "Struff",
    "Popyrin",
    "Michelsen",
    "Mensik",
    "Fonseca",
    "Darderi",
    "Nardi",
    "Bublik",
    "Etcheverry",
    "Monfils",
    "Wawrinka",
    "Bautista",
]
_COUNTRIES = [
    "ITA",
    "ESP",
    "SRB",
    "RUS",
    "GER",
    "NOR",
    "USA",
    "GRE",
    "POL",
    "BUL",
    "AUS",
    "FRA",
    "CAN",
    "CZE",
    "ARG",
    "GBR",
    "CHI",
    "KAZ",
    "NED",
    "BEL",
    "SUI",
    "BRA",
    "JPN",
    "CRO",
    "HUN",
]
_TRANSLIT = (
    ("sch", "ш"), ("sh", "ш"), ("ch", "ч"), ("kh", "х"), ("zh", "ж"), ("ts", "ц"),
    ("ya", "я"), ("yu", "ю"), ("ck", "к"), ("ph", "ф"), ("th", "т"), ("ou", "у"),
    ("a", "а"), ("b", "б"), ("c", "к"), ("d", "д"), ("e", "е"), ("f", "ф"), ("g", "г"),
    ("h", "х"), ("i", "и"), ("j", "дж"), ("k", "к"), ("l", "л"), ("m", "м"), ("n", "н"),
    ("o", "о"), ("p", "п"), ("q", "к"), ("r", "р"), ("s", "с"), ("t", "т"), ("u", "у"),
    ("v", "в"), ("w", "в"), ("x", "кс"), ("y", "и"), ("z", "з"),
)  # fmt: skip


def russian(name: str) -> str:
    """Имя по-русски простой транслитерацией (для поиска по-русски хватает)."""
    words = []
    for word in name.split():
        rest, out = word.lower(), ""
        while rest:
            for latin, cyrillic in _TRANSLIT:
                if rest.startswith(latin):
                    out += cyrillic
                    rest = rest[len(latin) :]
                    break
            else:
                rest = rest[1:]
        words.append(out[:1].upper() + out[1:])
    return " ".join(words)


def player_rows(count: int) -> list[dict[str, Any]]:
    """Игроки 1…count: разные имена (имя × фамилия), у половины — имя по-русски."""
    rows = []
    for number in range(1, count + 1):
        index = number - 1
        first = _FIRST[index % len(_FIRST)]
        last = _LAST[(index // len(_FIRST) + index) % len(_LAST)]
        name = f"{first} {last}"
        if index >= len(_FIRST) * len(_LAST):
            name = f"{name} {index // (len(_FIRST) * len(_LAST)) + 1}"
        rows.append(
            {
                "id": number,
                "name": name,
                "name_ru": russian(name) if number % 2 == 1 else None,
                "country": _COUNTRIES[(number * 7) % len(_COUNTRIES)],
            }
        )
    return rows


# --- SQL сида ---

# Случайное число [0, 1) из номера строки k и соли: одинаково при любом порядке строк
_RND_SQL = """
CREATE OR REPLACE FUNCTION pg_temp.rnd(k bigint, salt int) RETURNS double precision
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS
$$ SELECT (hashint8extended(k, {seed}::bigint * 1000 + salt) & 2147483647)::double precision
          / 2147483648.0 $$
"""

_TOURNAMENTS_SQL = """
INSERT INTO tournaments (id, name, category, surface, indoor, best_of, start_date, city,
    source, source_ref)
SELECT t,
    (ARRAY['Rotterdam', 'Dubai', 'Miami', 'Madrid', 'Roma', 'Halle', 'Umag', 'Kitzbuhel',
           'Washington', 'Toronto', 'Cincinnati', 'Winston-Salem', 'Chengdu', 'Tokyo',
           'Shanghai', 'Vienna', 'Basel', 'Paris', 'Doha', 'Marseille', 'Acapulco',
           'Santiago', 'Houston', 'Estoril', 'Munich', 'Geneva', 'Lyon', 'Stuttgart',
           'Mallorca', 'Eastbourne', 'Newport', 'Gstaad', 'Bastad', 'Atlanta', 'Los Cabos',
           'Metz', 'Astana', 'Antwerp', 'Stockholm', 'Belgrade'])[1 + t % 40]
        || ' ' || extract(year FROM d)::int,
    CASE WHEN t % 31 = 0 THEN 'grand_slam' WHEN t % 11 = 0 THEN 'masters'
         WHEN t % 5 = 0 THEN '500' WHEN t % 3 = 0 THEN 'challenger' ELSE '250' END,
    CASE WHEN r < 0.55 THEN 'hard' WHEN r < 0.85 THEN 'clay' WHEN r < 0.97 THEN 'grass'
         ELSE 'carpet' END,
    r < 0.2,
    CASE WHEN t % 31 = 0 THEN 5 ELSE 3 END,
    d,
    NULL,
    CASE WHEN d < CAST(:today AS date) - 1100 THEN 'sackmann' ELSE 'tennis_data' END,
    'perf-' || t
FROM (
    SELECT t, pg_temp.rnd(t, 1) AS r,
        CAST(:today AS date) - 1 - ((:tournaments - t) * :span_days / :tournaments) AS d
    FROM generate_series(1, :tournaments) AS t
) AS s
"""

# Матчи: 56 на турнир, круги R64…F по дням турнира. Игроки — с перекосом (у первых по
# номеру матчей больше), победитель — по силе (номер меньше — сильнее). Матчи позже
# сегодня — запланированы (на них открытые ставки)
_MATCHES_SQL = """
INSERT INTO matches (id, tournament_id, round, scheduled_at, match_date, player1_id,
    player2_id, winner_id, score, status, best_of, source, source_ref)
SELECT m, tid, round,
    CASE WHEN day > CAST(:today AS date) - 1
         THEN day + make_interval(hours => 10 + (m % 10)) END,
    CASE WHEN dated THEN day END,
    p1, p2,
    CASE WHEN status = 'scheduled' THEN NULL WHEN r3 < p2::float / (p1 + p2) THEN p1 ELSE p2 END,
    CASE WHEN status = 'scheduled' THEN NULL
         WHEN status = 'walkover' THEN NULL
         WHEN status = 'retired' THEN '6-4 2-1 RET'
         WHEN best_of = 5 THEN (ARRAY['6-4 6-3 6-2', '7-6(4) 6-4 6-4', '6-3 4-6 6-2 6-4',
                                      '3-6 6-4 6-4 6-7(5) 6-3'])[1 + (m % 4)]
         ELSE (ARRAY['6-4 6-3', '7-6(4) 6-4', '6-3 4-6 6-2', '6-2 6-1', '3-6 6-4 7-5',
                     '6-4 6-7(5) 6-3'])[1 + (m % 6)] END,
    status, best_of, source, 'perf-m' || m
FROM (
    SELECT m, tid, round, day, best_of, source, dated, r3, p1,
        CASE WHEN p2 = p1 THEN p1 % :players + 1 ELSE p2 END AS p2,
        CASE WHEN day > CAST(:today AS date) - 1 THEN 'scheduled'
             WHEN r4 < 0.012 THEN 'walkover' WHEN r4 < 0.03 THEN 'retired'
             ELSE 'finished' END AS status
    FROM (
        SELECT m, t.id AS tid, t.best_of, t.source, t.source = 'tennis_data' AS dated,
            CASE WHEN k < 32 THEN 'R64' WHEN k < 48 THEN 'R32' WHEN k < 52 THEN 'R16'
                 WHEN k < 54 THEN 'QF' WHEN k < 55 THEN 'SF' ELSE 'F' END AS round,
            t.start_date + CASE WHEN k < 16 THEN 0 WHEN k < 32 THEN 1 WHEN k < 48 THEN 2
                 WHEN k < 52 THEN 3 WHEN k < 54 THEN 4 WHEN k < 55 THEN 5 ELSE 6 END AS day,
            least(:players, 1 + floor(:players * power(pg_temp.rnd(m, 2), 1.5))::int) AS p1,
            least(:players, 1 + floor(:players * power(pg_temp.rnd(m, 3), 1.5))::int) AS p2,
            pg_temp.rnd(m, 4) AS r3, pg_temp.rnd(m, 5) AS r4
        FROM (
            SELECT m, (m - 1) % :per_tournament AS k, (m - 1) / :per_tournament + 1 AS tid
            FROM generate_series(1, :tournaments * :per_tournament) AS m
        ) AS g
        JOIN tournaments AS t ON t.id = g.tid
    ) AS a
) AS b
ON CONFLICT DO NOTHING
"""

_STATS_SQL = """
INSERT INTO match_stats (match_id, player_id, aces, double_faults, serve_points, first_in,
    first_won, second_won, bp_saved, bp_faced, serve_games, source)
SELECT id, pid, floor(r1 * 16)::int, floor(r2 * 7)::int, sp, fi,
    floor(fi * (0.62 + r3 * 0.16))::int, floor((sp - fi) * (0.42 + r4 * 0.16))::int,
    floor(r5 * 6)::int, floor(r5 * 6)::int + floor(r6 * 4)::int, 9 + floor(r6 * 7)::int,
    'sackmann'
FROM (
    SELECT m.id, s.pid, pg_temp.rnd(m.id * 2 + s.n, 11) AS r1,
        pg_temp.rnd(m.id * 2 + s.n, 12) AS r2, pg_temp.rnd(m.id * 2 + s.n, 13) AS r3,
        pg_temp.rnd(m.id * 2 + s.n, 14) AS r4, pg_temp.rnd(m.id * 2 + s.n, 15) AS r5,
        pg_temp.rnd(m.id * 2 + s.n, 16) AS r6,
        50 + floor(pg_temp.rnd(m.id * 2 + s.n, 17) * 60)::int AS sp,
        floor((50 + floor(pg_temp.rnd(m.id * 2 + s.n, 17) * 60)) *
              (0.55 + pg_temp.rnd(m.id * 2 + s.n, 18) * 0.15))::int AS fi
    FROM matches AS m
    CROSS JOIN LATERAL (VALUES (m.player1_id, 1), (m.player2_id, 2)) AS s(pid, n)
    WHERE m.status IN ('finished', 'retired')
) AS x
"""

_NEWS_SQL = """
INSERT INTO player_news (player_id, published_at, kind, summary, source_url, source_name,
    fetched_at)
SELECT p, CAST(:today_ts AS timestamptz) - make_interval(hours => (p * 7 + n * 29) % 600),
    (ARRAY['injury', 'withdrawal', 'motivation', 'other'])[1 + (p + n) % 4],
    'Perf news ' || p || '-' || n, 'https://www.atptour.com/perf/' || p || '/' || n, 'ATP',
    CAST(:today_ts AS timestamptz)
FROM generate_series(1, :news_players) AS p CROSS JOIN generate_series(1, 3) AS n
"""

_INGESTION_SQL = """
INSERT INTO ingestion_runs (source, started_at, finished_at, rows, status, details)
SELECT source, CAST(:today_ts AS timestamptz) + interval '3 hours',
    CAST(:today_ts AS timestamptz) + interval '3 hours 5 minutes', 1000, 'ok', '{}'::jsonb
FROM (VALUES ('sackmann'), ('tennis_data')) AS s(source)
"""

_USERS_SQL = """
INSERT INTO users (id, email, display_name, password_hash, role, status, ai_mode, tz,
    consent_training, terms_accepted_at, last_login_at, created_at, updated_at)
SELECT u,
    CASE u WHEN 1 THEN 'admin@perf.test' WHEN 2 THEN 'load@perf.test'
           WHEN 3 THEN 'dense@perf.test' ELSE 'member' || u || '@perf.test' END,
    CASE u WHEN 1 THEN 'Perf Admin' WHEN 2 THEN 'Perf Load' WHEN 3 THEN 'Perf Dense'
           ELSE 'Member ' || u END,
    :password_hash,
    CASE WHEN u = 1 THEN 'admin' ELSE 'member' END,
    'active',
    CASE WHEN u > 3 AND u % 9 = 0 THEN 'own' ELSE 'shared' END,
    :tz, u % 2 = 0,
    CAST(:today_ts AS timestamptz) - interval '800 days',
    CAST(:today_ts AS timestamptz) - make_interval(hours => u),
    CAST(:today_ts AS timestamptz) - interval '800 days',
    CAST(:today_ts AS timestamptz) - interval '800 days'
FROM generate_series(1, :members + 1) AS u
"""

_STRATEGY_SQL = """
INSERT INTO strategy_versions (user_id, code, name, params, prompt_version, status,
    approved_at, created_at)
SELECT u, 'v3', 'v3', CAST(:params AS jsonb), :prompt_version, 'active',
    CAST(:today_ts AS timestamptz) - interval '800 days',
    CAST(:today_ts AS timestamptz) - interval '800 days'
FROM generate_series(1, :members + 1) AS u
"""

_LIMITS_SQL = """
INSERT INTO ai_limits (user_id, monthly_usd, daily_analyses, per_analysis_usd)
SELECT u, CASE WHEN u = 3 THEN 1000 ELSE 10 END, CASE WHEN u = 3 THEN 200 ELSE 3 END, 0.5
FROM generate_series(2, :members + 1) AS u;
INSERT INTO play_limits (user_id, bets_per_day, stake_per_day, currency)
VALUES (2, 20, 50000, 'RUB');
INSERT INTO bookmakers (user_id, name, created_at)
SELECT u, b, CAST(:today_ts AS timestamptz) - interval '700 days'
FROM generate_series(2, :members + 1) AS u
CROSS JOIN unnest(ARRAY['Pinnacle', 'Fonbet', 'Winline', 'Bet365', 'Marathon']) AS b;
INSERT INTO notification_prefs (user_id, kind, on_site, push)
VALUES (2, 'bet_settled', false, false), (2, 'limit_80', true, false)
"""

# План ставок: у участника load — member_bets за member_days, у остальных — other_bets за
# год (у dense — тоже). Номера ставок и ног — свои, от 1
_PLAN_SQL = """
CREATE TEMP TABLE perf_bettor ON COMMIT DROP AS
SELECT u AS user_id,
    CASE WHEN u = 2 THEN :member_bets ELSE :other_bets END AS total,
    CASE WHEN u = 2 THEN :member_days ELSE 365 END AS span_days
FROM generate_series(2, :members + 1) AS u;

CREATE TEMP TABLE perf_bet ON COMMIT DROP AS
SELECT row_number() OVER (ORDER BY b.user_id, g) AS bid, b.user_id, g AS n,
    CAST(:today_ts AS timestamptz) - make_interval(days => b.span_days)
        + (g - 1) * make_interval(days => b.span_days) / b.total
        + make_interval(mins => floor(pg_temp.rnd(b.user_id * 1000000 + g, 21) * 360)::int)
        AS placed_at,
    CASE WHEN pg_temp.rnd(b.user_id * 1000000 + g, 22) < 0.55 THEN 1
         WHEN pg_temp.rnd(b.user_id * 1000000 + g, 22) < 0.80 THEN 2 ELSE 3 END AS nlegs,
    CASE WHEN b.user_id = 2 AND g <= b.total * 0.15 THEN 'legacy' ELSE 'app' END AS source,
    100 + 50 * floor(pg_temp.rnd(b.user_id * 1000000 + g, 23) * 39)::int AS stake,
    (ARRAY['Pinnacle', 'Fonbet', 'Winline', 'Bet365', 'Marathon'])
        [1 + floor(pg_temp.rnd(b.user_id * 1000000 + g, 24) * 5)::int] AS bookmaker,
    pg_temp.rnd(b.user_id * 1000000 + g, 25) < 0.7 AS analysed,
    g > b.total - CASE WHEN b.user_id = 2 THEN 25 ELSE 1 END AS open_slot
FROM perf_bettor AS b CROSS JOIN LATERAL generate_series(1, b.total) AS g;

CREATE TEMP TABLE perf_sched ON COMMIT DROP AS
SELECT row_number() OVER (ORDER BY id) AS rn, id FROM matches WHERE status = 'scheduled';

-- Ноги: матч турнира, начавшегося в день ставки или раньше (в экспрессе — разные матчи); у
-- последних ставок (open_slot) — запланированные матчи: они в игре
CREATE TEMP TABLE perf_leg ON COMMIT DROP AS
SELECT row_number() OVER (ORDER BY p.bid, k) AS lid, p.bid, k, m.id AS match_id,
    m.status, m.winner_id, m.player1_id, m.player2_id, m.best_of,
    coalesce(m.match_date, t.start_date) AS day, m.scheduled_at,
    pg_temp.rnd(p.bid * 4 + k, 31) AS r_market, pg_temp.rnd(p.bid * 4 + k, 32) AS r_sel,
    pg_temp.rnd(p.bid * 4 + k, 33) AS r_odds, pg_temp.rnd(p.bid * 4 + k, 34) AS r_close,
    pg_temp.rnd(p.bid * 4 + k, 35) AS r_hcp, pg_temp.rnd(p.bid * 4 + k, 36) AS r_pred
FROM perf_bet AS p
CROSS JOIN LATERAL generate_series(1, p.nlegs) AS k
CROSS JOIN LATERAL (
    SELECT CASE WHEN p.open_slot THEN (
            SELECT s.id FROM perf_sched AS s
            WHERE s.rn = 1 + (p.bid * 7 + k * 13)
                % greatest(1, (SELECT count(*) FROM perf_sched)))
        ELSE (greatest(1, least(:tournaments, :tournaments - ceil(
                (CAST(:today AS date) - 1 - CAST(p.placed_at AS date)) * :tournaments::float
                / :span_days)::int)) - 1) * :per_tournament
            + 1 + (floor(pg_temp.rnd(p.bid, 37) * :per_tournament)::int + (k - 1) * 19)
                % :per_tournament
        END AS match_id
) AS pick
JOIN matches AS m ON m.id = pick.match_id
JOIN tournaments AS t ON t.id = m.tournament_id;

CREATE INDEX ON perf_leg (bid);

ALTER TABLE perf_leg ADD COLUMN market text, ADD COLUMN selection int,
    ADD COLUMN odds numeric(6, 3), ADD COLUMN result text, ADD COLUMN closing numeric(6, 3),
    ADD COLUMN closing_opp numeric(6, 3), ADD COLUMN p_sel double precision;

UPDATE perf_leg SET
    market = CASE WHEN r_market < 0.7 THEN 'ML' WHEN r_market < 0.85 THEN 'HCP_-1.5'
                  ELSE 'HCP_+1.5' END,
    selection = CASE WHEN r_sel < 0.5 THEN 1 ELSE 2 END;

UPDATE perf_leg SET
    p_sel = CASE WHEN selection = 1 THEN player2_id::float / (player1_id + player2_id)
                 ELSE player1_id::float / (player1_id + player2_id) END;

UPDATE perf_leg SET
    odds = round(CAST(greatest(1.05, least(12.0,
        (1 / greatest(0.08, least(0.92, p_sel + (r_odds - 0.5) * 0.1))) / 1.05
        * CASE market WHEN 'HCP_-1.5' THEN 1.6 WHEN 'HCP_+1.5' THEN 0.7 ELSE 1 END))
        AS numeric), 2),
    result = CASE
        WHEN status = 'scheduled' THEN NULL
        WHEN status = 'walkover' THEN 'void'
        WHEN market = 'ML' THEN
            CASE WHEN winner_id = CASE selection WHEN 1 THEN player1_id ELSE player2_id END
                 THEN 'win' ELSE 'loss' END
        WHEN market = 'HCP_-1.5' THEN
            CASE WHEN winner_id = CASE selection WHEN 1 THEN player1_id ELSE player2_id END
                      AND r_hcp < 0.6 THEN 'win' ELSE 'loss' END
        ELSE CASE WHEN winner_id = CASE selection WHEN 1 THEN player1_id ELSE player2_id END
                       OR r_hcp < 0.35 THEN 'win' ELSE 'loss' END
    END;
UPDATE perf_leg SET odds = 1.01 WHERE odds < 1.01;

UPDATE perf_leg AS l SET
    closing = CASE WHEN p.source = 'app' AND l.r_close < 0.8
        THEN greatest(1.01, round(CAST(l.odds * (0.92 + l.r_close * 0.14) AS numeric), 2)) END
FROM perf_bet AS p WHERE p.bid = l.bid;
UPDATE perf_leg SET closing_opp = round(CAST(1 / greatest(0.02, 1.05 - 1 / closing::float)
        AS numeric), 2)
WHERE closing IS NOT NULL AND r_close < 0.4;
UPDATE perf_leg SET closing_opp = least(closing_opp, 50) WHERE closing_opp IS NOT NULL;
UPDATE perf_leg SET closing_opp = NULL WHERE closing_opp < 1.01;

-- Итог ставки по ногам (кэфы — с двумя знаками, как у букмекеров)
CREATE TEMP TABLE perf_outcome ON COMMIT DROP AS
SELECT bid,
    round(exp(sum(ln(odds::float)))::numeric, 3) AS total_odds,
    exp(sum(CASE result WHEN 'win' THEN ln(odds::float) ELSE 0 END)) AS paid_odds,
    bool_or(result IS NULL) AS open,
    bool_or(result = 'loss') AS lost,
    bool_and(result = 'void') AS void,
    max(day) AS last_day,
    count(*) AS legs
FROM perf_leg GROUP BY bid;
"""

_BETS_SQL = """
INSERT INTO bets (id, user_id, analysis_id, placed_at, bookmaker, stake, currency, total_odds,
    status, profit, settled_at, settled_by, source, source_ref, kind, created_at, updated_at)
SELECT p.bid, p.user_id, NULL, p.placed_at, p.bookmaker, p.stake, 'RUB',
    least(999.999, o.total_odds),
    CASE WHEN o.open THEN 'open' WHEN o.lost THEN 'lost' WHEN o.void THEN 'void'
         ELSE 'won' END,
    CASE WHEN o.open THEN NULL WHEN o.lost THEN -p.stake WHEN o.void THEN 0
         ELSE round(CAST(p.stake * o.paid_odds AS numeric), 2) - p.stake END,
    CASE WHEN o.open THEN NULL
         ELSE greatest(p.placed_at + interval '2 hours',
                       CAST(o.last_day AS timestamptz) + interval '21 hours') END,
    CASE WHEN o.open THEN NULL WHEN p.source = 'legacy' THEN 'legacy' ELSE 'manual' END,
    p.source,
    CASE WHEN p.source = 'legacy' THEN 'perf-' || p.bid END,
    -- Вид ставки (Р29) — как в миграции 0012
    CASE WHEN p.source = 'legacy' THEN 'legacy' WHEN o.legs = 1 THEN 'single'
         ELSE 'strategy' END,
    p.placed_at, p.placed_at
FROM perf_bet AS p JOIN perf_outcome AS o ON o.bid = p.bid
"""

# Анализы ставок (одна ставка — один анализ) и анализы без ставки; у анализов последнего
# года — вызовы Claude. Подтвержденный ввод — события ног
_ANALYSES_SQL = """
CREATE TEMP TABLE perf_analysis ON COMMIT DROP AS
SELECT row_number() OVER (ORDER BY created_at, user_id, ref) AS aid, *
FROM (
    SELECT p.user_id, p.bid AS ref, p.placed_at - interval '15 minutes' AS created_at,
        'bet' AS decision
    FROM perf_bet AS p JOIN perf_outcome AS o ON o.bid = p.bid
    WHERE p.source = 'app' AND p.analysed
    UNION ALL
    SELECT u, -g, CAST(:today_ts AS timestamptz) - make_interval(
            secs => floor(pg_temp.rnd(u * 1000000 + g, 41) * 365 * 86400)::int),
        'skip'
    FROM (
        SELECT u, CASE WHEN u = 2 THEN :member_skip
                       WHEN u = 1 THEN :admin_analyses
                       WHEN u = 3 THEN 0
                       ELSE round(:other_analyses * (0.3 + 1.4 * pg_temp.rnd(u, 42)))::int
                  END AS total
        FROM generate_series(1, :members + 1) AS u
    ) AS w CROSS JOIN LATERAL generate_series(1, w.total) AS g
    UNION ALL
    SELECT 3, -g, CAST(:dense_from AS timestamptz)
        + make_interval(secs => floor(:dense_span * pg_temp.rnd(g, 43))::int),
        'skip'
    FROM generate_series(1, :dense_runs / 5) AS g
) AS a;

INSERT INTO analyses (id, user_id, input_text, input_kind, confirmed, bank_input, bookmaker,
    status, strategy_version_id, prompt_version, key_source, started_at, attempt, result,
    decision, finished_at, created_at, updated_at)
SELECT a.aid, a.user_id, 'Perf analysis ' || a.aid, 'form',
    jsonb_build_object('bank', '10000.00', 'bookmaker', 'Pinnacle', 'events',
        coalesce((
            SELECT jsonb_agg(jsonb_build_object(
                'position', l.k, 'player1_id', l.player1_id, 'player2_id', l.player2_id,
                'match_id', l.match_id, 'tournament_id', NULL, 'tournament_name', NULL,
                'surface', 'hard', 'best_of', l.best_of, 'round', '',
                'odds', jsonb_build_object('ML', jsonb_build_array(
                    CAST(l.odds AS text), '1.90'), 'HCP_-1.5', jsonb_build_array(NULL, NULL),
                    'HCP_+1.5', jsonb_build_array(NULL, NULL)),
                'bookmaker', 'Pinnacle', 'line_no', l.k) ORDER BY l.k)
            FROM perf_leg AS l WHERE l.bid = a.ref), '[]'::jsonb)),
    10000, 'Pinnacle', 'done', s.id, :prompt_version,
    CASE WHEN a.user_id > 3 AND a.user_id % 9 = 0 THEN 'own' ELSE 'admin' END,
    a.created_at, 1, '{}'::jsonb, a.decision, a.created_at + interval '3 minutes',
    a.created_at, a.created_at + interval '3 minutes'
FROM perf_analysis AS a
JOIN strategy_versions AS s ON s.user_id = a.user_id AND s.status = 'active';

UPDATE bets AS b SET analysis_id = a.aid
FROM perf_analysis AS a WHERE a.ref = b.id AND a.decision = 'bet';
"""

_PREDICTIONS_SQL = """
INSERT INTO predictions (id, user_id, analysis_id, match_id, market, selection, as_of,
    llm_model, effort, p_base, p_claude, p_final, q_market_at_pred, odds_at_pred,
    bookmaker_at_pred, value_at_pred, created_at)
SELECT l.lid, p.user_id, b.analysis_id, l.match_id, l.market, l.selection,
    p.placed_at - interval '20 minutes', 'claude-opus-5-5', 'medium',
    greatest(0.02, least(0.98, l.p_sel + (l.r_pred - 0.5) * 0.12)),
    greatest(0.02, least(0.98, l.p_sel + (l.r_pred - 0.45) * 0.1)),
    greatest(0.02, least(0.98, l.p_sel + (l.r_pred - 0.47) * 0.1)),
    CASE WHEN l.r_pred < 0.85 THEN greatest(0.02, least(0.98, 0.952 / l.odds::float)) END,
    l.odds, p.bookmaker,
    greatest(0.02, least(0.98, l.p_sel + (l.r_pred - 0.47) * 0.1)) * l.odds::float - 1,
    p.placed_at - interval '20 minutes'
FROM perf_leg AS l
JOIN perf_bet AS p ON p.bid = l.bid
JOIN bets AS b ON b.id = l.bid
WHERE b.analysis_id IS NOT NULL;

SELECT setval(pg_get_serial_sequence('predictions', 'id'), (SELECT max(id) FROM predictions));

-- Замены прогнозов (supersedes): каждая сотая, до начала матча
INSERT INTO predictions (user_id, analysis_id, match_id, market, selection, as_of, p_base,
    p_claude, p_final, q_market_at_pred, supersedes, created_at)
SELECT user_id, analysis_id, match_id, market, selection, as_of + interval '5 minutes',
    p_base, p_claude, least(0.98, p_final + 0.03), q_market_at_pred, id,
    created_at + interval '5 minutes'
FROM predictions WHERE id % 100 = 7 AND supersedes IS NULL
ORDER BY id
"""

_LEGS_SQL = """
INSERT INTO bet_legs (id, bet_id, match_id, market, selection, odds_taken, closing_odds,
    prediction_id, result, clv, score, settled_at, result_source, closing_opp_odds,
    closing_bookmaker, closing_source, q_close)
SELECT l.lid, l.bid, l.match_id, l.market, l.selection, l.odds, l.closing,
    CASE WHEN b.analysis_id IS NOT NULL THEN l.lid END,
    l.result,
    CASE WHEN l.closing IS NOT NULL THEN l.odds::float / l.closing::float - 1 END,
    CASE WHEN l.result IS NULL OR l.result = 'void' THEN NULL
         WHEN l.result = 'win' THEN (ARRAY['2:0', '2:1'])[1 + (l.lid % 2)]
         ELSE (ARRAY['0:2', '1:2'])[1 + (l.lid % 2)] END,
    CASE WHEN l.result IS NOT NULL THEN b.settled_at END,
    CASE WHEN l.result IS NULL THEN NULL WHEN b.source = 'legacy' THEN 'legacy'
         ELSE 'manual' END,
    l.closing_opp,
    CASE WHEN l.closing IS NOT NULL THEN 'pinnacle' END,
    CASE WHEN l.closing IS NOT NULL THEN 'user' END,
    CASE WHEN l.closing_opp IS NOT NULL
         THEN (1 / l.closing::float) / (1 / l.closing::float + 1 / l.closing_opp::float) END
FROM perf_leg AS l JOIN bets AS b ON b.id = l.bid
"""

# Журнал банка: пополнения (стартовое и раз в месяц), выводы, корректировки, ставки,
# выплаты и возвраты; у каждой 41-й выигранной ставки — исправление (выплата, сторно,
# новая выплата)
_LEDGER_SQL = """
INSERT INTO bankroll_ledger (user_id, at, kind, amount, currency, note, created_at)
SELECT b.user_id, CAST(:today_ts AS timestamptz) - make_interval(days => b.span_days + 1),
    'deposit', CASE WHEN b.user_id = 2 THEN 100000 ELSE 20000 END, 'RUB', 'perf',
    CAST(:today_ts AS timestamptz) - make_interval(days => b.span_days + 1)
FROM perf_bettor AS b
ORDER BY b.user_id;

INSERT INTO bankroll_ledger (user_id, at, kind, amount, currency, note, created_at)
SELECT 2, d, kind, amount, 'RUB', 'perf', d
FROM (
    SELECT CAST(:today_ts AS timestamptz) - make_interval(days => g * 30) + interval '9 hours'
            AS d,
        CASE WHEN g % 4 = 0 THEN 'withdrawal' WHEN g % 9 = 0 THEN 'correction'
             ELSE 'deposit' END AS kind,
        CASE WHEN g % 4 = 0 THEN -3000 WHEN g % 9 = 0 THEN 50 ELSE 5000 END AS amount
    FROM generate_series(1, :member_days / 30) AS g
) AS x
ORDER BY d;

INSERT INTO bankroll_ledger (user_id, at, kind, amount, currency, bet_id, created_at)
SELECT user_id, placed_at, 'stake', -stake, 'RUB', id, placed_at FROM bets ORDER BY id;

INSERT INTO bankroll_ledger (user_id, at, kind, amount, currency, bet_id, created_at)
SELECT user_id, settled_at, CASE status WHEN 'won' THEN 'payout' ELSE 'refund' END,
    stake + profit, 'RUB', id, settled_at
FROM bets WHERE status IN ('won', 'void')
ORDER BY id;

CREATE TEMP TABLE perf_fix ON COMMIT DROP AS
SELECT l.id AS payout_id, l.user_id, l.at, l.amount, l.bet_id
FROM bankroll_ledger AS l JOIN bets AS b ON b.id = l.bet_id
WHERE l.kind = 'payout' AND b.source = 'app' AND b.id % 41 = 0;

INSERT INTO bankroll_ledger (user_id, at, kind, amount, currency, bet_id, note, created_at)
SELECT user_id, at + interval '1 hour', 'reversal', -amount, 'RUB', bet_id,
    'perf-fix-' || payout_id, at + interval '1 hour'
FROM perf_fix
ORDER BY payout_id;

UPDATE bankroll_ledger AS l SET reversed_by = r.id
FROM bankroll_ledger AS r
WHERE r.note = 'perf-fix-' || l.id AND l.id IN (SELECT payout_id FROM perf_fix);

INSERT INTO bankroll_ledger (user_id, at, kind, amount, currency, bet_id, created_at)
SELECT user_id, at + interval '2 hours', 'payout', amount, 'RUB', bet_id,
    at + interval '2 hours'
FROM perf_fix
ORDER BY payout_id;

UPDATE bets AS b SET updated_at = f.at + interval '2 hours'
FROM perf_fix AS f WHERE f.bet_id = b.id
"""

# Вызовы Claude: 5 на анализ последнего года (разбор, 2 новостей, 2 анализа), общие задачи
# без участника, проверки (eval) администратора. Цена — по токенам и примерным ценам
_RUNS_SQL = """
INSERT INTO eval_runs (version_kind, strategy_version_id, eval_set, split, n_events,
    metrics, cost_usd, created_at)
SELECT 'strategy', s.id, 'perf-smoke', 'test', 40, '{"kind": "smoke"}'::jsonb, 0,
    CAST(:today_ts AS timestamptz) - make_interval(days => g * 60)
FROM strategy_versions AS s CROSS JOIN generate_series(0, 4) AS g
WHERE s.user_id = 1
ORDER BY s.id, g;

INSERT INTO agent_runs (user_id, key_source, analysis_id, kind, step, model, effort,
    prompt_version, schema_version, input_tokens, cache_write_tokens, cache_write_5m_tokens,
    cache_read_tokens, output_tokens, web_searches, cost_usd, duration_ms, stop_reason,
    error, created_at)
SELECT a.user_id, an.key_source, a.aid, k.kind, k.step, k.model, k.effort, k.prompt, 'v1',
    tokens_in, cache_w, cache_w, cache_r, tokens_out, k.searches,
    round(CAST((tokens_in * k.p_in + cache_w * k.p_in * 1.25 + cache_r * k.p_in * 0.1
                + tokens_out * k.p_out) / 1000000 + k.searches * 0.01 AS numeric), 6),
    800 + floor(r * 40000)::int,
    CASE WHEN r < 0.01 THEN 'max_tokens' ELSE 'end_turn' END,
    CASE WHEN r > 0.985 THEN 'overloaded' END,
    a.created_at + make_interval(secs => k.step * 20 + k.n)
FROM perf_analysis AS a
JOIN analyses AS an ON an.id = a.aid
CROSS JOIN LATERAL (VALUES
    ('parse', 0, 'claude-haiku-5-5', 'low', 'parse_input.v1', 0, 1.0, 5.0, 0),
    ('news', 1, 'claude-sonnet-5-5', 'low', 'news.v2', 1, 3.0, 15.0, 1),
    ('news', 2, 'claude-sonnet-5-5', 'low', 'news.v2', 1, 3.0, 15.0, 2),
    ('analysis', 1, 'claude-opus-5-5', 'medium', 'analysis.v1', 0, 5.0, 25.0, 3),
    ('analysis', 2, 'claude-opus-5-5', 'medium', 'analysis.v1', 0, 5.0, 25.0, 4)
) AS k(kind, step, model, effort, prompt, searches, p_in, p_out, n)
CROSS JOIN LATERAL (
    SELECT pg_temp.rnd(a.aid * 8 + k.n, 51) AS r,
        800 + floor(pg_temp.rnd(a.aid * 8 + k.n, 52) * 3000)::int AS tokens_in,
        CASE WHEN k.kind = 'analysis' AND k.step = 1 THEN 6000 ELSE 0 END AS cache_w,
        CASE WHEN k.kind = 'analysis' AND k.step = 2 THEN 6000
             ELSE floor(pg_temp.rnd(a.aid * 8 + k.n, 53) * 4000)::int END AS cache_r,
        200 + floor(pg_temp.rnd(a.aid * 8 + k.n, 54) * 1500)::int AS tokens_out
) AS x
WHERE a.created_at >= CAST(:today_ts AS timestamptz) - interval '365 days'
ORDER BY a.aid, k.n;

INSERT INTO agent_runs (user_id, key_source, kind, step, model, effort, input_tokens,
    cache_read_tokens, output_tokens, web_searches, cost_usd, duration_ms, stop_reason,
    created_at)
SELECT NULL, 'admin', 'news', 0, 'claude-sonnet-5-5', 'low',
    1000 + floor(pg_temp.rnd(g, 61) * 2000)::int, 2000, 600, 1,
    round(CAST(0.01 + pg_temp.rnd(g, 62) * 0.05 AS numeric), 6), 9000, 'end_turn',
    CAST(:today_ts AS timestamptz) - make_interval(
        secs => floor(pg_temp.rnd(g, 63) * 365 * 86400)::int)
FROM generate_series(1, :shared_runs) AS g
ORDER BY g;

INSERT INTO agent_runs (user_id, key_source, eval_run_id, kind, step, model, effort,
    input_tokens, cache_read_tokens, output_tokens, cost_usd, duration_ms, stop_reason,
    created_at)
SELECT 1, 'admin', e.id, 'eval', 0, 'claude-opus-5-5', 'medium', 2000, 6000, 900,
    round(CAST(0.02 + pg_temp.rnd(g, 71) * 0.08 AS numeric), 6), 20000, 'end_turn',
    e.created_at + make_interval(secs => g)
FROM eval_runs AS e CROSS JOIN generate_series(1, :eval_per_run) AS g
ORDER BY e.id, g;

UPDATE analyses AS an SET cost_usd = r.cost
FROM (SELECT analysis_id, sum(cost_usd) AS cost FROM agent_runs
      WHERE analysis_id IS NOT NULL GROUP BY analysis_id) AS r
WHERE r.analysis_id = an.id
"""

# Этап 5 (волна 4): обучение модели — общая линия инструкций (v3 действует, v4 «экономия»
# — кандидат), свой кандидат правил суммы участника load, 40 общих уроков всех статусов,
# разборы матчей рассчитанных ставок load за 120 дней, замороженный набор на 250 матчей
# архива и законченные прогоны (v3 дважды — порог шума, v4 один раз), 8 версий калибровки
# базовой модели (последняя действует), 52 еженедельных отчета load, загрузки файла
_LEARNING_SQL = """
INSERT INTO strategy_versions (user_id, code, name, params, prompt_version, status, goal,
    approved_at, created_at)
VALUES (NULL, 'v3', 'v3', '{}'::jsonb, :prompt_version, 'active', 'quality',
    CAST(:today_ts AS timestamptz) - interval '800 days',
    CAST(:today_ts AS timestamptz) - interval '800 days');

INSERT INTO strategy_versions (user_id, code, name, params, prompt_version, status, goal,
    parent_id, changes, created_at)
SELECT NULL, 'v4', 'v4', '{}'::jsonb, :prompt_version, 'candidate', 'saving', id,
    ARRAY['perf'], CAST(:today_ts AS timestamptz) - interval '3 days'
FROM strategy_versions WHERE user_id IS NULL AND code = 'v3';

INSERT INTO strategy_versions (user_id, code, name, params, prompt_version, status, goal,
    parent_id, changes, created_at)
SELECT 2, 'v4', 'v4', CAST(:params AS jsonb), :prompt_version, 'candidate', 'rules', id,
    ARRAY['perf'], CAST(:today_ts AS timestamptz) - interval '1 day'
FROM strategy_versions WHERE user_id = 2 AND status = 'active';

INSERT INTO lessons (user_id, code, text, scope, kind, status, n_cases, n_hist, effect,
    effect_ci, effect_shrunk, in_prompt, origin, validated_at, decided_at, metrics,
    created_at)
SELECT NULL, 'L-' || lpad(g::text, 3, '0'), 'Perf lesson ' || g, CAST(:scope AS jsonb),
    'numeric', (ARRAY['hypothesis', 'ready', 'confirmed', 'rejected', 'retired'])[1 + g % 5],
    3 + g % 30, 200 + g * 7, -0.01, ARRAY[-0.02, 0.0], -0.005, g % 5 = 2 AND g <= 12,
    'postmortem',
    CASE WHEN g % 5 IN (1, 2) THEN CAST(:today_ts AS timestamptz) - make_interval(days => g) END,
    CASE WHEN g % 5 = 2 THEN CAST(:today_ts AS timestamptz) - make_interval(days => g) END,
    jsonb_build_object('own', jsonb_build_object('leg_ids', jsonb_build_array(g * 10, g * 10 + 1))),
    CAST(:today_ts AS timestamptz) - make_interval(days => g * 2)
FROM generate_series(1, 40) AS g;

INSERT INTO postmortems (match_id, prediction_id, bet_id, user_id, status, verdict, summary,
    why, side, winner, created_at)
SELECT DISTINCT ON (l.match_id) l.match_id, l.prediction_id, l.bet_id, 2, 'done',
    (ARRAY['fine', 'luck', 'model_error'])[1 + l.id % 3], 'Perf summary', 'Perf why', 1,
    CASE WHEN l.result = 'win' THEN l.selection ELSE 3 - l.selection END,
    b.settled_at + interval '1 hour'
FROM bet_legs AS l JOIN bets AS b ON b.id = l.bet_id
WHERE b.user_id = 2 AND b.source = 'app' AND l.prediction_id IS NOT NULL
    AND l.result IN ('win', 'loss')
    AND b.settled_at >= CAST(:today_ts AS timestamptz) - interval '120 days'
ORDER BY l.match_id, l.id;

INSERT INTO eval_sets (code, frozen_at, sha256, n_events, since, rules, created_at)
VALUES ('perf-eval', CAST(:today_ts AS timestamptz) - interval '10 days', repeat('0', 64), 250,
    CAST(:today AS date) - 75, '{}'::jsonb,
    CAST(:today_ts AS timestamptz) - interval '10 days');

INSERT INTO eval_set_items (eval_set_id, match_id, split, hard, with_news)
SELECT s.id, m.id, 'test', m.id % 6 = 0, false
FROM eval_sets AS s
CROSS JOIN LATERAL (
    SELECT id FROM matches
    WHERE winner_id IS NOT NULL AND match_date < CAST(:today AS date) - 1
    ORDER BY match_date DESC, id LIMIT 250
) AS m
WHERE s.code = 'perf-eval';

CREATE TEMP TABLE perf_eval_events ON COMMIT DROP AS
SELECT i.match_id, m.match_date, (i.match_id % 2) AS y, pg_temp.rnd(i.match_id, 91) AS r
FROM eval_set_items AS i JOIN matches AS m ON m.id = i.match_id;

INSERT INTO eval_runs (version_kind, strategy_version_id, eval_set, eval_set_id, split, n_events,
    repeat_no, status, metrics, cost_usd, created_at)
SELECT 'strategy', v.id, 'perf-eval', s.id, 'test', 250, r.repeat_no, 'done',
    jsonb_build_object(
        'kind', 'eval', 'worst_usd', '19.00',
        'summary', jsonb_build_object(
            'n', 250, 'total', 250, 'unrated', 0, 'format_errors', 0, 'max_tokens', 0,
            'refusals', 0, 'log_loss', 0.6 + r.shift, 'brier', 0.21 + r.shift / 2,
            'ece', 0.03, 'cost_usd', '3.00', 'tokens_per_event', 9000 - r.shift * 100000,
            'cost_per_event_usd', '0.012', 'market_n', 250, 'log_loss_market', 0.59,
            'brier_market', 0.205,
            'vs_market', jsonb_build_object('value', 0.01, 'low', -0.01, 'high', 0.03,
                'n', 250)),
        'events', (
            SELECT jsonb_object_agg(e.match_id::text, jsonb_build_object(
                'match_id', e.match_id, 'day', e.match_date, 'y', e.y, 'outcome', 'ok',
                'p_claude', greatest(0.05, least(0.95,
                    CASE WHEN e.y = 1 THEN 0.45 + 0.4 * e.r ELSE 0.15 + 0.4 * e.r END
                    + r.shift)),
                'decisions', '[]'::jsonb))
            FROM perf_eval_events AS e)),
    3, CAST(:today_ts AS timestamptz) - make_interval(days => 9 - r.repeat_no)
FROM eval_sets AS s
CROSS JOIN (VALUES ('v3', 1, 0.0), ('v3', 2, 0.002), ('v4', 1, -0.003))
    AS r(code, repeat_no, shift)
JOIN strategy_versions AS v ON v.user_id IS NULL AND v.code = r.code
WHERE s.code = 'perf-eval'
ORDER BY r.code, r.repeat_no;

INSERT INTO ml_models (id, kind, train_from, train_to, params, metrics, status, activated_at,
    created_at)
SELECT 'elo-v1@' || to_char(CAST(:today AS date) - g * 7, 'YYYY-MM-DD'), 'calibration',
    CAST(:today AS date) - 730 - g * 7, CAST(:today AS date) - 1 - g * 7,
    jsonb_build_object('platt', jsonb_build_object('a', 1.0 + g / 100.0, 'b', 0.0)),
    jsonb_build_object(
        'brier', 0.2 + g / 1000.0, 'log_loss', 0.58 + g / 1000.0, 'ece', 0.02,
        'n_train', 20000, 'n_holdout', 6000,
        'walk_forward', (
            SELECT jsonb_agg(jsonb_build_object(
                'month', to_char(date_trunc('month', CAST(:today AS date)) - make_interval(
                    months => k), 'YYYY-MM-DD'),
                'n', 1500, 'model_brier', 0.2 + k / 1000.0, 'model_log_loss', 0.58,
                'market_n', 1400, 'market_brier', 0.198) ORDER BY k)
            FROM generate_series(1, 6) AS k),
        'calibration', (
            SELECT jsonb_agg(jsonb_build_object(
                'low', k / 10.0, 'high', (k + 1) / 10.0, 'n', 500, 'p', k / 10.0 + 0.05,
                'actual', k / 10.0 + 0.04, 'ci_low', k / 10.0, 'ci_high', k / 10.0 + 0.08)
                ORDER BY k)
            FROM generate_series(0, 9) AS k)),
    CASE WHEN g = 0 THEN 'active' ELSE 'archived' END,
    CAST(:today_ts AS timestamptz) - make_interval(days => g * 7),
    CAST(:today_ts AS timestamptz) - make_interval(days => g * 7)
FROM generate_series(0, 7) AS g;

INSERT INTO weekly_reports (user_id, week_start, payload, created_at)
SELECT 2, CAST(:report_monday AS date) - g * 7, CAST(:report_payload AS jsonb),
    CAST(:today_ts AS timestamptz) - make_interval(days => g * 7)
FROM generate_series(1, 52) AS g;

INSERT INTO data_uploads (uploaded_by, filename, size_bytes, sha256, year, status, report,
    started_at, finished_at, created_at)
SELECT 1, '2026.xlsx', 1500000, md5(g::text) || md5((g + 1000)::text), 2026, 'done',
    '{}'::jsonb, CAST(:today_ts AS timestamptz) - make_interval(days => g * 7),
    CAST(:today_ts AS timestamptz) - make_interval(days => g * 7) + interval '2 minutes',
    CAST(:today_ts AS timestamptz) - make_interval(days => g * 7)
FROM generate_series(1, 30) AS g
"""

_ACTIVITY_SQL = """
INSERT INTO login_events (user_id, at, ip, user_agent, result, method)
SELECT u, CAST(:today_ts AS timestamptz) - make_interval(
        secs => floor(pg_temp.rnd(u * 1000 + g, 81) * 90 * 86400)::int),
    CAST('10.1.0.' || u AS inet), 'Mozilla/5.0 perf',
    CASE WHEN pg_temp.rnd(u * 1000 + g, 82) < 0.05 THEN 'bad_password' ELSE 'ok' END,
    'password'
FROM generate_series(1, :members + 1) AS u CROSS JOIN generate_series(1, 180) AS g;

INSERT INTO notifications (user_id, kind, title, body, params, link, read_at, created_at)
SELECT CASE WHEN g % 3 = 0 THEN 1 ELSE 2 END,
    CASE WHEN g % 3 = 0 THEN 'ai_alert' ELSE 'limit_80' END,
    'Perf ' || g, '', '{}'::jsonb, NULL,
    CASE WHEN g > 20 THEN CAST(:today_ts AS timestamptz) END,
    CAST(:today_ts AS timestamptz) - make_interval(hours => g * 7)
FROM generate_series(1, 400) AS g;

INSERT INTO admin_audit_log (at, actor_id, action, target_user_id, details)
SELECT CAST(:today_ts AS timestamptz) - make_interval(hours => g * 5), 1,
    (ARRAY['invite', 'limit_change', 'budget_change', 'message', 'block', 'unblock'])
        [1 + g % 6],
    2 + g % :members, '{}'::jsonb
FROM generate_series(1, 500) AS g
"""

_SEQUENCES = (
    "players",
    "tournaments",
    "matches",
    "users",
    "bets",
    "bet_legs",
    "predictions",
    "analyses",
)

# Отпечаток данных сида: деловые колонки (без меток времени записи)
_DIGEST_SQL = """
SELECT md5(string_agg(part, '|' ORDER BY name)) FROM (
    SELECT 'players' AS name, md5(string_agg(concat_ws(',', id, name, name_ru, country), ';'
        ORDER BY id)) AS part FROM players
    UNION ALL SELECT 'matches', md5(string_agg(concat_ws(',', id, tournament_id, round,
        player1_id, player2_id, winner_id, score, status, match_date, scheduled_at), ';'
        ORDER BY id)) FROM matches
    UNION ALL SELECT 'match_stats', md5(string_agg(concat_ws(',', match_id, player_id, aces,
        first_in, first_won), ';' ORDER BY match_id, player_id)) FROM match_stats
    UNION ALL SELECT 'elo', md5(string_agg(concat_ws(',', player_id, round(elo_all::numeric, 6),
        rank_all, last_match, matches_52w), ';' ORDER BY player_id)) FROM player_elo_current
    UNION ALL SELECT 'bets', md5(string_agg(concat_ws(',', id, user_id, analysis_id,
        placed_at, stake, total_odds, status, profit, settled_at, source), ';' ORDER BY id))
        FROM bets
    UNION ALL SELECT 'bet_legs', md5(string_agg(concat_ws(',', id, bet_id, match_id, market,
        selection, odds_taken, closing_odds, closing_opp_odds, result, score), ';'
        ORDER BY id)) FROM bet_legs
    UNION ALL SELECT 'predictions', md5(string_agg(concat_ws(',', id, match_id, p_final,
        q_market_at_pred, supersedes), ';' ORDER BY id)) FROM predictions
    UNION ALL SELECT 'ledger', md5(string_agg(concat_ws(',', id, user_id, at, kind, amount,
        bet_id, reversed_by), ';' ORDER BY id)) FROM bankroll_ledger
    UNION ALL SELECT 'agent_runs', md5(string_agg(concat_ws(',', id, user_id, analysis_id,
        kind, step, model, cost_usd, created_at), ';' ORDER BY id)) FROM agent_runs
    UNION ALL SELECT 'analyses', md5(string_agg(concat_ws(',', id, user_id, created_at,
        decision, cost_usd, confirmed), ';' ORDER BY id)) FROM analyses
) AS parts
"""

_COUNT_TABLES = (
    "players",
    "tournaments",
    "matches",
    "match_stats",
    "player_ratings",
    "player_elo_current",
    "users",
    "bets",
    "bet_legs",
    "predictions",
    "bankroll_ledger",
    "analyses",
    "agent_runs",
    "lessons",
    "postmortems",
    "eval_runs",
    "ml_models",
    "weekly_reports",
)


def _statements(sql: str) -> list[str]:
    """Отдельные операторы SQL (asyncpg не принимает несколько в одном запросе). Точка с
    запятой в конце строки — конец оператора (внутри операторов их нет)."""
    parts = re.split(r";\s*\n", sql.strip())
    return [part.strip().rstrip(";") for part in parts if part.strip()]


_PARAM = re.compile(r"(?<![:\w]):([a-z_]+)")


async def _run(db: AsyncSession, sql: str, params: dict[str, Any]) -> None:
    """Операторы sql по очереди. Целые параметры (объемы сида) подставляются в текст
    числом: у PostgreSQL нет типа для выражения из двух параметров ($1 * $2), а даты и
    строки идут параметрами."""
    for statement in _statements(sql):
        names = set(_PARAM.findall(statement))
        literal = {key for key in names if isinstance(params[key], int)}

        def number(found: re.Match[str], literal: set[str] = literal) -> str:
            return str(params[found[1]]) if found[1] in literal else found[0]

        body = _PARAM.sub(number, statement)
        await db.execute(text(body), {key: params[key] for key in names - literal})


def _params(sizes: Sizes, today: date) -> dict[str, Any]:
    first_day = date(today.year - sizes.years, today.month, 1)
    span_days = (today - first_day).days + 3
    # Плотный месяц — с 1-го числа до начала сегодняшнего дня (1-го числа — весь день)
    month_start = today.replace(day=1)
    dense_days = max(1, (today - month_start).days)
    return {
        "today": today,
        "today_ts": datetime.combine(today, time(), tzinfo=UTC),
        "dense_from": datetime.combine(month_start, time(), tzinfo=UTC),
        "dense_span": dense_days * 86400,
        "first_day": first_day,
        "span_days": span_days,
        "tournaments": sizes.tournaments,
        "per_tournament": sizes.matches_per_tournament,
        "players": sizes.players,
        "members": sizes.members,
        "member_bets": sizes.member_bets,
        "member_days": sizes.member_days,
        "other_bets": sizes.other_bets,
        "member_skip": sizes.member_skip_analyses,
        "other_analyses": sizes.other_analyses,
        "admin_analyses": sizes.admin_analyses,
        "shared_runs": sizes.shared_runs,
        "eval_per_run": max(1, sizes.eval_runs // 5),
        "dense_runs": sizes.dense_runs,
        "news_players": min(sizes.news_players, sizes.players),
        "tz": PERF_TZ,
    }


async def seed(
    maker: async_sessionmaker[AsyncSession],
    *,
    today: date,
    sizes: Sizes = Sizes(),  # noqa: B008 — неизменяемый dataclass
    seed_value: int = 42,
    progress: Any = None,
) -> SeedResult:
    """Заполнить пустую базу сидом (одна транзакция на данные, затем шаг elo) и вернуть
    число строк по таблицам и отпечаток. today — день, от которого считаются даты
    (сегодня по UTC в замере)."""
    params = _params(sizes, today)
    params["password_hash"] = await hash_password_async(PERF_PASSWORD)
    params["params"] = json.dumps(StrategyParams().to_params())
    params["prompt_version"] = current_prompt_version()
    params["scope"] = json.dumps(PERF_SCOPE)
    params["report_monday"] = today - timedelta(days=today.weekday())
    params["report_payload"] = json.dumps(_report_payload())

    def say(step: str) -> None:
        if progress is not None:
            progress(step)

    async with maker() as db:
        await check_empty(db)
        await db.execute(text("SET LOCAL TimeZone = 'UTC'"))
        await db.execute(text("SET LOCAL synchronous_commit = off"))
        await db.execute(text(_RND_SQL.format(seed=int(seed_value))))
        await db.execute(
            text(
                "INSERT INTO players (id, name, name_ru, country, created_at, updated_at)"
                " VALUES (:id, :name, :name_ru, :country, :at, :at)"
            ),
            [{**row, "at": params["today_ts"]} for row in player_rows(sizes.players)],
        )
        say("players")
        for name, sql in (
            ("tournaments", _TOURNAMENTS_SQL),
            ("matches", _MATCHES_SQL),
            ("match_stats", _STATS_SQL),
            ("news", _NEWS_SQL + ";\n" + _INGESTION_SQL),
            ("users", _USERS_SQL + ";\n" + _STRATEGY_SQL + ";\n" + _LIMITS_SQL),
            ("plan", _PLAN_SQL),
            ("bets", _BETS_SQL),
            ("analyses", _ANALYSES_SQL),
            ("predictions", _PREDICTIONS_SQL),
            ("legs", _LEGS_SQL),
            ("ledger", _LEDGER_SQL),
            ("runs", _RUNS_SQL),
            ("learning", _LEARNING_SQL),
            ("activity", _ACTIVITY_SQL),
        ):
            await _run(db, sql, params)
            say(name)
        for table in _SEQUENCES:
            await db.execute(
                text(
                    f"SELECT setval(pg_get_serial_sequence('{table}', 'id'),"
                    f" (SELECT coalesce(max(id), 0) + 1 FROM {table}), false)"
                )
            )
        await db.commit()
    await elo.rebuild_ratings(db_factory=maker, today=today)
    say("elo")
    async with maker() as db:
        await db.execute(text("ANALYZE"))
        await db.commit()
        counts = await table_counts(db)
        digest = await seed_digest(db)
    return SeedResult(counts=counts, digest=digest)


async def table_counts(db: AsyncSession, tables: Sequence[str] = _COUNT_TABLES) -> dict[str, int]:
    return {
        table: int(await db.scalar(text(f"SELECT count(*) FROM {table}")) or 0) for table in tables
    }


async def seed_digest(db: AsyncSession) -> str:
    """Отпечаток деловых колонок сида: одинаковый при одинаковых seed и today."""
    return str(await db.scalar(text(_DIGEST_SQL)))
