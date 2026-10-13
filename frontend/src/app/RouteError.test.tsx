import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Suspense, type ReactNode } from 'react';
import { createMemoryRouter, RouterProvider, useRouteError } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CHUNK_RELOAD_KEY,
  CHUNK_RELOAD_WINDOW_MS,
  ChunkLoadError,
  chunkReloadedRecently,
  claimChunkReload,
  isChunkLoadError,
  lazyPage,
} from './lazyPage';
import { reloadPage } from './reloadPage';
import { RouteError } from './RouteError';

vi.mock('./reloadPage', () => ({ reloadPage: vi.fn() }));

// Так браузер сообщает, что файла экрана после выкладки на сервере уже нет
const MISSING = new TypeError('Failed to fetch dynamically imported module: /assets/BetsPage-old.js');

function renderLazy(load: () => Promise<() => ReactNode>) {
  const Page = lazyPage(load);
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: (
          <Suspense fallback={<p>Грузим</p>}>
            <Page />
          </Suspense>
        ),
        errorElement: <RouteError />,
      },
    ],
    { initialEntries: ['/'] },
  );
  render(<RouterProvider router={router} />);
}

beforeEach(() => {
  window.sessionStorage.clear();
  // ошибки маршрута RouteError пишет в консоль — в тестах это ожидаемо
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.mocked(reloadPage).mockClear();
});

describe('Ленивые экраны', () => {
  it('экран грузится по требованию: сначала индикатор, потом экран', async () => {
    let resolve!: (component: () => ReactNode) => void;
    renderLazy(() => new Promise((r) => (resolve = r)));
    expect(screen.getByText('Грузим')).toBeInTheDocument();
    resolve(() => <h1>Ставки</h1>);
    expect(await screen.findByRole('heading', { name: 'Ставки' })).toBeInTheDocument();
  });

  it('файл экрана не загрузился — ChunkLoadError с исходной причиной', async () => {
    const Page = lazyPage(() => Promise.reject(MISSING));
    // lazy отдает ошибку при первой отрисовке; достаем ее через границу ошибок роутера
    let caught: unknown;
    const router = createMemoryRouter([
      {
        path: '/',
        element: (
          <Suspense fallback={null}>
            <Page />
          </Suspense>
        ),
        errorElement: <Catch onError={(error) => (caught = error)} />,
      },
    ]);
    render(<RouterProvider router={router} />);
    await screen.findByText('поймали');
    expect(isChunkLoadError(caught)).toBe(true);
    expect((caught as ChunkLoadError).cause).toBe(MISSING);
    expect(isChunkLoadError(MISSING)).toBe(false);
  });
});

describe('RouteError: экран не загрузился после выкладки', () => {
  it('первый раз страница перезагружается сама', async () => {
    renderLazy(() => Promise.reject(MISSING));
    expect(await screen.findByRole('status', { name: 'Загружаем новую версию программы' })).toBeInTheDocument();
    expect(reloadPage).toHaveBeenCalledTimes(1);
    expect(Number(window.sessionStorage.getItem(CHUNK_RELOAD_KEY))).toBeGreaterThan(0);
  });

  it('ошибка сразу после автоперезагрузки — новая версия уже загружена: текст сбоя, без цикла', async () => {
    const user = userEvent.setup();
    window.sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now() - 5_000));
    renderLazy(() => Promise.reject(MISSING));
    expect(await screen.findByText('Экран не загрузился')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Страницу уже обновили, но экран так и не загрузился');
    expect(screen.getByRole('alert')).toHaveTextContent('Обновите страницу через минуту');
    expect(screen.queryByText('Вышла новая версия программы')).toBeNull();
    expect(screen.getByRole('alert')).not.toHaveTextContent('откроется новая версия');
    expect(reloadPage).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Обновить страницу' }));
    expect(reloadPage).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('link', { name: 'На главную' })).toHaveAttribute('href', '/');
  });

  it('браузер запретил sessionStorage — сама не перезагружается: текст про новую версию', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    renderLazy(() => Promise.reject(MISSING));
    expect(await screen.findByText('Вышла новая версия программы')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Обновите страницу — откроется новая версия');
    expect(reloadPage).not.toHaveBeenCalled();
  });

  it('нет связи — свой текст, сама не перезагружается', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    renderLazy(() => Promise.reject(new TypeError('Failed to fetch')));
    expect(await screen.findByText('Экран не загрузился')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Нет связи с сервером');
    expect(reloadPage).not.toHaveBeenCalled();
  });

  it('обычная ошибка отрисовки — прежний текст, без автоперезагрузки', async () => {
    function Broken(): ReactNode {
      throw new Error('сломалось');
    }
    renderLazy(() => Promise.resolve(Broken));
    expect(await screen.findByText('Не удалось показать экран')).toBeInTheDocument();
    expect(reloadPage).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(CHUNK_RELOAD_KEY)).toBeNull();
  });
});

describe('claimChunkReload', () => {
  const NOW = 1_800_000_000_000;

  it('разрешает одну перезагрузку в минуту', () => {
    expect(claimChunkReload(NOW)).toBe(true);
    expect(claimChunkReload(NOW + 1_000)).toBe(false);
    expect(claimChunkReload(NOW + CHUNK_RELOAD_WINDOW_MS - 1)).toBe(false);
    // следующая выкладка через час — снова можно
    expect(claimChunkReload(NOW + CHUNK_RELOAD_WINDOW_MS)).toBe(true);
  });

  it('мусор в хранилище и время из будущего не мешают', () => {
    window.sessionStorage.setItem(CHUNK_RELOAD_KEY, 'abc');
    expect(claimChunkReload(NOW)).toBe(true);
    window.sessionStorage.setItem(CHUNK_RELOAD_KEY, String(NOW + 10 * CHUNK_RELOAD_WINDOW_MS));
    expect(claimChunkReload(NOW)).toBe(true);
  });

  it('хранилище недоступно — без автоперезагрузки', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(claimChunkReload(NOW)).toBe(false);
  });

  it('chunkReloadedRecently: только читает отметку', () => {
    expect(chunkReloadedRecently(NOW)).toBe(false);
    window.sessionStorage.setItem(CHUNK_RELOAD_KEY, String(NOW - 1_000));
    expect(chunkReloadedRecently(NOW)).toBe(true);
    expect(chunkReloadedRecently(NOW + CHUNK_RELOAD_WINDOW_MS)).toBe(false);
    expect(window.sessionStorage.getItem(CHUNK_RELOAD_KEY)).toBe(String(NOW - 1_000));
  });

  it('нет связи — без автоперезагрузки и без записи', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    expect(claimChunkReload(NOW)).toBe(false);
    expect(window.sessionStorage.getItem(CHUNK_RELOAD_KEY)).toBeNull();
  });
});

/** Граница ошибок маршрута для теста: отдает пойманную ошибку наружу. */
function Catch({ onError }: { onError: (error: unknown) => void }) {
  onError(useRouteError());
  return <p>поймали</p>;
}
