"""Команды приемки этапа 3 (PLAN.md, этап 3, «Готово, когда»):

    python -m app.admin.cli acceptance-runs [--count 20] [--email АДМИН] [--yes] [--report ПУТЬ]
    python -m app.admin.cli smoke-eval [--events 40] [--since 2026-08-01] [--yes] [--no-wait]
    python -m app.admin.cli smoke-eval --resume ID [--no-wait]
    python -m app.admin.cli parse-eval --file ПАРЫ.json [--yes] [--report ПУТЬ]
    python -m app.admin.cli parse-eval --draft --from-telegram result.json --out ПАРЫ.json

Каждая команда до вызовов печатает оценку цены и худший случай, проверяет бюджет (общий
бюджет ключа администратора — acceptance-runs; бюджет проверок eval_budget_usd с уже
потраченным за месяц — smoke-eval и parse-eval) и спрашивает подтверждение (--yes — без
вопроса). Каждый вызов Claude — строка agent_runs. Отчет Markdown — в файл --report
(bash deploy/local.sh сохраняет его в deploy/reports/).

Коды возврата: 0 — приемка пройдена; 1 — критерий не выполнен (отчет все равно
пишется) или команда не выполнена; 2 — запуск отменен ответом «нет»; 3 — пробный
прогон: критерии выполнены, но выборка меньше, чем в PLAN.md (20 анализов, 40 событий
после даты среза знаний модели, 50 сообщений), и приемкой это не считается;
130 — прервано (Ctrl+C), у acceptance-runs отчет пишется по законченным анализам.

Скрытые ключи для bash deploy/local.sh: --local-sh (путь отчета печатает обертка,
подсказки — командами обертки) и --file-label/--out-label (имена файлов, как их видит
владелец, а не временные пути в контейнере).

Логика — в app/services/acceptance_runs.py, smoke_eval.py и parse_eval.py; здесь
аргументы, вывод и отчет.
"""

import argparse
import asyncio
import json
import shlex
from collections.abc import Sequence
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

from anthropic.types.messages import MessageBatch
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.admin.terminal import EXIT_CANCELLED, EXIT_TRIAL, CliError, confirmed, say
from app.agent.client import client_for
from app.agent.config import AgentConfig, load_agent_config
from app.agent.errors import ClaudeStepError
from app.agent.runs import price_for
from app.core.i18n import t
from app.core.redis import create_redis
from app.db.models import EvalRun, StrategyVersion
from app.db.session import create_engine, create_sessionmaker
from app.ml.report import num, pct
from app.services import acceptance_runs, check_runs, parse_eval, smoke_eval
from app.services.agent_smoke import failure_text
from app.services.ai_access import access_for
from app.services.app_settings import get_app_settings
from app.services.claude_key import key_for
from app.services.sessions import utcnow
from app.services.strategy_versions import ensure_shared_ready, system_prompt_of

MAX_RUNS = 50
MAX_EVENTS = 200
MAX_DRAFT = 500
DEFAULT_SINCE = date(2026, 8, 1)
# Приемка разбора — на 50–150 эталонных сообщениях (PLAN.md, этап 3)
ACCEPTANCE_PAIRS = 50
# Тайм-аут запросов Batch API (создание, опрос, результаты)
BATCH_TIMEOUT_S = 120.0
# Прогресс разбора — каждые столько сообщений
PARSE_PROGRESS_EVERY = 10

Maker = async_sessionmaker[AsyncSession]


# --- общее ---


def _usd(value: Decimal | float | None, digits: int = 4) -> str:
    return num(None if value is None else float(value), digits)


def _dollars(value: Decimal | None) -> str:
    """Сумма со знаком доллара; нет значения — прочерк без знака."""
    return "—" if value is None else "$" + _usd(value)


def _verdict(ok: bool) -> str:
    return t("cli.acceptance.ok" if ok else "cli.acceptance.not_ok")


def _no_admin(email: str | None) -> CliError:
    if email:
        return CliError("acceptance.no_admin_email", email=email)
    return CliError("acceptance.no_admin")


def _claude_failed(exc: ClaudeStepError) -> CliError:
    return CliError("acceptance.claude_failed", message=failure_text(exc))


def _cancel() -> CliError:
    return CliError("cancelled", exit_code=EXIT_CANCELLED)


def _write_report(args: argparse.Namespace, text: str) -> None:
    path: str | None = args.report
    if not path:
        return
    try:
        Path(path).write_text(text, encoding="utf-8")
    except OSError:
        raise CliError("acceptance.report_write", path=path) from None
    # Через bash deploy/local.sh путь в контейнере не нужен: обертка печатает свой
    if not args.local_sh:
        say(t("cli.acceptance.report_saved", path=path))


def _shown(path: str, label: str | None) -> str:
    """Имя файла для вывода и отчета: как его видит владелец (метка обертки) или путь."""
    return label or path


def _command(args: argparse.Namespace, local: str, direct: str) -> str:
    """Команда для подсказки: через обертку на своем компьютере или прямая."""
    return local if args.local_sh else direct


def _trial_or_pass(*, trial: bool, trial_key: str, passed_key: str, **params: Any) -> None:
    """Критерии выполнены: на выборке из PLAN.md — приемка (код 0), на меньшей — пробный
    прогон (код 3). Ключи — без «cli.»."""
    if trial:
        raise CliError(trial_key, exit_code=EXIT_TRIAL, **params)
    say(t(f"cli.{passed_key}", **params))


def _save_json(path: str, data: Any, shown: str) -> None:
    try:
        Path(path).write_text(
            json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
    except OSError:
        raise CliError("acceptance.report_write", path=shown) from None


def _read_json(path: str, shown: str) -> Any:
    try:
        raw = Path(path).read_text(encoding="utf-8-sig")
    except OSError:
        raise CliError("acceptance.read_failed", path=shown) from None
    try:
        return json.loads(raw)
    except ValueError:
        raise CliError("acceptance.not_json", path=shown) from None


def _md_table(header: Sequence[str], rows: Sequence[Sequence[str]]) -> str:
    def line(cells: Sequence[str]) -> str:
        return "| " + " | ".join(cell.replace("|", "/") for cell in cells) + " |"

    return "\n".join([line(header), line(["---"] * len(header)), *(line(row) for row in rows)])


def _date_arg(value: str) -> date:
    try:
        return date.fromisoformat(value)
    except ValueError:
        raise argparse.ArgumentTypeError(t("cli.acceptance.date_format", value=value)) from None


def _engine_maker() -> tuple[Any, Maker]:
    engine = create_engine()
    return engine, create_sessionmaker(engine)


# --- acceptance-runs ---


def _duration(seconds: float | None) -> str:
    if seconds is None:
        return "—"
    whole = round(seconds)
    if whole < 60:
        return t("cli.acceptance.runs.seconds", seconds=whole)
    return t("cli.acceptance.runs.minutes", minutes=whole // 60, seconds=whole % 60)


def _print_step(step: dict[str, Any]) -> None:
    kind = str(step.get("kind") or "")
    match = step.get("match_id")
    searches = int(step.get("web_searches") or 0)
    say(
        t(
            "cli.acceptance.runs.step",
            step=t(f"cli.acceptance.runs.steps.{kind}"),
            match=t("cli.acceptance.runs.step_match", match=match) if match else "",
            state=t(f"cli.acceptance.runs.states.{step.get('state')}"),
            seconds=num(int(step.get("elapsed_ms") or 0) / 1000, 1),
            usd=_usd(Decimal(str(step.get("cost_usd") or "0"))),
            searches=t("cli.acceptance.runs.step_searches", count=searches) if searches else "",
        )
    )


def _error_text(result: acceptance_runs.RunResult) -> str:
    if result.error_code is None:
        return "—"
    return t(f"errors.{result.error_code}", **result.error_params)


def _news_cell(result: acceptance_runs.RunResult) -> str:
    """Новости прогона: сколько матчей с новостями, найденными сейчас, и остальные."""
    parts = [
        t(
            "cli.acceptance.runs.news_found",
            found=result.news.get(acceptance_runs.NEWS_FOUND, 0),
            total=len(result.match_ids),
        )
    ]
    for state in acceptance_runs.NEWS_STATES[1:]:
        if result.news.get(state):
            parts.append(t(f"cli.acceptance.runs.news_states.{state}", count=result.news[state]))
    return "; ".join(parts)


def _run_line(result: acceptance_runs.RunResult) -> str:
    if result.done:
        return t(
            "cli.acceptance.runs.run_done",
            duration=_duration(result.duration_s),
            usd=_usd(result.cost_usd),
            alone=_usd(result.alone_cost_usd),
            cache=pct(result.cache_share),
            news=_news_cell(result),
            analysis=result.analysis_id,
        )
    return t(
        "cli.acceptance.runs.run_failed",
        message=_error_text(result),
        step=result.failed_step or "—",
        usd=_usd(result.cost_usd),
        analysis=result.analysis_id,
    )


def _criteria(summary: acceptance_runs.SeriesSummary) -> list[list[str]]:
    return [
        [
            t("cli.acceptance.runs.criteria.p90"),
            t("cli.acceptance.runs.criteria.p90_goal"),
            _duration(summary.p90_s),
            _verdict(summary.p90_ok),
        ],
        [
            t("cli.acceptance.runs.criteria.cost"),
            t("cli.acceptance.runs.criteria.cost_goal"),
            _dollars(summary.mean_cost_usd),
            _verdict(summary.cost_ok),
        ],
        [
            t("cli.acceptance.runs.criteria.cache"),
            t("cli.acceptance.runs.criteria.cache_goal"),
            pct(summary.cache_share),
            _verdict(summary.cache_ok),
        ],
        [
            t("cli.acceptance.runs.criteria.errors"),
            t("cli.acceptance.runs.criteria.errors_goal"),
            t(
                "cli.acceptance.runs.criteria.errors_value",
                done=summary.done,
                runs=summary.planned,
            ),
            _verdict(summary.errors == 0 and summary.runs > 0 and summary.complete),
        ],
        [
            t("cli.acceptance.runs.criteria.news"),
            t("cli.acceptance.runs.criteria.news_goal"),
            t(
                "cli.acceptance.runs.criteria.news_value",
                found=summary.news_found,
                total=summary.news_matches,
            ),
            _verdict(summary.news_ok),
        ],
    ]


def _verdict_key(summary: acceptance_runs.SeriesSummary) -> str:
    if not summary.complete:
        return "cli.acceptance.runs.report.interrupted"
    if not summary.passed:
        return "cli.acceptance.runs.report.not_passed"
    if summary.trial:
        return "cli.acceptance.runs.report.trial"
    return "cli.acceptance.runs.report.passed"


def _runs_report(
    summary: acceptance_runs.SeriesSummary,
    results: Sequence[acceptance_runs.RunResult],
    *,
    email: str,
    started: datetime,
    bookmakers: str,
) -> str:
    header = [t(f"cli.acceptance.runs.report.criteria_columns.{name}") for name in _CRITERIA_COLS]
    steps = [
        [t(f"cli.acceptance.runs.report.cost_steps.{kind}"), _usd(summary.step_costs.get(kind))]
        for kind in acceptance_runs.COST_KINDS
    ]
    rows = [
        [
            str(result.number),
            str(result.analysis_id or "—"),
            ", ".join(str(match) for match in result.match_ids),
            t(f"cli.acceptance.runs.report.status.{'done' if result.done else 'failed'}"),
            _duration(result.duration_s),
            _usd(result.cost_usd),
            _usd(result.alone_cost_usd),
            pct(result.cache_share),
            str(result.searches),
            _news_cell(result),
            _parse_mark(result.parse_agrees),
        ]
        for result in results
    ]
    errors = [
        t(
            "cli.acceptance.runs.report.error",
            number=result.number,
            analysis=result.analysis_id or "—",
            code=result.error_code or "—",
            message=_error_text(result),
            step=result.failed_step or "—",
        )
        for result in results
        if not result.done
    ]
    parts = [
        t("cli.acceptance.runs.report.title"),
        t(
            "cli.acceptance.runs.report.intro",
            date=started.strftime("%Y-%m-%d %H:%M UTC"),
            email=email,
            runs=summary.runs,
            planned=summary.planned,
            matches=sum(len(result.match_ids) for result in results),
            bookmakers=bookmakers,
        ),
        t("cli.acceptance.runs.report.criteria"),
        _md_table(header, _criteria(summary)),
        t(
            _verdict_key(summary),
            runs=summary.runs,
            planned=summary.planned,
            need=acceptance_runs.ACCEPTANCE_RUNS,
        ),
        t(
            "cli.acceptance.runs.report.raw",
            usd=_dollars(summary.mean_cost_raw_usd),
            cache=pct(summary.cache_share_raw),
        ),
        t("cli.acceptance.runs.report.rules"),
        t("cli.acceptance.runs.report.costs"),
        _md_table(
            [
                t("cli.acceptance.runs.report.cost_columns.step"),
                t("cli.acceptance.runs.report.cost_columns.usd"),
            ],
            steps,
        ),
        t(
            "cli.acceptance.runs.report.parse",
            agree=summary.parse_agrees,
            checked=summary.parse_checked,
        ),
        t("cli.acceptance.runs.report.runs"),
        _md_table(
            [t(f"cli.acceptance.runs.report.run_columns.{name}") for name in _RUN_COLS], rows
        ),
    ]
    if errors:
        parts += [t("cli.acceptance.runs.report.errors"), "\n".join(errors)]
    return "\n\n".join(parts) + "\n"


_CRITERIA_COLS = ("criterion", "goal", "value", "verdict")
_RUN_COLS = (
    "number",
    "analysis",
    "matches",
    "status",
    "duration",
    "usd",
    "alone_usd",
    "cache",
    "searches",
    "news",
    "parse",
)


def _parse_mark(value: bool | None) -> str:
    if value is None:
        return "—"
    return t(
        "cli.acceptance.runs.report.parse_yes" if value else "cli.acceptance.runs.report.parse_no"
    )


def _failed_criteria(summary: acceptance_runs.SeriesSummary) -> list[str]:
    found: list[str] = []
    if not summary.complete:
        found.append(
            t("cli.acceptance.runs.problems.stopped", runs=summary.runs, planned=summary.planned)
        )
    if summary.done == 0:
        return [*found, t("cli.acceptance.runs.problems.none")]
    if not summary.p90_ok:
        found.append(t("cli.acceptance.runs.problems.p90", value=_duration(summary.p90_s)))
    if not summary.cost_ok:
        found.append(t("cli.acceptance.runs.problems.cost", value=_usd(summary.mean_cost_usd)))
    if not summary.cache_ok:
        found.append(t("cli.acceptance.runs.problems.cache", value=pct(summary.cache_share)))
    if summary.errors:
        found.append(t("cli.acceptance.runs.problems.errors", count=summary.errors))
    if not summary.news_ok:
        found.append(
            t(
                "cli.acceptance.runs.problems.news",
                found=summary.news_found,
                total=summary.news_matches,
            )
        )
    return found


async def _acceptance_runs(args: argparse.Namespace) -> None:
    if not 1 <= args.count <= MAX_RUNS:
        raise CliError("acceptance.runs.count", max=MAX_RUNS)
    engine, maker = _engine_maker()
    redis = create_redis()
    try:
        await _acceptance_series(args, maker, redis)
    finally:
        await redis.aclose()
        await engine.dispose()


async def _acceptance_series(args: argparse.Namespace, maker: Maker, redis: Any) -> None:
    started = utcnow()
    async with maker() as db:
        admin = await check_runs.pick_admin(db, args.email)
        if admin is None:
            raise _no_admin(args.email)
        config = await load_agent_config(db)
        settings = await get_app_settings(db)
        candidates, stale = await acceptance_runs.candidate_matches(db, config, now=started)
        plans = acceptance_runs.plan_runs(candidates, stale, args.count)
        if len(plans) < args.count:
            need = sum(acceptance_runs.matches_in_run(n) for n in range(1, args.count + 1))
            raise CliError(
                "acceptance.runs.not_enough", count=args.count, need=need, found=len(candidates)
            )
        problem = acceptance_runs.news_problem(config, plans)
        if problem is not None:
            raise CliError(f"acceptance.runs.{problem[0]}", **problem[1])
        # Оценка — по активной версии общей линии инструкций (ее промпт и уроки получат
        # анализы прогонов)
        shared = await ensure_shared_ready(db)
        prompt_version = shared.prompt_version or system_prompt_of(shared).version_id
        cost = await acceptance_runs.estimate_series(
            db,
            config,
            plans,
            currency=settings.currency,
            prompt_version=prompt_version,
            now=started,
        )
        access = await access_for(db, admin, estimate_usd=cost.per_run_max_usd)
        if not access.allowed:
            reason = access.reason or "ai.no_admin_key"
            raise CliError(
                "acceptance.runs.refused", reason=t(f"errors.{reason}", **access.reason_params)
            )
        left = access.budget_left_usd
        if left is not None and cost.estimate_usd > left:
            raise CliError(
                "acceptance.runs.budget", estimate=_usd(cost.estimate_usd), left=_usd(left)
            )
        email = admin.email
        admin_id = admin.id
    bookmakers = ", ".join(sorted({m.bookmaker for plan in plans for m in plan.matches}))
    say(
        t(
            "cli.acceptance.runs.estimate",
            count=len(plans),
            matches=cost.matches,
            bookmakers=bookmakers,
            email=email,
            searches=acceptance_runs.max_searches(config, plans),
            usd=_usd(cost.estimate_usd, 2),
            max=_usd(cost.worst_usd, 2),
            cap=_usd(settings.per_analysis_hard_usd, 2),
            left=_usd(left, 2),
        )
    )
    if len(plans) < acceptance_runs.ACCEPTANCE_RUNS:
        say(t("cli.acceptance.runs.trial_note", need=acceptance_runs.ACCEPTANCE_RUNS))
    if not args.yes and not confirmed("cli.acceptance.confirm"):
        raise _cancel()
    results: list[acceptance_runs.RunResult] = []
    try:
        for plan in plans:
            say(
                t(
                    "cli.acceptance.runs.run",
                    number=plan.number,
                    count=len(plans),
                    matches=", ".join(
                        f"{match.player1} — {match.player2} ({match.match_id})"
                        for match in plan.matches
                    ),
                )
            )
            result = await acceptance_runs.run_one(
                maker,
                redis,
                admin_id=admin_id,
                plan=plan,
                title=t("cli.acceptance.runs.input_title", number=plan.number),
                currency=settings.currency,
                on_step=_print_step,
            )
            say(_run_line(result))
            results.append(result)
            if result.stops_series:
                say(t("cli.acceptance.runs.stopped"))
                break
    except asyncio.CancelledError:
        # Ctrl+C: прерванный анализ воркер уже пометил failed; отчет — по законченным
        summary = acceptance_runs.summarize(results, planned=len(plans))
        say(t("cli.acceptance.runs.interrupted", done=len(results), planned=len(plans)))
        _write_report(
            args,
            _runs_report(summary, results, email=email, started=started, bookmakers=bookmakers),
        )
        raise
    summary = acceptance_runs.summarize(results, planned=len(plans))
    say(t("cli.acceptance.runs.summary_title"))
    for criterion, goal, value, verdict in _criteria(summary):
        say(
            t(
                "cli.acceptance.summary_row",
                criterion=criterion,
                goal=goal,
                value=value,
                verdict=verdict,
            )
        )
    _write_report(
        args,
        _runs_report(summary, results, email=email, started=started, bookmakers=bookmakers),
    )
    if not summary.passed:
        raise CliError("acceptance.runs.failed", problems="; ".join(_failed_criteria(summary)))
    _trial_or_pass(
        trial=summary.trial,
        trial_key="acceptance.runs.trial",
        passed_key="acceptance.runs.passed",
        runs=summary.runs,
        need=acceptance_runs.ACCEPTANCE_RUNS,
    )


# --- smoke-eval ---


def _smoke_rows(events: Sequence[dict[str, Any]]) -> list[list[str]]:
    rows: list[list[str]] = []
    for event in events:
        outcome = str(event.get("outcome") or "")
        p_claude = event.get("p_claude")
        rows.append(
            [
                str(event.get("match_id")),
                str(event.get("day")),
                f"{event.get('p1')} — {event.get('p2')}",
                str(event.get("y")),
                num(float((event.get("p_base") or {}).get("p1_win", 0.0))),
                num(float(p_claude)) if p_claude is not None else "—",
                num(float(event["p_final"])) if event.get("p_final") is not None else "—",
                t(f"cli.smoke_eval.outcomes.{outcome}") if outcome else "—",
            ]
        )
    return rows


def _smoke_criteria(summary: smoke_eval.SmokeSummary) -> list[list[str]]:
    counts = summary.counts
    diff = summary.diff
    return [
        [
            t("cli.smoke_eval.criteria.rated"),
            t("cli.smoke_eval.criteria.rated_goal"),
            t("cli.smoke_eval.criteria.rated_value", n=summary.n, total=summary.total),
            _verdict(summary.total > 0 and summary.n == summary.total),
        ],
        [
            t("cli.smoke_eval.criteria.format"),
            "0",
            str(counts.get(smoke_eval.FORMAT, 0)),
            _verdict(counts.get(smoke_eval.FORMAT, 0) == 0),
        ],
        [
            t("cli.smoke_eval.criteria.max_tokens"),
            "0",
            str(counts.get(smoke_eval.MAX_TOKENS, 0)),
            _verdict(counts.get(smoke_eval.MAX_TOKENS, 0) == 0),
        ],
        [
            t("cli.smoke_eval.criteria.log_loss"),
            t("cli.smoke_eval.criteria.log_loss_goal"),
            "—"
            if diff is None
            else t(
                "cli.smoke_eval.criteria.diff",
                value=num(diff.value),
                low=num(diff.low),
                high=num(diff.high),
            ),
            _verdict(diff is not None and diff.value <= smoke_eval.LOG_LOSS_MARGIN),
        ],
    ]


def _smoke_text(run: EvalRun, summary: smoke_eval.SmokeSummary) -> list[str]:
    counts = summary.counts
    return [
        t(
            "cli.smoke_eval.counts",
            ok=counts.get(smoke_eval.OK, 0),
            checks=counts.get(smoke_eval.CHECKS, 0),
            format=counts.get(smoke_eval.FORMAT, 0),
            max_tokens=counts.get(smoke_eval.MAX_TOKENS, 0),
            refusal=counts.get(smoke_eval.REFUSAL, 0),
            errored=counts.get(smoke_eval.ERRORED, 0)
            + counts.get(smoke_eval.EXPIRED, 0)
            + counts.get(smoke_eval.CANCELED, 0),
        ),
        t(
            "cli.smoke_eval.log_loss",
            n=summary.n,
            claude=num(summary.log_loss_claude),
            final=num(summary.log_loss_final),
            base=num(summary.log_loss_base),
        ),
        t("cli.smoke_eval.cost", usd=_usd(summary.cost_usd), id=run.id),
    ]


def _smoke_trial(run: EvalRun) -> bool:
    """Не приемка: событий меньше 40 или они раньше даты среза знаний модели."""
    return run.n_events < smoke_eval.ACCEPTANCE_EVENTS or run.split != smoke_eval.SPLIT


def _smoke_verdict(run: EvalRun, summary: smoke_eval.SmokeSummary) -> str:
    if not summary.passed:
        return t("cli.smoke_eval.report.not_passed")
    if _smoke_trial(run):
        return t("cli.smoke_eval.report.trial", need=smoke_eval.ACCEPTANCE_EVENTS)
    return t("cli.smoke_eval.report.passed")


def _smoke_report(run: EvalRun, summary: smoke_eval.SmokeSummary) -> str:
    metrics = run.metrics or {}
    header = [t(f"cli.acceptance.runs.report.criteria_columns.{name}") for name in _CRITERIA_COLS]
    event_cols = ("match", "day", "players", "y", "p_base", "p_claude", "p_final", "outcome")
    parts = [
        t("cli.smoke_eval.report.title"),
        t(
            "cli.smoke_eval.report.intro",
            id=run.id,
            batch=metrics.get("batch_id", "—"),
            events=run.n_events,
            since=metrics.get("since", "—"),
            model=metrics.get("model", "—"),
            effort=metrics.get("effort", "—"),
            prompt=metrics.get("prompt_version", "—"),
            eval_set=run.eval_set,
        ),
        t("cli.smoke_eval.report.criteria"),
        _md_table(header, _smoke_criteria(summary)),
        _smoke_verdict(run, summary),
        "\n\n".join(_smoke_text(run, summary)),
        t("cli.smoke_eval.report.rules"),
        t("cli.smoke_eval.report.events"),
        _md_table(
            [t(f"cli.smoke_eval.report.columns.{name}") for name in event_cols],
            _smoke_rows(smoke_eval.stored_events(run)),
        ),
    ]
    return "\n\n".join(parts) + "\n"


def _smoke_finish(args: argparse.Namespace, run: EvalRun, summary: smoke_eval.SmokeSummary) -> None:
    say(t("cli.smoke_eval.summary_title"))
    for criterion, goal, value, verdict in _smoke_criteria(summary):
        say(
            t(
                "cli.acceptance.summary_row",
                criterion=criterion,
                goal=goal,
                value=value,
                verdict=verdict,
            )
        )
    for line in _smoke_text(run, summary):
        say(line)
    _write_report(args, _smoke_report(run, summary))
    if not summary.passed:
        raise CliError("smoke_eval.failed", id=run.id, unrated=summary.unrated)
    _trial_or_pass(
        trial=_smoke_trial(run),
        trial_key="smoke_eval.trial",
        passed_key="smoke_eval.passed",
        events=run.n_events,
        need=smoke_eval.ACCEPTANCE_EVENTS,
        first=(run.metrics or {}).get("since", "—"),
        safe=smoke_eval.safe_since(str((run.metrics or {}).get("model") or "")).isoformat(),
    )


def _resume_hint(args: argparse.Namespace, run_id: int) -> str:
    return t(
        "cli.smoke_eval.resume_hint",
        command=_command(
            args,
            f"bash deploy/local.sh smoke-eval --resume {run_id}",
            f"python -m app.admin.cli smoke-eval --resume {run_id}",
        ),
    )


async def _smoke_lost(
    args: argparse.Namespace, maker: Maker, run_id: int, batch_id: str, reason: str
) -> CliError:
    """Пакета или результатов у Anthropic нет: строка lost, текст с причиной."""
    async with maker() as db:
        run = await smoke_eval.mark_lost(db, run_id, reason)
        worst = (run.metrics or {}).get("worst_usd") or "0"
    return CliError(
        f"smoke_eval.lost.{reason}",
        id=run_id,
        batch=batch_id,
        worst=_usd(Decimal(str(worst)), 2),
        command=_command(
            args,
            f"bash deploy/local.sh smoke-eval --resume {run_id}",
            f"python -m app.admin.cli smoke-eval --resume {run_id}",
        ),
    )


def _print_poll(batch: MessageBatch) -> None:
    counts = batch.request_counts
    total = counts.processing + counts.succeeded + counts.errored + counts.canceled + counts.expired
    minutes = int((utcnow() - batch.created_at).total_seconds() // 60)
    say(
        t(
            "cli.smoke_eval.waiting",
            batch=batch.id,
            processing=counts.processing,
            total=total,
            minutes=minutes,
        )
    )


async def _smoke_collect(
    args: argparse.Namespace, maker: Maker, key: str, run_id: int, batch_id: str
) -> None:
    client = client_for(key, timeout=BATCH_TIMEOUT_S)
    try:
        if args.no_wait:
            batch = await smoke_eval.retrieve(client, batch_id)
            if batch.processing_status != "ended":
                _print_poll(batch)
                say(_resume_hint(args, run_id))
                return
        else:
            try:
                await smoke_eval.wait_batch(client, batch_id, on_poll=_print_poll)
            except asyncio.CancelledError:
                say(t("cli.smoke_eval.interrupted", hint=_resume_hint(args, run_id)))
                raise
        async with maker() as db:
            run, summary = await smoke_eval.collect(db, client, run_id)
    except ClaudeStepError as exc:
        raise _claude_failed(exc) from None
    except smoke_eval.BatchLost as exc:
        raise await _smoke_lost(args, maker, run_id, batch_id, exc.reason) from None
    _smoke_finish(args, run, summary)


async def _smoke_eval(args: argparse.Namespace) -> None:
    engine, maker = _engine_maker()
    try:
        if args.abandon is not None:
            await _smoke_abandon(args, maker)
        elif args.resume is not None:
            await _smoke_resume(args, maker)
        else:
            await _smoke_new(args, maker)
    finally:
        await engine.dispose()


async def _smoke_abandon(args: argparse.Namespace, maker: Maker) -> None:
    async with maker() as db:
        run = await smoke_eval.abandon(db, args.abandon)
    if run is None:
        raise CliError("smoke_eval.not_found", id=args.abandon)
    status = (run.metrics or {}).get("status")
    if status != check_runs.ABANDONED:
        raise CliError("smoke_eval.abandon_status", id=run.id, status=status)
    say(t("cli.smoke_eval.abandoned", id=run.id, batch=(run.metrics or {}).get("batch_id", "—")))


async def _smoke_new(args: argparse.Namespace, maker: Maker) -> None:
    if not 1 <= args.events <= MAX_EVENTS:
        raise CliError("smoke_eval.events", max=MAX_EVENTS)
    async with maker() as db:
        admin = await check_runs.pick_admin(db, args.email)
        if admin is None:
            raise _no_admin(args.email)
        config = await load_agent_config(db)
        safe = smoke_eval.safe_since(config.analysis_model)
        if args.since < safe and not args.before_cutoff:
            raise CliError(
                "smoke_eval.since_cutoff",
                since=args.since.isoformat(),
                safe=safe.isoformat(),
                model=config.analysis_model,
            )
        today = utcnow().date()
        matches = await smoke_eval.pick_matches(
            db, since=args.since, count=args.events, today=today
        )
        if len(matches) < args.events:
            raise CliError(
                "smoke_eval.not_enough",
                since=args.since.isoformat(),
                found=len(matches),
                need=args.events,
            )
        try:
            key = await key_for(db, key_source="admin", user_id=admin.id)
            price = await price_for(db, config.analysis_model)
        except ClaudeStepError as exc:
            raise _claude_failed(exc) from None
        # Инструкции — действующая версия общей линии (промпт и уроки в анализе, Р25), а не
        # личная версия администратора: ответы годятся быстрой проверке как «без урока»
        version = await ensure_shared_ready(db)
        prompt = system_prompt_of(version)
        say(t("cli.smoke_eval.preparing", count=len(matches)))
        events = await smoke_eval.prepare_events(db, matches)
        await db.commit()
        version_id = version.id
        cost = smoke_eval.estimate(events, prompt, config, price)
        budget = await check_runs.eval_budget(db)
    if cost.worst_usd > budget.left_usd:
        raise CliError(
            "smoke_eval.budget",
            max=_usd(cost.worst_usd, 2),
            left=_usd(budget.left_usd, 2),
            budget=_usd(budget.budget_usd, 2),
            spent=_usd(budget.spent_usd, 2),
            reserved=_usd(budget.reserved_usd, 2),
        )
    say(
        t(
            "cli.smoke_eval.estimate",
            count=len(events),
            first=events[0].day.isoformat(),
            last=events[-1].day.isoformat(),
            model=config.analysis_model,
            effort=config.analysis_effort,
            usd=_usd(cost.estimate_usd, 2),
            max=_usd(cost.worst_usd, 2),
            left=_usd(budget.left_usd, 2),
            budget=_usd(budget.budget_usd, 2),
        )
    )
    if args.since < safe:
        say(t("cli.smoke_eval.seen_note", safe=safe.isoformat(), model=config.analysis_model))
    elif len(events) < smoke_eval.ACCEPTANCE_EVENTS:
        say(t("cli.smoke_eval.trial_note", need=smoke_eval.ACCEPTANCE_EVENTS))
    if not args.yes and not confirmed("cli.acceptance.confirm"):
        raise _cancel()
    async with maker() as db:
        # Остаток заново под блокировкой бюджета проверок, до commit строки creating (ее
        # худший случай — в резерве): две проверки не займут один остаток (М2 волны 2)
        await check_runs.lock_budget(db)
        budget = await check_runs.eval_budget(db)
        if cost.worst_usd > budget.left_usd:
            raise CliError(
                "smoke_eval.budget",
                max=_usd(cost.worst_usd, 2),
                left=_usd(budget.left_usd, 2),
                budget=_usd(budget.budget_usd, 2),
                spent=_usd(budget.spent_usd, 2),
                reserved=_usd(budget.reserved_usd, 2),
            )
        version = await db.get_one(StrategyVersion, version_id)
        run = await smoke_eval.create_run(
            db,
            version=version,
            prompt=prompt,
            config=config,
            since=args.since,
            events=events,
            cost=cost,
        )
        await db.commit()
        run_id = run.id
        try:
            batch_id = await smoke_eval.submit(
                client_for(key, timeout=BATCH_TIMEOUT_S), db, run, events, prompt, config
            )
        except ClaudeStepError as exc:
            raise _claude_failed(exc) from None
    say(t("cli.smoke_eval.submitted", batch=batch_id, id=run_id))
    if args.no_wait:
        say(_resume_hint(args, run_id))
        return
    await _smoke_collect(args, maker, key, run_id, batch_id)


async def _smoke_resume(args: argparse.Namespace, maker: Maker) -> None:
    async with maker() as db:
        run = await db.get(EvalRun, args.resume)
        metrics = (run.metrics or {}) if run is not None else {}
        if run is None or metrics.get("kind") != smoke_eval.KIND:
            raise CliError("smoke_eval.not_found", id=args.resume)
        status = metrics.get("status")
        if status == smoke_eval.ENDED:
            summary = smoke_eval.SmokeSummary.from_json(metrics.get("summary") or {})
            _smoke_finish(args, run, summary)
            return
        if status not in smoke_eval.COLLECTABLE:
            raise CliError(
                "smoke_eval.not_submitted",
                id=run.id,
                status=status,
                error=metrics.get("error") or "—",
            )
        try:
            key = await key_for(db, key_source="admin", user_id=0)
        except ClaudeStepError as exc:
            raise _claude_failed(exc) from None
        await db.commit()
        batch_id = str(metrics["batch_id"])
        run_id = run.id
    await _smoke_collect(args, maker, key, run_id, batch_id)


# --- parse-eval ---


# Рынок → ключ подписи (в ключе локали не может быть точки: HCP_-1.5)
_MARKET_KEYS = {"ML": "ml", "HCP_-1.5": "minus", "HCP_+1.5": "plus"}


def _market(market: str, side: int) -> str:
    """Подпись исхода: П1, П2(+1.5); новые рынки Р28 — кодом и стороной (у тоталов 1 —
    больше, 2 — меньше)."""
    if market not in _MARKET_KEYS:
        return t("cli.parse_eval.markets.other", market=market, side=side)
    return t(f"cli.parse_eval.markets.{_MARKET_KEYS[market]}", side=side)


def _diff_text(diff: parse_eval.Diff) -> str:
    kind, params = diff
    shown = dict(params)
    if "market" in shown:
        shown["market"] = _market(str(shown["market"]), int(shown.pop("side")))
    if kind == "parse_failed":
        shown["message"] = t(f"errors.{shown.get('code')}")
    return t(f"cli.parse_eval.diff.{kind}", **shown)


def _check_text(check: dict[str, Any]) -> str:
    params = dict(check.get("params") or {})
    if check.get("key") == "parse_failed":
        params["message"] = t(f"errors.{params.get('code') or 'ai.bad_output'}")
    return t(f"cli.parse_eval.check.{check.get('key')}", **params)


def _parse_verdict(ok: int, total: int) -> str:
    if ok != total:
        return t("cli.parse_eval.report.not_passed")
    if total < ACCEPTANCE_PAIRS:
        return t("cli.parse_eval.report.trial", total=total, need=ACCEPTANCE_PAIRS)
    return t("cli.parse_eval.report.passed")


def _parse_report(results: Sequence[parse_eval.PairResult], cost: Decimal, path: str) -> str:
    ok = sum(1 for result in results if result.ok)
    lines = [
        t(
            "cli.parse_eval.report.pair",
            number=result.pair.number,
            text=" / ".join(result.pair.text.split("\n"))[:200],
            diffs="; ".join(_diff_text(diff) for diff in result.diffs),
        )
        for result in results
        if not result.ok
    ]
    parts = [
        t("cli.parse_eval.report.title"),
        t("cli.parse_eval.report.intro", path=path, total=len(results), usd=_usd(cost)),
        t(
            "cli.parse_eval.result",
            ok=ok,
            total=len(results),
            share=pct(ok / len(results) if results else None),
        ),
        _parse_verdict(ok, len(results)),
        t("cli.parse_eval.report.rules"),
    ]
    if lines:
        parts += [t("cli.parse_eval.report.diffs"), "\n".join(lines)]
    return "\n\n".join(parts) + "\n"


async def _parse_prepare(
    maker: Maker, texts: Sequence[str], yes: bool, *, draft: bool = False
) -> tuple[str, AgentConfig]:
    """Оценка, бюджет проверок и подтверждение; возвращает ключ и настройки агента."""
    async with maker() as db:
        config = await load_agent_config(db)
        try:
            key = await key_for(db, key_source="admin", user_id=0)
            cost = await parse_eval.estimate_calls(db, config, texts)
        except ClaudeStepError as exc:
            raise _claude_failed(exc) from None
        await db.commit()
        budget = await check_runs.eval_budget(db)
    if cost.worst_usd > budget.left_usd:
        raise CliError(
            "parse_eval.budget",
            max=_usd(cost.worst_usd),
            left=_usd(budget.left_usd, 2),
            budget=_usd(budget.budget_usd, 2),
        )
    say(
        t(
            "cli.parse_eval.estimate",
            count=len(texts),
            model=config.parse_model,
            usd=_usd(cost.estimate_usd),
            max=_usd(cost.worst_usd),
            left=_usd(budget.left_usd, 2),
        )
    )
    if not draft and len(texts) < ACCEPTANCE_PAIRS:
        say(t("cli.parse_eval.trial_note", need=ACCEPTANCE_PAIRS))
    if not yes and not confirmed("cli.acceptance.confirm"):
        raise _cancel()
    return key, config


async def _parse_texts(
    maker: Maker, key: str, config: AgentConfig, texts: Sequence[str]
) -> tuple[list[parse_eval.ParseOutcome], Decimal]:
    hooks = parse_eval.EvalHooks(maker)
    done = 0

    def progress(_: int) -> None:
        nonlocal done
        done += 1
        if done % PARSE_PROGRESS_EVERY == 0 or done == len(texts):
            say(t("cli.parse_eval.progress", done=done, total=len(texts)))

    try:
        outcomes = await parse_eval.parse_all(
            client_for(key, timeout=float(config.parse_timeout_s)),
            texts,
            config,
            hooks,
            on_done=progress,
        )
    except ClaudeStepError as exc:
        raise _claude_failed(exc) from None
    return outcomes, hooks.spent


async def _parse_eval(args: argparse.Namespace) -> None:
    if args.draft:
        if not args.from_telegram or not args.out:
            raise CliError("parse_eval.draft_args")
        await _parse_draft(args)
        return
    if not args.file:
        raise CliError("parse_eval.args")
    shown = _shown(args.file, args.file_label)
    try:
        pairs = parse_eval.load_pairs(_read_json(args.file, shown))
    except parse_eval.PairsError as exc:
        raise CliError(f"parse_eval.file.{exc.key}", path=shown, **exc.params) from None
    engine, maker = _engine_maker()
    try:
        texts = [pair.text for pair in pairs]
        key, config = await _parse_prepare(maker, texts, args.yes)
        outcomes, spent = await _parse_texts(maker, key, config, texts)
        async with maker() as db:
            results = await parse_eval.check_pairs(db, pairs, outcomes)
    finally:
        await engine.dispose()
    ok = sum(1 for result in results if result.ok)
    for result in results:
        if not result.ok:
            say(
                t(
                    "cli.parse_eval.pair_failed",
                    number=result.pair.number,
                    diffs="; ".join(_diff_text(diff) for diff in result.diffs),
                )
            )
    say(
        t(
            "cli.parse_eval.result",
            ok=ok,
            total=len(results),
            share=pct(ok / len(results) if results else None),
        )
    )
    say(t("cli.parse_eval.cost", usd=_usd(spent)))
    _write_report(args, _parse_report(results, spent, shown))
    if ok != len(results):
        raise CliError("parse_eval.failed", ok=ok, total=len(results))
    _trial_or_pass(
        trial=len(results) < ACCEPTANCE_PAIRS,
        trial_key="parse_eval.trial",
        passed_key="parse_eval.passed",
        total=len(results),
        need=ACCEPTANCE_PAIRS,
    )


async def _parse_draft(args: argparse.Namespace) -> None:
    if not 1 <= args.limit <= MAX_DRAFT:
        raise CliError("parse_eval.limit", max=MAX_DRAFT)
    shown = _shown(args.from_telegram, args.file_label)
    try:
        messages = parse_eval.telegram_messages(
            _read_json(args.from_telegram, shown), limit=args.limit
        )
    except parse_eval.PairsError as exc:
        raise CliError(f"parse_eval.file.{exc.key}", path=shown) from None
    if not messages:
        raise CliError("parse_eval.draft_none", path=shown)
    engine, maker = _engine_maker()
    try:
        texts = [message.text for message in messages]
        key, config = await _parse_prepare(maker, texts, args.yes, draft=True)
        outcomes, spent = await _parse_texts(maker, key, config, texts)
        async with maker() as db:
            drafts = [
                await parse_eval.draft_pair(db, message, outcome)
                for message, outcome in zip(messages, outcomes, strict=True)
            ]
    finally:
        await engine.dispose()
    for draft in drafts:
        draft["check"] = [_check_text(check) for check in draft["check"]]
    out = _shown(args.out, args.out_label)
    _save_json(args.out, drafts, out)
    say(t("cli.parse_eval.cost", usd=_usd(spent)))
    say(
        t(
            "cli.parse_eval.draft_saved",
            count=len(drafts),
            path=out,
            command=_command(
                args,
                f"bash deploy/local.sh parse-eval --file {shlex.quote(out)}",
                f"python -m app.admin.cli parse-eval --file {shlex.quote(out)}",
            ),
        )
    )


# --- разбор аргументов ---


def add_commands(commands: "argparse._SubParsersAction[argparse.ArgumentParser]") -> None:
    """Команды приемки в общем разборе аргументов app/admin/cli.py."""

    def command(name: str, text: str) -> argparse.ArgumentParser:
        return commands.add_parser(name, help=text, description=text)

    def common(cmd: argparse.ArgumentParser) -> None:
        cmd.add_argument("--yes", action="store_true", help=t("cli.acceptance.help.yes"))
        cmd.add_argument(
            "--report",
            metavar=t("cli.acceptance.metavar_path"),
            help=t("cli.acceptance.help.report"),
        )
        # Для bash deploy/local.sh: путь отчета печатает обертка, подсказки — ее командами
        cmd.add_argument("--local-sh", action="store_true", help=argparse.SUPPRESS)

    runs = command("acceptance-runs", t("cli.acceptance.help.runs"))
    runs.add_argument("--count", type=int, default=20, help=t("cli.acceptance.help.runs_count"))
    runs.add_argument("--email", help=t("cli.acceptance.help.email"))
    common(runs)
    runs.set_defaults(handler=_acceptance_runs)

    smoke = command("smoke-eval", t("cli.acceptance.help.smoke"))
    smoke.add_argument("--events", type=int, default=40, help=t("cli.acceptance.help.smoke_events"))
    smoke.add_argument(
        "--since",
        type=_date_arg,
        default=DEFAULT_SINCE,
        metavar=t("cli.acceptance.metavar_date"),
        help=t("cli.acceptance.help.smoke_since"),
    )
    smoke.add_argument("--email", help=t("cli.acceptance.help.email"))
    smoke.add_argument(
        "--no-wait", action="store_true", help=t("cli.acceptance.help.smoke_no_wait")
    )
    smoke.add_argument(
        "--before-cutoff",
        action="store_true",
        help=t("cli.acceptance.help.smoke_before_cutoff"),
    )
    smoke.add_argument(
        "--resume",
        type=int,
        metavar=t("cli.acceptance.metavar_id"),
        help=t("cli.acceptance.help.smoke_resume"),
    )
    smoke.add_argument(
        "--abandon",
        type=int,
        metavar=t("cli.acceptance.metavar_id"),
        help=t("cli.acceptance.help.smoke_abandon"),
    )
    common(smoke)
    smoke.set_defaults(handler=_smoke_eval)

    parse = command("parse-eval", t("cli.acceptance.help.parse"))
    parse.add_argument(
        "--file", metavar=t("cli.acceptance.metavar_path"), help=t("cli.acceptance.help.parse_file")
    )
    parse.add_argument("--draft", action="store_true", help=t("cli.acceptance.help.parse_draft"))
    parse.add_argument(
        "--from-telegram",
        metavar=t("cli.acceptance.metavar_path"),
        help=t("cli.acceptance.help.parse_from_telegram"),
    )
    parse.add_argument(
        "--out", metavar=t("cli.acceptance.metavar_path"), help=t("cli.acceptance.help.parse_out")
    )
    parse.add_argument("--limit", type=int, default=150, help=t("cli.acceptance.help.parse_limit"))
    # Имена файлов, как их видит владелец (bash deploy/local.sh передает файлы во
    # временную папку контейнера)
    parse.add_argument("--file-label", help=argparse.SUPPRESS)
    parse.add_argument("--out-label", help=argparse.SUPPRESS)
    common(parse)
    parse.set_defaults(handler=_parse_eval)
