"""Миграции для одноразового сервиса migrate (deploy/docker-compose.yml):

    python -m app.db.migrate

Это alembic upgrade head, который compose выполняет до запуска api и worker, поэтому
обычный docker compose up поднимает стек с нуля. deploy.sh и deploy/local.sh применяют
миграции раньше отдельным шагом (при деплое — до перезапуска: упала миграция — работает
прежняя версия), и здесь тогда делать нечего.

Если в базе ревизия, которой нет в этом коде, схема новее кода: deploy.sh откатил образы
на прежнюю версию. Миграции вниз не откатываются (deploy/README.md, раздел 9), поэтому
шаг пропускается с предупреждением, а прежний код работает на новой схеме. Можно ли так,
deploy.sh проверяет сам до запуска сервисов.
"""

import asyncio
import sys
from pathlib import Path

from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text

from app.core.i18n import t
from app.db.session import create_engine

ALEMBIC_INI = Path(__file__).resolve().parents[2] / "alembic.ini"


async def database_revisions() -> set[str]:
    """Ревизии в таблице alembic_version. Пусто — база еще без схемы."""
    engine = create_engine()
    try:
        async with engine.connect() as conn:
            if not await conn.scalar(text("SELECT to_regclass('alembic_version') IS NOT NULL")):
                return set()
            rows = await conn.execute(text("SELECT version_num FROM alembic_version"))
            return {str(row[0]) for row in rows}
    finally:
        await engine.dispose()


def code_revisions(config: Config) -> set[str]:
    return {script.revision for script in ScriptDirectory.from_config(config).walk_revisions()}


def main() -> int:
    config = Config(str(ALEMBIC_INI))
    unknown = asyncio.run(database_revisions()) - code_revisions(config)
    if unknown:
        print(t("cli.migrate_db_ahead", revisions=", ".join(sorted(unknown))), file=sys.stderr)
        return 0
    command.upgrade(config, "head")
    return 0


if __name__ == "__main__":
    sys.exit(main())
