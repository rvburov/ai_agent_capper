import type { TFunction } from 'i18next';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { paths } from '../../app/paths';
import { Button, Card, Chip, Icon, KeyValue, Modal, type IconName } from '../../components';
import type { StrategyParams } from '../../features/bank/types';
import type { Bank } from '../../features/bank/types';
import { actingNowText, adminTodo, bankStateText, RULE_CHIP, ruleRows, type RuleRow } from '../../features/dashboard/display';
import { missingInArchive } from '../../features/bets/display';
import type { AdminAttention, ArchiveStale, OpenBet } from '../../features/dashboard/types';
import { formatDate, formatDateLong, formatTime, formatUsd } from '../../lib/format';
import { cx } from '../../lib/cx';
import { DATA_UPDATE_CLI } from '../../lib/terminal';

// «Требует внимания» (attentionCard макета): у всех — «Размер ставки» (адаптации Р22 и их
// статус, В7); у администратора — архив матчей и дела (просьбы ключа, участники у лимита).

interface Item {
  key: string;
  tone: 'warn' | 'info' | 'accent';
  icon: IconName;
  /** Для читалки экрана: «Предупреждение», «Нужно решение». */
  sr: string;
  title: string;
  text: ReactNode;
  action: ReactNode;
  wide?: boolean;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Текст карточки архива: дата последней загрузки или сколько архивов не загружалось ни разу. */
function archiveText(archive: ArchiveStale, t: TFunction): string {
  if (archive.last_load) return t('dashboard.archive.text', { date: formatDate(archive.last_load, { timeZone: 'UTC' }) });
  const never = archive.sources.filter((source) => !source.last_load).length;
  if (never >= archive.sources.length) return t('dashboard.archive.textNeverAll');
  return never === 1 ? t('dashboard.archive.textNever') : t('dashboard.archive.textNeverSome');
}

function ArchiveModal({ archive, onClose }: { archive: ArchiveStale; onClose: () => void }) {
  const { t } = useTranslation();
  const nightly = `${pad(archive.update_hour_utc)}:${pad(archive.update_minute)}`;
  const last = archive.last_load
    ? t('dashboard.archive.lastLoad', { date: formatDateLong(archive.last_load, { timeZone: 'UTC' }), time: formatTime(archive.last_load, { timeZone: 'UTC' }) })
    : t('dashboard.archive.neverLoaded');
  return (
    <Modal
      open
      onClose={onClose}
      title={t('dashboard.archive.modalTitle')}
      footer={
        <Button kind="primary" onClick={onClose}>
          {t('dashboard.archive.ok')}
        </Button>
      }
    >
      <p className="small soft">{t('dashboard.archive.nightly', { time: nightly, last })}</p>
      <KeyValue
        items={[
          ...archive.sources.map((source) => ({
            key: source.source,
            label: t(`dashboard.archive.source.${source.source}`),
            value: source.last_load ? formatDate(source.last_load, { timeZone: 'UTC' }) : t('dashboard.archive.never'),
          })),
          {
            key: 'stale',
            label: t('dashboard.archive.staleLabel'),
            // «после этой даты» — только когда дата последней загрузки есть на экране
            value: archive.last_load ? t('dashboard.archive.staleValue') : t('dashboard.archive.staleValueNever'),
          },
          { key: 'works', label: t('dashboard.archive.worksLabel'), value: t('dashboard.archive.worksValue') },
          { key: 'manual', label: t('dashboard.archive.manualLabel'), value: <code className="dashboard-code">{DATA_UPDATE_CLI}</code> },
        ]}
      />
      <p className="xsmall muted">{t('dashboard.archive.notice', { count: archive.stale_after_days })}</p>
    </Modal>
  );
}

function RulesText({ bank, rows }: { bank: Bank; rows: RuleRow[] }) {
  const { t } = useTranslation();
  const acting = rows.filter((row) => row.status === 'acting');
  const off = rows.filter((row) => row.status === 'off');
  const state = bankStateText(bank, t);
  const now = acting.length ? actingNowText(acting, t) : t('dashboard.attention.rules.byTable');
  return (
    <>
      {/* банка еще нет — одно предложение без «Сегодня суммы — по таблице» */}
      <span>{bank.empty ? state : t('dashboard.attention.rules.state', { state, now })}</span>
      <ul className="dashboard-rules" aria-label={t('dashboard.attention.rules.listLabel')}>
        {rows.map((row) => {
          const chip = RULE_CHIP[row.status];
          return (
            <li key={row.key}>
              <span className="dashboard-rule-name">
                {row.label}
                <small>{row.effect}</small>
              </span>
              <Chip kind={chip.kind} icon={chip.icon}>
                {t(`dashboard.attention.rules.status.${row.status}`)}
              </Chip>
            </li>
          );
        })}
      </ul>
      {off.length > 0 && (
        <span className="dashboard-rule-note">
          <Icon name="info" />
          <span>
            <b>{t('dashboard.attention.rules.offTitle')}</b>{' '}
            {t('dashboard.attention.rules.offText', {
              rules: off.map((row) => t('dashboard.attention.rules.quoted', { name: row.label.toLowerCase() })).join(t('dashboard.attention.rules.and')),
              tail: off.some((row) => row.met) ? t('dashboard.attention.rules.wouldAct') : t('dashboard.attention.rules.wouldNot'),
            })}
          </span>
        </span>
      )}
    </>
  );
}

/**
 * Ставки ждут результата (этап 5, В1): матчи сыграны, а исхода в архиве tennis-data еще нет.
 * Даты архива и следующего файла — у первой такой ставки из открытых (сервер, по поясу
 * участника); архив уже дальше дня матча, а исхода нет — ставка сама не рассчитается.
 */
function awaitingText(bet: OpenBet | null, t: TFunction): string {
  if (bet && missingInArchive(bet)) return t('dashboard.attention.awaiting.textMissing', { to: formatDate(bet.archive_matches_to) });
  if (bet?.archive_matches_to && bet.next_upload) {
    return t('dashboard.attention.awaiting.text', { to: formatDate(bet.archive_matches_to), next: formatDate(bet.next_upload) });
  }
  if (bet?.archive_matches_to) return t('dashboard.attention.awaiting.textNoNext', { to: formatDate(bet.archive_matches_to) });
  return t('dashboard.attention.awaiting.textPlain');
}

/** Решения администратора по обучению: кандидат инструкций и уроки, готовые к проверке. */
export interface LearningDecisions {
  /** Код кандидата инструкций, который ждет решения («v4»). */
  candidate: string | null;
  /** Коды уроков, готовых к быстрой проверке и решению. */
  ready: readonly string[];
  /** Цена быстрой проверки (≈ $), с сервера; нет — текст без цены. */
  quickPrice?: number | null;
}

function learningTitle(decisions: LearningDecisions, t: TFunction): string {
  const parts: string[] = [];
  if (decisions.candidate) parts.push(t('dashboard.attention.learning.candidate', { code: decisions.candidate }));
  if (decisions.ready.length) parts.push(t('dashboard.attention.learning.ready', { count: decisions.ready.length, codes: decisions.ready.join(', ') }));
  return t('dashboard.attention.learning.title', { what: parts.join(', ') });
}

function learningText(decisions: LearningDecisions, t: TFunction): string {
  const parts: string[] = [];
  if (decisions.candidate) parts.push(t('dashboard.attention.learning.candidateText', { code: decisions.candidate }));
  if (decisions.ready.length) {
    const price = decisions.quickPrice;
    parts.push(
      price === null || price === undefined
        ? t('dashboard.attention.learning.readyText')
        : t('dashboard.attention.learning.readyTextPrice', { price: formatUsd(price) }),
    );
  }
  return parts.join(' ');
}

interface AttentionProps {
  bank: Bank;
  params: StrategyParams | null;
  admin: AdminAttention | null;
  /** Сколько открытых ставок ждут результата (GET /api/dashboard) и первая из них. */
  awaiting: { count: number; bet: OpenBet | null };
  /** Решения по обучению — только администратору (В5); null — ждать нечего. */
  learning: LearningDecisions | null;
}

export function Attention({ bank, params, admin, awaiting, learning }: AttentionProps) {
  const { t } = useTranslation();
  const [archiveOpen, setArchiveOpen] = useState(false);
  const items: Item[] = [];
  if (awaiting.count > 0) {
    items.push({
      key: 'awaiting',
      tone: 'warn',
      icon: 'clock',
      sr: t('dashboard.attention.srAwaiting'),
      title: t('dashboard.attention.awaiting.title', { count: awaiting.count }),
      text: awaitingText(awaiting.bet, t),
      action: (
        <Button size="sm" icon="edit" to={awaiting.bet ? `${paths.bets}?bet=${awaiting.bet.id}` : `${paths.bets}?status=open`} ro>
          {t('dashboard.attention.awaiting.settle')}
        </Button>
      ),
    });
  }
  const archive = admin?.archive ?? null;
  if (archive) {
    items.push({
      key: 'archive',
      tone: 'warn',
      icon: 'database',
      sr: t('dashboard.attention.srWarn'),
      title: archive.days === null ? t('dashboard.archive.titleNever') : t('dashboard.archive.title', { count: archive.days }),
      text: archiveText(archive, t),
      action: (
        <Button size="sm" icon="info" onClick={() => setArchiveOpen(true)}>
          {t('dashboard.archive.what')}
        </Button>
      ),
    });
  }
  if (learning && (learning.candidate || learning.ready.length)) {
    items.push({
      key: 'learning',
      tone: 'accent',
      icon: 'brain',
      sr: t('dashboard.attention.srDecision'),
      title: learningTitle(learning, t),
      text: learningText(learning, t),
      action: (
        <Button size="sm" iconRight="chevronRight" to={paths.learning(learning.candidate ? 'versions' : 'lessons')}>
          {t('dashboard.attention.learning.open')}
        </Button>
      ),
    });
  }
  const todo = admin ? adminTodo(admin, t) : [];
  if (todo.length) {
    items.push({
      key: 'admin',
      tone: 'info',
      icon: 'admin',
      sr: t('dashboard.attention.srDecision'),
      title: t('dashboard.attention.admin.title', { count: todo.length }),
      text: todo.join(' '),
      action: (
        <Button size="sm" iconRight="chevronRight" to={paths.admin('users')}>
          {t('dashboard.attention.admin.open')}
        </Button>
      ),
    });
  }
  const rows = ruleRows(bank, params, t);
  const acting = rows.some((row) => row.status === 'acting');
  items.push({
    key: 'rules',
    tone: acting ? 'warn' : 'info',
    icon: 'shield',
    sr: acting ? t('dashboard.attention.srWarn') : t('dashboard.attention.srInfo'),
    title: acting ? t('dashboard.attention.rules.titleActing') : t('dashboard.attention.rules.titleCalm'),
    text: <RulesText bank={bank} rows={rows} />,
    action: (
      <Button size="sm" iconRight="chevronRight" to={paths.profile('bank')}>
        {t('dashboard.attention.rules.open')}
      </Button>
    ),
    wide: true,
  });
  return (
    <Card
      className="dashboard-card dashboard-attn-card"
      title={t('dashboard.attention.title')}
      subtitle={t('dashboard.attention.subtitle', {
        count: items.length,
        what: admin
          ? t('dashboard.attention.whatAdmin')
          : awaiting.count > 0
            ? t('dashboard.attention.whatMemberBets')
            : t('dashboard.attention.whatMember'),
      })}
    >
      <ul className="dashboard-alerts">
        {items.map((item) => (
          <li key={item.key} className={cx('dashboard-alert', item.wide && 'is-wide')}>
            <div className={cx('dashboard-alert-ic', item.tone)} aria-hidden="true">
              <Icon name={item.icon} />
            </div>
            <div className="dashboard-alert-body">
              <div className="dashboard-alert-title">
                <span className="sr-only">{item.sr}. </span>
                {item.title}
              </div>
              <div className="dashboard-alert-text">{item.text}</div>
              {item.action}
            </div>
          </li>
        ))}
      </ul>
      {archive && archiveOpen && <ArchiveModal archive={archive} onClose={() => setArchiveOpen(false)} />}
    </Card>
  );
}
