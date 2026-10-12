import { useTranslation } from 'react-i18next';

import { Card, EmptyState, type IconName } from '../../components';

export type StubScreen =
  | 'dashboard'
  | 'bets'
  | 'players'
  | 'player'
  | 'analytics'
  | 'learning'
  | 'costs';

const ICONS: Record<StubScreen, IconName> = {
  dashboard: 'home',
  bets: 'ticket',
  players: 'users',
  player: 'user',
  analytics: 'chart',
  learning: 'brain',
  costs: 'coins',
};

/** Заглушка экрана, которого еще нет: на каком этапе появится и что в нем будет (docs/PLAN.md, раздел 10). */
export function StubPage({ screen, stage }: { screen: StubScreen; stage: number }) {
  const { t } = useTranslation();
  return (
    <Card>
      <EmptyState icon={ICONS[screen]} title={t('stub.stage', { stage })} text={t(`stub.${screen}`)} />
    </Card>
  );
}
