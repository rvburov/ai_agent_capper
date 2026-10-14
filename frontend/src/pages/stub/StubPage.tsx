import { useTranslation } from 'react-i18next';

import { Card, EmptyState, type IconName } from '../../components';

// После этапа 4 заглушка осталась только у «Обучения модели» (этап 5)
export type StubScreen = 'learning';

const ICONS: Record<StubScreen, IconName> = {
  learning: 'brain',
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
