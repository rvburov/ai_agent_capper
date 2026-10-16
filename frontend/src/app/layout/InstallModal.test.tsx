import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { meQueryKey } from '../../api/keys';
import { ToastProvider } from '../../components';
import { listenInstallEvents, resetInstallState } from '../../features/pwa/install';
import { baseApi } from '../../test/factories';
import { ME_MEMBER, mockFetch } from '../../test/fetchMock';
import { IPHONE_UA, MAC_CHROME_UA, PIXEL_UA, stubPushBrowser } from '../../test/pushBrowser';
import { createTestQueryClient, renderPage } from '../../test/renderPage';
import { setViewportWidth } from '../../test/setup';
import { ProfilePage } from '../../pages/profile/ProfilePage';
import { ThemeProvider } from '../theme/ThemeProvider';
import { AppShell } from './AppShell';

// Установка приложения (В6): окно установки по устройству, кнопка «Установить» — окно браузера
// (beforeinstallprompt), пункт в боковой панели и в «Еще», карточка в «Профиле».

/** Событие установки Chrome: окно браузера и ответ человека. */
function installPrompt(outcome: 'accepted' | 'dismissed') {
  const event = new Event('beforeinstallprompt', { cancelable: true }) as Event & {
    prompt: ReturnType<typeof vi.fn>;
    userChoice: Promise<{ outcome: string }>;
  };
  event.prompt = vi.fn(async () => undefined);
  event.userChoice = Promise.resolve({ outcome });
  act(() => {
    window.dispatchEvent(event);
  });
  return event;
}

function renderShell(width = 1366) {
  setViewportWidth(width);
  mockFetch(baseApi(ME_MEMBER));
  const client = createTestQueryClient();
  client.setQueryData(meQueryKey, ME_MEMBER);
  const router = createMemoryRouter(
    [{ path: '/', element: <AppShell />, children: [{ index: true, element: <p>Экран главной</p>, handle: { title: 'dashboard', nav: 'dashboard' } }] }],
    { initialEntries: ['/'] },
  );
  render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

const toast = (text: string) => screen.findByText(text, { selector: '.toast span' });

beforeEach(() => {
  resetInstallState();
  listenInstallEvents();
});

afterEach(() => {
  resetInstallState();
});

describe('Окно установки', () => {
  it('компьютер, Chrome прислал beforeinstallprompt: «Установить приложение» в боковой панели → окно браузера → установлено', async () => {
    stubPushBrowser({ userAgent: MAC_CHROME_UA });
    renderShell();
    const event = installPrompt('accepted');
    expect(event.defaultPrevented).toBe(true);
    const user = userEvent.setup();
    const sidebar = screen.getByRole('complementary', { name: 'Основная навигация' });
    await user.click(within(sidebar).getByRole('button', { name: 'Установить приложение' }));
    const dialog = screen.getByRole('dialog', { name: 'Установить приложение' });
    expect(within(dialog).getByText(/В Chrome и Edge: кнопка «Установить» ниже/)).toBeInTheDocument();
    expect(within(dialog).getByText('Открывается с иконки на весь экран, без адресной строки')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Установить' }));
    expect(event.prompt).toHaveBeenCalledTimes(1);
    expect(await toast('AI Capper установлен: отдельное окно и значок в Dock или «Пуске»')).toBeInTheDocument();
    expect(within(dialog).getByText('Приложение установлено')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Установить' })).toBeNull();
  });

  it('Android, установку отменили — тост, кнопки больше нет (событие одноразовое), шаги через меню браузера', async () => {
    stubPushBrowser({ userAgent: PIXEL_UA });
    renderShell(375);
    installPrompt('dismissed');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Еще' }));
    await user.click(within(screen.getByRole('dialog', { name: 'Еще' })).getByRole('button', { name: 'Установить на телефон' }));
    const dialog = screen.getByRole('dialog', { name: 'Установить на телефон' });
    expect(within(dialog).getByText(/Нажмите «Установить» и подтвердите в окне Chrome/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Установить' }));
    expect(await toast('Установку отменили. Установить можно позже из меню браузера')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Установить' })).toBeNull();
    expect(within(dialog).getByText(/«Установить приложение» или «Добавить на главный экран»/)).toBeInTheDocument();
  });

  it('iPhone: пять шагов «Поделиться → На экран «Домой»», про iOS 16.4, без кнопки «Установить»', async () => {
    stubPushBrowser({ userAgent: IPHONE_UA });
    renderShell(375);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Еще' }));
    await user.click(within(screen.getByRole('dialog', { name: 'Еще' })).getByRole('button', { name: 'Установить на телефон' }));
    const dialog = screen.getByRole('dialog', { name: 'Установить на телефон' });
    const steps = within(dialog).getByRole('list', { name: 'Как установить на iPhone' });
    expect(steps.querySelectorAll('li')).toHaveLength(5);
    expect(within(steps).getByText('Поделиться')).toHaveClass('key-cap');
    expect(within(dialog).getByText(/iOS 16.4 и новее/)).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Установить' })).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Понятно' }));
    expect(screen.queryByRole('dialog', { name: 'Установить на телефон' })).toBeNull();
  });
});

describe('Профиль: «Приложение на телефоне»', () => {
  it('не установлено: это устройство, кнопка установки, ссылка «Как приложение выглядит без связи»', async () => {
    stubPushBrowser({ userAgent: PIXEL_UA });
    const { user } = renderPage(<ProfilePage />, { path: '/profile/:tab?', url: '/profile', api: {}, width: 375 });
    const card = (await screen.findByRole('heading', { name: 'Приложение на телефоне' })).closest('section') as HTMLElement;
    expect(within(card).getByText('Не установлено')).toBeInTheDocument();
    expect(within(card).getByText('Это устройство: Android · Chrome')).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: 'Как приложение выглядит без связи' })).toHaveAttribute('href', '/offline');
    await user.click(within(card).getByRole('button', { name: 'Установить на телефон' }));
    expect(screen.getByRole('dialog', { name: 'Установить на телефон' })).toBeInTheDocument();
  });

  it('открыто с экрана «Домой» — «Установлено», в окне — «Приложение установлено»', async () => {
    stubPushBrowser({ userAgent: IPHONE_UA, standalone: true });
    const { user } = renderPage(<ProfilePage />, { path: '/profile/:tab?', url: '/profile', api: {}, width: 375 });
    const card = (await screen.findByRole('heading', { name: 'Приложение на телефоне' })).closest('section') as HTMLElement;
    expect(within(card).getByText('Установлено')).toBeInTheDocument();
    expect(within(card).getByText('Это устройство: iPhone · приложение AI Capper')).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Подробнее' }));
    const dialog = screen.getByRole('dialog', { name: 'Установить на телефон' });
    expect(within(dialog).getByText('Приложение установлено')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Готово' })).toBeInTheDocument();
  });
});
