import type { TFunction } from 'i18next';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { paths, type LearningTab } from '../../app/paths';
import { Icon, type IconName } from '../../components';
import type { LearningSummary } from '../../features/learning/types';
import { formatDate, formatNumber } from '../../lib/format';

// Четыре плитки «Что учится сейчас» (drawTiles макета): уроки в анализе, инструкции анализа,
// базовая модель и отчет недели. Плитка — ссылка на свою вкладку.

interface TileProps {
  tab: LearningTab;
  active: boolean;
  icon: IconName;
  label: string;
  value: ReactNode;
  unit?: string;
  hint: string;
  onOpen: () => void;
}

function Tile({ tab, active, icon, label, value, unit, hint, onOpen }: TileProps) {
  return (
    <Link
      className="learning-tile"
      to={paths.learning(tab)}
      aria-current={active ? 'true' : undefined}
      aria-controls="learning-panel"
      onClick={onOpen}
    >
      <span className="learning-tile-label">
        <Icon name={icon} />
        <span className="learning-min">{label}</span>
        <span className="learning-tile-go">
          <Icon name="chevronRight" />
        </span>
      </span>
      <span className="learning-tile-value">
        {value}
        {unit && <small>{unit}</small>}
      </span>
      <span className="learning-tile-hint">{hint}</span>
    </Link>
  );
}

/** «1 ждет решения · 3 гипотезы»; уроков нет — «гипотез пока нет». */
function lessonsHint(lessons: LearningSummary['lessons'], t: TFunction): string {
  if (!lessons.total) return t('learning.tiles.noHypotheses');
  const hypotheses = t('learning.tiles.hypotheses', { count: lessons.hypotheses });
  if (!lessons.ready) return hypotheses;
  return lessons.hypotheses ? t('learning.tiles.readyAnd', { count: lessons.ready, hypotheses }) : t('learning.tiles.ready', { count: lessons.ready });
}

/** «перекалибрована сама 12 окт» или «включена 12 окт»; модели еще нет — что это за модель. */
/**
 * «Перекалибрована сама ‹дата›» — только у версии, которую включила перекалибровка (auto,
 * перекалибровки были — recalibrated_at);
 * иначе «включена ‹дата›», а была перекалибровка позже, но не лучше прежней — и ее дата.
 */
function modelHint(model: LearningSummary['model'], t: TFunction): string {
  if (!model?.activated_at) return t('learning.tiles.modelNone');
  const date = formatDate(model.activated_at);
  // «сама» — только когда перекалибровка была (recalibrated_at) и эту версию включила она
  if (model.auto && model.recalibrated_at) return t('learning.tiles.modelAuto', { date });
  const recal = model.recalibrated_at;
  if (recal && Date.parse(recal) > Date.parse(model.activated_at)) {
    return t('learning.tiles.modelOnRecal', { date, recal: formatDate(recal) });
  }
  return t('learning.tiles.modelOn', { date });
}

interface TilesProps {
  /** Сводка GET /api/learning; null — не загрузилась: прочерки. */
  summary: LearningSummary | null;
  active: LearningTab;
  mobile: boolean;
  /** Плитку нажали: экран прокручивается к вкладкам. */
  onOpen: () => void;
}

export function Tiles({ summary: s, active, mobile, onOpen }: TilesProps) {
  const { t } = useTranslation();
  const label = (id: 'lessons' | 'versions' | 'model' | 'report') => (mobile ? t(`learning.tiles.${id}Short`) : t(`learning.tiles.${id}`));
  const version = s?.versions.active?.code ?? null;
  const candidate = s?.versions.candidate?.code ?? null;
  const brier = s?.model?.brier ?? null;
  return (
    <div className="learning-tiles" role="group" aria-label={t('learning.tiles.label')}>
      <Tile
        tab="lessons"
        active={active === 'lessons'}
        icon="book"
        label={label('lessons')}
        value={s ? formatNumber(s.lessons.in_prompt) : '—'}
        {...(s ? { unit: t('learning.tiles.lessonsUnit', { max: s.thresholds.lessons_max }) } : {})}
        hint={s ? lessonsHint(s.lessons, t) : t('learning.tiles.noHypotheses')}
        onOpen={onOpen}
      />
      <Tile
        tab="versions"
        active={active === 'versions'}
        icon="layers"
        label={label('versions')}
        value={version ?? '—'}
        {...(version ? { unit: t('learning.tiles.versionsUnit') } : {})}
        hint={candidate ? t('learning.tiles.candidate', { code: candidate }) : t('learning.tiles.noCandidate')}
        onOpen={onOpen}
      />
      <Tile
        tab="model"
        active={active === 'model'}
        icon="chart"
        label={label('model')}
        value={brier === null ? '—' : formatNumber(brier, 3)}
        unit={t('learning.tiles.modelUnit')}
        hint={modelHint(s?.model ?? null, t)}
        onOpen={onOpen}
      />
      <Tile
        tab="reports"
        active={active === 'reports'}
        icon="calendar"
        label={label('report')}
        value={s?.last_report ? formatDate(s.last_report) : '—'}
        hint={s ? t('learning.tiles.reportNext', { date: formatDate(s.next_report) }) : t('learning.tiles.reportNextNoDate')}
        onOpen={onOpen}
      />
    </div>
  );
}
