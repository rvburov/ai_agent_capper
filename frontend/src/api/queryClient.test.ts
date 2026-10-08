import { afterEach, describe, expect, it } from 'vitest';

import { getDisplayTimeZone, setDisplayTimeZone } from '../lib/format';
import { ME_MEMBER } from '../test/fetchMock';
import { meQueryKey } from './keys';
import { createQueryClient } from './queryClient';

afterEach(() => {
  setDisplayTimeZone(undefined);
});

describe('пояс показа дат из профиля', () => {
  it('ставится и при записи профиля в кэш без запроса (вход), и снимается при выходе', () => {
    const client = createQueryClient();
    expect(getDisplayTimeZone()).toBeUndefined();

    client.setQueryData(meQueryKey, { ...ME_MEMBER, tz: 'Asia/Tokyo' });
    expect(getDisplayTimeZone()).toBe('Asia/Tokyo');

    client.setQueryData(meQueryKey, { ...ME_MEMBER, tz: 'Europe/Helsinki' });
    expect(getDisplayTimeZone()).toBe('Europe/Helsinki');

    client.removeQueries();
    expect(getDisplayTimeZone()).toBeUndefined();
  });

  it('другие запросы пояс не трогают', () => {
    const client = createQueryClient();
    client.setQueryData(meQueryKey, ME_MEMBER);
    client.setQueryData(['bets'], { tz: 'Asia/Tokyo' });
    expect(getDisplayTimeZone()).toBe('Europe/Helsinki');
  });
});
