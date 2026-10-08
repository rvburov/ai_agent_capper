import { useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { errorMessage, isApiError } from '../../api/errors';
import {
  Button,
  Callout,
  ChoiceCards,
  Dropdown,
  Field,
  FieldShell,
  KeyValue,
  Modal,
  describedById,
  useToast,
} from '../../components';
import { lowerFirst } from '../../features/admin/display';
import {
  checkLimit,
  defaultLimitDraft,
  DEFAULT_LIMIT,
  formatLimitUsd,
  limitText,
  type LimitDraft,
  type LimitField,
} from '../../features/admin/limits';
import { looksLikeEmail, visiblePeople } from '../../features/admin/people';
import type { AiMode, InviteCreated, Role } from '../../features/admin/types';
import { useAdminUsers } from '../../features/admin/useAdminUsers';
import { useCreateInvite, useInvites } from '../../features/admin/useInvites';
import { formatDateTime } from '../../lib/format';
import { CodeBox, HowTo, isOtpError, OtpField } from './parts';

/** «Пригласить в AI Capper» (inviteModal макета): форма, затем код один раз. */
export function InviteModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return <InviteDialog onClose={onClose} />;
}

// Ошибки сервера, которые относятся к полю email
const EMAIL_ERRORS = new Set(['admin.email_taken', 'admin.invite_exists']);
const LIMIT_FIELDS: readonly LimitField[] = ['monthly', 'daily', 'perAnalysis'];

function InviteDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const formId = useId();
  const users = useAdminUsers();
  const invites = useInvites();
  const create = useCreateInvite();

  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('member');
  const [mode, setMode] = useState<AiMode>('shared');
  const [limit, setLimit] = useState<LimitDraft>(defaultLimitDraft);
  const [code, setCode] = useState('');
  const [errors, setErrors] = useState<{
    email?: string;
    otp?: string;
    limit?: Partial<Record<LimitField, true>>;
    other?: string;
  }>({});
  const [created, setCreated] = useState<InviteCreated | null>(null);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (create.isPending) return;
    const value = email.trim().toLowerCase();
    const next: typeof errors = {};
    if (!looksLikeEmail(value)) next.email = t('admin.inviteForm.emailBad');
    else if (users.data && visiblePeople(users.data).some((u) => u.email.toLowerCase() === value)) {
      next.email = t('admin.inviteForm.emailTaken');
    } else if (invites.data?.some((i) => i.status === 'active' && i.email.toLowerCase() === value)) {
      next.email = t('admin.inviteForm.emailInvited');
    }
    const checked = mode === 'shared' ? checkLimit(limit) : null;
    if (checked && !checked.limit) next.limit = checked.errors;
    if (role === 'admin' && !/^\d{6}$/.test(code)) next.otp = t('admin.confirm.otpError');
    setErrors(next);
    if (next.email || next.limit || next.otp) {
      // фокус — на первое поле с ошибкой, как в макете
      requestAnimationFrame(() =>
        document.getElementById(formId)?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
      );
      return;
    }
    create.mutate(
      {
        email: value,
        role,
        ai_mode: mode,
        limit: checked?.limit ?? null,
        totp_code: role === 'admin' ? code : null,
      },
      {
        onSuccess: (data) => {
          setCreated(data);
          toast.show(t('admin.inviteForm.toast', { email: data.invite.email }), { icon: 'userPlus' });
        },
        onError: (error) => {
          if (isApiError(error) && EMAIL_ERRORS.has(error.code)) setErrors({ email: error.message });
          else if (isOtpError(error)) {
            setCode('');
            setErrors({ otp: errorMessage(error) });
          } else setErrors({ other: errorMessage(error) });
        },
      },
    );
  }

  if (created) return <InviteDone created={created} onClose={onClose} />;

  const roleId = `${formId}-role`;
  const roleHint = t(`admin.inviteForm.roleHint.${role}`);
  return (
    <Modal
      open
      onClose={onClose}
      title={t('admin.inviteForm.title')}
      footer={
        <>
          <Button onClick={onClose}>{t('admin.confirm.cancel')}</Button>
          <Button type="submit" form={formId} kind="primary" icon="userPlus" loading={create.isPending}>
            {t('admin.inviteForm.create')}
          </Button>
        </>
      }
    >
      <form id={formId} className="stack" noValidate onSubmit={onSubmit}>
        <p className="small soft">{t('admin.inviteForm.intro')}</p>
        <Field
          id={`${formId}-email`}
          type="email"
          label={t('admin.inviteForm.email')}
          hint={t('admin.inviteForm.emailHint')}
          error={errors.email}
          placeholder="name@example.com"
          autoComplete="off"
          spellCheck={false}
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            setErrors((prev) => ({ ...prev, email: undefined }));
          }}
        />
        <FieldShell id={roleId} label={t('admin.inviteForm.role')} hint={roleHint}>
          <Dropdown
            id={roleId}
            label={t('admin.inviteForm.role')}
            options={(['member', 'admin'] as const).map((value) => ({ value, label: t(`admin.role.${value}`) }))}
            value={role}
            onChange={(value) => {
              setRole(value);
              setCode('');
              setErrors((e) => ({ ...e, otp: undefined }));
            }}
            describedBy={describedById(roleId, roleHint, null)}
          />
        </FieldShell>
        <ChoiceCards
          legend={t('admin.inviteForm.keyLegend')}
          name={`${formId}-mode`}
          value={mode}
          onChange={setMode}
          options={[
            { value: 'shared', title: t('admin.inviteForm.sharedTitle'), text: t('admin.inviteForm.sharedText') },
            { value: 'own', title: t('admin.inviteForm.ownTitle'), text: t('admin.inviteForm.ownText') },
          ]}
        />
        {mode === 'shared' ? (
          <div className="stack" style={{ gap: 8 }}>
            <div className="field-label">
              <span>{t('admin.inviteForm.limitTitle')}</span>
            </div>
            <div className="adm-fields">
              {LIMIT_FIELDS.map((field) => (
                <Field
                  key={field}
                  id={`${formId}-${field}`}
                  label={t(`admin.inviteForm.${field}`)}
                  error={errors.limit?.[field] ? t(`admin.inviteForm.${field}Error`) : undefined}
                  inputMode={field === 'daily' ? 'numeric' : 'decimal'}
                  autoComplete="off"
                  value={limit[field]}
                  onChange={(e) => {
                    const value = e.target.value;
                    setLimit((l) => ({ ...l, [field]: value }));
                    setErrors((prev) => ({ ...prev, limit: { ...prev.limit, [field]: undefined } }));
                  }}
                />
              ))}
            </div>
            <HowTo>
              {t('admin.inviteForm.limitDefaults', {
                limit: limitText({
                  monthly_usd: DEFAULT_LIMIT.monthly,
                  daily_analyses: DEFAULT_LIMIT.daily,
                  per_analysis_usd: DEFAULT_LIMIT.perAnalysis,
                }),
              })}
            </HowTo>
          </div>
        ) : (
          <HowTo>{t('admin.inviteForm.ownHint', { per: formatLimitUsd(DEFAULT_LIMIT.perAnalysis) })}</HowTo>
        )}
        {role === 'admin' && (
          <div className="stack" style={{ gap: 8 }}>
            <HowTo>{t('admin.inviteForm.adminOtp')}</HowTo>
            <OtpField
              id={`${formId}-otp`}
              value={code}
              onChange={(value) => {
                setCode(value);
                setErrors((e) => ({ ...e, otp: undefined }));
              }}
              error={errors.otp}
            />
          </div>
        )}
        {errors.other && (
          <Callout kind="bad" role="alert">
            {errors.other}
          </Callout>
        )}
      </form>
    </Modal>
  );
}

function InviteDone({ created, onClose }: { created: InviteCreated; onClose: () => void }) {
  const { t } = useTranslation();
  const { invite, code } = created;
  return (
    <Modal
      open
      onClose={onClose}
      title={t('admin.inviteForm.title')}
      footer={
        <Button kind="primary" icon="check" onClick={onClose}>
          {t('admin.inviteForm.done')}
        </Button>
      }
    >
      <p className="small soft">
        {t('admin.inviteForm.createdBefore')}
        <b>{invite.email}</b>
        {t('admin.inviteForm.createdAfter')}
      </p>
      <CodeBox code={code} label={t('admin.inviteForm.codeLabel')} />
      <Callout kind="warn" icon="clock">
        <b>{t('admin.inviteForm.validStrong', { date: lowerFirst(formatDateTime(invite.expires_at)) })}</b>{' '}
        {t('admin.inviteForm.valid')}
      </Callout>
      <KeyValue
        items={[
          { key: 'role', label: t('admin.inviteForm.kvRole'), value: t(`admin.role.${invite.role}`) },
          {
            key: 'key',
            label: t('admin.inviteForm.kvKey'),
            value: invite.ai_mode === 'own' ? t('admin.invites.keyOwn') : t('admin.invites.keyShared'),
          },
          invite.limit
            ? { key: 'limit', label: t('admin.inviteForm.kvLimit'), value: limitText(invite.limit) }
            : { key: 'limits', label: t('admin.inviteForm.kvLimits'), value: t('admin.inviteForm.kvLimitsOwn') },
        ]}
      />
      <div className="eyebrow">{t('admin.inviteForm.stepsTitle')}</div>
      <ol className="adm-steps">
        <li>
          <span>
            {t('admin.inviteForm.step1')}
            <b>{t('admin.inviteForm.step1b')}</b>
          </span>
        </li>
        <li>
          <span>
            {t('admin.inviteForm.step2Before')}
            <b>{invite.email}</b>
            {t('admin.inviteForm.step2After')}
          </span>
        </li>
        <li>
          <span>{t('admin.inviteForm.step3')}</span>
        </li>
      </ol>
    </Modal>
  );
}
