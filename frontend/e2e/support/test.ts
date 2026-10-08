import { randomBytes, randomInt } from 'node:crypto';

import {
  test as base,
  expect,
  type APIRequestContext,
  type APIResponse,
  type BrowserContext,
  type Page,
} from '@playwright/test';

import { stackCli } from './stack';
import { Totp } from './totp';

/*
 * Общие помощники сквозных сценариев (e2e/flows) на настоящем API.
 *
 * Каждый «человек за своим устройством» — отдельный контекст браузера со своим IP-адресом:
 * заголовок X-Forwarded-For проходит через vite preview, и API (CAPPER_TRUSTED_PROXIES =
 * 127.0.0.1) считает его адресом клиента, как за Caddy. Так лимиты попыток входа и регистрации
 * (по IP) у тестов свои, а сценарий «пауза для одного IP, с другого вход работает» проверяется
 * честно. Почта и имена у каждого теста свои, поэтому сценарии не зависят друг от друга,
 * идут параллельно и повторяются на уже запущенном стеке.
 */

export interface Account {
  email: string;
  password: string;
  name: string;
  /** Есть после настройки 2FA. */
  totp?: Totp;
  recoveryCodes: string[];
}

export interface Device {
  context: BrowserContext;
  page: Page;
  /** Запросы к API с cookie и IP этого браузера. */
  api: Api;
  ip: string;
}

export interface DeviceOptions {
  /** Свой IP-адрес; по умолчанию случайный из 10.0.0.0/8. */
  ip?: string;
  userAgent?: string;
}

export function freshIp(): string {
  return `10.${randomInt(0, 256)}.${randomInt(0, 256)}.${randomInt(1, 255)}`;
}

export function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${randomBytes(3).toString('hex')}@e2e.test`;
}

/** Имя с меткой теста: база у всех сценариев общая, а участников на экране ищем по имени. */
export function uniqueName(name: string): string {
  return `${name} ${randomBytes(2).toString('hex').toUpperCase()}`;
}

export function newPassword(): string {
  return `e2e-${randomBytes(9).toString('base64url')}-7`;
}

/** Запросы к API: с CSRF-токеном, как у клиента приложения (double submit cookie). */
export class Api {
  constructor(readonly request: APIRequestContext) {}

  private async csrfToken(): Promise<string> {
    // Сервер отдает действующий токен из cookie или ставит новый
    const response = await this.request.get('/api/auth/csrf');
    expect(response.status()).toBe(200);
    return ((await response.json()) as { csrf_token: string }).csrf_token;
  }

  async post(path: string, data?: unknown): Promise<APIResponse> {
    return this.request.post(path, { data, headers: { 'X-CSRF-Token': await this.csrfToken() } });
  }

  async get(path: string): Promise<APIResponse> {
    return this.request.get(path);
  }

  /** POST с ожидаемым успешным ответом; возвращает JSON (или null для 204). */
  async ok<T = unknown>(path: string, data?: unknown): Promise<T> {
    const response = await this.post(path, data);
    if (!response.ok()) throw new Error(`POST ${path}: ${response.status()} ${await response.text()}`);
    return (response.status() === 204 ? null : await response.json()) as T;
  }

  async login(account: Account): Promise<string> {
    const out = await this.ok<{ status: string }>('/api/auth/login', {
      email: account.email,
      password: account.password,
    });
    return out.status;
  }

  /** Шаг настройки 2FA после пароля или регистрации: секрет, код, 8 резервных кодов. */
  async setupTwoFactor(account: Account): Promise<void> {
    const setup = await this.ok<{ secret: string }>('/api/auth/2fa/setup');
    account.totp = new Totp(setup.secret);
    const done = await this.ok<{ recovery_codes: string[] }>('/api/auth/2fa/setup/confirm', {
      code: await account.totp.next(),
    });
    account.recoveryCodes = [...done.recovery_codes];
  }
}

/** Администратор, созданный командой терминала (create-admin), без 2FA. */
export async function createCliAdmin(name = uniqueName('Админ')): Promise<Account> {
  const account: Account = { email: uniqueEmail('admin'), password: newPassword(), name, recoveryCodes: [] };
  await stackCli(['create-admin', '--email', account.email, '--name', name, '--password-stdin'], account.password);
  return account;
}

type DeviceFactory = (options?: DeviceOptions) => Promise<Device>;
type ApiFactory = (options?: { ip?: string }) => Promise<Api>;

export const test = base.extend<{ device: DeviceFactory; apiClient: ApiFactory }>({
  device: async ({ browser }, use) => {
    const contexts: BrowserContext[] = [];
    const errors: string[] = [];
    await use(async (options = {}) => {
      const ip = options.ip ?? freshIp();
      const context = await browser.newContext({
        extraHTTPHeaders: { 'X-Forwarded-For': ip },
        ...(options.userAgent ? { userAgent: options.userAgent } : {}),
      });
      contexts.push(context);
      // Нарушение CSP сайта (preview отдает ту же политику, что Caddy) — ошибка теста
      await context.addInitScript(() => {
        document.addEventListener('securitypolicyviolation', (event) => {
          console.error(`CSP: ${event.violatedDirective} ${event.blockedURI}`);
        });
      });
      context.on('weberror', (error) => errors.push(error.error().message));
      context.on('console', (message) => {
        // Ответы 4xx (неверный пароль, 401 после завершения сеанса, 429) браузер пишет в консоль
        // сам: это ожидаемо. Все остальные ошибки консоли — нет
        if (message.type() === 'error' && !/status of 4\d\d/.test(message.text())) {
          errors.push(`console: ${message.text()}`);
        }
      });
      context.on('response', (response) => {
        if (response.status() < 500) return;
        errors.push(`${response.status()} ${response.request().method()} ${response.url()}`);
      });
      const page = await context.newPage();
      return { context, page, api: new Api(context.request), ip };
    });
    for (const context of contexts) await context.close();
    // Ошибки на странице и ответы 5xx — дефект, даже если сценарий прошел
    expect(errors).toEqual([]);
  },

  // Клиент только для API (без браузера), со своим IP: подготовить данные, проверить ответ
  apiClient: async ({ playwright, baseURL }, use) => {
    const opened: APIRequestContext[] = [];
    await use(async (options = {}) => {
      const request = await playwright.request.newContext({
        baseURL,
        extraHTTPHeaders: { 'X-Forwarded-For': options.ip ?? freshIp() },
      });
      opened.push(request);
      return new Api(request);
    });
    for (const request of opened) await request.dispose();
  },
});

export { expect };

/** Администратор из терминала, вошедший в браузере устройства; 2FA настроена через API. */
export async function signedInAdmin(device: Device, name?: string): Promise<Account> {
  const admin = await createCliAdmin(name);
  expect(await device.api.login(admin)).toBe('totp_setup_required');
  await device.api.setupTwoFactor(admin);
  return admin;
}

/**
 * Участник по приглашению администратора: приглашение, регистрация и 2FA через API (свой IP,
 * сеанс регистрации потом закрывается). Возвращает участника с секретом 2FA и резервными кодами.
 */
export async function registeredMember(
  admin: Device,
  apiClient: ApiFactory,
  name = uniqueName('Участник'),
): Promise<Account> {
  const member: Account = { email: uniqueEmail('member'), password: newPassword(), name, recoveryCodes: [] };
  const invite = await admin.api.ok<{ code: string }>('/api/admin/invites', {
    email: member.email,
    role: 'member',
    ai_mode: 'shared',
  });
  const api = await apiClient();
  const registered = await api.ok<{ status: string }>('/api/auth/register', {
    invite_code: invite.code,
    email: member.email,
    display_name: name,
    password: member.password,
    accept_terms: true,
    consent_training: false,
    tz: 'Europe/Helsinki',
  });
  expect(registered.status).toBe('totp_setup_required');
  await api.setupTwoFactor(member);
  await api.ok('/api/auth/logout');
  return member;
}
