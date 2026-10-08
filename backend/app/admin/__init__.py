"""Администрирование: команды терминала (cli.py) и логика кабинета администратора.

Команды запускаются на сервере: docker compose exec api python -m app.admin.cli <команда>
create-admin, reset-code, reset-2fa, set-role, unblock, set-admin-key (docs/PLAN.md, раздел 7).
"""
