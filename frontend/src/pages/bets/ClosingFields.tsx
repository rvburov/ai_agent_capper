import type { TFunction } from 'i18next';
import { useId, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Dropdown, FieldShell, type DropdownOption } from '../../components';
import { checkClosing, CLOSING_BY, type ClosingDraft } from '../../features/bets/closing';
import { clvPreview } from '../../features/bets/settle';
import type { ClosingBy } from '../../features/bets/types';
import { formatOdds, formatPercent } from '../../lib/format';
import { cx } from '../../lib/cx';
import { Signed } from './parts';

// Закрывающий кэф ноги (closingFields макета, В1): чей кэф, ваш исход и обратный по желанию;
// CLV и CLV без маржи видны сразу, по мере ввода.

interface ClosingFieldsProps {
  id: string;
  draft: ClosingDraft;
  onChange: (draft: ClosingDraft) => void;
  /** Кэф ставки на этот исход. */
  odds: string;
  /** Букмекер ставки: вариант «ваш букмекер». */
  bookmaker: string;
  /** Попытка сохранить: показать ошибку и у недописанного кэфа. */
  submitted: boolean;
}

function whoOptions(bookmaker: string, own: string | null, t: TFunction): DropdownOption<ClosingBy>[] {
  const name = own ?? bookmaker;
  return CLOSING_BY.filter((by) => by !== 'bookmaker' || name.trim().toLowerCase() !== 'pinnacle').map((by) => ({
    value: by,
    label: by === 'bookmaker' ? t('bets.closing.byOwn', { name }) : t(`bets.closing.by.${by}`),
  }));
}

export function ClosingFields({ id, draft, onChange, odds, bookmaker, submitted }: ClosingFieldsProps) {
  const { t } = useTranslation();
  const whoId = useId();
  const check = checkClosing(draft);
  const ownBad = check.kind === 'invalid' && check.field === 'own' && (submitted || !check.typing);
  const oppBad = check.kind === 'invalid' && check.field === 'opp' && (submitted || !check.typing);
  const hintId = `${id}-closing-hint`;
  let hint: ReactNode;
  if (ownBad || oppBad) {
    hint = (
      <div className="field-error bets-close-hint" id={hintId} role="alert">
        {t('bets.closing.bad', { example: formatOdds(odds) })}
      </div>
    );
  } else if (check.kind === 'ok') {
    const { clv, fair } = clvPreview(Number(odds), check.own, check.opp);
    hint = (
      <div className="field-hint bets-close-hint" id={hintId} aria-live="polite">
        {t('bets.closing.before')} ·{' '}
        <b className="bets-nw">
          <Signed value={clv} text={t('bets.closing.clv', { value: formatPercent(clv, { signed: true }) })} />
        </b>
        {fair !== null ? (
          <>
            {' · '}
            <b className="bets-nw">
              <Signed value={fair} text={t('bets.closing.fair', { value: formatPercent(fair, { signed: true }) })} />
            </b>
          </>
        ) : (
          ` · ${t('bets.closing.fairHint')}`
        )}
      </div>
    );
  } else {
    hint = (
      <div className="field-hint bets-close-hint" id={hintId} aria-live="polite">
        {t('bets.closing.later')}
      </div>
    );
  }
  return (
    <fieldset className="bets-close">
      <legend className="field-label">{t('bets.closing.legend')}</legend>
      <div className="bets-close-grid">
        <FieldShell id={whoId} label={t('bets.closing.who')}>
          <Dropdown
            id={whoId}
            label={t('bets.closing.who')}
            options={whoOptions(bookmaker, draft.bookmaker, t)}
            value={draft.by}
            onChange={(by) => onChange({ ...draft, by })}
          />
        </FieldShell>
        <FieldShell id={`${id}-own`} label={t('bets.closing.own')}>
          <input
            id={`${id}-own`}
            className={cx('input mono', ownBad && 'invalid')}
            inputMode="decimal"
            autoComplete="off"
            maxLength={6}
            placeholder={formatOdds(odds)}
            value={draft.own}
            aria-invalid={ownBad || undefined}
            aria-describedby={hintId}
            onChange={(event) => onChange({ ...draft, own: event.target.value })}
          />
        </FieldShell>
        <FieldShell id={`${id}-opp`} label={t('bets.closing.opp')} labelAside={<span className="bets-opt">{t('bets.closing.optional')}</span>}>
          <input
            id={`${id}-opp`}
            className={cx('input mono', oppBad && 'invalid')}
            inputMode="decimal"
            autoComplete="off"
            maxLength={6}
            value={draft.opp}
            aria-invalid={oppBad || undefined}
            aria-describedby={hintId}
            onChange={(event) => onChange({ ...draft, opp: event.target.value })}
          />
        </FieldShell>
      </div>
      {hint}
    </fieldset>
  );
}
