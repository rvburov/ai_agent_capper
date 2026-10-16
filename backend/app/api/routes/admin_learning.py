"""Обучение модели в кабинете администратора (этап 5, волна 3): замороженный eval-набор,
прогоны версий инструкций, кандидат инструкций, перекалибровка базовой модели и откат.

Только роль admin (зависимость на роутере): без сеанса — 401, участнику — 403. Заморозка
набора, остановка прогона и перекалибровка денег не тратят (2FA не нужен); прогон версии
тратит бюджет проверок — в теле totp_code, текущий код 2FA (как смена ключа). Р14: в
ответах нет ставок, сумм и прогнозов участников.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, Path, Query, Response, status
from fastapi.responses import StreamingResponse

from app.api.routes.admin import Confirm
from app.core.deps import AdminUser, ClientIp, DbSession, require_admin
from app.schemas.learning import (
    EvalPlanOut,
    EvalRunIn,
    EvalRunOut,
    EvalRunsOut,
    EvalSetIn,
    EvalSetOut,
    EvalSetsOut,
    InstructionsCandidateIn,
    MlModelOut,
    RecalibrationOut,
    StrategyVersionOut,
)
from app.services import (
    eval_runs,
    eval_sets,
    ml_export,
    recalibration,
    strategy_versions,
    strategy_view,
)

router = APIRouter(prefix="/admin", tags=["admin"], dependencies=[Depends(require_admin)])

RowId = Annotated[int, Path(ge=1, le=2**63 - 1)]
QueryId = Annotated[int, Query(ge=1, le=2**63 - 1)]
ModelId = Annotated[str, Path(min_length=1, max_length=64, pattern=r"^[a-z0-9@._-]+$")]


@router.get("/eval/sets")
async def list_eval_sets(db: DbSession) -> EvalSetsOut:
    """Замороженные наборы и сколько сыгранных матчей доступно для нового."""
    return await eval_sets.list_sets(db)


@router.post("/eval/sets", status_code=status.HTTP_201_CREATED)
async def freeze_eval_set(
    body: EvalSetIn, admin: AdminUser, db: DbSession, ip: ClientIp
) -> EvalSetOut:
    """Заморозить набор: 200–300 сыгранных матчей после среза знаний модели, 15–20%
    трудных, список и sha256. Такой код уже есть — 409 eval.set_exists; мало матчей —
    422 eval.set_too_small; раньше среза — 422 eval.set_seen."""
    found = await eval_sets.freeze(db, body, actor_id=admin.id, ip=ip)
    return eval_sets.set_out(found)


@router.get("/eval/runs")
async def list_eval_runs(db: DbSession) -> EvalRunsOut:
    """Прогоны проверок (версии на наборе, быстрые проверки уроков, приемка) с ценой и
    худшим случаем; бюджет проверок."""
    return await eval_runs.list_runs(db)


@router.get("/eval/runs/preview")
async def eval_run_preview(version_id: QueryId, db: DbSession) -> EvalPlanOut:
    """Прогон версии до запуска: события, пакеты, цена по живым числам, худший случай,
    бюджет проверок; можно ли запустить и почему нет."""
    return await eval_runs.plan(db, version_id)


@router.post("/eval/runs", status_code=status.HTTP_202_ACCEPTED)
async def start_eval_run(
    body: EvalRunIn, admin: AdminUser, db: DbSession, ip: ClientIp, confirm: Confirm
) -> EvalRunOut:
    """Запустить прогон версии на наборе (Batch, бюджет проверок): код 2FA обязателен
    (403 admin.totp_required / admin.totp_invalid). Нельзя — 409 с причиной плана."""
    run = await eval_runs.start(db, admin, body, confirm=confirm.with_code(body.totp_code), ip=ip)
    return await eval_runs.run_detail(db, run.id)


@router.post("/eval/runs/{run_id}/cancel")
async def cancel_eval_run(
    run_id: RowId, admin: AdminUser, db: DbSession, ip: ClientIp
) -> EvalRunOut:
    """Остановить прогон (денег не тратит, 2FA не нужна): ждущий отправки, бюджета или
    ключа — сразу abandoned, резерв снимается; пакет у Anthropic отменяется (не начатые
    запросы бесплатно), начатые дособираются. 404 eval.run_not_found; уже закончен — 409
    eval.run_closed."""
    await eval_runs.cancel(db, admin, run_id, ip=ip)
    return await eval_runs.run_detail(db, run_id)


@router.get("/eval/runs/{run_id}")
async def get_eval_run(run_id: RowId, db: DbSession) -> EvalRunOut:
    """Прогон: ход, цена и отчет (метрики с ДИ, калибровка)."""
    return await eval_runs.run_detail(db, run_id)


@router.post("/strategy/versions", status_code=status.HTTP_201_CREATED)
async def create_instructions_candidate(
    body: InstructionsCandidateIn, admin: AdminUser, db: DbSession, ip: ClientIp
) -> StrategyVersionOut:
    """Кандидат инструкций анализа: промпт analysis.vN и/или набор уроков. Включается
    только после прогона на наборе и кнопкой (POST /strategy/versions/{id}/activate)."""
    version = await strategy_versions.create_instructions_candidate(db, admin, body, ip=ip)
    return await strategy_view.version_detail(db, admin, version.id)


@router.post("/ml/recalibrate")
async def recalibrate_model(admin: AdminUser, db: DbSession) -> RecalibrationOut:
    """Перекалибровать базовую модель сейчас (как задача по понедельникам): новая версия
    включается сама, если не хуже прежней на отложенной части (В6)."""
    return await recalibration.recalibrate(db, actor_id=admin.id)


@router.post("/ml/models/{model_id}/rollback")
async def rollback_model(
    model_id: ModelId, admin: AdminUser, db: DbSession, ip: ClientIp
) -> MlModelOut:
    """Вернуть версию базовой модели, которая уже была активной (404 / 409)."""
    return await recalibration.rollback(db, admin, model_id, ip=ip)


@router.get(
    "/ml/export.jsonl",
    response_class=Response,
    responses={
        200: {
            "content": {"application/x-ndjson": {}},
            "description": "JSONL: строка на прогноз (LLM_LEARNING.md 2.3)",
        }
    },
)
async def export_snapshots(admin: AdminUser, db: DbSession) -> Response:
    """Снимки прогнозов для учебного трека (В9): по архиву и свои, игроки обезличены,
    прогнозов участников нет (Р14). Файл отдается частями."""
    chunks = await ml_export.snapshots(db, admin)
    return StreamingResponse(
        chunks,
        media_type="application/x-ndjson; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{ml_export.FILENAME}"'},
    )
