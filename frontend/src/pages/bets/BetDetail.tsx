import type { TFunction } from 'i18next';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Button, Callout, KeyValue, Modal } from '../../components';
import { archiveConflicts, impliedProb, isImported, isLegacy, legProb, legShown, parlayProb, settledBy } from '../../features/bets/display';
import type { BetItem, BetLeg } from '../../features/bets/types';
import { formatDate, formatDateLong, formatDateTime, formatOdds, formatOddsExact, formatPp, formatProb } from '../../lib/format';
import { ClosingCell, OpenStatusChip } from './marks';
import { betKind, ClvValue, KindChip, legMarket, LegChip, MatchName, matchText, money, ResultIcon, Signed } from './parts';
import { ReviewBlock } from './ReviewBlock';

// Детали ставки (detailBlock и detailModal макета): события с исходом, закрытием и CLV, расчет
// (кто и когда рассчитал, расхождение с архивом), разбор ИИ с вердиктом по CLV строкой и
// действия «Внести закрытие» и «Исправить результат».

/** Кто и когда рассчитал ставку (settledNote макета). */
export function settledNote(bet: BetItem, t: TFunction): string | null {
  if (bet.status === 'open') return null;
  const by = settledBy(bet);
  if (by === 'auto') {
    const at = bet.settled_at ? formatDateTime(bet.settled_at, { calendar: false }) : '';
    return bet.archive_to
      ? t('bets.settledNote.auto', { at, date: formatDate(bet.archive_to) })
      : t('bets.settledNote.autoNoDate', { at });
  }
  if (by === 'manual') {
    return bet.settled_at ? t('bets.settledNote.manual', { at: formatDate(bet.settled_at) }) : t('bets.settledNote.manualNoDate');
  }
  return isLegacy(bet) ? t('bets.settledNote.legacy') : null;
}

function conflictText(leg: BetLeg, t: TFunction): string {
  const archive = leg.archive_result ?? 'void';
  const values = {
    match: matchText(leg),
    market: legMarket(leg),
    archive: t(`bets.conflict.archive.${archive}`),
    yours: leg.result ? t(`bets.conflict.yours.${leg.result}`) : t('bets.conflict.yours.none'),
    score: leg.archive_score ?? '',
  };
  return leg.archive_score ? t('bets.conflict.text', values) : t('bets.conflict.textNoScore', values);
}

/** Архив показывает другое (Т3): по ноге архив разошелся с расчетом; банк не меняли. */
function ConflictNotes({ bet, onCorrect }: { bet: BetItem; onCorrect: (bet: BetItem) => void }) {
  const { t } = useTranslation();
  const legs = archiveConflicts(bet);
  if (!legs.length) return null;
  return (
    <Callout kind="warn" icon="alert" className="bets-conflict">
      <div className="stack bets-conflict-in">
        {legs.map((leg) => (
          <span key={leg.id}>
            <b>{t('bets.conflict.title')}</b> {conflictText(leg, t)}
          </span>
        ))}
        {!isImported(bet) && (
          <div className="row">
            <Button size="sm" icon="edit" onClick={() => onCorrect(bet)} ro>
              {t('bets.actions.correct')}
            </Button>
          </div>
        )}
      </div>
    </Callout>
  );
}

/** Есть событие без закрывающего кэфа (кроме возвратов): кнопка «Внести закрытие». */
export function needsClosing(bet: BetItem): boolean {
  return bet.legs.some((leg) => !leg.closing && legShown(bet, leg) !== 'void');
}

/** Расчет ставки: выплата, прибыль, CLV ставки и шанс по модели против кэфа. */
function settleFacts(bet: BetItem, t: TFunction): { key: string; label: string; value: ReactNode }[] {
  const pModel = parlayProb(bet.legs);
  const legacy = isLegacy(bet);
  return [
    { key: 'bookmaker', label: t('bets.detail.bookmaker'), value: bet.bookmaker },
    { key: 'stake', label: t('bets.detail.stake'), value: money(bet, bet.stake) },
    // кэф расчета сервер считает до 0.001 (возврат ноги): по нему сходится выплата
    { key: 'odds', label: t('bets.detail.total'), value: <span className="odds">{bet.effective_odds !== null ? formatOddsExact(bet.effective_odds) : formatOdds(bet.total_odds)}</span> },
    { key: 'payout', label: t('bets.detail.payout'), value: money(bet, bet.payout) },
    { key: 'profit', label: t('bets.detail.profit'), value: <Signed value={bet.profit} text={money(bet, bet.profit, true)} /> },
    // Капитал сразу после расчета этой ставки (сервер, bank_after) — как «Банк после» на главной
    { key: 'bankAfter', label: t('bets.detail.bankAfter'), value: bet.bank_after !== null ? money(bet, bet.bank_after) : '—' },
    {
      key: 'settled',
      label: t('bets.detail.settledAt'),
      value: bet.settled_at ? formatDateTime(bet.settled_at) : '—',
    },
    {
      key: 'clv',
      label: t('bets.detail.clv'),
      value: legacy ? <span className="muted" title={t('bets.botClv')}>{t('bets.detail.clvBot')}</span> : <ClvValue value={bet.clv} />,
    },
    {
      key: 'chance',
      label: t('bets.detail.chance'),
      value: `${formatProb(pModel)} / ${formatProb(impliedProb(bet.total_odds))}`,
    },
  ];
}

function LegsTable({ bet }: { bet: BetItem }) {
  const { t } = useTranslation();
  const legacy = isLegacy(bet);
  return (
    <div className="table-wrap">
      <table className="table bets-legtable">
        <caption className="sr-only">{t('bets.detail.legsCaption', { id: bet.id })}</caption>
        <thead>
          <tr>
            <th scope="col">{t('bets.detail.cols.event')}</th>
            <th scope="col" className="c">{t('bets.detail.cols.score')}</th>
            <th scope="col" className="r">{t('bets.detail.cols.odds')}</th>
            <th scope="col" className="r" title={t('bets.detail.cols.closingTitle')}>{t('bets.detail.cols.closing')}</th>
            <th scope="col" className="r">{t('bets.detail.cols.clv')}</th>
            <th scope="col" className="r" title={t('bets.detail.cols.modelTitle')}>{t('bets.detail.cols.model')}</th>
            <th scope="col" className="r" title={t('bets.detail.cols.impliedTitle')}>{t('bets.detail.cols.implied')}</th>
            <th scope="col" className="r" title={t('bets.detail.cols.edgeTitle')}>{t('bets.detail.cols.edge')}</th>
            <th scope="col">{t('bets.detail.cols.result')}</th>
          </tr>
        </thead>
        <tbody>
          {bet.legs.map((leg) => {
            const p = legProb(leg);
            const implied = impliedProb(leg.odds_taken);
            const meta = [legMarket(leg), leg.match.surface ? t(`bets.filters.surfaces.${leg.match.surface}`).toLowerCase() : null, leg.match.best_of === 5 ? t('bets.detail.bestOf5') : null];
            return (
              <tr key={leg.id}>
                <td>
                  <div className="bets-legmatch">
                    <MatchName leg={leg} links />
                  </div>
                  <div className="xsmall muted">{meta.filter(Boolean).join(' · ')}</div>
                </td>
                <td className="c">
                  <span className="mono">{leg.score ?? '—'}</span>
                  {leg.archive_result !== null && bet.status !== 'open' && (
                    <div className="xsmall bets-archive-mark" title={t('bets.conflict.markTitle')}>
                      {leg.archive_score ? t('bets.conflict.mark', { score: leg.archive_score }) : t('bets.conflict.markNoScore')}
                    </div>
                  )}
                </td>
                <td className="r">
                  <span className="odds">{formatOdds(leg.odds_taken)}</span>
                </td>
                <td className="r">{legacy && !leg.closing ? <ClvValue value={null} legacy /> : <ClosingCell bet={bet} leg={leg} />}</td>
                <td className="r">
                  <ClvValue value={leg.clv} legacy={legacy} />
                </td>
                <td className="r">{formatProb(p)}</td>
                <td className="r">{formatProb(implied)}</td>
                <td className="r">
                  <span className="soft">{formatPp(leg.edge, { digits: 0 })}</span>
                </td>
                <td>
                  <LegChip shown={legShown(bet, leg)} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Notes({ bet }: { bet: BetItem }) {
  const { t } = useTranslation();
  const unknown = bet.legs.some((leg) => legShown(bet, leg) === 'unknown');
  return (
    <>
      {bet.status === 'void' && (
        <Callout icon="refresh">{t('bets.detail.voidNote')}</Callout>
      )}
      {isLegacy(bet) && (
        <Callout icon="info">
          {t('bets.detail.botNote')}
          {unknown ? ` ${t('bets.detail.botNoResult')}` : ''}
        </Callout>
      )}
    </>
  );
}

interface Actions {
  onClosing: (bet: BetItem) => void;
  onCorrect: (bet: BetItem) => void;
}

/** Раскрытая строка истории на компьютере. */
export function DetailBlock({ bet, onClosing, onCorrect }: { bet: BetItem } & Actions) {
  const { t } = useTranslation();
  const legacy = isLegacy(bet);
  const note = settledNote(bet, t);
  return (
    <div className="bets-detail">
      <div className="bets-detail-main">
        <div className="bets-detail-cap">
          <h4>{t('bets.detail.legsTitle')}</h4>
          <span className="xsmall muted">{t('bets.detail.legsHint')}</span>
        </div>
        <LegsTable bet={bet} />
        {(bet.status === 'void' || legacy) && (
          <div className="bets-detail-note">
            <Notes bet={bet} />
          </div>
        )}
      </div>
      <div className="bets-detail-bottom">
        <div className="bets-detail-box">
          <span className="eyebrow">{t('bets.detail.settleTitle')}</span>
          <dl className="bets-kvgrid">
            {settleFacts(bet, t).map((fact) => (
              <div key={fact.key}>
                <dt>{fact.label}</dt>
                <dd>{fact.value}</dd>
              </div>
            ))}
          </dl>
          {note && <p className="xsmall muted">{note}</p>}
          <ConflictNotes bet={bet} onCorrect={onCorrect} />
        </div>
        <div className="bets-detail-box">
          <ReviewBlock bet={bet} />
          {!isImported(bet) && (
            <div className="row">
              {/* Старый бот закрывающих кэфов не записывал, CLV по его ставкам не считается (В5) */}
              {!legacy && (
                <Button size="sm" icon="bolt" onClick={() => onClosing(bet)} ro>
                  {needsClosing(bet) ? t('bets.actions.addClosing') : t('bets.actions.closing')}
                </Button>
              )}
              <Button kind="ghost" size="sm" icon="edit" onClick={() => onCorrect(bet)} ro>
                {t('bets.actions.correct')}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Ставка в нижнем листе на телефоне. */
export function BetSheet({
  bet,
  onClose,
  onSettle,
  onClosing,
  onCorrect,
}: { bet: BetItem; onClose: () => void; onSettle: (bet: BetItem) => void } & Actions) {
  const { t } = useTranslation();
  const legacy = isLegacy(bet);
  const open = bet.status === 'open';
  const note = settledNote(bet, t);
  const footer = open ? (
    <>
      <Button onClick={onClose}>{t('common.close')}</Button>
      <Button kind="primary" icon="edit" onClick={() => onSettle(bet)} ro>
        {t('bets.actions.settle')}
      </Button>
    </>
  ) : (
    <>
      {!isImported(bet) && (
        <Button icon="edit" onClick={() => onCorrect(bet)} ro>
          {t('bets.actions.correctShort')}
        </Button>
      )}
      {!legacy && (
        <Button icon="bolt" onClick={() => onClosing(bet)} ro>
          {t('bets.actions.closingShort')}
        </Button>
      )}
      <Button kind="primary" onClick={onClose}>
        {t('common.close')}
      </Button>
    </>
  );
  return (
    <Modal open wide onClose={onClose} title={t('bets.detail.sheetTitle', { id: bet.id })} footer={footer} className="bets-sheet">
      <div className="bets-dm-top">
        <div className="bets-min">
          <div className="xsmall muted">
            {[formatDateLong(bet.placed_at), betKind(bet, t), bet.bookmaker].join(' · ')} <KindChip kind={bet.kind} />
          </div>
          <div className="bets-dm-profit">
            {open ? money(bet, bet.stake) : <Signed value={bet.profit} text={money(bet, bet.profit, true)} />}
          </div>
        </div>
        <OpenStatusChip bet={bet} />
      </div>
      {!open && !legacy && (
        <div className="bets-detail-box">
          <ReviewBlock bet={bet} />
        </div>
      )}
      {note && <p className="xsmall muted">{note}</p>}
      <ConflictNotes bet={bet} onCorrect={onCorrect} />
      {bet.legs.map((leg) => {
        const p = legProb(leg);
        const meta = [legMarket(leg), leg.match.tournament, leg.score ? t('bets.detail.scoreShort', { score: leg.score }) : null, leg.match.best_of === 5 ? t('bets.detail.bestOf5') : null];
        return (
          <div key={leg.id} className="bets-dleg">
            <div className="bets-dleg-head">
              <ResultIcon shown={legShown(bet, leg)} />
              <div className="bets-min bets-grow">
                <div className="bets-dleg-match">
                  <MatchName leg={leg} links />
                </div>
                <div className="xsmall muted">{meta.filter(Boolean).join(' · ')}</div>
              </div>
              <span className="odds">{formatOdds(leg.odds_taken)}</span>
            </div>
            <dl className="bets-dleg-grid">
              <div title={legacy ? t('bets.botClv') : undefined}>
                <dt>{t('bets.detail.cols.closing')}</dt>
                <dd>
                  <ClosingCell bet={bet} leg={leg} small />
                </dd>
              </div>
              <div title={legacy ? t('bets.botClv') : undefined}>
                <dt>{t('bets.detail.cols.clv')}</dt>
                <dd>
                  <ClvValue value={leg.clv} legacy={legacy} />
                </dd>
              </div>
              <div>
                <dt>{t('bets.detail.cols.model')}</dt>
                <dd>{formatProb(p)}</dd>
              </div>
              <div>
                <dt>{t('bets.detail.cols.implied')}</dt>
                <dd>{formatProb(impliedProb(leg.odds_taken))}</dd>
              </div>
            </dl>
          </div>
        );
      })}
      <Notes bet={bet} />
      {open ? (
        <KeyValue
          items={[
            { label: t('bets.detail.bookmaker'), value: bet.bookmaker },
            { label: t('bets.detail.total'), value: <span className="odds">{formatOdds(bet.total_odds)}</span> },
            { label: t('bets.detail.payoutIfWin'), value: money(bet, bet.payout) },
          ]}
        />
      ) : (
        <KeyValue items={settleFacts(bet, t)} />
      )}
    </Modal>
  );
}
