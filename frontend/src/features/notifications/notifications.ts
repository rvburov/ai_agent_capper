import type { QueryKey } from '@tanstack/react-query';

import { meQueryKey } from '../../api/keys';
import type { IconName } from '../../components';
import type { components } from '../../api/schema';
import { paths } from '../../app/paths';
import { adminKeys } from '../admin/keys';
import { aiKeys } from '../ai/keys';
import { analysisKeys } from '../analysis/keys';
import { MONEY_QUERIES } from '../bank/currency';
import { learningKeys } from '../learning/keys';
import { ANALYTICS_PREFIX, betKeys, DASHBOARD_PREFIX } from '../bets/keys';

// Центр уведомлений (колокольчик, Р3): вид уведомления, ссылки и отметка прочитанного в кэше.

export type NotificationsOut = components['schemas']['NotificationsOut'];
export type NotificationItem = components['schemas']['NotificationOut'];

export type NotificationTone = 'good' | 'warn' | 'bad' | 'info' | null;

/** Иконка и цвет кружка по виду уведомления (как в макете: DATA.notifications). */
export function notificationLook(kind: string): { icon: IconName; tone: NotificationTone } {
  switch (kind) {
    case 'new_device':
      return { icon: 'device', tone: 'info' };
    case 'login_failures':
      return { icon: 'lock', tone: 'bad' };
    case 'limit_80':
      return { icon: 'coins', tone: 'warn' };
    case 'limit_100':
      return { icon: 'coins', tone: 'bad' };
    // Этап 3: общий бюджет ключа администратора — как лимит участника
    case 'budget_80':
      return { icon: 'coins', tone: 'warn' };
    case 'budget_100':
      return { icon: 'coins', tone: 'bad' };
    // Ключ Claude: не работает; просьба вернуть ключ администратора и решение по ней
    case 'ai_key_failed':
      return { icon: 'key', tone: 'bad' };
    case 'ai_mode_request':
      return { icon: 'key', tone: 'info' };
    case 'ai_mode_decision':
      return { icon: 'key', tone: 'info' };
    // Архив устарел — «Пора загрузить файл tennis-data» (этап 5, В1)
    case 'data_stale':
      return { icon: 'database', tone: 'warn' };
    case 'admin_message':
      return { icon: 'megaphone', tone: 'info' };
    case 'bet_settled':
      return { icon: 'ticket', tone: null };
    // Этап 4: сигнал расхода ИИ администратору (текст правила с числами — с сервера)
    case 'ai_alert':
      return { icon: 'alert', tone: 'warn' };
    // Этап 5: ставка ждет результата (архива по матчу нет N дней), архив разошелся с ручным
    // расчетом (банк не меняли), отчет недели, обучение модели (урок готов, кандидат проверен,
    // модель перекалибрована)
    case 'bet_needs_result':
      return { icon: 'clock', tone: 'warn' };
    case 'settle_conflict':
      return { icon: 'alert', tone: 'warn' };
    case 'weekly_report':
      return { icon: 'calendar', tone: 'info' };
    case 'learning':
      return { icon: 'brain', tone: 'info' };
    default:
      return { icon: 'bell', tone: null };
  }
}

// Лимит и расход на ИИ: «Ключ Claude» и блок лимита анализа
const AI_BUDGET: readonly QueryKey[] = [aiKeys.all];

/**
 * Какие данные устарели, когда пришло уведомление этого вида: событие (просьба, решение,
 * расход) уже случилось на сервере, а открытый экран показывает старое. Переход по ссылке
 * уведомления на ту же страницу данные сам не перечитывает.
 */
export function staleQueriesFor(kind: string): readonly QueryKey[] {
  switch (kind) {
    case 'ai_mode_request':
      return [adminKeys.users, adminKeys.aiLimits, adminKeys.attention];
    case 'ai_mode_decision':
      return [...AI_BUDGET, meQueryKey];
    case 'ai_key_failed':
      return [...AI_BUDGET, adminKeys.aiKey];
    case 'limit_80':
    case 'limit_100':
      return [...AI_BUDGET, adminKeys.aiLimits, adminKeys.users, adminKeys.attention];
    case 'budget_80':
    case 'budget_100':
      return [...AI_BUDGET, adminKeys.aiBudget, adminKeys.aiLimits];
    // Архив матчей устарел: дело администратора на «Обзоре» и в кабинете
    case 'data_stale':
      return [adminKeys.attention];
    // Администратор сменил валюту программы: все суммы — заново (без уведомления участник
    // заметит смену по первому ответу в новой валюте, watchProgramCurrency)
    case 'currency_changed':
      return MONEY_QUERIES;
    // Ставка рассчитана сама (этап 5): ставки, банк, главная и аналитика
    case 'bet_settled':
      return [betKeys.all, analysisKeys.bank, DASHBOARD_PREFIX, ANALYTICS_PREFIX, learningKeys.all];
    // Ставка ждет результата или архив показывает другое: деньги не менялись, меняется
    // метка ставки и «Требует внимания» на главной
    case 'bet_needs_result':
    case 'settle_conflict':
      return [betKeys.all, DASHBOARD_PREFIX];
    case 'weekly_report':
    case 'learning':
      return [learningKeys.all, DASHBOARD_PREFIX];
    default:
      return [];
  }
}

/**
 * Ключи для перечитывания пачки уведомлений — без повторов: каждый invalidateQueries отменяет
 * запрос, который еще идет, и запускает его заново, поэтому пачка из N «рассчитана» иначе
 * перечитывает главную и ставки N раз. Ключ, у которого в списке уже есть префикс, тоже
 * лишний: префикс накрывает его сам.
 */
export function uniqueQueryKeys(keys: readonly QueryKey[]): QueryKey[] {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const covers = (prefix: QueryKey, key: QueryKey) => prefix.length <= key.length && prefix.every((part, i) => same(part, key[i]));
  const out: QueryKey[] = [];
  for (const key of keys) {
    if (out.some((kept) => covers(kept, key))) continue;
    for (let i = out.length - 1; i >= 0; i -= 1) if (covers(key, out[i]!)) out.splice(i, 1);
    out.push(key);
  }
  return out;
}

/** Ссылка уведомления — только путь этого сайта («/profile/security»), иначе без перехода. */
export function internalLink(link: string | null | undefined): string | null {
  if (typeof link !== 'string' || !/^\/(?![/\\])/.test(link) || /[\s\\]/.test(link)) return null;
  return link;
}

/**
 * Куда ведет уведомление без ссылки с сервера: «Ставка рассчитана», «ждет результата» и
 * «архив показывает другое» — на «Ставки» (саму ставку откроет ссылка /bets?bet=ID с
 * сервера), архив матчей — на «Обзор» администрирования, где видно, когда была последняя
 * загрузка; отчет недели — на вкладку «Отчеты», обучение — на «Обучение модели».
 */
export function notificationLink(item: Pick<NotificationItem, 'kind' | 'link'>): string | null {
  const own = internalLink(item.link);
  if (own) return own;
  switch (item.kind) {
    case 'bet_settled':
    case 'bet_needs_result':
    case 'settle_conflict':
      return paths.bets;
    case 'data_stale':
      return paths.admin();
    case 'weekly_report':
      return paths.learning('reports');
    case 'learning':
      return paths.learning();
    default:
      return null;
  }
}

/** Счетчик на колокольчике: больше 99 — «99+». */
export function badgeText(unread: number): string {
  return unread > 99 ? '99+' : String(unread);
}

/** Одно уведомление прочитано: отметка в кэше сразу, не дожидаясь сервера. */
export function markOneRead(data: NotificationsOut | undefined, id: number, at: string): NotificationsOut | undefined {
  if (!data) return data;
  let changed = false;
  const items = data.items.map((item) => {
    if (item.id !== id || item.read_at) return item;
    changed = true;
    return { ...item, read_at: at };
  });
  return changed ? { items, unread: Math.max(0, data.unread - 1) } : data;
}

/** Все прочитаны. */
export function markAllRead(data: NotificationsOut | undefined, at: string): NotificationsOut | undefined {
  if (!data) return data;
  return { items: data.items.map((item) => (item.read_at ? item : { ...item, read_at: at })), unread: 0 };
}
