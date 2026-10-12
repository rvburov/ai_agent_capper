import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { errorMessage } from '../../api/errors';
import { Button, Callout, Field, Modal, Toggle, useToast } from '../../components';
import { spendMonth, whenInline } from '../../features/admin/display';
import {
  checkLimit,
  formatLimitUsd,
  LIMIT_FIELDS,
  limitDraftOf,
  limitPatch,
  limitText,
  parseAmount,
  R13_LIMIT,
  sameLimit,
  type LimitDraft,
  type LimitField,
} from '../../features/admin/limits';
import { personName } from '../../features/admin/people';
import type { LimitDefaults, MemberLimit } from '../../features/admin/types';
import { useAdminBudget, useDecideReturn, useUpdateDefaults, useUpdateMemberLimit } from '../../features/admin/useAdminAi';
import { keyMask } from '../../features/ai/keyFormat';
import { formatPercent, formatUsd } from '../../lib/format';
import { ConfirmDialog, HowTo, PersonRow } from './parts';

// Быстрые суммы месячного лимита в окне лимита (как в макете)
const PRESETS = [8, 10, 12, 15, 20] as const;

type FieldErrors = Partial<Record<LimitField, true>>;

interface LimitFieldsProps {
  idPrefix: string;
  draft: LimitDraft;
  errors: FieldErrors;
  onChange: (field: LimitField, value: string) => void;
}

/** Три поля лимита (limitFields макета): в месяц, анализов в день, на один анализ. */
export function LimitFields({ idPrefix, draft, errors, onChange }: LimitFieldsProps) {
  const { t } = useTranslation();
  return (
    <div className="adm-fields">
      {LIMIT_FIELDS.map((field) => (
        <Field
          key={field}
          id={`${idPrefix}-${field}`}
          label={t(`admin.inviteForm.${field}`)}
          error={errors[field] ? t(`admin.inviteForm.${field}Error`) : undefined}
          inputMode={field === 'daily' ? 'numeric' : 'decimal'}
          autoComplete="off"
          value={draft[field]}
          onChange={(e) => onChange(field, e.target.value)}
        />
      ))}
    </div>
  );
}

/** Состояние трех полей лимита и проверка при отправке (фокус — на первое поле с ошибкой). */
function useLimitForm(initial: LimitDraft) {
  const formId = useId();
  const [draft, setDraft] = useState<LimitDraft>(initial);
  const [errors, setErrors] = useState<FieldErrors>({});
  return {
    formId,
    draft,
    errors,
    setDraft,
    onChange: (field: LimitField, value: string) => {
      setDraft((d) => ({ ...d, [field]: value }));
      setErrors((e) => ({ ...e, [field]: undefined }));
    },
    check: () => {
      const result = checkLimit(draft);
      setErrors(result.errors);
      if (!result.limit) {
        requestAnimationFrame(() =>
          document.getElementById(formId)?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
        );
      }
      return result.limit;
    },
  };
}

interface FormModalProps {
  formId: string;
  title: ReactNode;
  confirmLabel: string;
  pending: boolean;
  error: unknown;
  onSubmit: () => void;
  onClose: () => void;
  children: ReactNode;
}

function FormModal({ formId, title, confirmLabel, pending, error, onSubmit, onClose, children }: FormModalProps) {
  const { t } = useTranslation();
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button onClick={onClose}>{t('admin.confirm.cancel')}</Button>
          <Button type="submit" form={formId} kind="primary" icon="check" loading={pending}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="stack"
        noValidate
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          if (!pending) onSubmit();
        }}
      >
        {children}
        {error !== null && (
          <Callout kind="bad" role="alert">
            {errorMessage(error)}
          </Callout>
        )}
      </form>
    </Modal>
  );
}

interface LimitModalProps {
  member: MemberLimit;
  members: readonly MemberLimit[];
  meId: number;
  onClose: () => void;
}

/**
 * «Лимит на ключе администратора» (limitModal макета): поля лимита, быстрые суммы, что
 * будет с расходом и суммой личных лимитов, пауза. На своем ключе лимит задает участник.
 */
export function LimitModal({ member, members, meId, onClose }: LimitModalProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const update = useUpdateMemberLimit();
  const budget = useAdminBudget();
  const limit = member.limit;
  const form = useLimitForm(limitDraftOf(limit));
  const [paused, setPaused] = useState(limit?.paused ?? false);
  const [error, setError] = useState<unknown>(null);
  const name = personName(member);
  const month = spendMonth();
  const alertPct = budget.data?.alert_pct ?? 100;
  if (!limit) return null;

  const monthly = parseAmount(form.draft.monthly);
  const others = members
    .filter((m) => m.id !== member.id && m.role === 'member' && m.status === 'active' && m.ai_mode === 'shared' && m.limit)
    .reduce((sum, m) => sum + (m.limit?.monthly_usd ?? 0), 0);

  let preview: ReactNode;
  if (monthly === null || !(monthly > 0)) {
    preview = <span>{t('admin.key.limitModal.enterLimit')}</span>;
  } else {
    const share = member.spent_month_usd / monthly;
    const tone = share >= 1 ? 'bad-text' : share * 100 >= alertPct ? 'warn-text' : undefined;
    const total = Math.round((others + (member.status === 'active' ? monthly : 0)) * 100) / 100;
    preview = (
      <>
        <span>
          <Trans
            i18nKey="admin.key.limitModal.spent"
            values={{ month, spent: formatUsd(member.spent_month_usd), pct: formatPercent(share, { digits: 0 }) }}
            components={{ b: <b />, pct: <b className={tone} /> }}
          />
        </span>
        {share >= 1 && <span className="bad-text">{t('admin.key.limitModal.below')}</span>}
        {budget.data && (
          <span>
            <Trans
              i18nKey="admin.key.limitModal.sum"
              values={{ total: formatLimitUsd(total), budget: formatLimitUsd(budget.data.budget_usd) }}
              components={{ b: <b /> }}
            />
          </span>
        )}
      </>
    );
  }

  function onSubmit() {
    if (!limit) return;
    const next = form.check();
    if (!next) return;
    const patch = limitPatch(limit, next, paused);
    if (!patch) {
      onClose();
      toast.show(t('admin.key.limitModal.same'), { icon: 'info' });
      return;
    }
    setError(null);
    update.mutate(
      { id: member.id, patch },
      {
        onSuccess: (out) => {
          onClose();
          toast.show(
            t('admin.key.limitModal.done', { name, limit: out.limit ? limitText(out.limit) : limitText(next) }),
            { icon: 'sliders' },
          );
        },
        onError: setError,
      },
    );
  }

  return (
    <FormModal
      formId={form.formId}
      title={t('admin.key.limitModal.title')}
      confirmLabel={t('admin.key.save')}
      pending={update.isPending}
      error={error}
      onSubmit={onSubmit}
      onClose={onClose}
    >
      <PersonRow user={member} meId={meId} boxed />
      <p className="small soft">
        {t('admin.key.limitModal.usage', {
          today: t('admin.key.analyses', { count: member.analyses_today }),
          month,
          count: member.analyses_month,
        })}
      </p>
      <LimitFields idPrefix={`${form.formId}-lim`} draft={form.draft} errors={form.errors} onChange={form.onChange} />
      <div className="adm-presets">
        <span>{t('admin.key.limitModal.presets')}</span>
        {PRESETS.map((value) => (
          <button
            key={value}
            type="button"
            className="adm-pill"
            aria-pressed={monthly === value}
            onClick={() => form.onChange('monthly', String(value))}
          >
            {formatLimitUsd(value)}
          </button>
        ))}
      </div>
      <div className="adm-preview" aria-live="polite">
        {preview}
      </div>
      <Toggle
        label={t('admin.key.pause')}
        hint={t('admin.key.limitModal.pauseHint')}
        checked={paused}
        onChange={setPaused}
      />
    </FormModal>
  );
}

/** «Лимиты по умолчанию» (defaultsModal макета): что получит новый участник на ключе администратора. */
export function DefaultsModal({ defaults, onClose }: { defaults: LimitDefaults; onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const update = useUpdateDefaults();
  const form = useLimitForm(limitDraftOf(defaults));
  const [error, setError] = useState<unknown>(null);

  function onSubmit() {
    const next = form.check();
    if (!next) return;
    if (sameLimit(defaults, next)) {
      onClose();
      toast.show(t('admin.key.defaults.same'), { icon: 'info' });
      return;
    }
    setError(null);
    update.mutate(next, {
      onSuccess: (out) => {
        onClose();
        toast.show(t('admin.key.defaults.done', { limit: limitText(out) }), { icon: 'sliders' });
      },
      onError: setError,
    });
  }

  return (
    <FormModal
      formId={form.formId}
      title={t('admin.key.defaults.title')}
      confirmLabel={t('admin.key.save')}
      pending={update.isPending}
      error={error}
      onSubmit={onSubmit}
      onClose={onClose}
    >
      <p className="small soft">{t('admin.key.defaults.text')}</p>
      <LimitFields idPrefix={`${form.formId}-def`} draft={form.draft} errors={form.errors} onChange={form.onChange} />
      <div className="adm-presets">
        <span>{t('admin.key.defaults.decided', { limit: limitText(R13_LIMIT) })}</span>
        <button type="button" className="adm-pill" onClick={() => form.setDraft(limitDraftOf(R13_LIMIT))}>
          {t('admin.key.defaults.fill')}
        </button>
      </div>
    </FormModal>
  );
}

interface ApproveModalProps {
  member: MemberLimit;
  defaults: LimitDefaults | undefined;
  meId: number;
  onClose: () => void;
}

/** «Вернуть на ключ администратора» (approveReturn макета): разрешение с лимитом на вашем ключе. */
export function ApproveModal({ member, defaults, meId, onClose }: ApproveModalProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const decide = useDecideReturn();
  const form = useLimitForm(limitDraftOf(member.limit ?? defaults));
  const [error, setError] = useState<unknown>(null);
  const name = personName(member);

  function onSubmit() {
    const limit = form.check();
    if (!limit) return;
    setError(null);
    decide.mutate(
      { id: member.id, decision: 'approve', limit },
      {
        onSuccess: () => {
          onClose();
          toast.show(t('admin.key.approve.done', { name }), { icon: 'key' });
        },
        onError: setError,
      },
    );
  }

  return (
    <FormModal
      formId={form.formId}
      title={t('admin.key.approve.title')}
      confirmLabel={t('admin.key.approve.go')}
      pending={decide.isPending}
      error={error}
      onSubmit={onSubmit}
      onClose={onClose}
    >
      <PersonRow user={member} meId={meId} boxed />
      <p className="small soft">
        {t('admin.key.approve.text', {
          when: whenInline(member.return_requested_at),
          key: keyMask(member.own_key_last4),
          month: spendMonth(),
          spent: formatUsd(member.own_spent_month_usd),
        })}
      </p>
      <div className="field-label">
        <span>{t('admin.key.approve.limitTitle')}</span>
      </div>
      <LimitFields idPrefix={`${form.formId}-ret`} draft={form.draft} errors={form.errors} onChange={form.onChange} />
      {defaults && <HowTo>{t('admin.key.approve.defaults', { limit: limitText(defaults) })}</HowTo>}
    </FormModal>
  );
}

/** «Отклонить просьбу» (rejectReturn макета): участник остается на своем ключе. */
export function RejectDialog({ member, meId, onClose }: { member: MemberLimit; meId: number; onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const decide = useDecideReturn();
  const name = personName(member);
  return (
    <ConfirmDialog
      title={t('admin.key.reject.title')}
      confirmLabel={t('admin.key.reject.go')}
      icon="x"
      run={() => decide.mutateAsync({ id: member.id, decision: 'reject' })}
      onDone={() => {
        onClose();
        toast.show(t('admin.key.reject.done', { name }), { icon: 'x' });
      }}
      onClose={onClose}
    >
      <PersonRow user={member} meId={meId} boxed />
      <p className="small soft">{t('admin.key.reject.text')}</p>
    </ConfirmDialog>
  );
}
