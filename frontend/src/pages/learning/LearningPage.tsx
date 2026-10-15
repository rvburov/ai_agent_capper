import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useNavigate, useParams } from 'react-router';

import { useMe } from '../../api/hooks/useMe';
import { LEARNING_TABS, paths, type LearningTab } from '../../app/paths';
import { Button, Skeleton, Tabs } from '../../components';
import type { LessonFilter } from '../../features/learning/display';
import { useLessons } from '../../features/learning/lessons';
import { useLearningSummary } from '../../features/learning/overview';
import type { LearningSummary } from '../../features/learning/types';
import { formatNumber } from '../../lib/format';
import { MOBILE_QUERY, useMediaQuery } from '../../lib/useMediaQuery';
import { CycleCard } from './Cycle';
import { LessonsTab } from './LessonsTab';
import { ModelTab } from './ModelTab';
import { ProposeModal } from './ProposeModal';
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

function Lead({ summary }: { summary: LearningSummary | null }) {
  const { t } = useTranslation();
  if (!summary) return <p className="lead">{t('learning.head.leadUnknown')}</p>;
  if (!summary.settled) return <p className="lead">{t('learning.head.leadNone')}</p>;
  return (
    <p className="lead">
      {t('learning.head.leadSome', {
        count: formatNumber(summary.settled),
        legs: t('learning.head.legs', { count: summary.settled_legs }),
        auto: formatNumber(summary.settled_auto),
      })}
    </p>
  );
}

export function LearningPage() {
  const { t } = useTranslation();
  const { tab } = useParams();
  const navigate = useNavigate();
  const { data: me } = useMe();
  const mobile = useMediaQuery(MOBILE_QUERY);
  const summaryQuery = useLearningSummary();
  const summary = summaryQuery.data ?? null;
  const lessons = useLessons();
  const sections = useRef<HTMLElement>(null);
  const [proposing, setProposing] = useState(false);
  const [filter, setFilter] = useState<LessonFilter>('all');

  if (tab !== undefined && (!isLearningTab(tab) || tab === 'lessons')) {
    return <Navigate to={paths.learning()} replace />;
  }
  // Страница внутри RequireAuth: профиль уже загружен
  if (!me) return null;
  const active: LearningTab = tab ?? 'lessons';
  const admin = me.role === 'admin';
  // «Уроки · 7», как в макете: число уроков — на широком экране, когда они есть
  const lessonCount = lessons.data?.items.length ?? 0;
  const tabLabel = (id: LearningTab) =>
    id === 'lessons' && lessonCount > 0 ? t('learning.tabs.lessonsCount', { count: lessonCount }) : t(`learning.tabs.${id}`);
  const scrollToTabs = () => {
    // после перехода по ссылке плитки — к вкладкам, как в макете
    window.requestAnimationFrame(() => sections.current?.scrollIntoView({ block: 'start' }));
  };

  return (
    <div className="learning-root">
      <div className="page-head learning-head">
        <div className="learning-min">
          <h2>{t('learning.head.title')}</h2>
          {summaryQuery.isPending ? <Skeleton lines={2} /> : <Lead summary={summary} />}
        </div>
        <Button kind="secondary" icon="plus" onClick={() => setProposing(true)}>
          {t('learning.propose.open')}
        </Button>
      </div>
      <Tiles summary={summary} active={active} mobile={mobile} onOpen={scrollToTabs} />
      <CycleCard summary={summary} />
      <section ref={sections} className="learning-sections" aria-label={t('learning.tabs.label')}>
        <Tabs
          label={t('learning.tabs.label')}
          panelId="learning-panel"
          active={active}
          className="learning-tabs"
          items={LEARNING_TABS.map((id) => ({
            id,
            to: paths.learning(id),
            label: mobile ? t(`learning.tabs.short.${id}`) : tabLabel(id),
          }))}
        />
        <div id="learning-panel" className="learning-panel" role="tabpanel" tabIndex={-1} aria-label={t(`learning.tabs.${active}`)}>
          {active === 'lessons' && (
            <LessonsTab lessons={lessons} admin={admin} onPropose={() => setProposing(true)} filter={filter} onFilter={setFilter} />
          )}
          {active === 'versions' && <VersionsTab summary={summary} admin={admin} />}
          {active === 'model' && <ModelTab admin={admin} />}
          {active === 'reports' && <ReportsTab summary={summary} timeZone={me.tz} />}
        </div>
      </section>
      {proposing && (
        <ProposeModal
          admin={admin}
          onClose={() => setProposing(false)}
          onDone={() => {
            setProposing(false);
            // новый урок — гипотеза: показываем все уроки, как в макете
            setFilter('all');
            if (active !== 'lessons') void navigate(paths.learning());
          }}
        />
      )}
    </div>
  );
}
