import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { paths } from '../../app/paths';
import { Button, Chip, EmptyState, Icon, Skeleton } from '../../components';
import { signedPct } from '../../features/analytics/display';
import { currencyOf, STATUS_CHIP, toneClass } from '../../features/bets/display';
import { useMemberDashboard } from '../../features/dashboard/api';
import type { RecentBet } from '../../features/dashboard/types';
import { viewTo } from '../../features/view/viewMode';
import { formatDate, formatMoney, formatOdds } from '../../lib/format';
import { LoadError } from './parts';

/*
 * Блок «Ставки и банк» карточки участника (moneyCard макета, Р27): банк и вложено, прибыль и ROI
 * за 30 дней (рядом ROI за все время), ставки в игре и последние 5 ставок. Данные — главная
 * участника (GET /api/dashboard?as_user=): те же числа, что видит он сам; просмотр сервер пишет в
 * журнал. Кнопки открывают данные участника в режиме просмотра (?as=<id>).
 */

function kind(bet: RecentBet, t: TFunction): string {
  return bet.legs > 1 ? t('admin.money.parlay', { n: bet.legs }) : t('admin.money.single');
}

export function MemberMoney({ userId, own, blocked }: { userId: number; own: boolean; blocked: boolean }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const month = useMemberDashboard(userId, '30d', own);
  const ever = useMemberDashboard(userId, 'all', own);
  const go = (path: string) => void navigate(own ? path : viewTo(path, userId));

  let body;
  if (month.isError || ever.isError) {
    body = (
      <LoadError
        error={month.error ?? ever.error}
        onRetry={() => {
          if (month.isError) void month.refetch();
          if (ever.isError) void ever.refetch();
        }}
      />
    );
  } else if (!month.data || !ever.data) {
    body = <Skeleton lines={4} height={18} />;
  } else if (month.data.bank.empty && !ever.data.kpi.settled && !ever.data.open_count) {
    body = <EmptyState>{blocked ? t('admin.money.emptyBlocked') : t('admin.money.empty')}</EmptyState>;
  } else {
    const d = month.data;
    const currency = currencyOf(d.currency);
    const money = (value: string | null, signed = false) => formatMoney(value, currency, { signed });
    const last = ever.data.recent.slice(0, 5);
    body = (
      <>
        <dl className="adm-facts four">
          <div>
            <dt>{t('admin.money.bank')}</dt>
            <dd>
              {money(d.bank.equity)}
              <small>{t('admin.money.invested', { amount: money(d.bank.invested) })}</small>
            </dd>
          </div>
          <div>
            <dt>{t('admin.money.profit')}</dt>
            <dd className={toneClass(d.kpi.profit)}>
              {money(d.kpi.profit, true)}
              <small>{t('admin.money.bets', { count: d.kpi.settled })}</small>
            </dd>
          </div>
          <div>
            <dt>{t('admin.money.roi')}</dt>
            <dd className={d.kpi.roi !== null && d.kpi.roi < 0 ? 'bad-text' : undefined}>
              {signedPct(d.kpi.roi)}
              <small>{t('admin.money.roiAll', { roi: signedPct(ever.data.kpi.roi) })}</small>
            </dd>
          </div>
          <div>
            <dt>{t('admin.money.inPlay')}</dt>
            <dd>
              {t('admin.money.bets', { count: d.open_count })}
              <small>{d.open_count ? t('admin.money.inPlayOn', { amount: money(d.open_stake) }) : t('admin.money.noOpen')}</small>
            </dd>
          </div>
        </dl>
        <div className="eyebrow">{t('admin.money.last')}</div>
        {last.length ? (
          <ul className="adm-bets" aria-label={t('admin.money.last')}>
            {last.map((bet) => (
              <li key={bet.id}>
                <span className="adm-bets-date">{formatDate(bet.settled_at ?? bet.placed_at)}</span>
                <div className="adm-bets-what">
                  <b>{t('admin.money.what', { kind: kind(bet, t), odds: formatOdds(bet.total_odds) })}</b>
                  <span>{t('admin.money.number', { id: bet.id })}</span>
                </div>
                <div className="adm-bets-sum">
                  <Chip kind={STATUS_CHIP[bet.status].kind} icon={STATUS_CHIP[bet.status].icon}>
                    {t(`admin.money.status.${bet.status}`)}
                  </Chip>
                  {bet.status === 'open' ? (
                    <span className="muted">{t('admin.money.stakeOpen', { amount: money(bet.stake) })}</span>
                  ) : (
                    <span className={toneClass(bet.profit)}>{money(bet.profit, true)}</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState>{t('admin.money.noBets')}</EmptyState>
        )}
        {!own && (
          <span className="adm-ro-note">
            <Icon name="history" />
            {t('admin.money.logged')}
          </span>
        )}
      </>
    );
  }

  return (
    <section className="stack" style={{ gap: 10 }} aria-labelledby={`adm-money-${userId}`}>
      <div className="row-between" style={{ gap: 8, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <div className="eyebrow" id={`adm-money-${userId}`}>
            {t('admin.money.title')}
          </div>
          <div className="xsmall muted">{own ? t('admin.money.subtitleOwn') : t('admin.money.subtitle')}</div>
        </div>
        {!own && (
          <Chip kind="warn" icon="eye">
            {t('admin.summary.readOnly')}
          </Chip>
        )}
      </div>
      {body}
      <div className="adm-money-acts">
        {own ? (
          <>
            <Button size="sm" icon="home" onClick={() => go(paths.home)}>
              {t('admin.money.myHome')}
            </Button>
            <Button kind="ghost" size="sm" icon="ticket" onClick={() => go(paths.bets)}>
              {t('admin.money.myBets')}
            </Button>
          </>
        ) : (
          <>
            <Button kind="primary" icon="eye" onClick={() => go(paths.home)}>
              {t('admin.money.openAsMember')}
            </Button>
            <Button size="sm" icon="ticket" onClick={() => go(paths.bets)}>
              {t('admin.money.toBets')}
            </Button>
            <Button kind="ghost" size="sm" icon="wallet" onClick={() => go(paths.profile('bank'))}>
              {t('admin.money.toBank')}
            </Button>
          </>
        )}
      </div>
    </section>
  );
}
