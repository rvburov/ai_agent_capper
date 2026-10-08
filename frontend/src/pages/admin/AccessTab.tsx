import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router';

import { errorMessage } from '../../api/errors';
import type { Me } from '../../api/hooks/useMe';
import {
  Button,
  Callout,
  Card,
  Chip,
  Dropdown,
  FieldShell,
  Icon,
  IconButton,
  Skeleton,
  describedById,
  useToast,
} from '../../components';
import { copyText } from '../../features/auth/clipboard';
import { timeLeft, whenInline } from '../../features/admin/display';
import { personName, resetCandidates, twoFactorCandidates } from '../../features/admin/people';
import type { AdminUser, ResetCode, ResetCodeCreated } from '../../features/admin/types';
import { useAdminUsers } from '../../features/admin/useAdminUsers';
import {
  useActiveResetCodes,
  useCreateResetCode,
  useRevokeResetCode,
} from '../../features/admin/useResetCodes';
import { CodeBox, ConfirmDialog, Item, LoadError, PersonRow } from './parts';
import { useUserActions, type AccessNavState } from './UserActions';

/** Вкладка «Сброс доступа» (PANELS.access макета): код сброса, сброс 2FA, коды, терминал. */
export function AccessTab({ me }: { me: Me }) {
  const users = useAdminUsers();
  const codes = useActiveResetCodes();
  const actions = useUserActions(me);
  return (
    <>
      <div className="grid">
        <div className="col-6 adm-col">
          <ResetCard me={me} users={users.data} codes={codes.data} />
        </div>
        <div className="col-6 adm-col">
          <TwoFactorCard
            me={me}
            users={users.data}
            onReset={(user) => actions.open('reset2fa', user)}
          />
        </div>
      </div>
      <CodesCard codes={codes} />
      <TerminalCard me={me} />
      {actions.dialogs}
    </>
  );
}

interface ResetCardProps {
  me: Me;
  users: AdminUser[] | undefined;
  codes: ResetCode[] | undefined;
}

/** «Код сброса пароля»: выбор участника, выдача кода, показ кода один раз. */
function ResetCard({ me, users, codes }: ResetCardProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const location = useLocation();
  const create = useCreateResetCode();
  const navState = location.state as Partial<AccessNavState> | null;
  const [selected, setSelected] = useState<number | null>(navState?.resetUserId ?? null);
  const [shown, setShown] = useState<{
    created: ResetCodeCreated;
    user: AdminUser;
    replaced: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const goRef = useRef<HTMLButtonElement>(null);

  // Пришли из меню участника «Выдать код сброса пароля»: карточка на виду, фокус на «Выдать код»
  const fromMenu = navState?.resetUserId ?? null;
  useEffect(() => {
    if (fromMenu === null || !users) return;
    document.getElementById('adm-reset')?.scrollIntoView({ block: 'start' });
    goRef.current?.focus({ preventScroll: true });
  }, [fromMenu, users]);

  const candidates = users ? resetCandidates(users, me.id) : [];
  const user = candidates.find((u) => u.id === selected) ?? null;
  const hasCode = user ? (codes ?? []).some((c) => c.user_id === user.id) : false;
  const hint = !user
    ? t('admin.access.reset.hintNone')
    : hasCode
      ? t('admin.access.reset.hintHas')
      : user.status === 'blocked'
        ? t('admin.access.reset.hintBlocked')
        : t('admin.access.reset.hintDefault');

  function onIssue() {
    if (!user) return;
    setError(null);
    // прежний код сервер отзывает сам: «перестал действовать» — если он был до выдачи
    const replaced = hasCode;
    create.mutate(user.id, {
      onSuccess: (created) => {
        setShown({ created, user, replaced });
        toast.show(t('admin.access.reset.toast', { name: personName(user) }), { icon: 'lock' });
      },
      onError: (err) => setError(errorMessage(err)),
    });
  }

  const selectId = 'adm-reset-user';
  let body;
  if (shown) {
    const { created } = shown;
    body = (
      <>
        <PersonRow user={shown.user} meId={me.id} boxed />
        <CodeBox code={created.code} label={t('admin.access.reset.codeLabel')} />
        <Callout kind="warn" icon="clock">
          {t('admin.access.reset.valid', { date: whenInline(created.reset_code.expires_at) })}
          {shown.replaced ? ` ${t('admin.access.reset.replaced')}` : ''}
        </Callout>
        <div className="eyebrow">{t('admin.access.reset.steps')}</div>
        <ResetSteps email={shown.user.email} />
        <div className="row">
          <Button size="sm" icon="eyeOff" onClick={() => setShown(null)}>
            {t('admin.access.reset.hide')}
          </Button>
        </div>
      </>
    );
  } else if (!users) {
    body = <Skeleton lines={2} height={18} />;
  } else {
    body = (
      <>
        <FieldShell id={selectId} label={t('admin.access.reset.user')} hint={hint}>
          <Dropdown
            id={selectId}
            label={t('admin.access.reset.user')}
            placeholder={t('admin.access.reset.placeholder')}
            searchable
            options={candidates.map((u) => ({ value: String(u.id), label: `${personName(u)} · ${u.email}` }))}
            value={user ? String(user.id) : null}
            onChange={(value) => {
              setSelected(Number(value));
              setError(null);
            }}
            describedBy={describedById(selectId, hint, null)}
          />
        </FieldShell>
        {error && (
          <Callout kind="bad" role="alert">
            {error}
          </Callout>
        )}
        <div className="row">
          <Button
            ref={goRef}
            kind="primary"
            icon="lock"
            disabled={!user}
            loading={create.isPending}
            onClick={onIssue}
          >
            {t('admin.access.reset.go')}
          </Button>
        </div>
        <p className="xsmall muted">{t('admin.access.reset.admins')}</p>
      </>
    );
  }

  return (
    <Card
      id="adm-reset"
      className="adm-anchor adm-fill"
      title={t('admin.access.reset.title')}
      subtitle={t('admin.access.reset.subtitle')}
    >
      {body}
    </Card>
  );
}

function ResetSteps({ email }: { email: string }) {
  const { t } = useTranslation();
  return (
    <ol className="adm-steps">
      <li>
        <span>
          <b>{t('admin.access.reset.step1b')}</b>
        </span>
      </li>
      <li>
        <span>
          {t('admin.access.reset.step2Before')}
          <b>{email}</b>
          {t('admin.access.reset.step2After')}
        </span>
      </li>
      <li>
        <span>{t('admin.access.reset.step3')}</span>
      </li>
    </ol>
  );
}

interface TwoFactorCardProps {
  me: Me;
  users: AdminUser[] | undefined;
  onReset: (user: AdminUser) => void;
}

/** «Сбросить 2FA»: участники с включенной 2FA; подтверждение кодом 2FA администратора. */
function TwoFactorCard({ me, users, onReset }: TwoFactorCardProps) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<number | null>(null);
  const candidates = users ? twoFactorCandidates(users, me.id) : [];
  const user = candidates.find((u) => u.id === selected) ?? null;
  const selectId = 'adm-2fa-user';
  const hint = t('admin.access.twofa.hint');
  return (
    <Card
      className="adm-fill"
      title={t('admin.access.twofa.title')}
      subtitle={t('admin.access.twofa.subtitle')}
    >
      <ul className="adm-bul">
        <li>
          <Icon name="shield" />
          {t('admin.access.twofa.b1')}
        </li>
        <li>
          <Icon name="refresh" />
          {t('admin.access.twofa.b2')}
        </li>
        <li>
          <Icon name="lock" />
          {t('admin.access.twofa.b3')}
        </li>
      </ul>
      {users ? (
        <FieldShell id={selectId} label={t('admin.access.twofa.user')} hint={hint}>
          <Dropdown
            id={selectId}
            label={t('admin.access.twofa.user')}
            placeholder={t('admin.access.reset.placeholder')}
            searchable
            options={candidates.map((u) => ({ value: String(u.id), label: `${personName(u)} · ${u.email}` }))}
            value={user ? String(user.id) : null}
            onChange={(value) => setSelected(Number(value))}
            describedBy={describedById(selectId, hint, null)}
          />
        </FieldShell>
      ) : (
        <Skeleton height={42} />
      )}
      <div className="row">
        <Button kind="danger" icon="shield" disabled={!user} onClick={() => user && onReset(user)}>
          {t('admin.access.twofa.go')}
        </Button>
      </div>
    </Card>
  );
}

type CodesQuery = ReturnType<typeof useActiveResetCodes>;

/** «Действующие коды сброса»: кому и когда выдан, сколько осталось, отзыв. */
function CodesCard({ codes }: { codes: CodesQuery }) {
  const { t } = useTranslation();
  const toast = useToast();
  const revoke = useRevokeResetCode();
  const [revoking, setRevoking] = useState<ResetCode | null>(null);
  const list = codes.data ?? [];

  let body;
  if (codes.isPending) body = <Skeleton lines={2} height={18} />;
  else if (codes.isError) body = <LoadError error={codes.error} onRetry={() => void codes.refetch()} />;
  else if (!list.length) body = <p className="small soft">{t('admin.access.codes.empty')}</p>;
  else {
    body = (
      <div className="adm-list">
        {list.map((code) => {
          const name = code.user_name.trim() || code.user_email;
          return (
            <Item
              key={code.id}
              icon="lock"
              iconKind="info"
              title={name}
              meta={t('admin.access.codes.meta', {
                created: whenInline(code.created_at),
                expires: whenInline(code.expires_at),
                left: timeLeft(code.expires_at),
              })}
              side={
                <Button
                  size="sm"
                  icon="x"
                  aria-label={t('admin.access.codes.revokeLabel', { name })}
                  onClick={() => setRevoking(code)}
                >
                  {t('admin.access.codes.revoke')}
                </Button>
              }
            />
          );
        })}
      </div>
    );
  }

  return (
    <Card
      title={t('admin.access.codes.title')}
      subtitle={t('admin.access.codes.subtitle')}
      actions={codes.data ? <Chip kind={list.length ? 'info' : 'outline'}>{list.length}</Chip> : undefined}
    >
      {body}
      {revoking && (
        <ConfirmDialog
          title={t('admin.access.codes.revokeTitle')}
          confirmLabel={t('admin.access.codes.revoke')}
          icon="x"
          danger
          run={() => revoke.mutateAsync(revoking.id)}
          onDone={() => {
            setRevoking(null);
            toast.show(t('admin.access.codes.revokeDone'), { icon: 'x' });
          }}
          onClose={() => setRevoking(null)}
        >
          <p className="small soft">
            {t('admin.access.codes.revokeText', { name: revoking.user_name.trim() || revoking.user_email })}
          </p>
        </ConfirmDialog>
      )}
    </Card>
  );
}

// Команды терминала (Р6): как в макете, docker compose на сервере
const CLI = 'docker compose exec api python -m app.admin.cli';

type CommandKey = 'resetCode' | 'reset2fa' | 'createAdmin' | 'setRole' | 'unblock' | 'setAdminKey';

/** «Если забыл пароль администратор»: команды терминала с кнопкой «Скопировать». */
function TerminalCard({ me }: { me: Me }) {
  const { t } = useTranslation();
  const toast = useToast();
  const commands: { key: CommandKey; name: string; args: string }[] = [
    { key: 'resetCode', name: 'reset-code', args: `reset-code --email ${me.email}` },
    { key: 'reset2fa', name: 'reset-2fa', args: `reset-2fa --email ${me.email}` },
    { key: 'createAdmin', name: 'create-admin', args: 'create-admin --email admin2@example.com' },
    { key: 'setRole', name: 'set-role', args: 'set-role --email name@example.com --role admin' },
    { key: 'unblock', name: 'unblock', args: `unblock --email ${me.email}` },
    { key: 'setAdminKey', name: 'set-admin-key', args: 'set-admin-key' },
  ];
  async function onCopy(text: string, node: HTMLElement | null) {
    const ok = await copyText(text, node);
    toast.show(ok ? t('admin.access.terminal.copied') : t('admin.copyFailed'), { icon: ok ? 'copy' : 'alert' });
  }
  return (
    <Card
      id="adm-terminal"
      className="adm-anchor"
      title={t('admin.access.terminal.title')}
      subtitle={t('admin.access.terminal.subtitle')}
    >
      <p className="small soft">{t('admin.access.terminal.text')}</p>
      <ul className="adm-cmds">
        {commands.map((cmd) => {
          const text = `${CLI} ${cmd.args}`;
          return (
            <li key={cmd.key}>
              <div className="adm-cmd-desc">
                <b>{cmd.name}</b> — {t(`admin.access.terminal.cmds.${cmd.key}`)}
              </div>
              <div className="adm-pre">
                <code>{text}</code>
                <IconButton
                  icon="copy"
                  size="sm"
                  label={t('admin.access.terminal.copy', { name: cmd.name })}
                  title={t('admin.copy')}
                  onClick={(e) =>
                    void onCopy(text, e.currentTarget.parentElement?.querySelector('code') ?? null)
                  }
                />
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
