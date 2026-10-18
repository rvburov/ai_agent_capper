import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

import { Button, Callout, Chip, Dropdown, FieldShell, IconButton, OddsGrid, type OddsCell } from '../../components';
import {
  ambigGuess,
  answerAmbig,
  checkEvent,
  defaultLine,
  extraLine,
  lineInputText,
  newExtra,
  nextExtraFamily,
  normalizeOdd,
  setLines,
  shortName,
  slotName,
  type AmbigHcp,
  type EditEvent,
  type ExtraMarket,
  type HcpUnit,
} from '../../features/analysis/draft';
import { EXTRA_FAMILIES, isGamesFamily, isHalfOrWhole, type ExtraFamily } from '../../features/analysis/markets';
import { statusChipKind, statusHint, statusLabel, type MarketStatusMap } from '../../features/markets/status';
import { hasText, keyText } from '../../features/analysis/codes';
import { formatLine } from '../../lib/format';
import { cx } from '../../lib/cx';

// Блок «Другие рынки» карточки события и вопрос о спорной форе (extraBlock, extraRow и
// ambigCallout в mockup/js/screens/new-analysis.js, Р28).

function isHcp(family: ExtraFamily): boolean {
  return family === 'shcp' || family === 'ghcp';
}

/** Подписи сторон: «Ф1(−3.5)» и «Ф2(+3.5)» или «Больше 22.5» и «Меньше 22.5». */
export function sideLabels(x: Pick<ExtraMarket, 'family' | 'line'>, t: TFunction): [string, string] {
  const line = extraLine(x);
  if (!isHalfOrWhole(line)) return [t('new.extra.side', { n: 1 }), t('new.extra.side', { n: 2 })];
  if (isHcp(x.family)) {
    return [
      t('analysis.market.hcp', { n: 1, line: formatLine(line, { signed: true }) }),
      t('analysis.market.hcp', { n: 2, line: formatLine(-line, { signed: true }) }),
    ];
  }
  return [t('new.extra.over', { line: formatLine(line) }), t('new.extra.under', { line: formatLine(line) })];
}

/** Название строки в карточке: «Тотал геймов 22.5», «Фора по геймам: Синнер −4.5». */
function rowTitle(event: EditEvent, x: ExtraMarket, t: TFunction): string {
  const line = extraLine(x);
  const shown = isHalfOrWhole(line) ? formatLine(line, { signed: isHcp(x.family) }) : x.line;
  if (!isHcp(x.family)) return t('analysis.marketGroup.total', { family: t(`analysis.market.family.${x.family}`), line: shown });
  return t('analysis.marketGroup.hcp', {
    family: t(`analysis.market.family.${x.family}`),
    name: shortName(slotName(event.p1, t('new.player.n', { n: 1 }))),
    line: shown,
  });
}

function Note({ x, statuses }: { x: ExtraMarket; statuses: MarketStatusMap | undefined }) {
  const { t } = useTranslation();
  const info = statuses?.get(x.family);
  const line = extraLine(x);
  return (
    <div className="new-xm-note">
      <span title={info ? statusHint(info) : undefined}>
        <Chip kind={info ? statusChipKind(info.status) : 'info'} icon="flask">
          {info ? statusLabel(info) : t('analysis.marketStatus.compare')}
        </Chip>
      </span>
      <span>
        {Number.isInteger(line) ? `${t('new.extra.whole', { n: formatLine(Math.abs(line)) })} ` : ''}
        {isGamesFamily(x.family) ? t('new.extra.noteGames') : t('new.extra.note')}
      </span>
    </div>
  );
}

interface RowProps {
  event: EditEvent;
  x: ExtraMarket;
  editable: boolean;
  statuses: MarketStatusMap | undefined;
  onChange: (next: EditEvent) => void;
}

function ExtraRow({ event, x, editable, statuses, onChange }: RowProps) {
  const { t } = useTranslation();
  const check = checkEvent(event);
  const set = (change: Partial<ExtraMarket>) =>
    onChange({ ...event, blank: false, extra: event.extra.map((y) => (y.key === x.key ? { ...y, ...change } : y)) });
  const remove = () => onChange({ ...event, extra: event.extra.filter((y) => y.key !== x.key) });
  const labels = sideLabels(x, t);
  const marketName = t(`new.extra.family.${x.family}`);
  const cells: OddsCell[] = (['o1', 'o2'] as const).map((side, i) => ({
    key: side,
    label: labels[i] ?? '',
    value: x[side],
    ariaLabel: t('new.extra.oddAria', { label: `${marketName} ${labels[i] ?? ''}` }),
    invalid: check.bad.has(`${x.key}-${side}`),
  }));
  const odds = (
    <OddsGrid
      className="new-xm-odds"
      cells={cells}
      idPrefix={x.key}
      label={t('new.extra.odds', { market: rowTitle(event, x, t) })}
      corridorTitle=""
      onChange={(side, value) => set({ [side]: value })}
      onBlur={(side) => {
        const key = side as 'o1' | 'o2';
        const next = normalizeOdd(x[key]);
        if (next !== x[key]) set({ [key]: next });
      }}
    />
  );
  const removeButton = <IconButton icon="trash" size="sm" label={t('new.extra.remove')} onClick={remove} />;
  if (!editable) {
    return (
      <div className="new-xm" role="group" aria-label={rowTitle(event, x, t)}>
        <div className="new-xm-head">
          <b>{rowTitle(event, x, t)}</b>
          {removeButton}
        </div>
        {odds}
        <Note x={x} statuses={statuses} />
      </div>
    );
  }
  const marketId = `${x.key}-mk`;
  const lineId = `${x.key}-line`;
  const badLine = check.badLines.has(x.key);
  let lineControl;
  if (x.family === 'shcp' || x.family === 'stot') {
    const lines = setLines(x.family, event.bestOf);
    const current = extraLine(x);
    const all = Number.isFinite(current) && !lines.includes(current) ? [...lines, current] : lines;
    lineControl = (
      <FieldShell id={lineId} label={t('new.extra.line')}>
        <Dropdown
          id={lineId}
          label={t('new.extra.line')}
          value={x.line}
          invalid={badLine}
          options={all.map((v) => ({
            value: lineInputText(v),
            label: x.family === 'shcp' ? t('new.extra.hcpOption', { line: formatLine(v, { signed: true }) }) : formatLine(v),
          }))}
          onChange={(value) => set({ line: value })}
        />
      </FieldShell>
    );
  } else {
    const label = x.family === 'ghcp' ? t('new.extra.hcpLine') : t('new.extra.line');
    lineControl = (
      <FieldShell id={lineId} label={label}>
        <input
          id={lineId}
          className={cx('input mono', badLine && 'invalid')}
          inputMode="decimal"
          autoComplete="off"
          maxLength={6}
          placeholder={x.family === 'ghcp' ? '-3.5' : '22.5'}
          value={x.line}
          aria-invalid={badLine || undefined}
          onChange={(e) => set({ line: e.target.value })}
        />
      </FieldShell>
    );
  }
  return (
    <div className="new-xm" role="group" aria-label={t('new.extra.group', { market: marketName })}>
      <div className="new-xm-top">
        <FieldShell id={marketId} label={t('new.extra.market')}>
          <Dropdown
            id={marketId}
            label={t('new.extra.market')}
            value={x.family}
            options={EXTRA_FAMILIES.map((family) => ({ value: family, label: t(`new.extra.family.${family}`) }))}
            onChange={(family) => set({ family, line: lineInputText(defaultLine(family, event.bestOf)) })}
          />
        </FieldShell>
        {lineControl}
        <div className="new-xm-rm">{removeButton}</div>
      </div>
      {odds}
      <Note x={x} statuses={statuses} />
    </div>
  );
}

/** «Другие рынки»: в форме — с выбором рынка и линии, в карточке разбора — только кэфы. */
export function ExtraBlock({
  event,
  editable,
  statuses,
  onChange,
}: {
  event: EditEvent;
  editable: boolean;
  statuses: MarketStatusMap | undefined;
  onChange: (next: EditEvent) => void;
}) {
  const { t } = useTranslation();
  if (!event.extra.length && !editable) return null;
  return (
    <div className="field new-xm-block">
      <span className="field-label">
        <span>{t('new.extra.label')}</span>
        <span className="new-odds-hint">{t('new.extra.hint')}</span>
      </span>
      {event.extra.length > 0 && (
        <div className="new-xm-list">
          {event.extra.map((x) => (
            <ExtraRow key={x.key} event={event} x={x} editable={editable} statuses={statuses} onChange={onChange} />
          ))}
        </div>
      )}
      {editable && (
        <Button
          kind="ghost"
          size="sm"
          icon="plus"
          className="new-xm-add"
          onClick={() => onChange({ ...event, blank: false, extra: [...event.extra, newExtra(nextExtraFamily(event), event.bestOf)] })}
        >
          {t('new.extra.add')}
        </Button>
      )}
    </div>
  );
}

/** Спорная фора: «Ф1(−1.5) = 2.05, Ф2(+1.5) = 1.72» — по сетам или по геймам? */
export function AmbigCallout({
  event,
  index,
  ambig,
  onChange,
  onAnswered,
}: {
  event: EditEvent;
  index: number;
  ambig: AmbigHcp;
  onChange: (next: EditEvent) => void;
  onAnswered?: (text: string) => void;
}) {
  const { t } = useTranslation();
  const guess = ambigGuess(ambig);
  const abs = formatLine(Math.abs(ambig.line));
  const odds = [
    ambig.o1 && `${t('analysis.market.hcp', { n: 1, line: formatLine(ambig.line, { signed: true }) })} = ${ambig.o1}`,
    ambig.o2 && `${t('analysis.market.hcp', { n: 2, line: formatLine(-ambig.line, { signed: true }) })} = ${ambig.o2}`,
  ]
    .filter(Boolean)
    .join(', ');
  const answer = (unit: HcpUnit) => {
    onChange(answerAmbig(event, index, unit));
    onAnswered?.(t('new.ambig.done', { abs, unit: t(unit === 'sets' ? 'new.ambig.unitSets' : 'new.ambig.unitGames') }));
  };
  const button = (unit: HcpUnit) => (
    <Button
      size="sm"
      kind={guess === unit ? 'secondary' : 'ghost'}
      icon={guess === unit ? 'check' : undefined}
      disabled={unit === 'sets' && !ambig.setsOk}
      title={unit === 'sets' && !ambig.setsOk ? t('new.ambig.setsNo') : undefined}
      onClick={() => answer(unit)}
    >
      {t(unit === 'sets' ? 'new.ambig.sets' : 'new.ambig.games')}
    </Button>
  );
  return (
    <Callout kind="warn" role="status">
      <div>
        <b>{t('new.ambig.title', { odds })}</b> {t('new.ambig.text', { abs })}
      </div>
      {ambig.hint && hasText(ambig.hint.key) && <div className="xsmall new-callout-sub">{keyText(ambig.hint.key, ambig.hint.params)}</div>}
      <div className="row new-callout-actions">
        {button('sets')}
        {button('games')}
      </div>
    </Callout>
  );
}
