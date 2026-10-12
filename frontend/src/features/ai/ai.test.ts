import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import ru from '../../i18n/locales/ru.json';
import { keyMask, keyProblem, spelled } from './keyFormat';
import { aiKeys, invalidateAiBudget } from './keys';
import { modelLabel, modelList } from './models';
import { aiErrorText, keyErrorText } from './reasons';

// Локаль сервера: коды errors.ai.* приходят из API ключами, тексты для них — во фронтенде
const backend = import.meta.glob<{ errors: { ai: Record<string, string> } }>(
  '../../../../backend/app/locales/ru.json',
  { eager: true, import: 'default' },
);

/** Имена подстановок: «{cap}» на сервере и «{{cap}}» в i18next. */
function placeholders(text: string): string[] {
  return [...text.matchAll(/\{\{?(\w+)\}\}?/g)].map((m) => m[1] ?? '').sort();
}

describe('коды ИИ из API', () => {
  it('каждый код errors.ai.* сервера есть во фронтенде, с теми же подстановками и текстом', () => {
    const files = Object.values(backend);
    expect(files).toHaveLength(1);
    const server = files[0]!.errors.ai;
    const client: Record<string, string> = ru.errors.ai;
    expect(Object.keys(client).sort()).toEqual(Object.keys(server).sort());
    for (const [code, text] of Object.entries(server)) {
      expect(placeholders(client[code] ?? ''), code).toEqual(placeholders(text));
      expect(client[code]!.replace(/\{\{(\w+)\}\}/g, '{$1}'), code).toBe(text);
    }
  });

  it('текст причины по коду и параметрам; неизвестный код — общий текст', () => {
    expect(aiErrorText('ai.daily_limit', { daily: 3 })).toBe('На сегодня анализы закончились: 3 в день');
    expect(aiErrorText('ai.analysis_cap', { cap: '1,00' })).toBe('Анализ дороже потолка $1,00 на один анализ');
    expect(aiErrorText('ai.paused')).toBe('Анализы на паузе — решение администратора');
    expect(aiErrorText('ai.nothing_like_this')).toBe(ru.errors.unknown);
    expect(aiErrorText('ai.toString')).toBe(ru.errors.unknown);
  });

  it('последняя ошибка своего ключа: итог проверки и сбой настоящего вызова', () => {
    expect(keyErrorText(null)).toBeNull();
    expect(keyErrorText('rejected:401')).toBe(ru.errors.ai.key_rejected);
    expect(keyErrorText('models:claude-opus-5-5,claude-haiku-5-5')).toBe(
      'Ключ рабочий, но ему недоступны модели: claude-opus-5-5, claude-haiku-5-5. Проверьте доступ в консоли Anthropic',
    );
    expect(keyErrorText('error:500')).toBe('Anthropic ответил ошибкой 500 при проверке ключа. Попробуйте еще раз чуть позже');
    expect(keyErrorText('unavailable:None')).toBe(ru.errors.ai.key_unavailable);
    expect(keyErrorText('ai.billing')).toBe(ru.errors.ai.billing);
  });
});

describe('ключ Claude на экране', () => {
  it('формат как на сервере: sk-ant- и еще 16+ символов из латиницы, цифр, «_» и «-»', () => {
    expect(keyProblem('')).toBe('empty');
    expect(keyProblem('   ')).toBe('empty');
    expect(keyProblem('ant-api03-abcdefghijklmnop')).toBe('prefix');
    expect(keyProblem('sk-ant-123456789012345')).toBe('short');
    expect(keyProblem('sk-ant-1234567890123456')).toBeNull();
    expect(keyProblem(' sk-ant-api03-ABCdef_123-xyz7890 ')).toBeNull();
    expect(keyProblem('sk-ant-api03-ключ-1234567890123')).toBe('format');
    expect(keyProblem('sk-ant-api03 1234567890123456')).toBe('format');
  });

  it('только последние 4 символа', () => {
    expect(keyMask('m9Tq')).toBe('sk-ant-…m9Tq');
    expect(keyMask(null)).toBe('sk-ant-…••••');
    expect(spelled('m9Tq')).toBe('m 9 T q');
  });

  it('имена моделей для людей', () => {
    expect(modelLabel('claude-opus-5-5')).toBe('Opus 5.5');
    expect(modelLabel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
    expect(modelLabel('claude-sonnet-5')).toBe('Sonnet 5');
    expect(modelLabel('gpt-x')).toBe('gpt-x');
    expect(modelList(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'])).toBe('Opus 5.5, Sonnet 5.5 и Haiku 5.5');
    expect(modelList(['claude-opus-5-5'])).toBe('Opus 5.5');
    // порядок настроек агента (разбор, новости, анализ) — на экране от старшей модели
    expect(modelList(['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'])).toBe('Opus 5.5, Sonnet 5.5 и Haiku 5.5');
  });
});

describe('кэш лимита', () => {
  it('лимит перечитывается и во вкладке «Ключ Claude», и в блоке лимита анализа', async () => {
    // оба экрана читают GET /api/ai/budget под одним ключом
    const client = new QueryClient();
    client.setQueryData(aiKeys.budget, { spent_usd: 0 });
    await invalidateAiBudget(client);
    expect(client.getQueryState(aiKeys.budget)?.isInvalidated).toBe(true);
  });
});
