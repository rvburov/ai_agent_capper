import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Card, Chip, EmptyState, Icon, Segmented } from '../../components';
import type { LearningOverview } from '../../features/learning/overview';

// Вкладка «Уроки» (lessonsPanel макета): фильтр по статусу, список уроков и как их проверяют.
// Уроков до разборов ставок нет (волны 2–3 этапа 5) — пустое состояние макета.

const FILTERS = ['all', 'confirmed', 'ready', 'hypothesis', 'off'] as const;
type Filter = (typeof FILTERS)[number];

export function LessonsTab({ overview: o, admin }: { overview: LearningOverview; admin: boolean }) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<Filter>('all');
  return (
    <Card
      className="learning-card"
      title={t('learning.lessons.title')}
      subtitle={t('learning.lessons.subtitle', { max: o.lessonsMax, count: o.lessonsInPrompt })}
      {...(admin
        ? {}
        : {
            actions: (
              <Chip kind="outline" icon="admin">
                {t('learning.byAdmin')}
              </Chip>
            ),
          })}
    >
      <Segmented
        className="learning-filter"
        label={t('learning.lessons.filterLabel')}
        value={filter}
        onChange={setFilter}
        items={FILTERS.map((id) => ({
          value: id,
          label: t('learning.lessons.filterCount', { label: t(`learning.lessons.filter.${id}`), count: 0 }),
        }))}
      />
      <div aria-live="polite">
        <EmptyState>
          {o.lessonsTotal ? t('learning.lessons.emptyGroup') : t('learning.lessons.empty', { min: o.lessonMinCases })}
        </EmptyState>
      </div>
      <p className="learning-hint">
        <Icon name="info" />
        <span>{t('learning.lessons.hint', { min: o.lessonMinCases, minProcess: o.lessonMinProcess })}</span>
      </p>
    </Card>
  );
}
