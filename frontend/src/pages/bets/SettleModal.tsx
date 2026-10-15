import type { TFunction } from 'i18next';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { isApiError } from '../../api/errors';
import { Button, Callout, Icon, Modal } from '../../components';
import { apiErrorText } from '../../features/analysis/codes';
import { displayName, shortName } from '../../features/analysis/draft';
import { freshest, useBet, useSettleBet } from '../../features/bets/api';
import { closingDraft, closingPayload, type ClosingDraft } from '../../features/bets/closing';
import { isLegacy, lastMatchDay, legProb, missingInArchive } from '../../features/bets/display';
import { legNewsResult, newsResultOutcome, newsScoreText, safeSourceUrl, type NewsResult } from '../../features/bets/review';
import { toMilli } from '../../features/bets/money';
import { bankAfter, checkScore, scoreExamples, settlePreview, type SettlePreview } from '../../features/bets/settle';
import type { BetItem, BetLeg, Closing, LegResult, LegSettleIn } from '../../features/bets/types';
import { formatDate, formatOdds, formatOddsExact, formatProb } from '../../lib/format';
import { cx } from '../../lib/cx';
import { ClosingFields } from './ClosingFields';
import { OpenStatusChip } from './marks';
import { betKindLong, legMarket, matchText, money, Signed, StatusChip } from './parts';

// «Результат ставки» (settleModal макета): исход каждого события, счет (по нему исход отмечается
// сам по таблице сервера score_outcomes), закрывающий кэф и сводка «выплата / прибыль / банк
// после». Сохраняет PUT /api/bets/{id}/result с версией ставки; при гонке — 409 и свежая версия:
// исходы участника остаются, а закрытие, которое он не трогал, берется из свежей карточки.

export interface LegPrefill {
  result: LegResult | null;
  score: string | null;
}

interface LegState {
  result: LegResult | null;
  /** Исход отмечен по счету — его можно поправить. */
  auto: boolean;
  score: string;
  /**
   * Поля закрытия, если участник их менял; null — не трогал: поля показывают закрытие из
   * текущей версии ставки, а в запрос closing не идет (сервер оставит то, что есть).
   */
  closing: ClosingDraft | null;
  /** Закрытие, с которого участник начал правку: с ним сравнивается черновик. */
  closingBase: Closing | null;
}

const RESULTS: readonly { value: LegResult; icon: 'check' | 'x' | 'refresh' }[] = [
  { value: 'win', icon: 'check' },
  { value: 'loss', icon: 'x' },
  { value: 'void', icon: 'refresh' },
];

function initialState(bet: BetItem, prefill: readonly LegPrefill[] | undefined): LegState[] {
  return bet.legs.map((_, i) => ({
    result: prefill?.[i]?.result ?? null,
    auto: false,
    score: prefill?.[i]?.score ?? '',
    closing: null,
    closingBase: null,
  }));
}

/** Ставку уже рассчитали (другая вкладка): поля показывают то, что записал сервер. */
function serverState(leg: BetLeg): LegState {
  return { result: leg.result, auto: false, score: leg.score ?? '', closing: closingDraft(leg.closing), closingBase: leg.closing };
}

/** Итог, который записал сервер, — для сводки уже рассчитанной ставки. */
function serverPreview(bet: BetItem): SettlePreview | null {
  if (bet.status === 'open') return null;
  const effective = bet.effective_odds;
  return {
    status: bet.status,
    payout: bet.payout ?? '0.00',
    profit: bet.profit ?? '0.00',
    recalculated: bet.status === 'won' && effective !== null && toMilli(effective) !== toMilli(bet.total_odds) ? effective : null,
  };
}

interface SettleModalProps {
  bet: BetItem;
  /** Прежние исходы и счет при «Исправить результат» (прошлый расчет уже отменен сторно). */
  prefill?: readonly LegPrefill[];
  /** Ставка была проиграна: при отмене в журнале проводки не было. */
  correctedFrom?: BetItem['status'] | null;
  /** Капитал по учету сейчас — для «Банк после». */
  equity: string | null;
  onClose: () => void;
  onSettled: (bet: BetItem) => void;
}

export function SettleModal({ bet: initial, prefill, correctedFrom, equity, onClose, onSettled }: SettleModalProps) {
  const { t } = useTranslation();
  const query = useBet(initial.id, initial);
  const bet = freshest(query.data, initial);
  const settle = useSettleBet();
  const [legs, setLegs] = useState<LegState[]>(() => initialState(initial, prefill));
  const [submitted, setSubmitted] = useState(false);
  // Запрос уже ушел: второй клик до перерисовки кнопки не отправляет расчет еще раз
  const busy = useRef(false);
  const corrected = prefill !== undefined;
  const formId = `bets-settle-${bet.id}`;

  // После сохранения карточка в кэше уже рассчитана — окно закрывается, «уже рассчитана» не показываем
  const notOpen = bet.status !== 'open' && !settle.isSuccess;
  const shown = notOpen ? bet.legs.map(serverState) : legs;
  const results = shown.map((leg) => leg.result);
  const preview = notOpen ? serverPreview(bet) : settlePreview(bet, results);
  const complete = results.every((r) => r !== null);

  function update(index: number, change: Partial<LegState>) {
    setLegs((prev) => prev.map((leg, i) => (i === index ? { ...leg, ...change } : leg)));
    settle.reset();
  }

  function pickResult(index: number, result: LegResult) {
    update(index, { result, auto: false });
  }

  function typeScore(index: number, leg: BetLeg, text: string) {
    const state = legs[index];
    if (!state) return;
    const check = checkScore(text, leg.score_outcomes);
    if (check.kind === 'ok' && (state.result === null || state.auto)) {
      update(index, { score: text, result: check.result, auto: true });
    } else if (check.kind === 'empty' && state.auto) {
      update(index, { score: text, result: null, auto: false });
    } else {
      update(index, { score: text });
    }
  }

  /** «Подставить 2:0»: счет и исход из новостей — в форму; сохраняет только участник (В1-Г). */
  function applyHint(index: number, leg: BetLeg, news: NewsResult) {
    const outcome = newsResultOutcome(leg, news);
    if (news.sets && !news.retired) {
      const check = checkScore(news.sets, leg.score_outcomes);
      if (check.kind === 'ok') update(index, { score: news.sets, result: check.result, auto: true });
      else update(index, { score: news.sets, ...(outcome ? { result: outcome, auto: false } : {}) });
    } else if (outcome && !news.retired) {
      update(index, { result: outcome, auto: false });
    }
  }

  function editClosing(index: number, leg: BetLeg, closing: ClosingDraft) {
    const state = legs[index];
    if (!state) return;
    update(index, { closing, closingBase: state.closing === null ? leg.closing : state.closingBase });
  }

  async function save() {
    setSubmitted(true);
    if (!complete || notOpen || busy.current) return;
    const body: LegSettleIn[] = [];
    for (let i = 0; i < bet.legs.length; i += 1) {
      const leg = bet.legs[i];
      const state = legs[i];
      if (!leg || !state?.result) return;
      const score = checkScore(state.score, leg.score_outcomes);
      if (score.kind === 'invalid' || score.kind === 'typing') return;
      // закрытие отправляем, только если участник его менял, и сравниваем с тем, что он видел
      const closing = state.closing === null ? undefined : closingPayload(state.closing, state.closingBase);
      if (closing === 'invalid') return;
      const item: LegSettleIn = { leg_id: leg.id, result: state.result };
      if (score.kind === 'ok') item.score = score.key;
      if (closing !== undefined) item.closing = closing;
      body.push(item);
    }
    busy.current = true;
    try {
      const saved = await settle.mutateAsync({ bet, legs: body });
      onSettled(saved);
    } catch {
      // текст ошибки — под формой (settle.error); при гонке окно уже получило свежую ставку
    } finally {
      busy.current = false;
    }
  }

  const error = settle.error;
  const badScore = isApiError(error) && error.code === 'bet.bad_score' ? String(error.detail.score ?? '') : null;
  let errorText: string | null = null;
  // «уже рассчитана» говорит плашка выше; «изменилась» — свой текст: свежая версия уже в окне
  if (error && !notOpen) errorText = isApiError(error) && error.code === 'bet.changed' ? t('bets.settle.changed') : apiErrorText(error);

  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={corrected ? t('bets.settle.titleCorrect', { id: bet.id }) : t('bets.settle.title', { id: bet.id })}
      className="bets-settle"
      footer={
        <>
          <Button onClick={onClose}>{notOpen ? t('common.close') : t('bets.settle.cancel')}</Button>
          {!notOpen && (
            <Button kind="primary" icon="check" type="submit" form={formId} disabled={!complete} loading={settle.isPending}>
              {corrected ? t('bets.settle.saveCorrect') : t('bets.settle.save')}
            </Button>
          )}
        </>
      }
    >
      <form
        id={formId}
        className="stack"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="bets-settle-intro">
          <OpenStatusChip bet={bet} />
          <span>
            {t('bets.settle.intro', { kind: betKindLong(bet, t), bookmaker: bet.bookmaker, stake: money(bet, bet.stake) })}{' '}
            <span className="odds">{formatOdds(bet.total_odds)}</span>
          </span>
        </div>
        {notOpen && (
          <Callout kind="info" role="status">
            {t('bets.settle.alreadySettled')}
          </Callout>
        )}
        {bet.awaiting_result && !corrected && !notOpen && (
          <Callout kind="info" icon="database">
            <b>{awaitedTitle(bet, t)}</b> {awaitedText(bet, t)}
          </Callout>
        )}
        {corrected && !notOpen && (
          <Callout kind="warn" icon="edit">
            <b>{correctedFrom === 'lost' ? t('bets.settle.reversedLoss') : t('bets.settle.reversed')}</b> {t('bets.settle.reversedHint')}
          </Callout>
        )}
        {bet.legs.map((leg, i) => {
          const state = shown[i];
          if (!state) return null;
          return (
            <LegBlock
              key={leg.id}
              bet={bet}
              leg={leg}
              index={i}
              state={state}
              closing={state.closing ?? closingDraft(leg.closing)}
              submitted={submitted}
              serverBadScore={badScore !== null && badScore === state.score.trim()}
              disabled={notOpen}
              onPick={(result) => pickResult(i, result)}
              onScore={(text) => typeScore(i, leg, text)}
              onHint={(news) => applyHint(i, leg, news)}
              onClosing={(closing) => editClosing(i, leg, closing)}
            />
          );
        })}
        <SettleSummary bet={bet} preview={preview} complete={complete} results={results} equity={notOpen ? null : equity} />
        <Callout kind="info">
          <b>{t('bets.settle.withdrawTitle')}</b> {t('bets.settle.withdrawText')}
        </Callout>
        {errorText !== null && (
          <Callout kind="bad" role="alert">
            {errorText}
          </Callout>
        )}
      </form>
    </Modal>
  );
}

function awaitedTitle(bet: BetItem, t: TFunction): string {
  const day = lastMatchDay(bet);
  return day ? t('bets.awaiting.settleTitle', { date: formatDate(day) }) : t('bets.awaiting.settleTitleNoDate');
}

function awaitedText(bet: BetItem, t: TFunction): string {
  if (bet.archive_matches_to && missingInArchive(bet)) {
    return t('bets.awaiting.settleTextMissing', { archive: formatDate(bet.archive_matches_to) });
  }
  if (!bet.archive_matches_to || !bet.next_upload) return t('bets.awaiting.settleText');
  return t('bets.awaiting.settleTextArchive', {
    archive: formatDate(bet.archive_matches_to),
    next: formatDate(bet.next_upload),
  });
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

/**
 * Подсказка из новостей у события: кто выиграл и счет, источник и день, «Подставить 2:0».
 * Снятие — без кнопки: исход по правилам букмекера выбирает участник.
 */
function NewsHintBox({ leg, news, onApply }: { leg: BetLeg; news: NewsResult; onApply: () => void }) {
  const { t } = useTranslation();
  const winner = shortName(displayName(news.winner === 1 ? leg.match.player1 : leg.match.player2));
  const score = newsScoreText(news.score);
  const text = news.retired ? t('bets.news.retired', { name: winner, score }) : t('bets.news.won', { name: winner, score });
  const url = safeSourceUrl(news.source_url);
  const source = news.source_name ?? (url ? hostOf(url) : null);
  let label: string | null = null;
  if (!news.retired && news.sets) label = t('bets.news.apply', { score: news.sets });
  else if (!news.retired && newsResultOutcome(leg, news)) label = t('bets.news.applyResult');
  return (
    <div className="bets-news" role="note">
      <div className="bets-min">
        <span>
          {t('bets.news.found')} <b>{text}</b>
        </span>
        <small>
          {source &&
            (url ? (
              <a href={url} target="_blank" rel="noopener noreferrer">
                {source}
              </a>
            ) : (
              source
            ))}
          {source && ' · '}
          {[news.published_on ? formatDate(news.published_on) : null, news.retired ? t('bets.news.retiredHint') : t('bets.news.check')].filter(Boolean).join(' · ')}
        </small>
      </div>
      {label && (
        <Button size="sm" icon="check" onClick={onApply} title={t('bets.news.applyTitle')}>
          {label}
        </Button>
      )}
    </div>
  );
}

/** «2:0, 2:1, 1:2 или 0:2». */
function listText(items: readonly string[], or: string): string {
  if (items.length < 2) return items.join('');
  return `${items.slice(0, -1).join(', ')} ${or} ${items[items.length - 1] ?? ''}`;
}

interface LegBlockProps {
  bet: BetItem;
  leg: BetLeg;
  index: number;
  state: LegState;
  /** Поля закрытия: черновик участника или закрытие из текущей версии ставки. */
  closing: ClosingDraft;
  submitted: boolean;
  serverBadScore: boolean;
  disabled: boolean;
  onPick: (result: LegResult) => void;
  onScore: (text: string) => void;
  onHint: (news: NewsResult) => void;
  onClosing: (closing: ClosingDraft) => void;
}

function LegBlock({ bet, leg, index, state, closing, submitted, serverBadScore, disabled, onPick, onScore, onHint, onClosing }: LegBlockProps) {
  const { t } = useTranslation();
  const id = `bets-settle-${bet.id}-${index}`;
  const match = matchText(leg);
  const bestOf5 = leg.match.best_of === 5;
  const format = bestOf5 ? t('bets.settle.bestOf5') : leg.match.best_of === 3 ? t('bets.settle.bestOf3') : null;
  const p = legProb(leg);
  const meta = [
    leg.match.day ? formatDate(leg.match.day) : null,
    leg.match.tournament,
    legMarket(leg),
    p !== null ? t('bets.open.model', { p: formatProb(p) }) : null,
    format ? t('bets.settle.matchFormat', { format }) : null,
  ];
  const check = checkScore(state.score, leg.score_outcomes);
  const examples = scoreExamples(leg.score_outcomes);
  const scoreBad = serverBadScore || check.kind === 'invalid' || (submitted && check.kind === 'typing');
  const fromScore = check.kind === 'ok' ? check.result : null;
  const firstName = shortName(displayName(leg.match.player1));
  const scoreHint = t('bets.settle.scoreHint', { first: firstName, format: bestOf5 ? t('bets.settle.upTo3') : t('bets.settle.upTo2') });
  let note: { text: string; warn: boolean } | null = null;
  if (state.auto && state.result) note = { text: t('bets.settle.autoNote'), warn: false };
  else if (fromScore && state.result && fromScore !== state.result) {
    note = { text: t('bets.settle.conflict', { result: t(`bets.settle.word.${fromScore}`) }), warn: true };
  }
  const scoreId = `${id}-score`;
  const news = legNewsResult(leg);
  return (
    <fieldset className="bets-sleg" disabled={disabled}>
      <legend className="sr-only">{t('bets.settle.legLegend', { n: index + 1, match })}</legend>
      <div className="bets-sleg-head">
        <div className="bets-min">
          <div className="bets-sleg-match">{match}</div>
          <div className="xsmall muted">{meta.filter(Boolean).join(' · ')}</div>
        </div>
        <span className="odds bets-sleg-odds" aria-label={t('bets.settle.oddsLabel', { odds: formatOdds(leg.odds_taken) })}>
          {formatOdds(leg.odds_taken)}
        </span>
      </div>
      <div className="bets-sleg-grid">
        <div className="field bets-sleg-res">
          <div className="field-label">{t('bets.settle.result')}</div>
          <div className="bets-resseg" role="group" aria-label={t('bets.settle.resultGroup', { match })}>
            {RESULTS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={option.value}
                aria-pressed={state.result === option.value}
                onClick={() => onPick(option.value)}
              >
                <Icon name={option.icon} />
                {t(`bets.settle.results.${option.value}`)}
              </button>
            ))}
          </div>
          {note && <div className={cx('field-hint bets-auto', note.warn && 'warn')}>{note.text}</div>}
          {submitted && !state.result && (
            <div className="field-error" role="alert">
              {t('bets.settle.needResult')}
            </div>
          )}
        </div>
        <div className="field">
          <label className="field-label" htmlFor={scoreId}>
            <span>{t('bets.settle.score')}</span>
          </label>
          <input
            id={scoreId}
            className={cx('input mono', scoreBad && 'invalid')}
            autoComplete="off"
            maxLength={7}
            inputMode="numeric"
            placeholder={bestOf5 ? '3:1' : '2:0'}
            value={state.score}
            aria-invalid={scoreBad || undefined}
            aria-describedby={`${scoreId}-hint`}
            onChange={(event) => onScore(event.target.value)}
          />
          {scoreBad ? (
            <div className="field-error" id={`${scoreId}-hint`} role="alert">
              {format
                ? t('bets.settle.scoreBad', { format, examples: listText(examples, t('bets.settle.or')) })
                : t('bets.settle.scoreBadAny', { examples: listText(examples, t('bets.settle.or')) })}
            </div>
          ) : (
            <div className="field-hint" id={`${scoreId}-hint`}>
              {scoreHint}
            </div>
          )}
        </div>
      </div>
      {news && !disabled && <NewsHintBox leg={leg} news={news} onApply={() => onHint(news)} />}
      {/* у ставок старого бота CLV не считается (В5): закрывающий кэф не спрашиваем */}
      {!isLegacy(bet) && (
        <ClosingFields id={id} draft={closing} onChange={onClosing} odds={leg.odds_taken} bookmaker={bet.bookmaker} submitted={submitted} />
      )}
    </fieldset>
  );
}

function SettleSummary({
  bet,
  preview,
  complete,
  results,
  equity,
}: {
  bet: BetItem;
  preview: ReturnType<typeof settlePreview>;
  complete: boolean;
  results: readonly (LegResult | null)[];
  equity: string | null;
}) {
  const { t } = useTranslation();
  let hint: string | null = null;
  if (!complete) hint = preview ? t('bets.settle.lostEarly') : t('bets.settle.markAll');
  else if (preview?.status === 'won' && results.includes('void')) hint = t('bets.settle.voidInWin');
  return (
    <div className="stack bets-ssum-wrap" aria-live="polite">
      <dl className="bets-ssum">
        <div>
          <dt>{t('bets.settle.sum.status')}</dt>
          <dd>{preview ? <StatusChip status={preview.status} /> : <span className="muted">{t('bets.settle.sum.waiting')}</span>}</dd>
        </div>
        <div>
          <dt>{t('bets.settle.sum.payout')}</dt>
          <dd>{preview ? money(bet, preview.payout) : '—'}</dd>
          <small>
            {preview?.recalculated
              ? t('bets.settle.sum.recalculated', { odds: formatOddsExact(preview.recalculated) })
              : t('bets.settle.sum.odds', { odds: formatOddsExact(bet.total_odds) })}
          </small>
        </div>
        <div>
          <dt>{t('bets.settle.sum.profit')}</dt>
          <dd>{preview ? <Signed value={preview.profit} text={money(bet, preview.profit, true)} /> : '—'}</dd>
        </div>
        <div>
          <dt>{t('bets.settle.sum.bankAfter')}</dt>
          <dd>{preview && equity !== null ? money(bet, bankAfter(equity, preview.profit)) : '—'}</dd>
          {equity !== null && <small>{t('bets.settle.sum.bankNow', { bank: money(bet, equity) })}</small>}
        </div>
      </dl>
      {hint && <div className="field-hint">{hint}</div>}
    </div>
  );
}
