import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import type { Me } from '../../../api/hooks/useMe';
import { paths } from '../../../app/paths';
import { Callout, Icon, Skeleton, Stat } from '../../../components';
import { useBank, useStrategy } from '../../../features/analysis/api';
import { useBankEntries } from '../../../features/bank/api';
import type { Bank } from '../../../features/bank/types';
import { useBetSummary } from '../../../features/bets/api';
import { currencyOf } from '../../../features/bets/display';
import { formatDateLong, formatMoney, formatPercent, type Currency } from '../../../lib/format';
import { MOBILE_QUERY, useMediaQuery } from '../../../lib/useMediaQuery';
import { LoadError } from '../LoadError';
import { AdaptCard } from './AdaptCard';
import { BooksCard } from './BooksCard';
import { MovesCard } from './MovesCard';
import { ResponsibleCard } from './ResponsibleCard';
import { StrategyCard } from './StrategyCard';
import './bank.css';

/*
 * Личный кабинет → «Банк и стратегия» (panelBank в mockup/js/screens/profile.js): валюта,
 * плитки банка, правила стратегии и адаптации — только просмотр, движение банка с журналом,
 * ответственная игра и «Мои букмекеры». Числа банка — из GET /api/me/bank.
 */

function CurrencyNote({ currency, admin }: { currency: Currency; admin: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="profile-cur" role="note">
      <Icon name="currency" />
      <div className="profile-cur-text">
        <b>{t('profile.bank.currency.title', { name: t(`profile.bank.currency.names.${currency}`) })}</b> {t('profile.bank.currency.text')}
      </div>
      {admin && <Link to={paths.admin('settings')}>{t('profile.bank.currency.change')}</Link>}
    </div>
  );
}

function Tiles({ bank, openBets }: { bank: Bank; openBets: number | null }) {
  const { t } = useTranslation();
  const entries = useBankEntries();
  const currency = currencyOf(bank.currency);
  const money = (amount: string) => formatMoney(amount, currency);
  const growth = bank.growth === null ? null : Number(bank.growth);
  const drawdown = Number(bank.drawdown);
  const equity = Number(bank.equity);
  const flows = entries.data?.pages.flatMap((page) => page.items) ?? [];
  const onlyStart = flows.length === 1 && !entries.hasNextPage ? flows[0] : null;
  const share = equity > 0 ? Number(bank.in_play) / equity : null;
  return (
    <div className="grid profile-tiles">
      <div className="col-3 half-mobile">
        <Stat
          label={t('profile.bank.tiles.invested')}
          icon="wallet"
          value={money(bank.invested)}
          hint={onlyStart ? t('profile.bank.tiles.investedStart', { date: formatDateLong(onlyStart.at) }) : t('profile.bank.tiles.investedHint')}
        />
      </div>
      <div className="col-3 half-mobile">
        <Stat
          label={t('profile.bank.tiles.bank')}
          icon="coins"
          value={money(bank.equity)}
          delta={growth === null ? undefined : formatPercent(growth, { signed: true })}
          trend={growth === null || growth === 0 ? 'flat' : growth > 0 ? 'up' : 'down'}
          hint={t('profile.bank.tiles.bankHint')}
        />
      </div>
      <div className="col-3 half-mobile">
        <Stat
          label={t('profile.bank.tiles.inPlay')}
          icon="clock"
          value={money(bank.in_play)}
          hint={[
            openBets !== null ? t('bets.count', { count: openBets }) : null,
            share !== null ? t('profile.bank.tiles.inPlayShare', { share: formatPercent(share) }) : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        />
      </div>
      <div className="col-3 half-mobile">
        <Stat
          label={t('profile.bank.tiles.fromPeak')}
          icon="arrowDown"
          value={drawdown > 0 ? formatPercent(-drawdown, { signed: true }) : formatPercent(0, { digits: 0 })}
          hint={t('profile.bank.tiles.peak', { peak: money(bank.peak) })}
        />
      </div>
    </div>
  );
}

export function BankTab({ me }: { me: Me }) {
  const bank = useBank();
  const strategy = useStrategy();
  const summary = useBetSummary({});
  const mobile = useMediaQuery(MOBILE_QUERY);
  const { t } = useTranslation();

  if (bank.error) return <LoadError error={bank.error} onRetry={() => void bank.refetch()} />;
  if (!bank.data) {
    return (
      <div className="profile-panel-body">
        <Skeleton lines={4} />
      </div>
    );
  }
  const data = bank.data;
  const currency = currencyOf(data.currency);
  const admin = me.role === 'admin';
  const openBets = summary.data?.open ?? null;
  const strategyCard = <StrategyCard strategy={strategy.data} error={strategy.error} onRetry={() => void strategy.refetch()} bank={data} />;
  const adaptCard = <AdaptCard bank={data} params={strategy.data?.params ?? null} />;
  const movesCard = <MovesCard bank={data} />;
  const responsible = <ResponsibleCard currency={currency} />;
  const books = <BooksCard />;
  return (
    <>
      <CurrencyNote currency={currency} admin={admin} />
      {data.empty && <Callout kind="info">{t('profile.bank.empty')}</Callout>}
      <Tiles bank={data} openBets={openBets} />
      {mobile ? (
        <>
          {responsible}
          {adaptCard}
          {strategyCard}
          {movesCard}
          {books}
        </>
      ) : (
        <>
          <div className="grid">
            <div className="col-7 profile-col">
              {strategyCard}
              {movesCard}
            </div>
            <div className="col-5 profile-col">
              {responsible}
              {books}
            </div>
          </div>
          {adaptCard}
        </>
      )}
    </>
  );
}
