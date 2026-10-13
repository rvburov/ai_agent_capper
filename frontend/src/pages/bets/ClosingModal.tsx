import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button, Callout, Modal, useToast } from '../../components';
import { apiErrorText } from '../../features/analysis/codes';
import { useSetClosing } from '../../features/bets/api';
import { closingDraft, closingPayload, type ClosingDraft } from '../../features/bets/closing';
import { legShown } from '../../features/bets/display';
import type { BetItem } from '../../features/bets/types';
import { formatDate, formatOdds, formatPercent } from '../../lib/format';
import { ClosingFields } from './ClosingFields';
import { legMarket, matchText } from './parts';

// «Внести закрытие» (closingModal макета): закрывающие кэфы событий можно внести и после
// расчета (PUT …/legs/{leg}/closing по каждому измененному событию), CLV пересчитает сервер.

export function ClosingModal({ bet, onClose }: { bet: BetItem; onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const setClosing = useSetClosing();
  const [drafts, setDrafts] = useState<ClosingDraft[]>(() => bet.legs.map((leg) => closingDraft(leg.closing)));
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // Сохранение уже идет: второй клик до перерисовки кнопки не шлет кэфы еще раз
  const busy = useRef(false);

  async function save() {
    if (busy.current) return;
    setSubmitted(true);
    setError(null);
    const changes: { legId: number; closing: ReturnType<typeof closingPayload> }[] = [];
    for (let i = 0; i < bet.legs.length; i += 1) {
      const leg = bet.legs[i];
      const draft = drafts[i];
      if (!leg || !draft || legShown(bet, leg) === 'void') continue;
      const payload = closingPayload(draft, leg.closing);
      if (payload === 'invalid') return;
      if (payload !== undefined) changes.push({ legId: leg.id, closing: payload });
    }
    if (!changes.length) {
      onClose();
      return;
    }
    setSaving(true);
    busy.current = true;
    let last: BetItem | null = null;
    try {
      for (const change of changes) {
        if (change.closing === 'invalid' || change.closing === undefined) continue;
        last = await setClosing.mutateAsync({ betId: bet.id, legId: change.legId, closing: change.closing });
      }
    } catch (failure) {
      setError(failure);
      setSaving(false);
      busy.current = false;
      return;
    }
    setSaving(false);
    busy.current = false;
    toast.show(
      last?.clv !== null && last?.clv !== undefined
        ? t('bets.closingModal.savedClv', { clv: formatPercent(last.clv, { signed: true }) })
        : t('bets.closingModal.saved'),
      { icon: 'bolt' },
    );
    onClose();
  }

  const formId = `bets-closing-${bet.id}`;
  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={t('bets.closingModal.title', { id: bet.id })}
      className="bets-settle"
      footer={
        <>
          <Button onClick={onClose}>{t('bets.settle.cancel')}</Button>
          <Button kind="primary" icon="check" type="submit" form={formId} loading={saving}>
            {t('bets.closingModal.save')}
          </Button>
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
        <p className="small soft">{t('bets.closingModal.lead')}</p>
        {bet.legs.map((leg, i) => {
          const draft = drafts[i];
          if (!draft) return null;
          const meta = [legMarket(leg), leg.match.day ? formatDate(leg.match.day) : null];
          return (
            <div key={leg.id} className="bets-sleg">
              <div className="bets-sleg-head">
                <div className="bets-min">
                  <div className="bets-sleg-match">{matchText(leg)}</div>
                  <div className="xsmall muted">{meta.filter(Boolean).join(' · ')}</div>
                </div>
                <span className="odds bets-sleg-odds">{formatOdds(leg.odds_taken)}</span>
              </div>
              {legShown(bet, leg) === 'void' ? (
                <p className="xsmall muted">{t('bets.closingModal.voidLeg')}</p>
              ) : (
                <ClosingFields
                  id={`bets-cl-${bet.id}-${i}`}
                  draft={draft}
                  onChange={(next) => setDrafts((prev) => prev.map((d, k) => (k === i ? next : d)))}
                  odds={leg.odds_taken}
                  bookmaker={bet.bookmaker}
                  submitted={submitted}
                />
              )}
            </div>
          );
        })}
        {error !== null && (
          <Callout kind="bad" role="alert">
            {apiErrorText(error)}
          </Callout>
        )}
      </form>
    </Modal>
  );
}
