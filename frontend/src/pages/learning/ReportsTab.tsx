import type { TFunction } from 'i18next';
import { useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';

import { errorMessage, isApiError } from '../../api/errors';
import { paths } from '../../app/paths';
import { Button, Callout, Card, EmptyState, Icon, Modal, Skeleton } from '../../components';
import { currencyOf } from '../../features/bets/display';
import { timeZoneName } from '../../features/profile/timezones';
import { useWeeklyReport, useWeeklyReports } from '../../features/learning/reports';
import type { LearningSummary, WeeklyReport, WeeklyReportBrief } from '../../features/learning/types';
import { formatDate, formatDateRange, formatDateTime, formatMoney, formatNumber, formatPercent, formatUsd } from '../../lib/format';
import { cx } from '../../lib/cx';

// Вкладка «Отчеты» (reportsPanel макета, В8): последний отчет недели крупно, прошлые недели —
// списком с окном отчета. Неделя — с понедельника по воскресенье по поясу участника; отчет
// приходит в понедельник 07:00 в центр уведомлений (ссылка /learning/reports?report=ID).
// Пустая неделя — короткий отчет «ставок не было». Все числа — с сервера.

const signedPct = (value: number | null | undefined) => (value === null || value === undefined ? '—' : formatPercent(value, { signed: true }));
const tone = (value: number) => (value > 0 ? 'good-text' : value < 0 ? 'bad-text' : null);

function Cell({ label, value, sub, className }: { label: string; value: ReactNode; sub?: ReactNode; className?: string | null }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className={className ?? undefined}>
        {value}
        {sub && <small>{sub}</small>}
      </dd>
    </div>
  );
}

function codes(list: readonly string[], t: TFunction): string {
  return list.length ? list.join(', ') : t('learning.reports.none');
}

/** Отчет недели: сетка чисел, у администратора — общее по программе (Р14, без ставок участников). */
export function ReportBlock({ report }: { report: WeeklyReport }) {
  const { t } = useTranslation();
  const currency = currencyOf(report.currency);
  const b = report.bets;
  const profit = Number(b.profit);
  const acc = report.accuracy;
  const cal = report.calibration;
  const l = report.lessons;
  const shared = report.shared;
  return (
    <div className="learning-report">
      {report.empty && (
        <Callout kind="info" icon="info">
          {/* рассчитанных нет, но поставленные или ждущие результата есть — так и пишем */}
          {b.placed > 0 || b.open > 0
            ? t('learning.reports.emptyWaiting', { placed: formatNumber(b.placed), open: formatNumber(b.open) })
            : t('learning.reports.emptyWeek')}
        </Callout>
      )}
      <dl className="learning-rgrid">
        <Cell label={t('learning.reports.cells.settled')} value={formatNumber(b.settled)} sub={t('learning.reports.cells.settledSub', { auto: formatNumber(b.auto), manual: formatNumber(b.manual) })} />
        <Cell
          label={t('learning.reports.cells.profit')}
          value={formatMoney(b.profit, currency, { signed: true })}
          sub={b.roi !== null ? t('learning.reports.cells.roi', { roi: signedPct(b.roi) }) : t('learning.reports.cells.placed', { placed: formatNumber(b.placed), open: formatNumber(b.open) })}
          className={tone(profit)}
        />
        <Cell label={t('learning.reports.cells.clv')} value={signedPct(report.clv.mean)} sub={t('learning.reports.cells.clvSub', { count: report.clv.n, positive: formatNumber(report.clv.positive) })} />
        <Cell
          label={t('learning.reports.cells.brier')}
          value={acc.model !== null && acc.market !== null ? t('learning.reports.cells.brierValue', { model: formatNumber(acc.model, 3), market: formatNumber(acc.market, 3) }) : '—'}
          sub={t(acc.source === 'closing' ? 'learning.reports.cells.brierSubClosing' : 'learning.reports.cells.brierSub', { count: acc.n })}
        />
        <Cell
          label={t('learning.reports.cells.reviews')}
          value={formatNumber(report.reviews.done)}
          sub={t(report.reviews.pending ? 'learning.reports.cells.reviewsSubPending' : 'learning.reports.cells.reviewsSub', {
            cost: formatUsd(report.reviews.cost_usd),
            pending: formatNumber(report.reviews.pending),
          })}
        />
        <Cell label={t('learning.reports.cells.lessons')} value={codes(l.new, t)} sub={t('learning.reports.cells.lessonsSub', { confirmed: codes(l.confirmed, t), enabled: codes(l.enabled, t), n: formatNumber(l.in_prompt) })} />
        <Cell
          label={t('learning.reports.cells.eval')}
          value={formatUsd(report.eval.spent_usd)}
          sub={t('learning.reports.cells.evalSub', { month: formatUsd(report.eval.month_spent_usd), budget: formatUsd(report.eval.budget_usd, 0) })}
        />
        <Cell
          label={t('learning.reports.cells.calibration')}
          value={cal.mean_p !== null && cal.hit_rate !== null ? t('learning.reports.cells.calibrationValue', { p: formatPercent(cal.mean_p, { digits: 0 }), hit: formatPercent(cal.hit_rate, { digits: 0 }) }) : '—'}
          sub={t('learning.reports.cells.calibrationSub', { count: cal.n })}
        />
      </dl>
      {(report.model.id || l.retired.length > 0) && (
        <p className="small soft">
          {report.model.id &&
            t(report.model.recalibrated_at ? (report.model.recalibration_activated ? 'learning.reports.modelRecal' : 'learning.reports.modelRecalNo') : 'learning.reports.model', {
              id: report.model.id,
              brier: formatNumber(report.model.brier, 3),
              date: formatDate(report.model.recalibrated_at),
            })}
          {l.retired.length > 0 && ` ${t('learning.reports.retired', { codes: l.retired.join(', ') })}`}
        </p>
      )}
      {shared && (
        <div className="learning-cond-box">
          <div className="eyebrow">{t('learning.reports.shared.title')}</div>
          <dl className="learning-rgrid">
            <Cell label={t('learning.reports.shared.members')} value={formatNumber(shared.members)} sub={t('learning.reports.shared.membersSub')} />
            <Cell label={t('learning.reports.shared.settled')} value={formatNumber(shared.settled)} sub={t('learning.reports.shared.settledSub', { auto: formatNumber(shared.auto) })} />
            <Cell label={t('learning.reports.shared.reviews')} value={formatNumber(shared.reviews)} sub={formatUsd(shared.reviews_usd)} />
            <Cell label={t('learning.reports.shared.ai')} value={formatUsd(shared.ai_usd)} sub={t('learning.reports.shared.aiSub', { count: shared.analyses })} />
          </dl>
        </div>
      )}
      <p className="learning-hint">
        <Icon name="info" />
        <span>{t('learning.reports.hint')}</span>
      </p>
    </div>
  );
}

/** id = null — номер в ссылке не число: отчета точно нет, сервер не спрашиваем. */
function ReportModal({ id, onClose }: { id: number | null; onClose: () => void }) {
  const { t } = useTranslation();
  const query = useWeeklyReport(id);
  const notFound = id === null || (isApiError(query.error) && (query.error.status === 404 || query.error.status === 422));
  const report = query.data;
  return (
    <Modal
      open
      wide
      onClose={onClose}
      className="learning-modal"
      title={report ? t('learning.reports.modalTitle', { week: formatDateRange(report.week_start, report.week_end) }) : t('learning.reports.modalTitlePlain')}
      footer={
        <Button kind="primary" onClick={onClose}>
          {t('common.close')}
        </Button>
      }
    >
      {report ? (
        <ReportBlock report={report} />
      ) : notFound || query.isError ? (
        <Callout kind="bad" icon="alert" role="alert">
          {/* ссылка на чужой, удаленный или неверный отчет (404, 422): понятными словами */}
          {notFound ? t('learning.reports.notFound') : errorMessage(query.error)}
        </Callout>
      ) : (
        <Skeleton lines={4} />
      )}
    </Modal>
  );
}

function OlderRow({ item, onOpen }: { item: WeeklyReportBrief; onOpen: () => void }) {
  const { t } = useTranslation();
  const profit = Number(item.profit);
  return (
    <button type="button" className="learning-rrow" data-report={item.id} onClick={onOpen}>
      <span className="learning-min">
        <b>{formatDateRange(item.week_start, item.week_end)}</b>
        <small>
          {item.empty
            ? t('learning.reports.emptyShort')
            : t('learning.reports.rowSub', { bets: t('learning.reports.bets', { count: item.settled }), roi: signedPct(item.roi), clv: signedPct(item.clv) })}
        </small>
      </span>
      <span className={cx('small', 'learning-rrow-sum', tone(profit) ?? 'muted')}>{formatMoney(item.profit, currencyOf(item.currency), { signed: true })}</span>
      <Icon name="chevronRight" />
    </button>
  );
}

export function ReportsTab({ summary, timeZone }: { summary: LearningSummary | null; timeZone: string }) {
  const { t } = useTranslation();
  const city = timeZoneName(t, timeZone);
  const [params, setParams] = useSearchParams();
  const list = useWeeklyReports();
  const items = list.data?.items ?? [];
  const latest = items[0] ?? null;
  const latestReport = useWeeklyReport(latest?.id ?? null);
  // отчет из ссылки уведомления (?report=ID): последний — карточкой, прошлый — окном
  const raw = params.get('report');
  const wanted = raw === null ? null : Number(raw);
  const valid = wanted !== null && Number.isSafeInteger(wanted) && wanted > 0;
  const openId = valid && wanted !== latest?.id ? wanted : null;
  // номер в ссылке не число — окно «не найден», а не молча последний отчет
  const badLink = raw !== null && !valid;
  const open = (id: number) => setParams((prev) => {
    const next = new URLSearchParams(prev);
    next.set('report', String(id));
    return next;
  });
  const panelRef = useRef<HTMLDivElement>(null);
  const close = () => {
    const closed = openId;
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('report');
      return next;
    });
    // окно по ссылке уведомления открыто без кнопки: фокус — на строку этого отчета в
    // «Прошлых неделях», а нет ее (чужой или удаленный отчет) — на вкладку
    requestAnimationFrame(() => {
      const row = panelRef.current?.querySelector<HTMLElement>(`[data-report="${closed ?? ''}"]`);
      if (row) row.focus();
      else panelRef.current?.focus({ preventScroll: true });
    });
  };
  const nextDay = list.data?.next_report ?? summary?.next_report ?? null;
  const hour = String(list.data?.report_hour ?? 7).padStart(2, '0');

  if (list.isPending) {
    return (
      <Card className="learning-card" title={t('learning.reports.title')}>
        <Skeleton lines={4} />
      </Card>
    );
  }
  if (!list.data) {
    return (
      <Card className="learning-card" title={t('learning.reports.title')}>
        <Callout kind="bad" icon="alert" role="alert">
          {errorMessage(list.error)}{' '}
          <Button kind="ghost" size="sm" icon="refresh" onClick={() => void list.refetch()}>
            {t('common.retry')}
          </Button>
        </Callout>
      </Card>
    );
  }
  if (!latest) {
    return (
      <Card className="learning-card" title={t('learning.reports.title')} subtitle={t('learning.reports.subtitle', { city })}>
        <EmptyState>{nextDay ? t('learning.reports.empty', { date: formatDate(nextDay) }) : t('learning.reports.emptyNoDate')}</EmptyState>
      </Card>
    );
  }
  const report = latestReport.data;
  const nextText = nextDay ? t('learning.reports.next', { date: formatDate(nextDay), hour }) : '';
  return (
    <div className="learning-panel" ref={panelRef} tabIndex={-1}>
      <Card
        className="learning-card"
        eyebrow={t('learning.reports.last')}
        title={t('learning.reports.week', { week: formatDateRange(latest.week_start, latest.week_end) })}
        subtitle={[t('learning.reports.came', { when: formatDateTime(latest.created_at, { calendar: false }), city }), nextText].filter(Boolean).join(' · ')}
        actions={
          <Button kind="ghost" size="sm" icon="sliders" to={{ pathname: paths.profile('notifications'), hash: '#profile-notif' }}>
            {t('learning.reports.setup')}
          </Button>
        }
      >
        {report ? (
          <ReportBlock report={report} />
        ) : latestReport.isError ? (
          <Callout kind="bad" icon="alert" role="alert">
            {errorMessage(latestReport.error)}
          </Callout>
        ) : (
          <Skeleton lines={4} />
        )}
      </Card>
      {items.length > 1 && (
        <Card className="learning-card" title={t('learning.reports.older')} subtitle={t('learning.reports.olderSub')}>
          <div className="learning-rlist">
            {items.slice(1).map((item) => (
              <OlderRow key={item.id} item={item} onOpen={() => open(item.id)} />
            ))}
          </div>
        </Card>
      )}
      {(openId !== null || badLink) && <ReportModal id={openId} onClose={close} />}
    </div>
  );
}
