import { useTranslation } from 'react-i18next';

import { Callout, Card, Chip, EmptyState } from '../../components';
import { useStrategy } from '../../features/analysis/api';
import { formatPp } from '../../lib/format';

// Вкладка «Базовая модель» (mlPanel макета): Эло по покрытиям + калибровка, одна на всех.
// Версий модели и проверки по месяцам до первой перекалибровки (волна 3 этапа 5) нет —
// пустое состояние вместо полосы чисел, графиков и списка версий. Предел поправки Claude —
// из действующей стратегии участника (claude_max_shift), пока ее нет — без числа.

/** Предел поправки Claude: 0.1 → «10 п.п.», 0.075 → «7,5 п.п.». */
function shiftText(shift: number): string {
  const whole = Math.abs(shift * 100 - Math.round(shift * 100)) < 1e-9;
  return formatPp(shift, { digits: whole ? 0 : 1, signed: false });
}

export function ModelTab({ admin }: { admin: boolean }) {
  const { t } = useTranslation();
  const shift = useStrategy().data?.params.claude_max_shift;
  return (
    <Card
      className="learning-card"
      eyebrow={t('learning.model.eyebrow')}
      title={t('learning.model.title')}
      subtitle={t('learning.model.subtitle')}
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
      <EmptyState>{t('learning.model.empty')}</EmptyState>
      <Callout kind="accent" icon="shield">
        <b>{t('learning.model.calloutStrong')}</b>
        {shift === undefined ? t('learning.model.calloutTextNoShift') : t('learning.model.calloutText', { shift: shiftText(shift) })}
      </Callout>
    </Card>
  );
}
