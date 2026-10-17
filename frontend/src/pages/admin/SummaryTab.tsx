import type { TFunction } from 'i18next';
import type { KeyboardEvent } from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import type { Me } from '../../api/hooks/useMe';
import { paths } from '../../app/paths';
import { Button, Card, Chip, EmptyState, Icon, Segmented, Skeleton, Stat } from '../../components';
import { spendMonth, whenInline } from '../../features/admin/display';
import {
  brierVerdict,
  canOpen,
  SUMMARY_PERIODS,
  useAdminSummary,
  type AdminSummary,
  type SummaryMember,
  type SummaryPeriod,
} from '../../features/admin/summary';
import { brierText, signedPct } from '../../features/analytics/display';
import { currencyOf } from '../../features/bets/display';
import { viewTo } from '../../features/view/viewMode';
import { cx } from '../../lib/cx';
import { currencySign, formatMoney, formatNumber, formatUsd } from '../../lib/format';
import { useMediaQuery } from '../../lib/useMediaQuery';
import { NARROW_QUERY } from './media';
import { Avatar, HowTo, LoadError } from './parts';

/*
 * «Администрирование → Сводка» (PANELS.summary макета, Р27): итоги за период по всем вместе с
 * вами и строка на каждого. Нажатие на строку открывает данные участника так, как он их видит,
 * только просмотр (?as=<id>); своя строка — своя главная. Открытие сводки сервер пишет в журнал.
 */

const tone = (value: number | null) => (value === null ? undefined : value > 0 ? 'good-text' : value < 0 ? 'bad-text' : undefined);

function nameOf(row: SummaryMember, t: TFunction): string {
  return row.name.trim() || t('view.unknown', { id: row.user_id });
}

export function SummaryTab({ me }: { me: Me }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const narrow = useMediaQuery(NARROW_QUERY);
  const [period, setPeriod] = useState<SummaryPeriod>('30d');
  const summary = useAdminSummary(period);
  const data = summary.data;

  const open = (row: SummaryMember) => void navigate(row.me ? paths.home : viewTo(paths.home, row.user_id));
  const seg = (
    <div className="adm-toolbar">
      <Segmented<SummaryPeriod>
        label={t('admin.summary.periodLabel')}
        items={SUMMARY_PERIODS.map((value) => ({ value, label: t(`analytics.period.items.${value}`) }))}
        value={period}
        onChange={setPeriod}
      />
    </div>
  );

  if (!data) {
    return (
      <div className="stack">
        <Card title={t('admin.summary.title')}>
          {seg}
          {summary.isError ? (
            <LoadError error={summary.error} onRetry={() => void summary.refetch()} />
          ) : (
            <Skeleton lines={4} height={18} />
          )}
        </Card>
      </div>
    );
  }

  const ctx = t(`analytics.period.ctx.${data.period}`);
  const month = spendMonth(new Date(data.month_start));
  const currency = currencyOf(data.currency);
  return (
    <div className={cx('stack', summary.isPlaceholderData && 'adm-pending')} aria-busy={summary.isPlaceholderData || undefined}>
      <Card
        title={t('admin.summary.title')}
        subtitle={t('admin.summary.subtitle', { ctx: ctx.charAt(0).toUpperCase() + ctx.slice(1), sign: currencySign(currency) })}
        actions={
          <Chip kind="warn" icon="eye">
            {t('admin.summary.readOnly')}
          </Chip>
        }
      >
        {seg}
        <Tiles data={data} />
        <HowTo>{t('admin.summary.howto')}</HowTo>
      </Card>
      {narrow ? (
        <>
          <div className="eyebrow">{t('admin.summary.byMember', { ctx })}</div>
          {data.members.length ? (
            <div className="adm-scards">
              {data.members.map((row) => (
                <MemberCard key={row.user_id} row={row} data={data} me={me} onOpen={open} />
              ))}
            </div>
          ) : (
            <EmptyState>{t('admin.summary.empty')}</EmptyState>
          )}
          <span className="adm-ro-note">
            <Icon name="eye" />
            {t('admin.summary.noteNarrow')}
          </span>
        </>
      ) : (
        <Card
          title={t('admin.summary.byMemberTitle')}
          subtitle={t('admin.summary.byMemberSubtitle', { ctx, month })}
          flush
          foot={
            <span className="adm-ro-note">
              <Icon name="eye" />
              {t('admin.summary.note')}
            </span>
          }
        >
          <SummaryTable data={data} me={me} month={month} onOpen={open} />
        </Card>
      )}
    </div>
  );
}

function Tiles({ data }: { data: AdminSummary }) {
  const { t } = useTranslation();
  const currency = currencyOf(data.currency);
  const s = data.totals;
  const verdict = brierVerdict(s.brier_model, s.brier_market);
  return (
    <div className="adm-sum-tiles">
      <Stat
        label={t('admin.summary.tiles.bets')}
        icon="ticket"
        value={formatNumber(s.bets)}
        hint={t('admin.summary.tiles.betsHint', { count: s.members_with_bets })}
      />
      <Stat label={t('admin.summary.tiles.turnover')} icon="coins" value={formatMoney(s.turnover, currency)} hint={t('admin.summary.tiles.turnoverHint')} />
      <Stat
        label={t('admin.summary.tiles.profit')}
        icon="wallet"
        value={<span className={tone(Number(s.profit))}>{formatMoney(s.profit, currency, { signed: true })}</span>}
        hint={t('admin.summary.tiles.profitHint')}
      />
      <Stat label={t('admin.summary.tiles.roi')} icon="chart" value={signedPct(s.roi)} hint={t('admin.summary.tiles.roiHint')} />
      <Stat
        label={t('admin.summary.tiles.clv')}
        icon="bolt"
        value={signedPct(s.clv_avg)}
        hint={t('admin.summary.tiles.clvHint', { count: s.clv_n })}
      />
      <Stat
        label={t('admin.summary.tiles.brier')}
        icon="target"
        value={s.brier_model === null ? '—' : brierText(s.brier_model)}
        hint={
          verdict === null
            ? t('admin.summary.tiles.brierNone')
            : t('admin.summary.tiles.brierHint', { market: brierText(s.brier_market), verdict: t(`admin.summary.verdict.${verdict}`) })
        }
      />
    </div>
  );
}

function PersonCell({ row, me }: { row: SummaryMember; me: Me }) {
  const { t } = useTranslation();
  const name = nameOf(row, t);
  return (
    <div className="adm-person">
      <Avatar user={{ id: row.user_id, display_name: name, email: '' }} meId={me.id} />
      <div className="adm-person-name">
        <span className="adm-nowrap">{name}</span>
        {row.me && <Chip kind="accent">{t('admin.you')}</Chip>}
        {row.status === 'blocked' && <Chip kind="bad">{t('admin.summary.blocked')}</Chip>}
      </div>
    </div>
  );
}

function SummaryTable({ data, me, month, onOpen }: { data: AdminSummary; me: Me; month: string; onOpen: (row: SummaryMember) => void }) {
  const { t } = useTranslation();
  const currency = currencyOf(data.currency);
  const s = data.totals;
  const money = (value: string, signed = false) => formatMoney(value, currency, { signed });
  const onKey = (event: KeyboardEvent<HTMLTableRowElement>, row: SummaryMember) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onOpen(row);
  };
  const analyses = data.members.reduce((n, row) => n + row.analyses, 0);
  const spent = data.members.reduce((n, row) => n + row.ai_spend_usd, 0);
  return (
    <div className="table-wrap adm-users-wrap">
      <table className="table adm-sum-table">
        <caption className="sr-only">{t('admin.summary.byMemberTitle')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('admin.summary.columns.person')}</th>
            <th scope="col" className="r">{t('admin.summary.columns.bank')}</th>
            <th scope="col" className="r">{t('admin.summary.columns.bets')}</th>
            <th scope="col" className="r">{t('admin.summary.columns.roi')}</th>
            <th scope="col" className="r">{t('admin.summary.columns.profit')}</th>
            <th scope="col" className="r">{t('admin.summary.columns.clv')}</th>
            <th scope="col" className="r">{t('admin.summary.columns.analyses', { month })}</th>
            <th scope="col" className="r">{t('admin.summary.columns.spent', { month })}</th>
            <th scope="col">{t('admin.summary.columns.login')}</th>
            <th scope="col" className="r">
              <span className="sr-only">{t('admin.summary.columns.open')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {data.members.map((row) => {
            const clickable = canOpen(row);
            const name = nameOf(row, t);
            return (
              <tr
                key={row.user_id}
                className={cx(clickable ? 'clickable' : 'is-empty')}
                tabIndex={clickable ? 0 : undefined}
                aria-label={clickable ? (row.me ? t('admin.summary.rowOwn', { name }) : t('admin.summary.row', { name })) : undefined}
                onClick={clickable ? () => onOpen(row) : undefined}
                onKeyDown={clickable ? (event) => onKey(event, row) : undefined}
              >
                <td>
                  <PersonCell row={row} me={me} />
                </td>
                <td className="r">{row.empty ? '—' : money(row.bank)}</td>
                <td className="r">{formatNumber(row.bets)}</td>
                <td className={cx('r', tone(row.roi))}>{signedPct(row.roi)}</td>
                <td className={cx('r', tone(Number(row.profit)))}>{row.bets ? money(row.profit, true) : '—'}</td>
                <td className={cx('r', tone(row.clv_avg))}>{signedPct(row.clv_avg)}</td>
                <td className="r">{formatNumber(row.analyses)}</td>
                <td className="r">{formatUsd(row.ai_spend_usd)}</td>
                <td>{row.last_login_at ? whenInline(row.last_login_at) : t('admin.users.never')}</td>
                <td className="r">
                  {clickable && (
                    <span className="adm-sum-go" aria-hidden="true">
                      <Icon name="chevronRight" />
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
          <tr className="is-total">
            <td>{t('admin.summary.total')}</td>
            <td className="r">{money(s.bank)}</td>
            <td className="r">{formatNumber(s.bets)}</td>
            <td className={cx('r', tone(s.roi))}>{signedPct(s.roi)}</td>
            <td className={cx('r', tone(Number(s.profit)))}>{money(s.profit, true)}</td>
            <td className={cx('r', tone(s.clv_avg))}>{signedPct(s.clv_avg)}</td>
            <td className="r">{formatNumber(analyses)}</td>
            <td className="r">{formatUsd(spent)}</td>
            <td />
            <td />
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function MemberCard({ row, data, me, onOpen }: { row: SummaryMember; data: AdminSummary; me: Me; onOpen: (row: SummaryMember) => void }) {
  const { t } = useTranslation();
  const currency = currencyOf(data.currency);
  const name = nameOf(row, t);
  const clickable = canOpen(row);
  return (
    <section className="card adm-scard" aria-label={name}>
      <div className="adm-scard-head">
        <Avatar user={{ id: row.user_id, display_name: name, email: '' }} meId={me.id} />
        <div style={{ minWidth: 0 }}>
          <div className="adm-person-name">
            {name}
            {row.me && <Chip kind="accent">{t('admin.you')}</Chip>}
            {row.status === 'blocked' && <Chip kind="bad">{t('admin.summary.blocked')}</Chip>}
          </div>
          <div className="adm-person-mail">
            {t('admin.summary.login', { when: row.last_login_at ? whenInline(row.last_login_at) : t('admin.users.never') })}
          </div>
        </div>
        <span className="adm-scard-bank">{row.empty ? '—' : formatMoney(row.bank, currency)}</span>
      </div>
      {clickable ? (
        <dl className="adm-facts">
          <div>
            <dt>{t('admin.summary.columns.bets')}</dt>
            <dd>{formatNumber(row.bets)}</dd>
          </div>
          <div>
            <dt>{t('admin.summary.columns.roi')}</dt>
            <dd className={tone(row.roi)}>{signedPct(row.roi)}</dd>
          </div>
          <div>
            <dt>{t('admin.summary.columns.profit')}</dt>
            <dd className={tone(Number(row.profit))}>{row.bets ? formatMoney(row.profit, currency, { signed: true }) : '—'}</dd>
          </div>
          <div>
            <dt>{t('admin.summary.columns.clv')}</dt>
            <dd className={tone(row.clv_avg)}>{signedPct(row.clv_avg)}</dd>
          </div>
          <div>
            <dt>{t('admin.summary.columns.analysesShort')}</dt>
            <dd>{formatNumber(row.analyses)}</dd>
          </div>
          <div>
            <dt>{t('admin.summary.columns.spentShort')}</dt>
            <dd>{formatUsd(row.ai_spend_usd)}</dd>
          </div>
        </dl>
      ) : (
        <p className="small soft" style={{ margin: 0 }}>
          {t('admin.summary.noBets')}
        </p>
      )}
      {clickable && (
        <Button size="sm" icon="eye" iconRight="chevronRight" block onClick={() => onOpen(row)}>
          {row.me ? t('admin.summary.openOwn') : t('admin.summary.open')}
        </Button>
      )}
    </section>
  );
}
