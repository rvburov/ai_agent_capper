import { useState, type ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { errorMessage } from '../../api/errors';
import type { Me } from '../../api/hooks/useMe';
import { Button, Card, Chip, Meter, spendTone, useToast } from '../../components';
import { spendMonth } from '../../features/admin/display';
import { formatLimitUsd, limitText } from '../../features/admin/limits';
import { personName } from '../../features/admin/people';
import type { AdminLimits, MemberLimit } from '../../features/admin/types';
import { useUpdateMemberLimit } from '../../features/admin/useAdminAi';
import { cx } from '../../lib/cx';
import { formatPercent, formatUsd } from '../../lib/format';
import { useMediaQuery } from '../../lib/useMediaQuery';
import { DefaultsModal, LimitModal } from './LimitDialogs';
import { NARROW_QUERY } from './media';
import { HowTo } from './parts';

/** Личный лимит на ключе администратора есть только у участника на этом ключе (limitOf макета). */
export function memberLimitOf(member: MemberLimit) {
  return member.role === 'member' && member.ai_mode === 'shared' ? member.limit : null;
}

/** Расход дошел до порога уведомления (или до 100%): такие строки подсвечиваются (flash макета). */
function atThreshold(member: MemberLimit, alertPct: number | null): boolean {
  const limit = memberLimitOf(member);
  return limit !== null && spendTone(member.spent_month_usd, limit.monthly_usd, alertPct ?? 100) !== null;
}

/** Порядок как в макете: сначала вы, участники на своем ключе — в конце. */
function sortRows(members: readonly MemberLimit[], meId: number): MemberLimit[] {
  return [...members].sort(
    (a, b) =>
      Number(b.id === meId) - Number(a.id === meId) || Number(a.ai_mode === 'own') - Number(b.ai_mode === 'own'),
  );
}

type Dialog = { kind: 'limit'; member: MemberLimit } | { kind: 'defaults' } | null;

interface LimitsCardProps {
  me: Me;
  limits: AdminLimits;
  /** Порог уведомления, %; пока бюджет не загружен — null (полоса без желтого). */
  alertPct: number | null;
  /** Переход из уведомления о расходе: подсветить участников у порога. */
  flash?: boolean;
}

/**
 * «Лимиты участников» (limitsCard макета): лимиты по умолчанию, таблица на компьютере и карточки
 * до 1280 px, пауза анализов переключателем, окно лимита. Свой ключ — только посмотреть.
 */
export function LimitsCard({ me, limits, alertPct, flash = false }: LimitsCardProps) {
  const { t } = useTranslation();
  const narrow = useMediaQuery(NARROW_QUERY);
  const [dialog, setDialog] = useState<Dialog>(null);
  const rows = sortRows(limits.members, me.id);
  const month = spendMonth();
  const editLimit = (member: MemberLimit) => setDialog({ kind: 'limit', member });

  return (
    <Card
      id="adm-limits"
      className="adm-anchor"
      title={t('admin.key.limits.title')}
      subtitle={t('admin.key.limits.subtitle', { month })}
    >
      <div className="adm-defaults">
        <div className="adm-min0">
          <div className="eyebrow">{t('admin.key.limits.defaults')}</div>
          <div className="adm-defaults-v">{limitText(limits.defaults)}</div>
        </div>
        <Button size="sm" icon="edit" aria-label={t('admin.key.limits.defaultsEdit')} onClick={() => setDialog({ kind: 'defaults' })}>
          {t('admin.key.edit')}
        </Button>
      </div>
      {narrow ? (
        <div className="adm-lcards">
          {rows.map((member) => (
            <LimitCardItem key={member.id} member={member} me={me} alertPct={alertPct} flash={flash} onEdit={editLimit} />
          ))}
        </div>
      ) : (
        <LimitsTable rows={rows} me={me} alertPct={alertPct} flash={flash} onEdit={editLimit} />
      )}
      <HowTo>{t('admin.key.limits.ownNote')}</HowTo>
      {dialog?.kind === 'limit' && (
        <LimitModal member={dialog.member} members={limits.members} meId={me.id} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'defaults' && <DefaultsModal defaults={limits.defaults} onClose={() => setDialog(null)} />}
    </Card>
  );
}

interface RowProps {
  me: Me;
  alertPct: number | null;
  flash: boolean;
  onEdit: (member: MemberLimit) => void;
}

function LimitsTable({ rows, me, alertPct, flash, onEdit }: RowProps & { rows: readonly MemberLimit[] }) {
  const { t } = useTranslation();
  return (
    <div className="table-wrap adm-bleed">
      <table className="table adm-limits-table">
        <caption className="sr-only">{t('admin.key.limits.caption')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('admin.key.limits.columns.person')}</th>
            <th scope="col" className="r">
              {t('admin.key.limits.columns.monthly')}
            </th>
            <th scope="col" className="r">
              {t('admin.key.limits.columns.daily')}
            </th>
            <th scope="col" className="r">
              {t('admin.key.limits.columns.per')}
            </th>
            <th scope="col">{t('admin.key.limits.columns.spent')}</th>
            <th scope="col">{t('admin.key.limits.columns.pause')}</th>
            <th scope="col" className="r">
              <span className="sr-only">{t('admin.key.limits.columns.actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((member) => {
            const limit = memberLimitOf(member);
            const spend = <LimitSpend member={member} alertPct={alertPct} />;
            if (member.ai_mode === 'own') {
              return (
                <tr key={member.id}>
                  <td>
                    <NameCell member={member} me={me} />
                  </td>
                  <td colSpan={2} className="adm-muted-cell">
                    {t('admin.key.limits.own')}
                  </td>
                  <td className="r">
                    <OwnCapCell member={member} />
                  </td>
                  <td>{spend}</td>
                  <td className="adm-muted-cell">—</td>
                  <td />
                </tr>
              );
            }
            if (!limit) {
              return (
                <tr key={member.id}>
                  <td>
                    <NameCell member={member} me={me} />
                  </td>
                  <td colSpan={3} className="adm-muted-cell">
                    {t('admin.key.limits.noLimit')}
                  </td>
                  <td>{spend}</td>
                  <td className="adm-muted-cell">—</td>
                  <td />
                </tr>
              );
            }
            return (
              <tr key={member.id} className={cx(flash && atThreshold(member, alertPct) && 'adm-flash')}>
                <td>
                  <NameCell member={member} me={me} />
                </td>
                <td className="r mono">{formatLimitUsd(limit.monthly_usd)}</td>
                <td className="r mono">{limit.daily_analyses}</td>
                <td className="r mono">{formatLimitUsd(limit.per_analysis_usd)}</td>
                <td>{spend}</td>
                <td>
                  <PauseSwitch member={member} paused={limit.paused} id={`adm-pause-${member.id}`} />
                </td>
                <td className="r">
                  {member.id !== me.id && <EditButton member={member} onEdit={onEdit} />}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Карточка участника на узком экране (adm-lcard макета). */
function LimitCardItem({ member, me, alertPct, flash, onEdit }: RowProps & { member: MemberLimit }) {
  const { t } = useTranslation();
  const limit = memberLimitOf(member);
  const head = (
    <div className="adm-lcard-head">
      <NameCell member={member} me={me} />
      {limit && member.id !== me.id && <EditButton member={member} onEdit={onEdit} />}
    </div>
  );
  const spend = <LimitSpend member={member} alertPct={alertPct} />;
  if (member.ai_mode === 'own') {
    return (
      <section className="adm-lcard" aria-label={personName(member)}>
        {head}
        <div className="small soft">{t('admin.key.limits.ownCard', { cap: formatLimitUsd(member.own_cap_usd) })}</div>
        {spend}
      </section>
    );
  }
  if (!limit) {
    return (
      <section className="adm-lcard" aria-label={personName(member)}>
        {head}
        <div className="small soft">{t('admin.key.limits.noLimit')}</div>
        {spend}
      </section>
    );
  }
  const pauseId = `adm-pause-${member.id}-m`;
  return (
    <section
      className={cx('adm-lcard', flash && atThreshold(member, alertPct) && 'adm-flash')}
      aria-label={personName(member)}
    >
      {head}
      <dl className="adm-facts">
        <div>
          <dt>{t('admin.key.limits.factMonthly')}</dt>
          <dd>{formatLimitUsd(limit.monthly_usd)}</dd>
        </div>
        <div>
          <dt>{t('admin.key.limits.factDaily')}</dt>
          <dd>{t('admin.key.analyses', { count: limit.daily_analyses })}</dd>
        </div>
        <div>
          <dt>{t('admin.key.limits.factPer')}</dt>
          <dd>{formatLimitUsd(limit.per_analysis_usd)}</dd>
        </div>
      </dl>
      {spend}
      <label className="row-between adm-pause-row" htmlFor={pauseId}>
        <span className="small adm-min0">
          <b>{t('admin.key.pause')}</b>
          <span className="muted"> {t('admin.key.limits.pauseHint')}</span>
        </span>
        <PauseSwitch member={member} paused={limit.paused} id={pauseId} />
      </label>
    </section>
  );
}

function NameCell({ member, me }: { member: MemberLimit; me: Me }) {
  const { t } = useTranslation();
  const mine = member.id === me.id;
  return (
    <div className="adm-cell2 adm-min0">
      <span className="adm-person-name">
        <span className="adm-nowrap adm-ellipsis" title={personName(member)}>
          {personName(member)}
        </span>
        {mine && <Chip kind="accent">{t('admin.you')}</Chip>}
        {member.role === 'admin' && !mine && <Chip kind="outline">{t('admin.roleLower.admin')}</Chip>}
        {member.status === 'blocked' && <Chip kind="bad">{t('admin.key.limits.blocked')}</Chip>}
      </span>
      <span className="adm-sub">
        {member.ai_mode === 'own'
          ? t('admin.key.limits.keyOwn', { last4: member.own_key_last4 ?? '••••' })
          : t('admin.key.limits.keyShared')}
      </span>
    </div>
  );
}

function OwnCapCell({ member }: { member: MemberLimit }) {
  const { t } = useTranslation();
  return (
    <div className="adm-cell2 r">
      <span className="mono">{formatLimitUsd(member.own_cap_usd)}</span>
      <span className="adm-sub">{t('admin.key.limits.capByMember')}</span>
    </div>
  );
}

function EditButton({ member, onEdit }: { member: MemberLimit; onEdit: (member: MemberLimit) => void }) {
  const { t } = useTranslation();
  return (
    <Button
      size="sm"
      icon="edit"
      aria-label={t('admin.key.limits.editLabel', { name: personName(member) })}
      onClick={() => onEdit(member)}
    >
      {t('admin.key.edit')}
    </Button>
  );
}

/** Пауза анализов участника на ключе администратора — сразу, без «Сохранить». */
function PauseSwitch({ member, paused, id }: { member: MemberLimit; paused: boolean; id: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const update = useUpdateMemberLimit();
  const name = personName(member);
  return (
    <span className="switch">
      <input
        type="checkbox"
        role="switch"
        id={id}
        checked={update.isPending ? Boolean(update.variables?.patch.paused) : paused}
        disabled={update.isPending}
        aria-label={t('admin.key.limits.pauseLabel', { name })}
        onChange={(e) => {
          const next = e.target.checked;
          update.mutate(
            { id: member.id, patch: { paused: next } },
            {
              onSuccess: () =>
                toast.show(t(next ? 'admin.key.limits.pausedOn' : 'admin.key.limits.pausedOff', { name }), {
                  icon: next ? 'pause' : 'play',
                }),
              onError: (error) => toast.show(errorMessage(error), { icon: 'alert' }),
            },
          );
        }}
      />
      <span />
    </span>
  );
}

/**
 * Расход за месяц (spendBlock макета): на ключе администратора — доля лимита полосой; на своем
 * ключе — свой счет, вне бюджета. Порог желтого — из настроек бюджета.
 */
function LimitSpend({ member, alertPct }: { member: MemberLimit; alertPct: number | null }) {
  const { t } = useTranslation();
  const onKey = member.spent_month_usd;
  const own = member.own_spent_month_usd;
  const limit = memberLimitOf(member);
  const dim = member.status === 'blocked' && 'adm-dim';
  let extra: ReactNode = null;

  if (member.ai_mode === 'own') {
    return (
      <div className={cx('adm-spend', dim)}>
        <div className="adm-spend-top">
          <span>
            <Trans i18nKey="admin.key.limits.ownSpent" values={{ amount: formatUsd(own) }} components={{ b: <b /> }} />
          </span>
          <span className="muted">{t('admin.users.outOfBudget')}</span>
        </div>
        {onKey > 0 && <span className="adm-sub">{t('admin.users.onYourKey', { amount: formatUsd(onKey) })}</span>}
      </div>
    );
  }
  if (own > 0) extra = <span className="adm-sub">{t('admin.key.limits.ownExtra', { amount: formatUsd(own) })}</span>;
  if (!limit) {
    return (
      <div className={cx('adm-spend', dim)}>
        <div className="adm-spend-top">
          <span>
            <b>{formatUsd(onKey)}</b>
          </span>
          <span className="muted">{t('admin.users.inBudget')}</span>
        </div>
        {extra}
      </div>
    );
  }
  // доля лимита — с сервера (limit_share)
  const share = member.limit_share ?? 0;
  const tone = spendTone(onKey, limit.monthly_usd, alertPct ?? 100);
  const max = formatLimitUsd(limit.monthly_usd);
  return (
    <div className={cx('adm-spend', dim)}>
      <div className="adm-spend-top">
        <span>
          <b>{formatUsd(onKey)}</b> {t('admin.users.spendOf', { limit: max })}
        </span>
        <span className={tone ? `${tone}-text` : 'muted'}>{formatPercent(share, { digits: 0 })}</span>
      </div>
      <Meter
        value={onKey}
        max={limit.monthly_usd}
        kind={tone ?? undefined}
        label={t('admin.users.spentAria', { spent: formatUsd(onKey), limit: max })}
      />
      {extra}
      {limit.paused && (
        <Chip kind="warn" icon="pause" className="adm-self-start">
          {t('admin.users.paused')}
        </Chip>
      )}
    </div>
  );
}
