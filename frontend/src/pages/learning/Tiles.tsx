import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { paths, type LearningTab } from '../../app/paths';
import { Icon, type IconName } from '../../components';
import type { LearningOverview } from '../../features/learning/overview';
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

interface TilesProps {
  overview: LearningOverview;
  active: LearningTab;
  mobile: boolean;
  /** Плитку нажали: экран прокручивается к вкладкам. */
  onOpen: () => void;
}

export function Tiles({ overview: o, active, mobile, onOpen }: TilesProps) {
  const { t } = useTranslation();
  const label = (id: 'lessons' | 'versions' | 'model' | 'report') => (mobile ? t(`learning.tiles.${id}Short`) : t(`learning.tiles.${id}`));
  return (
    <div className="learning-tiles" role="group" aria-label={t('learning.tiles.label')}>
      <Tile
        tab="lessons"
        active={active === 'lessons'}
        icon="book"
        label={label('lessons')}
        value={formatNumber(o.lessonsInPrompt)}
        unit={t('learning.tiles.lessonsUnit', { max: o.lessonsMax })}
        hint={t('learning.tiles.noHypotheses')}
        onOpen={onOpen}
      />
      <Tile
        tab="versions"
        active={active === 'versions'}
        icon="layers"
        label={label('versions')}
        value={o.activeVersion ?? '—'}
        {...(o.activeVersion ? { unit: t('learning.tiles.versionsUnit') } : {})}
        hint={t('learning.tiles.noCandidate')}
        onOpen={onOpen}
      />
      <Tile
        tab="model"
        active={active === 'model'}
        icon="chart"
        label={label('model')}
        value="—"
        unit={t('learning.tiles.modelUnit')}
        hint={t('learning.tiles.modelNone')}
        onOpen={onOpen}
      />
      <Tile
        tab="reports"
        active={active === 'reports'}
        icon="calendar"
        label={label('report')}
        value="—"
        hint={t('learning.tiles.reportNext', { date: formatDate(o.nextReport) })}
        onOpen={onOpen}
      />
    </div>
  );
}
