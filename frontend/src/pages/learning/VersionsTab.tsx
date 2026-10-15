import { useTranslation } from 'react-i18next';

import { paths } from '../../app/paths';
import { Button, Callout, Card, Chip, Skeleton } from '../../components';
import { useStrategy } from '../../features/analysis/api';
import type { LearningSummary } from '../../features/learning/types';

// Вкладка «Версии стратегии» (versionsPanel макета): инструкции анализа — общая линия версий,
// ее ведет администратор (В5); как принимается новая версия; свои правила суммы ставки.
// Набора для проверки версий и кандидатов пока нет — пустое состояние макета.

function RulesCard() {
  const { t } = useTranslation();
  const rule = (n: number, text: string, title?: string) => (
    <li>
      <span aria-hidden="true">{n}</span>
      <div>
        {title && <b>{title}</b>}
        <span>{text}</span>
      </div>
    </li>
  );
  return (
    <Card className="learning-card" title={t('learning.versions.rules.title')} subtitle={t('learning.versions.rules.subtitle')}>
      <ol className="learning-rules">
        {rule(1, t('learning.versions.rules.r1'))}
        {rule(2, t('learning.versions.rules.r2'), t('learning.versions.rules.r2Title'))}
        {rule(3, t('learning.versions.rules.r3'), t('learning.versions.rules.r3Title'))}
        {rule(4, t('learning.versions.rules.r4'))}
      </ol>
    </Card>
  );
}

/** Свои правила суммы ставки: действующая версия стратегии участника (GET /api/strategy/active). */
function StakeRulesCard() {
  const { t } = useTranslation();
  const strategy = useStrategy();
  let body;
  if (strategy.isPending) body = <Skeleton height={40} />;
  else if (!strategy.data) body = <p className="small muted">{t('learning.versions.stake.failed')}</p>;
  else
    body = (
      <div className="learning-row">
        <div className="learning-min">
          <div className="learning-ver-name">
            <b>{strategy.data.code}</b>
            <span className="soft small">{strategy.data.name}</span>
          </div>
        </div>
        <Chip kind="good" icon="check">
          {t('learning.versions.stake.active')}
        </Chip>
      </div>
    );
  return (
    <Card
      className="learning-card"
      title={t('learning.versions.stake.title')}
      subtitle={t('learning.versions.stake.subtitle')}
      actions={
        <Button kind="secondary" size="sm" icon="wallet" to={paths.profile('bank')}>
          {t('learning.versions.stake.open')}
        </Button>
      }
    >
      {body}
    </Card>
  );
}

export function VersionsTab({ summary, admin }: { summary: LearningSummary | null; admin: boolean }) {
  const { t } = useTranslation();
  const activeVersion = summary?.versions.active?.code ?? null;
  return (
    <div className="learning-panel">
      <Card
        className="learning-card"
        title={t('learning.versions.title')}
        subtitle={activeVersion ? t('learning.versions.subtitleOne', { version: activeVersion }) : t('learning.versions.subtitle')}
        actions={
          admin ? (
            <Button kind="secondary" size="sm" icon="play" disabled>
              {t('learning.versions.evaluate')}
            </Button>
          ) : (
            <Chip kind="outline" icon="admin">
              {t('learning.byAdmin')}
            </Chip>
          )
        }
      >
        <Callout kind="warn" icon="database">
          <b>{t('learning.versions.notFrozen')}</b>
          {t('learning.versions.notFrozenText')} {admin ? t('learning.versions.notFrozenAdmin') : t('learning.versions.notFrozenMember')}
        </Callout>
      </Card>
      <div className="learning-two wide-left">
        <RulesCard />
        <StakeRulesCard />
      </div>
    </div>
  );
}
