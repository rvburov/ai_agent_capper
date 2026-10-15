import { useTranslation } from 'react-i18next';

import { Card, EmptyState } from '../../components';
import { timeZoneName } from '../../features/profile/timezones';
import type { LearningSummary } from '../../features/learning/types';
import { formatDate } from '../../lib/format';

// Вкладка «Отчеты» (reportsPanel макета, В8): отчет недели приходит в понедельник в 07:00 по
// поясу участника (день считает сервер, GET /api/learning). Отчетов до волны 4 этапа 5 нет —
// пустое состояние с датой первого.

export function ReportsTab({ summary, timeZone }: { summary: LearningSummary | null; timeZone: string }) {
  const { t } = useTranslation();
  return (
    <Card
      className="learning-card"
      title={t('learning.reports.title')}
      subtitle={t('learning.reports.subtitle', { city: timeZoneName(t, timeZone) })}
    >
      <EmptyState>{summary ? t('learning.reports.empty', { date: formatDate(summary.next_report) }) : t('learning.reports.emptyNoDate')}</EmptyState>
    </Card>
  );
}
