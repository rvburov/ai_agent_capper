import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, onTestFinished } from 'vitest';

import { ToastProvider } from '../../components';
import { json, mockFetch } from '../../test/fetchMock';
import { ThemeProvider } from '../theme/ThemeProvider';
import { OfflineGate } from './OfflineGate';

// «Нет связи» поверх приложения (В7): связь пропала — экран, приложение недоступно; вернулась — ушел.

function setOnline(value: boolean) {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => value });
  window.dispatchEvent(new Event(value ? 'online' : 'offline'));
}

function renderGate() {
  const root = document.createElement('div');
  root.id = 'root';
  document.body.appendChild(root);
  onTestFinished(() => {
    root.remove();
    delete (navigator as { onLine?: boolean }).onLine;
  });
  return render(
    <ThemeProvider>
      <ToastProvider>
        <OfflineGate>
          <p>Ставки участника</p>
        </OfflineGate>
      </ToastProvider>
    </ThemeProvider>,
    { container: root },
  );
}

describe('OfflineGate', () => {
  it('связь пропала — «Нет связи с интернетом», приложение под ним inert; вернулась — экран ушел сам', async () => {
    renderGate();
    expect(screen.queryByRole('heading', { name: 'Нет связи с интернетом' })).toBeNull();
    act(() => setOnline(false));
    expect(screen.getByRole('heading', { name: 'Нет связи с интернетом' })).toBeInTheDocument();
    expect(document.getElementById('root')?.inert).toBe(true);
    expect(document.title).toBe('Нет связи · AI Capper');
    expect(screen.getByText('Проверьте Wi-Fi или мобильный интернет')).toBeInTheDocument();
    act(() => setOnline(true));
    expect(screen.queryByRole('heading', { name: 'Нет связи с интернетом' })).toBeNull();
    expect(document.getElementById('root')?.inert).toBe(false);
    expect(screen.getByText('Ставки участника')).toBeInTheDocument();
  });

  it('«Повторить»: сервер не отвечает — «по-прежнему нет»; отвечает — экран убран, тост', async () => {
    let up = false;
    mockFetch({
      'GET /api/health': () => {
        if (!up) throw new TypeError('Failed to fetch');
        return json({ status: 'ok' });
      },
    });
    renderGate();
    act(() => setOnline(false));
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(await screen.findByText('Связи по-прежнему нет. Попробуйте еще раз через минуту')).toBeInTheDocument();
    up = true;
    await user.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(await screen.findByText('Связь восстановлена')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Нет связи с интернетом' })).toBeNull();
  });
});
