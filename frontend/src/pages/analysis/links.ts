import { paths } from '../../app/paths';

// Куда ведут кнопки остановки анализа: «Ключ Claude» в личном кабинете или «Ключ и бюджет».
export type AppPath = 'profileKey' | 'adminKey';

export function appPath(to: AppPath): string {
  return to === 'profileKey' ? paths.profile('key') : paths.admin('key');
}
