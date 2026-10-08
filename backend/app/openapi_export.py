"""Печатает схему OpenAPI приложения в stdout, без запуска сервера и без БД.

    cd backend && python -m app.openapi_export > ../frontend/openapi.json

Из файла фронтенд генерирует типы (npm run gen:api). Файл коммитится, CI проверяет,
что он совпадает с выводом этой команды.
"""

import json
import sys

from app.main import create_app


def main() -> None:
    schema = create_app().openapi()
    json.dump(schema, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
