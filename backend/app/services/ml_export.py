"""Выгрузка снимков прогнозов в JSONL для учебного трека (В9 Р25; LLM_LEARNING.md 2.3):
кнопка «Выгрузить JSONL» у администратора на «Базовой модели».

Строка — один прогноз (последний в цепочке исправлений): момент данных, турнир и покрытие,
рынок и сторона, признаки, sha256 досье, версии (стратегия, модель Claude, effort,
базовая модель, уроки), вероятности p_base / p_claude / p_final, рынок на момент прогноза
и исход. В файл идут только прогнозы по архиву (проверки на наборе и быстрые проверки,
is_eval) и свои прогнозы администратора: прогнозы участников — их данные (Р14). Игроки
обезличены: ни имен, ни id игроков, ни текста досье и обоснования в строке нет. Файл
отдается частями по CHUNK строк — целиком в памяти не собирается.
"""

import asyncio
import json
from collections.abc import AsyncIterator
from typing import Any

from sqlalchemy import exists, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.db.models import Dossier, Match, Prediction, StrategyVersion, Tournament, User

FILENAME = "snapshots.jsonl"
CHUNK = 1000
# Рынок, исход которого известен по победителю матча
MONEYLINE = "ML"


def _outcome(selection: int, player1: int, player2: int, winner: int | None) -> int | None:
    if winner is None:
        return None
    chosen = player1 if selection == 1 else player2
    return 1 if winner == chosen else 0


def _row(
    prediction: Prediction,
    match: Match,
    tournament: Tournament | None,
    dossier_sha: str | None,
    version_code: str | None,
) -> dict[str, Any]:
    outcome = (
        _outcome(prediction.selection, match.player1_id, match.player2_id, match.winner_id)
        if prediction.market == MONEYLINE
        else None
    )
    return {
        "prediction_id": prediction.id,
        "source": "eval" if prediction.is_eval else "own",
        "eval_run_id": prediction.eval_run_id,
        "as_of": prediction.as_of.isoformat(),
        "match_id": match.id,
        "match_date": match.match_date.isoformat() if match.match_date else None,
        "level": tournament.category if tournament is not None else None,
        "surface": tournament.surface if tournament is not None else None,
        "best_of": tournament.best_of if tournament is not None else None,
        "market": prediction.market,
        "selection": prediction.selection,
        "features": prediction.features or {},
        "feature_set": prediction.feature_set,
        "dossier_sha256": dossier_sha,
        "strategy_version": version_code,
        "prompt_version": prediction.prompt_version,
        "llm_model": prediction.llm_model,
        "effort": prediction.effort,
        "ml_model": prediction.ml_model_id,
        "lessons_applied": list(prediction.lessons_applied or []),
        "p_base": prediction.p_base,
        "p_claude": prediction.p_claude,
        "p_final": prediction.p_final,
        "q_market_at_pred": prediction.q_market_at_pred,
        "odds_at_pred": float(prediction.odds_at_pred)
        if prediction.odds_at_pred is not None
        else None,
        "outcome": outcome,
    }


async def snapshots(db: AsyncSession, admin: User) -> AsyncIterator[str]:
    """JSONL снимков: по архиву и свои администратора, по возрастанию id. Сеанс БД должен
    жить, пока ответ не отдан (зависимость маршрута с yield так и живет)."""
    newer = aliased(Prediction)
    superseded = exists().where(newer.supersedes == Prediction.id)
    base = (
        select(Prediction, Match, Tournament, Dossier.sha256, StrategyVersion.code)
        .join(Match, Match.id == Prediction.match_id)
        .outerjoin(Tournament, Tournament.id == Match.tournament_id)
        .outerjoin(Dossier, Dossier.id == Prediction.dossier_id)
        .outerjoin(StrategyVersion, StrategyVersion.id == Prediction.strategy_version_id)
        .where(
            Prediction.is_eval.is_(True) | (Prediction.user_id == admin.id),
            ~superseded,
        )
        .order_by(Prediction.id)
        .limit(CHUNK)
    )

    async def chunks() -> AsyncIterator[str]:
        after = 0
        while True:
            rows = (await db.execute(base.where(Prediction.id > after))).all()
            if not rows:
                return
            yield "".join(
                json.dumps(_row(*row), ensure_ascii=False, separators=(",", ":")) + "\n"
                for row in rows
            )
            after = rows[-1][0].id
            if len(rows) < CHUNK:
                return
            await asyncio.sleep(0)

    return chunks()
