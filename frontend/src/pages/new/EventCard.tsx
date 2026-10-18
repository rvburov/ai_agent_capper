import type { TFunction } from 'i18next';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import {
  Button,
  Callout,
  Chip,
  Combobox,
  Dropdown,
  FieldShell,
  FreshnessChip,
  IconButton,
  OddsGrid,
  Segmented,
  SurfaceChip,
  surfaceColor,
  useToast,
  type Freshness,
  type OddsCell,
  type Surface,
} from '../../components';
import {
  checkEvent,
  displayName,
  hasOtherMarkets,
  normalizeOdd,
  ODD_KEYS,
  resolvedPlayer,
  shortName,
  slotName,
  validOdd,
  type EditEvent,
  type OddKey,
  type PickedPlayer,
  type PlayerSlot,
} from '../../features/analysis/draft';
import { formatProb, marketLabel } from '../../features/analysis/markets';
import { inlineDateTime, keyText } from '../../features/analysis/codes';
import { categoryLabel, ROUND_CODES, roundLabel } from '../../features/analysis/rounds';
import type { PreviewEvent, PreviewPlayer } from '../../features/analysis/types';
import { usePlayerSearch, type PlayerHit } from '../../features/players/api';
import { formatOdds, formatPercent } from '../../lib/format';
import { cx } from '../../lib/cx';
import { useMarketStatuses } from '../../features/markets/api';
import { expressListText, type MarketStatusMap } from '../../features/markets/status';
import { AmbigCallout, ExtraBlock } from './ExtraMarkets';
import { issueLabel } from './summary';

// Карточка события «Что распознано» и блок правки (reviewCard и editorBlock в
// mockup/js/screens/new-analysis.js).

const SURFACES: readonly Surface[] = ['hard', 'clay', 'grass'];
// Совпадение имени с базой: уверенно (подставляем) и «похоже» (спрашиваем), как в разборе
const SURE_SCORE = 0.9;
const LIKE_SCORE = 0.7;
const CLIENT_CHECKED = new Set([
  'errors.analysis.player_missing',
  'errors.analysis.player_unconfirmed',
  'errors.analysis.same_players',
  'errors.analysis.odds_ml',
  'errors.analysis.odds_range',
]);

export interface EventActions {
  onChange: (next: EditEvent) => void;
  onRemove: () => void;
  onEdit: (player?: 1 | 2) => void;
  onDone: () => void;
  onCancel: () => void;
}

interface CardProps extends EventActions {
  event: EditEvent;
  index: number;
  preview: PreviewEvent | undefined;
  corridor: [string, string] | null;
  /** Режим правки: inline — «Исправить» во вкладке текста, form — вкладка «Заполнить форму». */
  mode: 'review' | 'inline' | 'form';
}

/** Свежесть игрока для метки: не подтвержден, нет в базе, новости свежие или поищем. */
export function slotFreshness(slot: PlayerSlot, info: PreviewPlayer | undefined): Freshness {
  if (slot.status === 'check') return 'unconfirmed';
  if (!resolvedPlayer(slot)) return 'missing';
  return info?.news_fresh ? 'fresh' : 'stale';
}

function previewPlayer(preview: PreviewEvent | undefined, slot: PlayerSlot): PreviewPlayer | undefined {
  const id = slot.player?.id;
  return id === undefined ? undefined : preview?.players.find((p) => p.id === id);
}

/** «новости сегодня, 04:10» или «новостей еще нет». */
export function NewsWhen({ checkedAt }: { checkedAt: string | null | undefined }) {
  const { t } = useTranslation();
  return <>{checkedAt ? t('new.player.newsAt', { when: inlineDateTime(checkedAt) }) : t('new.player.newsNone')}</>;
}

function PlayerBox({ slot, number, preview }: { slot: PlayerSlot; number: 1 | 2; preview: PreviewEvent | undefined }) {
  const { t } = useTranslation();
  const resolved = resolvedPlayer(slot);
  const info = previewPlayer(preview, slot);
  let chip;
  if (slot.status === 'manual' && slot.raw) chip = <Chip kind="good" icon="check">{t('new.player.confirmed')}</Chip>;
  else if (slot.status === 'matched' || slot.status === 'manual')
    chip = (
      <Chip kind="good" icon="check">
        {slot.score !== null ? t('new.player.matched', { score: formatProb(Math.min(slot.score, 1)) }) : t('new.player.found')}
      </Chip>
    );
  else if (slot.status === 'check')
    chip = (
      <Chip kind="warn" icon="alert">
        {t('new.player.check', { score: formatProb(slot.score ?? 0) })}
      </Chip>
    );
  else
    chip = (
      <Chip kind="bad" icon="x">
        {t('new.player.missing')}
      </Chip>
    );
  return (
    <div className="new-pl">
      <div className="new-pl-src">{slot.raw ? t('new.player.inText', { raw: slot.raw }) : t('new.player.n', { n: number })}</div>
      <div className="new-pl-name">
        <span>{resolved ? displayName(resolved) : slot.raw || slot.text || '—'}</span>
        {slot.player && (
          <span className="new-pl-sub">
            {resolved ? playerSub(slot.player, t) : t('new.player.like', { name: displayName(slot.player) })}
          </span>
        )}
      </div>
      <div className="row">
        {chip}
        <FreshnessChip state={slotFreshness(slot, info)} />
      </div>
    </div>
  );
}

function playerSub(player: PickedPlayer, t: TFunction): string {
  const parts = [player.country, player.eloRank ? t('new.player.eloRank', { rank: player.eloRank }) : null].filter(Boolean);
  return parts.join(' · ');
}

/** Предупреждения события: подтвердить игрока, игрока нет в базе, новости поищем. */
function Warnings({
  event,
  preview,
  editing,
  onChange,
  onEdit,
}: {
  event: EditEvent;
  preview: PreviewEvent | undefined;
  editing: boolean;
  onChange: (next: EditEvent) => void;
  onEdit: (player: 1 | 2) => void;
}) {
  const { t } = useTranslation();
  const seen = new Set<string>();
  const items = ([1, 2] as const).map((number) => {
    const slot = number === 1 ? event.p1 : event.p2;
    const key = slot.player ? `id${slot.player.id}` : `raw${slot.raw || slot.text}`;
    if (seen.has(key) || slot.status === 'empty') return null;
    seen.add(key);
    const fix = !editing && (
      <Button kind="ghost" size="sm" icon="edit" onClick={() => onEdit(number)}>
        {t('new.event.fixName')}
      </Button>
    );
    if (slot.status === 'check' && slot.player) {
      const candidate = slot.player;
      return (
        <Callout key={key} kind="warn" role="status">
          <div>
            <b>{t('new.warn.checkTitle', { raw: slot.raw || slot.text, name: displayName(candidate) })}</b>{' '}
            {t('new.warn.checkText', { score: formatProb(slot.score ?? 0) })}
          </div>
          <div className="row new-callout-actions">
            <Button
              size="sm"
              icon="check"
              onClick={() =>
                onChange({ ...event, [number === 1 ? 'p1' : 'p2']: { ...slot, status: 'manual', text: displayName(candidate) } })
              }
            >
              {t('new.warn.confirm', { name: shortName(displayName(candidate)) })}
            </Button>
            {fix}
          </div>
        </Callout>
      );
    }
    // typed — игрок еще набирается: что выбрать, говорит строка под полем, а «нет в базе» —
    // только после ухода из поля, когда подсказки к этому тексту пришли пустыми
    if (slot.status === 'typed') return null;
    if (slot.status === 'missing') {
      return (
        <Callout key={key} kind="bad" role="status">
          <div>
            <b>{t('new.warn.missingTitle', { raw: slot.raw || slot.text })}</b> {t('new.warn.missingText')}
          </div>
          <div className="xsmall new-callout-sub">{t('new.warn.missingHint')}</div>
          {fix && <div className="row new-callout-actions">{fix}</div>}
        </Callout>
      );
    }
    const info = previewPlayer(preview, slot);
    if (resolvedPlayer(slot) && info && !info.news_fresh) {
      return (
        <Callout key={key} icon="clock">
          <b>
            {shortName(slotName(slot, ''))}: <NewsWhen checkedAt={info.news_checked_at} />
          </b>{' '}
          {t('new.warn.newsStale')}
        </Callout>
      );
    }
    return null;
  });
  const shown = items.filter(Boolean);
  if (!shown.length) return null;
  return <div className="new-ev-warn">{shown}</div>;
}

/** Подвал события: маржа, рынок без маржи, коридор стратегии (по «Перед запуском»). */
function Foot({
  event,
  preview,
  corridor,
  statuses,
}: {
  event: EditEvent;
  preview: PreviewEvent | undefined;
  corridor: [string, string] | null;
  statuses: MarketStatusMap | undefined;
}) {
  const { t } = useTranslation();
  const list = statuses ? expressListText(statuses) : '';
  const others = hasOtherMarkets(event) && (
    <div className="new-corr">{list ? t('new.foot.others', { list }) : t('new.foot.othersNoList')}</div>
  );
  const ml1 = preview?.market_p.find((m) => m.market === 'ML' && m.selection === 1);
  if (!validOdd(event.odds.ml1) || !validOdd(event.odds.ml2) || !preview || preview.margin_ml === null || !ml1) {
    return (
      <div className="new-corr">
        {t('new.foot.enterMl')}
      </div>
    );
  }
  const margin = preview.margin_ml;
  const kind = margin < 0 ? 'bad' : margin > 0.08 ? 'warn' : 'outline';
  const text =
    margin < 0
      ? t('new.foot.marginNegative')
      : preview.margin_hcp !== null && preview.margin_hcp >= 0
        ? t('new.foot.marginHcp', { ml: formatPercent(margin), hcp: formatPercent(preview.margin_hcp) })
        : t('new.foot.margin', { ml: formatPercent(margin) });
  const name1 = shortName(slotName(event.p1, t('new.odds.ml1')));
  const name2 = shortName(slotName(event.p2, t('new.odds.ml2')));
  const inCorridor = preview.in_corridor;
  const range = corridor ? `${formatOdds(corridor[0])}–${formatOdds(corridor[1])}` : '';
  const labelOf = (market: string, selection: number) => marketLabel(market, selection);
  return (
    <div className="new-ev-foot">
      <div className="new-foot-row">
        <span title={t('new.foot.marginTitle')}>
          <Chip kind={kind} icon={kind === 'outline' ? 'info' : 'alert'}>
            {text}
          </Chip>
        </span>
        <span className="new-novig">
          {t('new.foot.noVig')}{' '}
          <b>
            {name1} {formatProb(ml1.q)}
          </b>{' '}
          · <b>{name2} {formatProb(1 - ml1.q)}</b>
        </span>
      </div>
      {inCorridor.length ? (
        <div className="new-corr">
          {t('new.foot.inCorridor', {
            range,
            list: inCorridor.map((c) => `${labelOf(c.market, c.selection)} ${formatOdds(c.odds)}`).join(', '),
          })}
        </div>
      ) : (
        <div className="new-corr out">{t('new.foot.outCorridor', { range })}</div>
      )}
      {others}
    </div>
  );
}

function issueText(event: EditEvent, t: TFunction): string[] {
  return checkEvent(event).issues.map((issue) => issueLabel(issue, t));
}

/** Ошибки проверки события текстом: «Нужны кэфы П1 и П2» (для «Событие N: …»). */
export function eventIssueTexts(event: EditEvent, t: TFunction): string[] {
  return issueText(event, t);
}

function Odds({
  event,
  onChange,
  corridor,
  all,
  statuses,
}: {
  event: EditEvent;
  onChange: (next: EditEvent) => void;
  corridor: [string, string] | null;
  all: boolean;
  statuses: MarketStatusMap | undefined;
}) {
  const { t } = useTranslation();
  // Галочка «в коридоре стратегии» — только у рынков, которые идут в экспресс (Р28)
  const hcpInExpress = statuses?.get('h15')?.status === 'express';
  const check = checkEvent(event);
  const low = corridor ? Number(corridor[0]) : Number.NaN;
  const high = corridor ? Number(corridor[1]) : Number.NaN;
  const keys = all ? ODD_KEYS : ODD_KEYS.filter((key) => key === 'ml1' || key === 'ml2' || event.odds[key] !== '');
  const cells: OddsCell[] = keys.map((key) => {
    const value = event.odds[key];
    const n = Number(value.replace(',', '.'));
    const main = key === 'ml1' || key === 'ml2';
    return {
      key,
      label: t(`new.odds.${key}`),
      value,
      ariaLabel: main ? t('new.odds.aria', { label: t(`new.odds.${key}`) }) : t('new.odds.ariaOptional', { label: t(`new.odds.${key}`) }),
      invalid: check.bad.has(key),
      inCorridor: (main || hcpInExpress) && validOdd(value) && n >= low && n <= high,
      title: main ? undefined : t('new.odds.hcpTitle'),
    };
  });
  return (
    <OddsGrid
      cells={cells}
      idPrefix={event.key}
      label={t('new.odds.group', { title: eventTitle(event, t) })}
      corridorTitle={t('new.odds.inCorridor')}
      onChange={(key, value) => onChange({ ...event, blank: false, odds: { ...event.odds, [key]: value } })}
      onBlur={(key) => {
        const k = key as OddKey;
        const next = normalizeOdd(event.odds[k]);
        if (next !== event.odds[k]) onChange({ ...event, odds: { ...event.odds, [k]: next } });
      }}
    />
  );
}

export function eventTitle(event: EditEvent, t: TFunction): string {
  return t('new.event.title', {
    p1: shortName(slotName(event.p1, t('new.player.n', { n: 1 }))),
    p2: shortName(slotName(event.p2, t('new.player.n', { n: 2 }))),
  });
}

function Meta({ event }: { event: EditEvent }) {
  const { t } = useTranslation();
  const parts = [event.tournamentName || t('new.event.noTournament'), categoryLabel(event.category), roundLabel(event.round)].filter(Boolean);
  return (
    <div className="new-ev-meta">
      <SurfaceChip surface={event.surface} />
      <span className="new-ev-meta-text">{parts.join(' · ')}</span>
    </div>
  );
}

/** Поле игрока с подсказками из базы (GET /api/players?q=): кириллица и латиница. */
function pickedOf(hit: PlayerHit): PickedPlayer {
  return { id: hit.id, name: hit.name, nameRu: hit.name_ru, country: hit.country, eloRank: hit.elo_rank, lastMatch: hit.last_match };
}

/**
 * Набранное имя после ухода из поля (как change в макете): совпадение ≥ 0,9 подставляется само,
 * 0,7–0,9 — «Это ‹игрок›?», иначе — нет в базе. Только по подсказкам к этому же тексту.
 */
export function resolveTyped(slot: PlayerSlot, hits: readonly PlayerHit[]): PlayerSlot {
  const best = hits[0];
  const text = slot.text.trim();
  if (best && best.score >= SURE_SCORE) return { raw: '', text: displayName(pickedOf(best)), status: 'manual', score: best.score, player: pickedOf(best) };
  if (best && best.score >= LIKE_SCORE) return { raw: text, text, status: 'check', score: best.score, player: pickedOf(best) };
  return { raw: text, text, status: 'missing', score: null, player: null };
}

function PlayerField({ event, number, onChange }: { event: EditEvent; number: 1 | 2; onChange: (next: EditEvent) => void }) {
  const { t } = useTranslation();
  const slot = number === 1 ? event.p1 : event.p2;
  const { hits, loading, fresh } = usePlayerSearch(slot.status === 'typed' || slot.status === 'missing' ? slot.text : '');
  const id = `${event.key}-n${number}`;
  const field = number === 1 ? 'p1' : 'p2';
  const set = (next: PlayerSlot) => onChange({ ...event, blank: false, [field]: next });
  const status = slotStatusText(slot, t);
  // Ушли из поля раньше, чем пришли подсказки к набранному: решим, когда они придут
  const pending = useRef(false);
  useEffect(() => {
    if (!pending.current || !fresh) return;
    pending.current = false;
    if (slot.status === 'typed') set(resolveTyped(slot, hits));
  });
  return (
    <FieldShell id={id} label={t('new.player.n', { n: number })} className="new-player-field">
      <Combobox
        id={id}
        label={t('new.player.n', { n: number })}
        value={slot.text}
        placeholder={number === 1 ? t('new.player.placeholder1') : t('new.player.placeholder2')}
        options={hits.map((hit) => ({
          value: String(hit.id),
          label: hit.name_ru ?? hit.name,
          hint: [hit.name_ru ? hit.name : null, hit.country, hit.elo_rank ? t('new.player.eloRank', { rank: hit.elo_rank }) : null]
            .filter(Boolean)
            .join(' · '),
        }))}
        loading={loading}
        describedBy={`${id}-status`}
        onChange={(text) => {
          pending.current = false;
          set({ raw: '', text, status: text.trim() ? 'typed' : 'empty', player: null, score: null });
        }}
        onPick={(option) => {
          const hit = hits.find((h) => String(h.id) === option.value);
          if (!hit) return;
          pending.current = false;
          set({ raw: '', text: displayName(pickedOf(hit)), status: 'manual', score: hit.score, player: pickedOf(hit) });
        }}
        onBlur={() => {
          if (slot.status !== 'typed') return;
          if (fresh) set(resolveTyped(slot, hits));
          else pending.current = true;
        }}
      />
      <div className="new-pstat" id={`${id}-status`} aria-live="polite">
        {slot.status === 'check' && slot.player ? (
          <>
            <button
              type="button"
              className="chip warn new-pstat-confirm"
              onClick={() => set({ ...slot, status: 'manual', text: displayName(slot.player as PickedPlayer) })}
            >
              {t('new.player.isIt', { name: displayName(slot.player) })}
            </button>
            <span>{t('new.player.tapToConfirm')}</span>
          </>
        ) : (
          <span className={cx(status.kind === 'bad' && 'bad-text')}>{status.text}</span>
        )}
      </div>
    </FieldShell>
  );
}

function slotStatusText(slot: PlayerSlot, t: TFunction): { text: string; kind?: 'bad' } {
  const player = resolvedPlayer(slot);
  if (player) return { text: playerSub(player, t) || t('new.player.found') };
  if (slot.status === 'empty') return { text: t('new.player.surnameEnough') };
  if (slot.status === 'typed') return { text: t('new.player.pick') };
  return { text: t('new.player.notInBase'), kind: 'bad' };
}

function Editor({ event, onChange }: { event: EditEvent; onChange: (next: EditEvent) => void }) {
  const { t } = useTranslation();
  const tourId = `${event.key}-tour`;
  const roundId = `${event.key}-round`;
  return (
    <div className="new-edit-grid">
      <PlayerField event={event} number={1} onChange={onChange} />
      <PlayerField event={event} number={2} onChange={onChange} />
      <FieldShell id={tourId} label={t('new.event.tournament')}>
        <input
          id={tourId}
          className="input"
          value={event.tournamentName}
          placeholder={t('new.event.tournamentPlaceholder')}
          autoComplete="off"
          maxLength={200}
          // Другой турнир — и формат матча (до 2 или 3 побед) сервер определит заново по названию
          onChange={(e) => onChange({ ...event, blank: false, tournamentName: e.target.value, tournamentId: null, category: null, bestOf: null })}
        />
      </FieldShell>
      <FieldShell id={roundId} label={t('new.event.round')}>
        <Dropdown
          id={roundId}
          label={t('new.event.round')}
          value={event.round || 'none'}
          options={[{ value: 'none', label: t('new.rounds.none') }, ...ROUND_CODES.map((code) => ({ value: code, label: t(`new.rounds.${code}`) }))]}
          onChange={(value) => onChange({ ...event, round: value === 'none' ? '' : value })}
        />
      </FieldShell>
      <div className="field full">
        <span className="field-label">{t('new.event.surface')}</span>
        <Segmented
          label={t('new.event.surface')}
          className="new-surface"
          value={event.surface ?? 'hard'}
          onChange={(surface) => onChange({ ...event, surface })}
          items={SURFACES.map((surface) => ({
            value: surface,
            label: (
              <>
                <i className="new-sdot" style={{ background: surfaceColor(surface) }} aria-hidden="true" />
                {t(`analysis.surface.${surface}`)}
              </>
            ),
          }))}
        />
      </div>
    </div>
  );
}

/** Карточка события: просмотр с «Исправить» или правка (в тексте — inline, в форме — всегда). */
export function EventCard({ event, index, preview, corridor, mode, onChange, onRemove, onEdit, onDone, onCancel }: CardProps) {
  const { t } = useTranslation();
  const title = eventTitle(event, t);
  const titleId = `${event.key}-t`;
  const errors = event.blank ? [] : issueText(event, t);
  // Игроков и кэфы проверяем и на экране — те же проблемы сервера второй раз не показываем
  const serverProblems = (preview?.problems ?? []).filter((p) => !CLIENT_CHECKED.has(p.key)).map((p) => keyText(p.key, p.params, p.key));
  const editing = mode !== 'review';
  const msgId = `${event.key}-msg`;
  const statuses = useMarketStatuses();
  const toast = useToast();
  return (
    <article className={cx('new-ev', mode === 'inline' && 'editing')} aria-labelledby={titleId}>
      <div className="new-ev-head">
        <span className="new-ev-num" aria-hidden="true">
          {index + 1}
        </span>
        <h4 className="new-ev-title" id={titleId}>
          {title}
        </h4>
        {editing ? (
          <div className="new-ev-meta">{mode === 'inline' ? t('new.event.editingInline') : t('new.event.editingForm')}</div>
        ) : (
          <Meta event={event} />
        )}
        <div className="new-ev-actions">
          {!editing && (
            <Button kind="ghost" size="sm" icon="edit" aria-label={t('new.event.fixAria', { n: index + 1 })} title={t('new.event.fixTitle')} onClick={() => onEdit()}>
              {t('new.event.fix')}
            </Button>
          )}
          <IconButton icon="trash" size="sm" label={t('new.event.remove', { n: index + 1 })} onClick={onRemove} />
        </div>
      </div>
      {editing ? (
        <Editor event={event} onChange={onChange} />
      ) : (
        <div className="new-ev-players">
          <PlayerBox slot={event.p1} number={1} preview={preview} />
          <PlayerBox slot={event.p2} number={2} preview={preview} />
        </div>
      )}
      {event.ambig.length > 0 && (
        <div className="new-ev-warn">
          {event.ambig.map((ambig, i) => (
            <AmbigCallout
              key={`${ambig.line}-${ambig.o1}-${ambig.o2}`}
              event={event}
              index={i}
              ambig={ambig}
              onChange={onChange}
              onAnswered={(text) => toast.show(text, { icon: 'check' })}
            />
          ))}
        </div>
      )}
      <Warnings event={event} preview={preview} editing={editing} onChange={onChange} onEdit={onEdit} />
      {editing ? (
        <div className="field">
          <span className="field-label">
            <span>{t('new.odds.label')}</span>
            <span className="new-odds-hint">{t('new.odds.hint')}</span>
          </span>
          <Odds event={event} onChange={onChange} corridor={corridor} all statuses={statuses} />
        </div>
      ) : (
        <Odds event={event} onChange={onChange} corridor={corridor} all={false} statuses={statuses} />
      )}
      <ExtraBlock event={event} editable={editing} statuses={statuses} onChange={onChange} />
      <Foot event={event} preview={preview} corridor={corridor} statuses={statuses} />
      <div className="new-ev-msg" id={msgId} aria-live="polite">
        {errors.length > 0 && <div className="field-error">{errors.join('. ')}.</div>}
        {errors.length === 0 && serverProblems.length > 0 && <div className="field-error">{serverProblems.join('. ')}.</div>}
      </div>
      {mode === 'inline' && (
        <div className="new-edit-foot">
          <Button kind="primary" icon="check" onClick={onDone}>
            {t('new.event.done')}
          </Button>
          <Button kind="ghost" onClick={onCancel}>
            {t('new.event.cancel')}
          </Button>
        </div>
      )}
    </article>
  );
}
