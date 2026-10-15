import { useTranslation } from 'react-i18next';

import { Callout, Card, Chip, Icon, type IconName } from '../../components';

// «Как модель учится» (cycleCard макета): шесть шагов цикла, петля «следующая ставка — с учетом
// урока», что учится, а что нет, и сколько ждать результата.

const STEPS: readonly { id: 'bet' | 'result' | 'review' | 'hypothesis' | 'check' | 'prompt'; icon: IconName; who: IconName }[] = [
  { id: 'bet', icon: 'ticket', who: 'user' },
  { id: 'result', icon: 'database', who: 'bolt' },
  { id: 'review', icon: 'search', who: 'spark' },
  { id: 'hypothesis', icon: 'book', who: 'spark' },
  { id: 'check', icon: 'flask', who: 'bolt' },
  { id: 'prompt', icon: 'brain', who: 'user' },
];

interface CycleCardProps {
  /** С какого числа своих случаев проверяется урок. */
  lessonMinCases: number;
  /** После скольких событий с исходами поправка Claude — числом в коде. */
  claudeMinEvents: number;
}

export function CycleCard({ lessonMinCases, claudeMinEvents }: CycleCardProps) {
  const { t } = useTranslation();
  return (
    <Card className="learning-card" title={t('learning.cycle.title')} subtitle={t('learning.cycle.subtitle')}>
      <ol className="learning-cycle" aria-label={t('learning.cycle.label')}>
        {STEPS.map((step, i) => (
          <li key={step.id} className="learning-step">
            <div className="learning-step-mark">
              <span className="learning-step-num" aria-hidden="true">
                {i + 1}
              </span>
              <Icon name={step.icon} />
            </div>
            <div className="learning-step-body">
              <h4>
                <span className="sr-only">{t('learning.cycle.step', { n: i + 1 })}</span>
                {t(`learning.cycle.steps.${step.id}.title`)}
              </h4>
              <p>{t(`learning.cycle.steps.${step.id}.text`, { min: lessonMinCases })}</p>
              <Chip kind="outline" icon={step.who}>
                {t(`learning.cycle.steps.${step.id}.who`)}
              </Chip>
            </div>
            {i < STEPS.length - 1 && (
              <span className="learning-step-arrow" aria-hidden="true">
                <Icon name="arrowRight" />
              </span>
            )}
          </li>
        ))}
      </ol>
      <div className="learning-loop">
        <span className="learning-loop-label">
          <Icon name="refresh" />
          <span>
            <b>{t('learning.cycle.loop')}</b>
            {t('learning.cycle.loopText')}
          </span>
        </span>
      </div>
      <Callout kind="info">
        <b>{t('learning.cycle.calloutStrong')}</b>
        {t('learning.cycle.calloutText', { min: claudeMinEvents })}
      </Callout>
      <p className="learning-doc">
        <Icon name="clock" />
        <span>{t('learning.cycle.doc')}</span>
      </p>
    </Card>
  );
}
