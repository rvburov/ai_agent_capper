import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router';

import { useMe } from '../../api/hooks/useMe';
import { paths } from '../../app/paths';
import { Button, Card, Chip, Meter, Skeleton } from '../../components';
import { useMarkets } from '../../features/markets/api';
import { modelState } from '../../features/markets/labels';
import { familyLines, familyTitle, statusChipKind, statusChipLabel, statusHint } from '../../features/markets/status';
import type { MarketFamilyOut, Markets } from '../../features/markets/types';
import { MOBILE_QUERY, useMediaQuery } from '../../lib/useMediaQuery';
import { CiCell, Howto, RoiText } from './parts';

// «Рынки: в экспрессе, на проверке, для сравнения» (freshCard макета, Р28): статус семейства,
// события (у «для сравнения» — «47 из 150» с полосой), ROI и CLV с 95% ДИ, сколько событий с
// закрытием (у «для сравнения» — «из 50»), у рынка, модель которого не прошла проверку, — метка. Данные общие для всех участников (GET /api/markets), от
// фильтров страницы не зависят; ROI и CLV при малом числе значений сервер не отдает (null — «—»).

function StatusMark({ m, need }: { m: MarketFamilyOut; need: number }) {
  const { t } = useTranslation();
  return (
    <span className="analytics-fresh-st">
      <span title={statusHint({ status: m.status, need })}>
        <Chip kind={m.status === 'express' ? 'good' : statusChipKind(m.status)} icon={m.status === 'express' ? 'ticket' : 'flask'}>
          {statusChipLabel(m.status)}
        </Chip>
      </span>
      {m.status === 'compare' && m.ready && (
        <Chip kind="good" icon="check">
          {t('analysis.marketChip.ready')}
        </Chip>
      )}
      {modelState(m) === 'failed' && (
        <span title={t('analysis.marketChip.modelFailedHint')}>
          <Chip kind="warn" icon="alert">
            {t('analysis.marketChip.modelFailed')}
          </Chip>
        </span>
      )}
    </span>
  );
}

function Events({ m, need }: { m: MarketFamilyOut; need: number }) {
  const { t } = useTranslation();
  if (m.status !== 'compare') return <span className="muted xsmall">{t('analysis.marketStatus.events', { count: m.events })}</span>;
  const text = t('analysis.marketChip.of', { n: m.events, need });
  return (
    <div className="analytics-fresh-prog">
      <span className="xsmall">{text}</span>
      <Meter value={m.events} max={need} label={t('analysis.marketStatus.progress')} valueText={text} />
    </div>
  );
}

function Value({ value, low, high }: { value: number | null; low: number | null; high: number | null }) {
  if (value === null) return <span className="muted">—</span>;
  return (
    <span className="analytics-fresh-val">
      <RoiText value={value} />
      {low !== null && high !== null && <CiCell ci={{ low, high }} />}
    </span>
  );
}

function Name({ m }: { m: MarketFamilyOut }) {
  return (
    <div className="analytics-min">
      <div className="analytics-mname">{familyTitle(m.family)}</div>
      <div className="analytics-mdesc">{familyLines(m.family)}</div>
    </div>
  );
}

function Body({ data }: { data: Markets }) {
  const { t } = useTranslation();
  const mobile = useMediaQuery(MOBILE_QUERY);
  const clvNeed = data.clv_need;
  if (mobile) {
    return (
      <ul className="analytics-fresh-list">
        {data.families.map((m) => (
          <li key={m.family}>
            <div className="analytics-fresh-head">
              <Name m={m} />
              <StatusMark m={m} need={data.need} />
            </div>
            <Events m={m} need={data.need} />
            {/* на телефоне title не виден: почему модель не прошла — текстом */}
            {modelState(m) === 'failed' && <div className="xsmall muted">{t('analysis.marketChip.modelFailedHint')}</div>}
            <div className="analytics-fresh-nums">
              <span>
                {t('analytics.marketsCard.roi')} <RoiText value={m.roi} />
              </span>
              <span>
                {t('analytics.marketsCard.clv')} <RoiText value={m.clv} />
              </span>
            </div>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <div className="analytics-tablebox">
      <div className="table-wrap">
        <table className="table analytics-fresh-table">
          <caption className="sr-only">{t('analytics.marketsCard.title')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('analytics.marketsCard.colMarket')}</th>
              <th scope="col">{t('analytics.marketsCard.colStatus')}</th>
              <th scope="col">{t('analytics.marketsCard.colEvents')}</th>
              <th scope="col" className="r">
                {t('analytics.marketsCard.roi')}
              </th>
              <th scope="col" className="r">
                {t('analytics.marketsCard.clv')}
              </th>
            </tr>
          </thead>
          <tbody>
            {data.families.map((m) => (
              <tr key={m.family}>
                <td>
                  <Name m={m} />
                </td>
                <td>
                  <StatusMark m={m} need={data.need} />
                </td>
                <td>
                  <Events m={m} need={data.need} />
                </td>
                <td className="r">
                  <Value value={m.roi} low={m.roi_low} high={m.roi_high} />
                </td>
                <td className="r">
                  <Value value={m.clv} low={m.clv_low} high={m.clv_high} />
                  <div className="muted xsmall">{m.status === 'compare' ? t('analysis.marketStatus.withClosingOf', { n: m.clv_n, need: clvNeed }) : t('analysis.marketStatus.withClosing', { n: m.clv_n })}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function MarketsCard() {
  const { t } = useTranslation();
  const { data, isPending, isError } = useMarkets();
  const admin = useMe().data?.role === 'admin';
  const { hash, key } = useLocation();
  // Уведомление «рынок прошел порог» ведет сюда (/analytics#markets): прокрутка, когда карточка готова
  useEffect(() => {
    if (hash !== `#${ANCHOR}` || !data) return;
    const frame = requestAnimationFrame(() => document.getElementById(ANCHOR)?.scrollIntoView({ block: 'start' }));
    return () => cancelAnimationFrame(frame);
  }, [hash, key, data]);
  const ready = data?.families.some((m) => m.can_promote) ?? false;
  return (
    <Card id={ANCHOR} className="analytics-card analytics-fresh" title={t('analytics.marketsCard.title')} subtitle={t('analytics.marketsCard.subtitle')}>
      {isPending ? <Skeleton height={160} /> : isError || !data ? <p className="muted small">{t('analytics.marketsCard.failed')}</p> : <Body data={data} />}
      {admin && ready && (
        <div className="row">
          <Button size="sm" kind="primary" icon="ticket" to={paths.admin('settings')}>
            {t('analytics.marketsCard.promote')}
          </Button>
        </div>
      )}
      <Howto>{t('analytics.marketsCard.howto', { need: data?.need ?? 150, needMax: data?.need_max ?? 200, clvNeed: data?.clv_need ?? 50, privateMin: data?.private_min ?? 10 })}</Howto>
    </Card>
  );
}

const ANCHOR = 'markets';
