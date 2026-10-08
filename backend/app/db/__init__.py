"""База данных: подключение к PostgreSQL, модели SQLAlchemy и запросы.

Модели раскладываются по разделам: users, access_codes, players, matches, odds,
analyses, predictions, bets, lessons, agent_runs, notifications и т. д.
Схема меняется только миграциями Alembic (backend/alembic/).
"""
