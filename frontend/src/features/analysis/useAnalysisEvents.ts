import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { invalidateAiBudget } from '../ai/keys';
import { analysisKeys } from './keys';
import type { Analysis, ProgressEvent, Step } from './types';
import { isActive } from './types';

/*
 * Ход анализа потоком SSE (GET /api/analyses/{id}/events). Первое событие — снимок из базы,
 * дальше — шаги и смена статуса; каждое событие пишется в кэш TanStack Query (анализ по
 * ключу analysisKeys.one). Конец — done, failed или cancelled: поток закрывается, анализ
 * перечитывается целиком (итог, ошибка). Снимок анализа не в работе — тоже закрываем, иначе
 * браузер переподключался бы каждые 3 с.
 *
 * Обрыв связи: EventSource переподключается сам и шлет Last-Event-ID последнего события —
 * сервер продолжит с него. Пока связи нет, экран показывает «Связь прервалась — обновляем…»
 * и опрашивает GET /api/analyses/{id} (poll). Сервер закрыл поток ошибкой (401, 404) —
 * переподключения не будет, остается опрос.
 */

const TERMINAL = new Set(['done', 'failed', 'cancelled']);

export type StreamState = 'idle' | 'connecting' | 'open' | 'offline' | 'closed';

export interface AnalysisEventsState {
  /** Состояние потока: offline — связь прервалась, идет переподключение и опрос. */
  stream: StreamState;
  /** Нужен запасной опрос GET /api/analyses/{id}. */
  poll: boolean;
}

// Событие в кэш: снимок заменяет шаги целиком, событие шага — только свой шаг
export function applyEvent(analysis: Analysis, event: ProgressEvent): Analysis {
  let steps: Step[] = analysis.steps;
  if (event.steps) steps = event.steps;
  else if (event.step) {
    const step = event.step;
    const found = steps.some((item) => item.index === step.index);
    steps = found
      ? steps.map((item) => (item.index === step.index ? step : item))
      : [...steps, step].sort((a, b) => a.index - b.index);
  }
  return {
    ...analysis,
    status: event.status,
    steps,
    totals: event.totals,
    error: event.error ?? (event.status === 'failed' ? analysis.error : null),
  };
}

/** Фабрика EventSource: тесты подменяют ее (в jsdom EventSource нет). */
export type EventSourceFactory = (url: string) => EventSource;

const browserSource: EventSourceFactory = (url) => new EventSource(url);
let makeSource: EventSourceFactory = browserSource;

export function setEventSourceFactory(factory: EventSourceFactory | null): void {
  makeSource = factory ?? browserSource;
}

/** Подписка на ход анализа, пока он идет (active — статус анализа в работе). */
export function useAnalysisEvents(id: number, active: boolean): AnalysisEventsState {
  const client = useQueryClient();
  const [stream, setStream] = useState<StreamState>('idle');
  const finished = useRef(false);

  useEffect(() => {
    if (!active || id <= 0 || typeof EventSource === 'undefined') {
      setStream(active ? 'closed' : 'idle');
      return;
    }
    finished.current = false;
    const key = analysisKeys.one(id);
    const source = makeSource(`/api/analyses/${encodeURIComponent(String(id))}/events`);
    setStream('connecting');

    function close() {
      source.close();
      setStream('closed');
    }

    source.onopen = () => setStream('open');
    source.onmessage = (message: MessageEvent<string>) => {
      let event: ProgressEvent;
      try {
        event = JSON.parse(message.data) as ProgressEvent;
      } catch {
        return;
      }
      setStream('open');
      client.setQueryData<Analysis>(key, (old) => (old ? applyEvent(old, event) : old));
      const ended = TERMINAL.has(event.type) || (event.type === 'snapshot' && !isActive(event.status));
      if (ended && !finished.current) {
        finished.current = true;
        close();
        // Итог (вероятности, экспресс) и решение приходят только в полном анализе
        void client.invalidateQueries({ queryKey: key });
        void client.invalidateQueries({ queryKey: analysisKeys.list });
        // Анализ закончился на глазах: его расход уже в лимите месяца
        if (TERMINAL.has(event.type)) void invalidateAiBudget(client);
      }
    };
    source.onerror = () => {
      if (finished.current) return;
      // CONNECTING — браузер переподключается сам (с Last-Event-ID); CLOSED — сервер отказал
      setStream(source.readyState === EventSource.CLOSED ? 'closed' : 'offline');
    };
    return () => {
      source.close();
    };
  }, [id, active, client]);

  return { stream, poll: active && (stream === 'offline' || stream === 'closed') };
}
