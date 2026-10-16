import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { paths } from '../../app/paths';
import { Card, Chip, DataTable, Icon, type ChipKind, type IconName } from '../../components';
import { modelLabel } from '../../features/ai/models';
import type { AgentSettings, AiUsage, Saving } from '../../features/costs/types';
import { formatInterval, formatNumber, formatUsd } from '../../lib/format';
import { Howto } from './Blocks';
import type { Period } from './Hero';

// «Где экономим» и «До и после» (savingsCard и beforeAfterCard макета costs.js, этап 5): мера
// экономии включается, только если на замороженном наборе качество не хуже с допуском (правило
// экономии TOKEN_ECONOMY 2.4). Меры, их статус, токены, цены и экономию в месяц считает
// сервер (GET /api/ai/usage: savings, before_after); экран только рисует.

interface Measure {
  key: string;
  icon: IconName;
  title: string;
  text: string;
  save: string;
  chip: { kind: ChipKind; icon: IconName; text: string };
  link?: boolean;
}

const signed3 = (value: number) => formatNumber(value, 3, { signed: true });
const ci3 = (low: number | null | undefined, high: number | null | undefined) => formatInterval(low, high, signed3);
const tokensText = (value: number | null | undefined, t: TFunction) =>
  value === null || value === undefined ? '—' : t('costs.before.tokensValue', { n: formatNumber(value / 1000, 1) });
const pct = (value: number | null) => (value === null ? '—' : `${formatNumber(value * 100, 0, { signed: true })}%`);

function statusChip(saving: Saving, admin: boolean, t: TFunction): Measure['chip'] {
  if (saving.status === 'on') return { kind: 'good', icon: 'check', text: t('costs.savings.on') };
  if (saving.status === 'waiting') {
    if (saving.passed === false) return { kind: 'bad', icon: 'x', text: t('costs.savings.failed') };
    if (saving.passed === null) return { kind: 'outline', icon: 'flask', text: t('costs.savings.notChecked') };
    return { kind: 'accent', icon: 'clock', text: admin ? t('costs.savings.waitsYou') : t('costs.savings.waits') };
  }
  if (saving.status === 'off') return { kind: 'outline', icon: 'pause', text: t('costs.savings.off') };
  return { kind: 'outline', icon: 'flask', text: t('costs.savings.notChecked') };
}

/** Мера с сервера словами. */
export function measureOf(saving: Saving, admin: boolean, t: TFunction): Measure {
  const chip = statusChip(saving, admin, t);
  if (saving.kind === 'version') {
    const set = saving.eval_set_code ?? '—';
    let text: string;
    if (saving.passed === null) text = t('costs.savings.versionNoRun');
    else if (saving.passed)
      text = t(saving.status === 'on' ? 'costs.savings.versionOn' : 'costs.savings.versionPassed', {
        tokens: pct(saving.tokens_change),
        cost: pct(saving.cost_change),
        set,
        ci: ci3(saving.log_loss?.low, saving.log_loss?.high),
      });
    else text = t('costs.savings.versionFailed', { tokens: pct(saving.tokens_change), set });
    return {
      key: `v${saving.version_id ?? ''}`,
      icon: 'layers',
      // имя версии с кодом («v4 · сжатое досье»), нет имени — код
      title: t('costs.savings.versionTitle', { code: saving.version_name ?? saving.version_code ?? '—' }),
      text,
      save: saving.month_forecast_usd !== null ? t('costs.savings.saveMonth', { amount: formatUsd(saving.month_forecast_usd) }) : t('costs.savings.saveTokens', { tokens: pct(saving.tokens_change) }),
      chip,
      link: saving.status === 'waiting',
    };
  }
  if (saving.kind === 'postmortem_batch') {
    const per =
      saving.per_run_usd !== null && saving.per_run_without_usd !== null
        ? t('costs.savings.batchSave', { amount: formatUsd(saving.per_run_usd), without: formatUsd(saving.per_run_without_usd) })
        : t('costs.savings.batchSavePlain');
    return {
      key: 'postmortem',
      icon: 'clock',
      title: t('costs.savings.batchTitle'),
      text: t('costs.savings.batchText', { model: saving.model ? modelLabel(saving.model) : t('costs.savings.sonnet') }),
      save: saving.month_usd !== null ? `${per} · ${t('costs.savings.savedMonth', { amount: formatUsd(saving.month_usd) })}` : per,
      chip,
    };
  }
  return {
    key: 'cache',
    icon: 'database',
    title: t('costs.savings.cacheTitle'),
    text: t('costs.savings.cacheText'),
    save: saving.month_usd !== null ? t('costs.savings.savedMonth', { amount: formatUsd(saving.month_usd) }) : '—',
    chip,
  };
}

export function SavingsCard({ usage, settings, admin, period }: { usage: AiUsage; settings: AgentSettings; admin: boolean; period: Period }) {
  const { t } = useTranslation();
  const items: Measure[] = [
    ...usage.savings.map((saving) => measureOf(saving, admin, t)),
    // меры, которых на наборе еще не проверяли: модель и effort меняются только настройкой
    {
      key: 'sonnet',
      icon: 'flask',
      title: t('costs.savings.sonnetTitle'),
      text: t('costs.savings.sonnetText', { model: modelLabel(settings.analysis_model) }),
      save: t('costs.savings.sonnetSave'),
      chip: { kind: 'outline', icon: 'flask', text: t('costs.savings.notChecked') },
    },
    {
      key: 'effort',
      icon: 'sliders',
      title: t('costs.savings.effortTitle'),
      text: t('costs.savings.effortText', { effort: settings.analysis_effort }),
      save: '—',
      chip: { kind: 'outline', icon: 'flask', text: t('costs.savings.notChecked') },
    },
  ];
  return (
    <Card className="costs-card costs-o-3" title={t('costs.savings.title')} subtitle={t('costs.savings.subtitle')}>
      <ul className="costs-later">
        {items.map((item) => (
          <li key={item.key}>
            <span className="costs-later-ic">
              <Icon name={item.icon} />
            </span>
            <span className="costs-min">
              <span className="costs-saving-head">
                <b>{item.title}</b>
                <Chip kind={item.chip.kind} icon={item.chip.icon}>
                  {item.chip.text}
                </Chip>
              </span>
              <span>{item.text}</span>
              <span className="xsmall muted costs-saving-save">{t('costs.savings.save', { value: item.save })}</span>
              {item.link && (
                <Link className="small" to={paths.learning('versions')}>
                  {t('costs.savings.compareLink')}
                </Link>
              )}
            </span>
          </li>
        ))}
      </ul>
      <Howto>{t('costs.savings.howto', { period: period.short })}</Howto>
    </Card>
  );
}

/**
 * «До и после»: та же оценка матча до и после изменения инструкций на одних и тех же матчах
 * набора (before_after сервера: действующая против кандидата или прежняя против действующей).
 * Со старым ботом не сравниваем: его логов нет. Пары нет — карточки нет.
 */
export function BeforeAfterCard({ usage }: { usage: AiUsage }) {
  const { t } = useTranslation();
  const pair = usage.before_after;
  if (!pair) return null;
  const a = pair.before;
  const b = pair.after;
  const usd3 = (value: number | null) => (value === null ? '—' : formatUsd(value, 3));
  // цена обеих версий — на одной основе (price_source сервера): прогоны на наборе через Batch
  // или ваши вызовы за месяц; основы нет — цену не сравниваем, строки нет
  const source = pair.price_source;
  const rows = [
    ...(source ? [{ key: 'cost', label: t(`costs.before.cost_${source}`), a: usd3(a.price_usd), b: usd3(b.price_usd) }] : []),
    { key: 'tokens', label: t('costs.before.tokens'), a: tokensText(a.eval.tokens_per_event, t), b: tokensText(b.eval.tokens_per_event, t) },
    { key: 'll', label: t('costs.before.logLoss'), a: formatNumber(a.eval.log_loss, 3), b: formatNumber(b.eval.log_loss, 3) },
    { key: 'brier', label: t('costs.before.brier'), a: formatNumber(a.eval.brier, 3), b: formatNumber(b.eval.brier, 3) },
    { key: 'format', label: t('costs.before.format'), a: formatNumber(a.eval.format_errors), b: formatNumber(b.eval.format_errors) },
  ];
  const verdict = pair.comparison?.verdict ?? null;
  return (
    <Card
      className="costs-card costs-o-5"
      title={t('costs.before.title')}
      subtitle={t(b.status === 'candidate' ? 'costs.before.subtitleCandidate' : 'costs.before.subtitle', { a: a.code, b: b.code, n: formatNumber(b.eval.n) })}
    >
      <DataTable
        className="costs-ver"
        mobileLayout="table"
        caption={t('costs.before.title')}
        rows={rows}
        rowKey={(row) => row.key}
        columns={[
          { key: 'k', label: t('costs.before.cols.metric'), render: (row) => row.label },
          { key: 'a', label: t('costs.before.cols.before', { code: a.code }), align: 'r', render: (row) => row.a },
          { key: 'b', label: t('costs.before.cols.after', { code: b.code }), align: 'r', render: (row) => <b>{row.b}</b> },
        ]}
      />
      <Howto>
        {verdict ? `${t(`costs.before.verdict.${verdict}`, { a: a.code, b: b.code })} ` : ''}
        {t(source === 'live' ? 'costs.before.howtoLive' : 'costs.before.howto')}
      </Howto>
    </Card>
  );
}
