import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { errorMessage } from '../../api/errors';
import { Button, Callout, Card, Chip, EmptyState, Icon, Segmented, Skeleton, useToast } from '../../components';
import { filterCounts, inFilter, LESSON_FILTERS, plural, sortLessons, type LessonFilter } from '../../features/learning/display';
import type { useLessons } from '../../features/learning/lessons';
import type { Lesson } from '../../features/learning/types';
import { formatNumber } from '../../lib/format';
import { EnableModal } from './EnableModal';
import { LessonCard } from './LessonCard';
import { LessonModal } from './LessonModal';

// Вкладка «Уроки» (lessonsPanel макета): фильтр по статусу, карточки уроков (готовые к решению
// — первыми, порядок — сервера), «Подробнее», у администратора — «Использовать в анализе» с
// быстрой проверкой (В4). Уроки общие, ведет администратор (В5); предложить урок может каждый.

interface LessonsTabProps {
  lessons: ReturnType<typeof useLessons>;
  admin: boolean;
  onPropose: () => void;
  /** Фильтр — в состоянии страницы: после «Предложить урок» он сбрасывается на «Все». */
  filter: LessonFilter;
  onFilter: (filter: LessonFilter) => void;
}

export function LessonsTab({ lessons: query, admin, onPropose, filter, onFilter }: LessonsTabProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const [openedId, setOpenedId] = useState<number | null>(null);
  const [enabling, setEnabling] = useState<Lesson | null>(null);
  const data = query.data;
  const items = data?.items ?? [];
  const counts = filterCounts(items);
  const rows = sortLessons(items.filter((lesson) => inFilter(lesson, filter)));
  const opened = openedId === null ? null : (items.find((lesson) => lesson.id === openedId) ?? null);

  // урок включили из окна: кнопка, которая его открыла, исчезла (карточка стала
  // «Подтвержден») — фокус на выключатель карточки; карточки в группе нет — на панель вкладки
  const [focusId, setFocusId] = useState<number | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const focusReady = focusId !== null && items.some((lesson) => lesson.id === focusId && lesson.in_prompt);
  useEffect(() => {
    if (focusId === null || enabling || !focusReady) return;
    const box = boxRef.current;
    const target =
      box?.querySelector<HTMLElement>(`[data-lesson-id="${focusId}"] input[role="switch"]`) ??
      box?.closest<HTMLElement>('[role="tabpanel"]') ??
      null;
    target?.focus({ preventScroll: true });
    setFocusId(null);
  }, [focusId, enabling, focusReady]);

  function openEnable(lesson: Lesson) {
    // предел уроков в анализе (настройки): сначала выключить один, как в макете
    if (data && data.active >= data.max_active) {
      toast.show(t('learning.lessons.toastFull', { count: data.max_active, n: formatNumber(data.max_active) }), { icon: 'alert', duration: 5000 });
      return;
    }
    setEnabling(lesson);
  }

  let body;
  if (query.isPending) body = <Skeleton lines={4} />;
  else if (!data)
    body = (
      <Callout kind="bad" icon="alert" role="alert">
        {errorMessage(query.error)}{' '}
        <Button size="sm" kind="ghost" icon="refresh" onClick={() => void query.refetch()}>
          {t('common.retry')}
        </Button>
      </Callout>
    );
  else if (!rows.length)
    body = <EmptyState>{items.length ? t('learning.lessons.emptyGroup') : t('learning.lessons.empty', { fromCases: plural(t, 'fromCases', data.min_cases) })}</EmptyState>;
  else
    body = (
      <div className="learning-lessons">
        {rows.map((lesson) => (
          <LessonCard key={lesson.id} lesson={lesson} admin={admin} onEnable={openEnable} onOpen={(lesson) => setOpenedId(lesson.id)} />
        ))}
      </div>
    );

  return (
    <Card
      className="learning-card"
      title={t('learning.lessons.title')}
      subtitle={data ? t('learning.lessons.subtitle', { max: data.max_active, count: data.active }) : t('learning.lessons.subtitleShort')}
      actions={
        <>
          {!admin && (
            <Chip kind="outline" icon="admin">
              {t('learning.byAdmin')}
            </Chip>
          )}
          <Button kind="secondary" size="sm" icon="plus" onClick={onPropose}>
            {t('learning.propose.open')}
          </Button>
        </>
      }
    >
      <Segmented<LessonFilter>
        className="learning-filter"
        label={t('learning.lessons.filterLabel')}
        value={filter}
        onChange={onFilter}
        items={LESSON_FILTERS.map((id) => ({
          value: id,
          label: t('learning.lessons.filterCount', { label: t(`learning.lessons.filter.${id}`), count: counts[id] }),
        }))}
      />
      <div aria-live="polite" className="learning-lessons-box" ref={boxRef}>
        {body}
      </div>
      <p className="learning-hint">
        <Icon name="info" />
        <span>
          {data
            ? t('learning.lessons.hint', { fromCases: plural(t, 'fromCases', data.min_cases), onCases: plural(t, 'onCases', data.min_cases_process) })
            : t('learning.lessons.hintShort')}
        </span>
      </p>
      {opened && <LessonModal lesson={opened} shrinkK={data?.shrink_k ?? null} onClose={() => setOpenedId(null)} />}
      {enabling && <EnableModal lesson={enabling} onClose={() => setEnabling(null)} onEnabled={(lesson) => setFocusId(lesson.id)} />}
    </Card>
  );
}
