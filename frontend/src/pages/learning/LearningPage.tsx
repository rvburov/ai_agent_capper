import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useParams } from 'react-router';

import { useMe } from '../../api/hooks/useMe';
import { LEARNING_TABS, paths, type LearningTab } from '../../app/paths';
import { Skeleton, Tabs } from '../../components';
import { useLearningOverview, type LearningOverview } from '../../features/learning/overview';
import { MOBILE_QUERY, useMediaQuery } from '../../lib/useMediaQuery';
import { CycleCard } from './Cycle';
import { LessonsTab } from './LessonsTab';
import { ModelTab } from './ModelTab';
import { ReportsTab } from './ReportsTab';
import { Tiles } from './Tiles';
import { VersionsTab } from './VersionsTab';
import './learning.css';

// «Обучение модели» (mockup/js/screens/learning.js, Р25): как система учится на рассчитанных
// ставках. Шапка, четыре плитки, цикл из шести шагов и вкладки-адреса /learning/<вкладка>:
// «Уроки», «Версии стратегии», «Базовая модель», «Отчеты». Все числа — с сервера (Т15);
// данные вкладок подключаются по мере готовности API этапа 5, до того — пустые состояния макета.

function isLearningTab(value: string): value is LearningTab {
  return (LEARNING_TABS as readonly string[]).includes(value);
}

function Lead({ overview }: { overview: LearningOverview }) {
  const { t } = useTranslation();
  if (overview.settled === null) return <p className="lead">{t('learning.head.leadUnknown')}</p>;
  return (
    <p className="lead">
      {overview.settled ? t('learning.head.leadSome', { count: overview.settled }) : t('learning.head.leadNone')}
    </p>
  );
}

export function LearningPage() {
  const { t } = useTranslation();
  const { tab } = useParams();
  const { data: me } = useMe();
  const mobile = useMediaQuery(MOBILE_QUERY);
  const overview = useLearningOverview(me?.tz ?? 'UTC');
  const sections = useRef<HTMLElement>(null);

  if (tab !== undefined && (!isLearningTab(tab) || tab === 'lessons')) {
    return <Navigate to={paths.learning()} replace />;
  }
  // Страница внутри RequireAuth: профиль уже загружен
  if (!me) return null;
  const active: LearningTab = tab ?? 'lessons';
  const admin = me.role === 'admin';
  const scrollToTabs = () => {
    // после перехода по ссылке плитки — к вкладкам, как в макете
    window.requestAnimationFrame(() => sections.current?.scrollIntoView({ block: 'start' }));
  };

  return (
    <div className="learning-root">
      <div className="page-head learning-head">
        <div className="learning-min">
          <h2>{t('learning.head.title')}</h2>
          {overview.settledPending ? <Skeleton lines={2} /> : <Lead overview={overview} />}
        </div>
      </div>
      <Tiles overview={overview} active={active} mobile={mobile} onOpen={scrollToTabs} />
      <CycleCard lessonMinCases={overview.lessonMinCases} claudeMinEvents={overview.claudeMinEvents} />
      <section ref={sections} className="learning-sections" aria-label={t('learning.tabs.label')}>
        <Tabs
          label={t('learning.tabs.label')}
          panelId="learning-panel"
          active={active}
          className="learning-tabs"
          items={LEARNING_TABS.map((id) => ({
            id,
            to: paths.learning(id),
            label: mobile ? t(`learning.tabs.short.${id}`) : t(`learning.tabs.${id}`),
          }))}
        />
        <div id="learning-panel" className="learning-panel" role="tabpanel" tabIndex={-1} aria-label={t(`learning.tabs.${active}`)}>
          {active === 'lessons' && <LessonsTab overview={overview} admin={admin} />}
          {active === 'versions' && <VersionsTab overview={overview} admin={admin} />}
          {active === 'model' && <ModelTab admin={admin} />}
          {active === 'reports' && <ReportsTab overview={overview} timeZone={me.tz} />}
        </div>
      </section>
    </div>
  );
}
