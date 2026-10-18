import { useTranslation } from 'react-i18next';

import { Chip, Meter, Skeleton } from '../../../components';
import { useMarkets } from '../../../features/markets/api';
import { modelState } from '../../../features/markets/labels';
import { familyLines, familyTitle, statusChipKind, statusChipLabel, statusHint } from '../../../features/markets/status';
import { formatPercent } from '../../../lib/format';

// «Рынки» в «Правилах стратегии» (marketsBlock макета, Р28): статус каждого семейства, у «для
// сравнения» — счетчик «47 из 150» и CLV, у рынка на проверке и у рынка, модель которого не прошла
// проверку, — почему. Общие для всех участников.

export function MarketsBlock() {
  const { t } = useTranslation();
  const { data } = useMarkets();
  return (
    <div className="stack profile-tight">
      <div className="profile-section-title">
        <h4>{t('profile.bank.markets.title')}</h4>
        <span className="xsmall muted">{t('profile.bank.markets.aside')}</span>
      </div>
      {!data ? (
        <Skeleton lines={4} />
      ) : (
        <ul className="profile-mk">
          {data.families.map((m) => {
            const text = t('analysis.marketChip.of', { n: m.events, need: data.need });
            return (
              <li key={m.family}>
                <div className="profile-mk-head">
                  <div className="profile-mk-name">
                    <b>{familyTitle(m.family)}</b>
                    <small>{familyLines(m.family)}</small>
                  </div>
                  <span title={statusHint({ status: m.status, need: data.need })}>
                    <Chip kind={m.status === 'express' ? 'good' : statusChipKind(m.status)} icon={m.status === 'express' ? 'ticket' : 'flask'}>
                      {statusChipLabel(m.status)}
                    </Chip>
                  </span>
                </div>
                {m.status === 'compare' && (
                  <div className="profile-mk-prog">
                    <Meter value={m.events} max={data.need} label={t('analysis.marketStatus.progress')} valueText={text} />
                    <span className="xsmall muted">
                      {t('profile.bank.markets.progress', { events: text, clv: m.clv === null ? '—' : formatPercent(m.clv, { signed: true }) })}
                    </span>
                  </div>
                )}
                {m.status === 'suspended' && <div className="xsmall muted">{t('analysis.marketStatus.suspendedHint')}</div>}
                {modelState(m) === 'failed' && <div className="xsmall muted">{t('analysis.marketChip.modelFailedHint')}</div>}
              </li>
            );
          })}
        </ul>
      )}
      <p className="xsmall muted profile-mk-note">
        <b>{t('profile.bank.markets.oneTitle')}</b> {t('profile.bank.markets.oneText', { need: data?.need ?? 150, needMax: data?.need_max ?? 200, clvNeed: data?.clv_need ?? 50 })}
      </p>
    </div>
  );
}
