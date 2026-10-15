import { describe, expect, it } from 'vitest';

import { loginPath, paths, safeNext } from './paths';

describe('адреса', () => {
  it('вкладки по умолчанию без хвоста', () => {
    expect(paths.profile()).toBe('/profile');
    expect(paths.profile('profile')).toBe('/profile');
    expect(paths.profile('security')).toBe('/profile/security');
    expect(paths.admin('overview')).toBe('/admin');
    expect(paths.admin('invites')).toBe('/admin/invites');
    expect(paths.player('sinner jannik')).toBe('/players/sinner%20jannik');
    expect(paths.learning()).toBe('/learning');
    expect(paths.learning('lessons')).toBe('/learning');
    expect(paths.learning('reports')).toBe('/learning/reports');
  });

  it('loginPath запоминает, откуда пришли', () => {
    expect(loginPath('/')).toBe('/login');
    expect(loginPath('/bets?status=open')).toBe('/login?next=%2Fbets%3Fstatus%3Dopen');
  });

  it('safeNext пускает только пути этого сайта', () => {
    expect(safeNext('/bets?status=open')).toBe('/bets?status=open');
    expect(safeNext(null)).toBe('/');
    expect(safeNext('https://evil.example')).toBe('/');
    expect(safeNext('//evil.example/path')).toBe('/');
    expect(safeNext('/\\evil.example')).toBe('/');
    expect(safeNext('/login?next=/bets')).toBe('/');
    expect(safeNext('/login#x')).toBe('/');
    expect(safeNext('/login/')).toBe('/');
    expect(safeNext('bets')).toBe('/');
  });

  it('safeNext: табуляция и перевод строки не превращают путь в чужой сайт', () => {
    // браузер вырезает эти символы: «/\t/evil.example» становится «//evil.example»
    expect(safeNext('/\t/evil.example/pwn')).toBe('/');
    expect(safeNext('/\n/evil.example')).toBe('/');
    expect(safeNext('/\r\n/evil.example')).toBe('/');
    expect(safeNext(' //evil.example')).toBe('/');
    // так next приходит из адреса /login?next=...: %09 и %0A уже раскодированы
    expect(safeNext(new URLSearchParams('next=%2F%09%2Fevil.example').get('next'))).toBe('/');
    expect(safeNext(new URLSearchParams('next=%2F%0A%2Fevil.example').get('next'))).toBe('/');
    expect(safeNext(new URLSearchParams('next=%2F%5C%2Fevil.example').get('next'))).toBe('/');
    // закодированные внутри пути символы остаются частью пути этого сайта
    expect(safeNext('/players/a%09b?tab=1#top')).toBe('/players/a%09b?tab=1#top');
  });
});
