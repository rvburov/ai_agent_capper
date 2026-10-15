import { useTranslation } from 'react-i18next';

import { Card, EmptyState } from '../../components';
import { timeZoneName } from '../../features/profile/timezones';
import type { LearningOverview } from '../../features/learning/overview';
import { formatDate } from '../../lib/format';

// Вкладка «Отчеты» (reportsPanel макета, В8): отчет недели приходит в понедельник в 07:00 по
// поясу участника. Отчетов до волны 4 этапа 5 нет — пустое состояние с датой первого.

export function ReportsTab({ overview: o, timeZone }: { overview: LearningOverview; timeZone: string }) {
  const { t } = useTranslation();
  return (
    <Card
      className="learning-card"
      title={t('learning.reports.title')}
      subtitle={t('learning.reports.subtitle', { city: timeZoneName(t, timeZone) })}
    >
      <EmptyState>{t('learning.reports.empty', { date: formatDate(o.nextReport) })}</EmptyState>
    </Card>
  );
}
