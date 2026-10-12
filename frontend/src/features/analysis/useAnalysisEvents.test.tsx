import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { aiKeys } from '../ai/keys';
import { analysisKeys } from './keys';
import { analysisDone, analysisRunning, progressEvent } from './testData';
import type { Analysis } from './types';
import { applyEvent, setEventSourceFactory, useAnalysisEvents } from './useAnalysisEvents';

// Поддельный EventSource: тест сам шлет события и обрывы; в jsdom настоящего нет
class FakeSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static all: FakeSource[] = [];

  readyState = FakeSource.CONNECTING;
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((message: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeSource.all.push(this);
  }

  open() {
    this.readyState = FakeSource.OPEN;
    this.onopen?.();
  }

  send(data: unknown) {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(data) }));
  }

  fail(readyState: number) {
    this.readyState = readyState;
    this.onerror?.();
  }

  close() {
    this.closed = true;
    this.readyState = FakeSource.CLOSED;
  }
}

function setup(analysis: Analysis, active = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(analysisKeys.one(analysis.id), analysis);
  const invalidate = vi.spyOn(client, 'invalidateQueries').mockResolvedValue(undefined);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const hook = renderHook(({ on }) => useAnalysisEvents(analysis.id, on), {
    wrapper,
    initialProps: { on: active },
  });
  const cached = () => client.getQueryData<Analysis>(analysisKeys.one(analysis.id));
  return { client, hook, cached, invalidate, source: () => FakeSource.all.at(-1)! };
}

beforeEach(() => {
  FakeSource.all = [];
  vi.stubGlobal('EventSource', FakeSource);
  setEventSourceFactory((url) => new FakeSource(url) as unknown as EventSource);
});

afterEach(() => {
  setEventSourceFactory(null);
});

describe('useAnalysisEvents', () => {
  it('подписывается на поток и пишет шаги в кэш', () => {
    const running = analysisRunning();
    const { hook, cached, source } = setup(running);
    expect(source().url).toBe('/api/analyses/1/events');
    expect(hook.result.current).toEqual({ stream: 'connecting', poll: false });

    act(() => source().open());
    act(() => source().send(progressEvent(running)));
    expect(hook.result.current.stream).toBe('open');

    const step = { ...running.steps[6]!, state: 'done' as const, tokens: 5467, cost_usd: 0.038 };
    act(() =>
      source().send(
        progressEvent(running, { type: 'step', steps: null, step, totals: { ...running.totals, step: 8 } }),
      ),
    );
    expect(cached()?.steps[6]?.state).toBe('done');
    expect(cached()?.steps[7]?.state).toBe('pending');
    expect(cached()?.totals.step).toBe(8);
  });

  it('конец анализа: поток закрыт, анализ и список перечитываются', () => {
    const running = analysisRunning();
    const { hook, cached, invalidate, source } = setup(running);
    act(() => source().open());
    act(() => source().send(progressEvent(running, { type: 'done', status: 'done', steps: null })));
    expect(source().closed).toBe(true);
    expect(cached()?.status).toBe('done');
    expect(hook.result.current).toEqual({ stream: 'closed', poll: true });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: analysisKeys.one(1) });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: analysisKeys.list });
    // расход анализа виден и во вкладке «Ключ Claude», и в блоке лимита
    expect(invalidate).toHaveBeenCalledWith({ queryKey: aiKeys.all });
    // поздний обрыв после конца ничего не меняет
    act(() => source().fail(FakeSource.CONNECTING));
    expect(hook.result.current.stream).toBe('closed');
  });

  it('снимок анализа не в работе — поток закрывается, без переподключений', () => {
    const done = analysisDone();
    const { source, invalidate } = setup(done);
    act(() => source().send(progressEvent(done)));
    expect(source().closed).toBe(true);
    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  it('обрыв связи: опрос, пока браузер переподключается; потом снова поток', () => {
    const running = analysisRunning();
    const { hook, source } = setup(running);
    act(() => source().open());
    act(() => source().fail(FakeSource.CONNECTING));
    expect(hook.result.current).toEqual({ stream: 'offline', poll: true });
    act(() => source().open());
    expect(hook.result.current).toEqual({ stream: 'open', poll: false });
    // сервер отказал (CLOSED) — остается опрос
    act(() => source().fail(FakeSource.CLOSED));
    expect(hook.result.current).toEqual({ stream: 'closed', poll: true });
  });

  it('битое событие пропускается; анализ не в работе — подписки нет', () => {
    const running = analysisRunning();
    const { cached, source, hook } = setup(running);
    act(() => source().onmessage?.(new MessageEvent('message', { data: 'not json' })));
    expect(cached()?.status).toBe('llm_review');
    hook.rerender({ on: false });
    expect(source().closed).toBe(true);
    expect(hook.result.current).toEqual({ stream: 'idle', poll: false });
    expect(FakeSource.all).toHaveLength(1);
  });
});

describe('applyEvent', () => {
  it('снимок заменяет шаги целиком, шаг — только свой', () => {
    const running = analysisRunning();
    const snapshot = applyEvent(running, progressEvent(running, { steps: running.steps.slice(0, 2) }));
    expect(snapshot.steps).toHaveLength(2);
    const added = applyEvent(
      snapshot,
      progressEvent(running, { type: 'step', steps: null, step: { ...running.steps[4]!, state: 'running' } }),
    );
    expect(added.steps.map((s) => s.index)).toEqual([0, 1, 4]);
  });

  it('ошибка: из события, а у failed без ошибки — прежняя', () => {
    const running = analysisRunning();
    const error = { code: 'ai.overloaded', params: {}, step: 'claude' };
    const failed = applyEvent(running, progressEvent(running, { type: 'failed', status: 'failed', error }));
    expect(failed.error).toEqual(error);
    expect(applyEvent(failed, progressEvent(failed, { status: 'failed', error: null })).error).toEqual(error);
    expect(applyEvent(failed, progressEvent(failed, { status: 'queued', error: null })).error).toBeNull();
  });
});
