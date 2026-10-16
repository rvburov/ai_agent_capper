import type { TFunction } from 'i18next';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { errorMessage } from '../../api/errors';
import { Button, Callout, Card, Chip, DataTable, EmptyState, Icon, Skeleton, useToast } from '../../components';
import { CalibrationChart, ChartWithTable, LineChart } from '../../components/charts';
import { useStrategy } from '../../features/analysis/api';
import { useExportSnapshots, useMlModel, useModelRollback, useRecalibrate } from '../../features/learning/model';
import type { MlModel, MlVersion, WalkForward } from '../../features/learning/types';
import { dec3, dec4, ecePct, reasonText, signed3, VERSION_CHIP } from '../../features/learning/versionView';
import { formatDate, formatDateTime, formatNumber, formatPp } from '../../lib/format';
import { MOBILE_QUERY, useMediaQuery } from '../../lib/useMediaQuery';

// Вкладка «Базовая модель» (mlPanel макета, Т13, Т17, В6): Эло по покрытиям + калибровка
// Платта, одна на всех. Полоса чисел активной версии, проверка по месяцам против рынка архива
// (walk-forward), калибровка, версии модели с «Вернуть» и «Перекалибровать» у администратора.
// Перекалибровка включается сама, если не хуже (решает сервер). Все числа — GET /api/ml/model.

/** Предел поправки Claude: 0.1 → «10 п.п.», 0.075 → «7,5 п.п.». */
function shiftText(shift: number): string {
  const whole = Math.abs(shift * 100 - Math.round(shift * 100)) < 1e-9;
  return formatPp(shift, { digits: whole ? 0 : 1, signed: false });
}

/**
 * Подписи месяца: short — ось графика в именительном падеже («май», а не «мая» из дат),
 * full — внутри фразы со строчной («апрель 2026»), cell — в начале ячейки таблицы.
 */
function monthLabels(month: string, t: TFunction): { short: string; full: string; cell: string } {
  const names: readonly string[] = t('costs.months', { returnObjects: true });
  const index = Number(month.slice(5, 7)) - 1;
  const name = names[index] ?? month;
  const full = `${name} ${month.slice(0, 4)}`;
  return { short: name.slice(0, 3), full, cell: `${full.charAt(0).toUpperCase()}${full.slice(1)}` };
}

function RuleCallout({ model }: { model: MlModel | undefined }) {
  const { t } = useTranslation();
  const shift = useStrategy().data?.params.claude_max_shift;
  const margins = model
    ? { brier: formatNumber(model.rule.brier_margin, 3, { signed: true }), ll: formatNumber(model.rule.log_loss_margin, 2, { signed: true }) }
    : { brier: formatNumber(0.005, 3, { signed: true }), ll: formatNumber(0.01, 2, { signed: true }) };
  return (
    <Callout kind="accent" icon="shield">
      <b>{t('learning.model.calloutStrong')}</b>
      {shift === undefined ? t('learning.model.calloutTextNoShift', margins) : t('learning.model.calloutText', { ...margins, shift: shiftText(shift) })}
    </Callout>
  );
}

function Strip({ model }: { model: MlModel }) {
  const { t } = useTranslation();
  const m = model.active;
  if (!m) return null;
  const cell = (key: string, label: string, value: string, sub: string) => (
    <div key={key}>
      <dt>{label}</dt>
      <dd>
        {value}
        <small>{sub}</small>
      </dd>
    </div>
  );
  return (
    <dl className="learning-strip">
      {cell('active', t('learning.model.strip.active'), formatDateTime(m.activated_at ?? m.created_at, { calendar: false }), t(m.auto ? 'learning.model.strip.auto' : 'learning.model.strip.manual'))}
      {cell('brier', t('learning.model.strip.brier'), dec4(m.brier), m.prev_brier !== null ? t('learning.model.strip.prev', { value: dec4(m.prev_brier) }) : t('learning.model.strip.noPrev'))}
      {cell('ece', t('learning.model.strip.ece'), ecePct(m.ece), t('learning.model.strip.eceSub'))}
      {cell('elo', t('learning.model.strip.elo'), t('learning.model.strip.eloValue'), t('learning.model.strip.eloSub'))}
      {cell('recal', t('learning.model.strip.recal'), t('learning.model.strip.recalValue'), t('learning.model.strip.recalNext', { date: formatDate(model.next_run) }))}
      {cell(
        'claude',
        t('learning.model.strip.claude'),
        t('learning.model.strip.claudeValue', { n: formatNumber(model.events_with_outcome), min: formatNumber(model.claude_min_events) }),
        t('learning.model.strip.claudeSub', { min: formatNumber(model.claude_min_events) }),
      )}
    </dl>
  );
}

function HeadCard({ model, admin, pending }: { model: MlModel | undefined; admin: boolean; pending: boolean }) {
  const { t } = useTranslation();
  const toast = useToast();
  const recal = useRecalibrate();
  const recalRef = useRef<HTMLButtonElement>(null);
  const active = model?.active ?? null;
  function run() {
    recal.mutate(undefined, {
      // пока идет запрос, кнопка недоступна и теряет фокус: после ответа — вернуть на нее
      onSettled: () => requestAnimationFrame(() => recalRef.current?.focus()),
      onSuccess: (result) => {
        const v = result.version;
        if (result.decision === 'activated' && v) {
          toast.show(t('learning.model.toastOn', { brier: dec4(v.brier), prev: dec4(v.prev_brier) }), { icon: 'check', duration: 6000 });
        } else if (result.decision === 'rejected') {
          toast.show(t('learning.model.toastRejected', { reason: reasonText(result.reason ?? v?.reason ?? 'other', t) }), { icon: 'alert', duration: 6000 });
        } else toast.show(t('learning.model.toastSkipped', { reason: reasonText(result.reason ?? 'other', t) }), { icon: 'info', duration: 6000 });
      },
      onError: (failure) => toast.show(errorMessage(failure), { icon: 'alert' }),
    });
  }
  const actions = (
    <>
      {active && (
        <Chip kind="good" icon="check">
          {t('learning.model.activeChip', { id: active.id })}
        </Chip>
      )}
      {admin ? (
        <Button ref={recalRef} kind="secondary" size="sm" icon="refresh" loading={recal.isPending} disabled={recal.isPending || !model} onClick={run}>
          {recal.isPending ? t('learning.model.recalibrating') : t('learning.model.recalibrate')}
        </Button>
      ) : (
        <Chip kind="outline" icon="admin">
          {t('learning.byAdmin')}
        </Chip>
      )}
    </>
  );
  let body;
  if (pending) body = <Skeleton lines={3} />;
  else if (model?.active) body = <Strip model={model} />;
  else body = <EmptyState>{t('learning.model.empty')}</EmptyState>;
  return (
    <Card className="learning-card" eyebrow={t('learning.model.eyebrow')} title={t('learning.model.title')} subtitle={t('learning.model.subtitle')} actions={actions}>
      {body}
      {recal.isPending && (
        <p className="small soft" aria-live="polite">
          {t('learning.model.recalNote')}
        </p>
      )}
      <RuleCallout model={model} />
    </Card>
  );
}

function WalkForwardCard({ rows, mobile }: { rows: WalkForward[]; mobile: boolean }) {
  const { t } = useTranslation();
  const labels = rows.map((row) => monthLabels(row.month, t));
  const withBoth = rows.filter((row) => row.model_brier !== null && row.market_brier !== null);
  const first = withBoth[0];
  const last = withBoth[withBoth.length - 1];
  const ns = rows.map((row) => row.n).filter((n) => n > 0);
  const legend = [
    { key: 'model', name: t('learning.model.wf.model'), color: 'var(--s1)' },
    { key: 'market', name: t('learning.model.wf.market'), color: 'var(--s2)' },
  ];
  return (
    <Card className="learning-card" title={t('learning.model.wf.title')} subtitle={t('learning.model.wf.subtitle')}>
      <ChartWithTable
        legend={legend}
        empty={rows.length ? undefined : t('learning.model.wf.empty')}
        table={() => (
          <DataTable
            mobileLayout="table"
            caption={t('learning.model.wf.title')}
            rows={rows}
            rowKey={(row) => row.month}
            columns={[
              { key: 'month', label: t('learning.model.wf.cols.month'), render: (row) => monthLabels(row.month, t).cell },
              { key: 'n', label: t('learning.model.wf.cols.n'), align: 'r', render: (row) => formatNumber(row.n) },
              { key: 'model', label: t('learning.model.wf.cols.model'), align: 'r', render: (row) => dec3(row.model_brier) },
              { key: 'market', label: t('learning.model.wf.cols.market'), align: 'r', render: (row) => dec3(row.market_brier) },
            ]}
          />
        )}
      >
        <LineChart
          labels={labels.map((label) => label.short)}
          series={[
            { key: 'model', name: legend[0]!.name, color: 'var(--s1)', values: rows.map((row) => row.model_brier) },
            { key: 'market', name: legend[1]!.name, color: 'var(--s2)', values: rows.map((row) => row.market_brier) },
          ]}
          ariaLabel={t('learning.model.wf.aria')}
          height={mobile ? 200 : 230}
          yFormat={(value) => dec3(value)}
          tipTitle={(_label, index) => t('learning.model.wf.tip', { month: labels[index]?.cell ?? '', matches: t('learning.plural.matches', { count: rows[index]?.n ?? 0, n: formatNumber(rows[index]?.n ?? 0) }) })}
        />
      </ChartWithTable>
      {first && last && (
        <p className="learning-hint">
          <Icon name="info" />
          <span>
            {t('learning.model.wf.hint', {
              from: signed3((first.model_brier ?? 0) - (first.market_brier ?? 0)),
              fromMonth: labels[rows.indexOf(first)]?.full ?? '',
              to: signed3((last.model_brier ?? 0) - (last.market_brier ?? 0)),
              toMonth: labels[rows.indexOf(last)]?.full ?? '',
              min: formatNumber(Math.min(...ns)),
              max: formatNumber(Math.max(...ns)),
            })}
          </span>
        </p>
      )}
    </Card>
  );
}

function CalibrationCard({ model, mobile }: { model: MlModel; mobile: boolean }) {
  const { t } = useTranslation();
  const bins = model.calibration;
  return (
    <Card className="learning-card" title={t('learning.model.calib.title')} subtitle={t('learning.model.calib.subtitle')}>
      <ChartWithTable
        empty={bins.length ? undefined : t('learning.model.calib.empty')}
        table={() => (
          <DataTable
            mobileLayout="table"
            caption={t('learning.model.calib.title')}
            rows={bins}
            rowKey={(bin) => String(bin.low)}
            columns={[
              { key: 'range', label: t('learning.model.calib.cols.range'), render: (bin) => `${formatNumber(bin.low * 100)}–${formatNumber(bin.high * 100)}%` },
              { key: 'n', label: t('learning.model.calib.cols.n'), align: 'r', render: (bin) => formatNumber(bin.n) },
              { key: 'p', label: t('learning.model.calib.cols.p'), align: 'r', render: (bin) => `${formatNumber(bin.p * 100, 1)}%` },
              { key: 'actual', label: t('learning.model.calib.cols.actual'), align: 'r', render: (bin) => `${formatNumber(bin.actual * 100, 1)}%` },
            ]}
          />
        )}
      >
        <CalibrationChart
          bins={bins.map((bin) => ({ key: String(bin.low), lo: bin.low, hi: bin.high, p: bin.p, actual: bin.actual, n: bin.n, ci: [bin.ci_low, bin.ci_high] as const }))}
          ariaLabel={t('learning.model.calib.aria')}
          domain={[0.5, 1]}
          height={mobile ? 240 : 250}
        />
      </ChartWithTable>
      <p className="learning-hint">
        <Icon name="info" />
        <span>{t('learning.model.calib.hint')}</span>
      </p>
    </Card>
  );
}

function versionLine(version: MlVersion, t: TFunction): string {
  const parts = [
    formatDateTime(version.activated_at ?? version.created_at, { calendar: false }),
    t('learning.model.versions.brier', { value: dec4(version.brier) }),
    t('learning.model.versions.logLoss', { value: dec3(version.log_loss) }),
  ];
  if (version.status === 'rejected' && version.reason) parts.push(reasonText(version.reason, t));
  return parts.join(' · ');
}

function VersionsCard({ model, admin }: { model: MlModel; admin: boolean }) {
  const { t } = useTranslation();
  const toast = useToast();
  const rollback = useModelRollback();
  return (
    <Card className="learning-card" title={t('learning.model.versions.title')} subtitle={t('learning.model.versions.subtitle')}>
      {model.versions.length ? (
        <div className="learning-rows">
          {model.versions.map((version) => {
            const chip = VERSION_CHIP[version.status];
            return (
              <div key={version.id} className="learning-row">
                <div className="learning-min">
                  <div className="mono learning-model-id">{version.id}</div>
                  <div className="xsmall muted">{versionLine(version, t)}</div>
                </div>
                <div className="learning-row-side">
                  <Chip kind={chip.kind} icon={chip.icon}>
                    {t(`learning.model.status.${version.status}`)}
                  </Chip>
                  {admin && version.can_rollback && (
                    <Button
                      kind="ghost"
                      size="sm"
                      icon="history"
                      aria-label={t('learning.model.versions.rollbackLabel', { id: version.id })}
                      loading={rollback.isPending && rollback.variables === version.id}
                      onClick={() =>
                        rollback.mutate(version.id, {
                          onSuccess: () => toast.show(t('learning.model.toastRollback', { id: version.id, brier: dec4(version.brier) }), { icon: 'history' }),
                          onError: (failure) => toast.show(errorMessage(failure), { icon: 'alert' }),
                        })
                      }
                    >
                      {t('learning.model.versions.rollback')}
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="small muted">{t('learning.model.versions.empty')}</p>
      )}
    </Card>
  );
}

/** Набор для учебного трека (администратор, В9): снимки матчей в JSONL. */
function ExportCard() {
  const { t } = useTranslation();
  const toast = useToast();
  const exporter = useExportSnapshots();
  const [error, setError] = useState<string | null>(null);
  function run() {
    setError(null);
    exporter.mutate(undefined, {
      onSuccess: (name) => toast.show(t('learning.model.export.done', { name }), { icon: 'download' }),
      onError: (failure) => setError(errorMessage(failure)),
    });
  }
  return (
    <Card
      className="learning-card"
      title={t('learning.model.export.title')}
      subtitle={t('learning.model.export.subtitle')}
      actions={
        <Button kind="secondary" size="sm" icon="download" loading={exporter.isPending} onClick={run}>
          {t('learning.model.export.button')}
        </Button>
      }
    >
      <p className="small soft">{t('learning.model.export.text')}</p>
      {error && (
        <Callout kind="bad" icon="alert" role="alert">
          {error}
        </Callout>
      )}
    </Card>
  );
}

export function ModelTab({ admin }: { admin: boolean }) {
  const { t } = useTranslation();
  const mobile = useMediaQuery(MOBILE_QUERY);
  const query = useMlModel();
  const model = query.data;
  return (
    <div className="learning-panel">
      <HeadCard model={model} admin={admin} pending={query.isPending} />
      {query.isError && !model && (
        <Callout kind="bad" icon="alert" role="alert">
          {errorMessage(query.error)}{' '}
          <Button kind="ghost" size="sm" icon="refresh" onClick={() => void query.refetch()}>
            {t('common.retry')}
          </Button>
        </Callout>
      )}
      {model?.active && (
        <>
          <div className="learning-two">
            <WalkForwardCard rows={model.walk_forward} mobile={mobile} />
            <CalibrationCard model={model} mobile={mobile} />
          </div>
          {admin ? (
            <div className="learning-two">
              <VersionsCard model={model} admin={admin} />
              <ExportCard />
            </div>
          ) : (
            <VersionsCard model={model} admin={admin} />
          )}
        </>
      )}
    </div>
  );
}
