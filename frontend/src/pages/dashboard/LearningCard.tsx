import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { paths } from '../../app/paths';
import { Button, Card, Icon, type IconName } from '../../components';
import type { LearningSnapshot } from '../../features/dashboard/learning';
import { formatDate } from '../../lib/format';

// «Модель учится» (learningCard макета, этап 5): уроки в анализе и гипотезы, последний урок,
// версия инструкций и кандидат, отчет недели — строки-ссылки на вкладки «Обучения модели».
// Уроки и инструкции общие (В5): участник видит, что учится, решения — у администратора.

interface RowProps {
  icon: IconName;
  title: string;
  meta: string;
  to: string;
}

function Row({ icon, title, meta, to }: RowProps) {
  return (
    <Link className="dashboard-learn-row" to={to}>
      <span className="dashboard-learn-ic" aria-hidden="true">
        <Icon name={icon} />
      </span>
      <span className="dashboard-min">
        <b>{title}</b>
        <small>{meta}</small>
      </span>
      <Icon name="chevronRight" />
    </Link>
  );
}

/** «ждет вашего решения: прошел правило»; кандидатов нет — так и сказано. */
function candidateMeta(s: LearningSnapshot, admin: boolean, t: TFunction): string {
  if (!s.candidate) return t('dashboard.learning.noCandidate');
  const who = admin ? t('dashboard.learning.candidateAdmin') : t('dashboard.learning.candidateMember');
  if (s.candidatePassed === null) return who;
  return t(s.candidatePassed ? 'dashboard.learning.candidatePassed' : 'dashboard.learning.candidateFailed', { who, active: s.active ?? '—' });
}

export function LearningCard({ snapshot: s, admin }: { snapshot: LearningSnapshot; admin: boolean }) {
  const { t } = useTranslation();
  const lessonsMeta = [
    s.hypotheses ? t('dashboard.learning.hypotheses', { count: s.hypotheses }) : t('dashboard.learning.noHypotheses'),
    ...(s.readyCodes.length ? [t('dashboard.learning.readyCode', { code: s.readyCodes[0] })] : []),
  ].join(' · ');
  return (
    <Card
      className="dashboard-card"
      title={t('dashboard.learning.title')}
      subtitle={s.settled ? t('dashboard.learning.settledAuto', { count: s.settled, auto: s.settledAuto }) : t('dashboard.learning.subtitleShort')}
      foot={
        <Button kind="ghost" size="sm" icon="brain" iconRight="chevronRight" to={paths.learning()}>
          {t('dashboard.learning.link')}
        </Button>
      }
    >
      <div className="dashboard-learn">
          <Row
            icon="book"
            title={t('dashboard.learning.inPrompt', { count: s.inPrompt, max: s.max })}
            meta={lessonsMeta}
            to={paths.learning()}
          />
          {s.last && <Row icon="flask" title={t('dashboard.learning.last', { code: s.last.code })} meta={s.last.text} to={paths.learning()} />}
          <Row
            icon="layers"
            title={
              s.candidate
                ? t('dashboard.learning.versionCandidate', { active: s.active ?? '—', candidate: s.candidate })
                : t('dashboard.learning.version', { active: s.active ?? '—' })
            }
            meta={candidateMeta(s, admin, t)}
            to={paths.learning('versions')}
          />
          <Row
            icon="calendar"
            title={s.lastReport ? t('dashboard.learning.reportLast', { date: formatDate(s.lastReport) }) : t('dashboard.learning.report')}
            meta={t(s.lastReport ? 'dashboard.learning.reportNextShort' : 'dashboard.learning.reportNext', { date: formatDate(s.nextReport) })}
            to={paths.learning('reports')}
          />
      </div>
      {s.settled === 0 && (
        <p className="dashboard-howto">
          <Icon name="info" />
          <span>{t('dashboard.learning.empty')}</span>
        </p>
      )}
    </Card>
  );
}
