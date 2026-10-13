import { useTranslation } from 'react-i18next';

import { Card, Chip, EmptyState } from '../../components';
import { ciPct, ciPp, signClass, signedPct } from '../../features/analytics/display';
import type { Analytics, Ci } from '../../features/analytics/types';
import { currencyOf } from '../../features/bets/display';
import { formatMoney, formatPp } from '../../lib/format';
import { cx } from '../../lib/cx';
import { FootNote, Howto } from './parts';

// Р21: реальные экспрессы против тех же событий ординарами на равную сумму (parlayCard макета).
// Разница и интервалы — парный бутстрэп сервера; экспрессы старого бота не входят (Т10).

function Side({ label, roi, ci, sub }: { label: string; roi: number | null; ci: Ci | null; sub: string }) {
  const { t } = useTranslation();
  return (
    <div className="analytics-r21-side">
      <div className="analytics-r21-l">{label}</div>
      <div className={cx('analytics-r21-v', signClass(roi))}>{roi === null ? '—' : signedPct(roi)}</div>
      <div className="analytics-r21-s">{t('analytics.parlays.ci', { range: ciPct(ci) })}</div>
      <div className="analytics-r21-s">{sub}</div>
    </div>
  );
}

export function ParlaysCard({ data }: { data: Analytics }) {
  const { t } = useTranslation();
  const r = data.parlays;
  const head = { className: 'analytics-card', title: t('analytics.parlays.title'), subtitle: t('analytics.parlays.subtitle') };
  if (!r) {
    return (
      <Card {...head}>
        <EmptyState>{t('analytics.parlays.none')}</EmptyState>
      </Card>
    );
  }
  const legacy = t('analytics.parlays.legacy', { count: r.legacy_parlays });
  if (!r.parlays) {
    return (
      <Card {...head}>
        <EmptyState>{t('analytics.parlays.onlyLegacy', { legacy })}</EmptyState>
      </Card>
    );
  }
  const currency = currencyOf(data.currency);
  const verdict = r.verdict ?? 'noise';
  const noise = verdict === 'noise';
  return (
    <Card
      {...head}
      actions={
        <Chip kind="outline">
          {t('analytics.parlays.chip', { parlays: t('analytics.count.parlays', { count: r.parlays }), events: t('analytics.count.events', { count: r.events }) })}
        </Chip>
      }
    >
      <div className="analytics-r21-grid">
        <Side
          label={t('analytics.parlays.parlaysLabel')}
          roi={r.parlays_roi}
          ci={r.parlays_ci}
          sub={t('analytics.parlays.parlaysSub', { profit: formatMoney(r.profit, currency, { signed: true }) })}
        />
        <Side label={t('analytics.parlays.singlesLabel')} roi={r.singles_roi} ci={r.singles_ci} sub={t('analytics.parlays.singlesSub')} />
        <div className="analytics-r21-side">
          <div className="analytics-r21-l">{t('analytics.parlays.diffLabel')}</div>
          <div className={cx('analytics-r21-v', !noise && signClass(r.diff))}>{r.diff === null ? '—' : formatPp(r.diff)}</div>
          <div className="analytics-r21-s">{t('analytics.parlays.ci', { range: ciPp(r.diff_ci) })}</div>
          <Chip kind={noise ? 'outline' : verdict === 'parlays' ? 'good' : 'warn'} icon={noise ? 'info' : 'check'}>
            {t(`analytics.parlays.verdict.${verdict}`)}
          </Chip>
        </div>
      </div>
      {r.legacy_parlays > 0 && <FootNote>{t('analytics.parlays.legacyNote', { legacy })}</FootNote>}
      <Howto>{t('analytics.parlays.howto')}</Howto>
    </Card>
  );
}
