/*
 * Команды терминала администратора (Р6) — одна форма на весь интерфейс: вкладка «Сброс доступа»
 * и подсказки на экранах входа. Сервера пока нет (Р19, решение от 8 октября 2026): приложение
 * работает на компьютере владельца через deploy/local.sh. Когда появится сервер, там те же
 * команды идут через SERVER_CLI (deploy/README.md).
 */
export const TERMINAL_CLI = 'bash deploy/local.sh cli';
export const SERVER_CLI = 'docker compose exec api python -m app.admin.cli';
/** Обновить архив матчей вручную (загрузка и пересчет Эло), как ночное обновление. */
export const DATA_UPDATE_CLI = 'bash deploy/local.sh data';

/** Команда терминала для пользователя с email, например reset-code --email …. */
export function terminalCommand(command: string, email = '…'): string {
  return `${TERMINAL_CLI} ${command} --email ${email}`;
}
