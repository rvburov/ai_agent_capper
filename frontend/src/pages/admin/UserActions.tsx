import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { errorMessage } from '../../api/errors';
import type { Me } from '../../api/hooks/useMe';
import { paths } from '../../app/paths';
import { Callout, Field, Icon, useToast, type ActionMenuEntry } from '../../components';
import { spendMonth } from '../../features/admin/display';
import { personName } from '../../features/admin/people';
import type { AdminUser } from '../../features/admin/types';
import {
  useBlockUser,
  useChangeRole,
  useDeleteUser,
  useResetTwoFactor,
  useRevokeSessions,
  useUnblockUser,
} from '../../features/admin/useAdminUsers';
import { formatUsd } from '../../lib/format';
import { ConfirmDialog, PersonRow } from './parts';
import { UserCard } from './UserCard';

type DialogKind = 'card' | 'block' | 'sessions' | 'reset2fa' | 'role' | 'delete';
interface Dialog {
  kind: DialogKind;
  user: AdminUser;
}

/** Состояние «Выдать код сброса»: вкладка «Сброс доступа» открывается с выбранным участником. */
export interface AccessNavState {
  resetUserId: number;
}

/**
 * Действия над участником (userMenu макета): пункты меню «⋯» и окна подтверждения.
 * Те же пункты — в карточке участника. Ставок, банка и стратегии здесь нет (Р14).
 */
export function useUserActions(me: Me) {
  const { t } = useTranslation();
  const toast = useToast();
  const navigate = useNavigate();
  const unblock = useUnblockUser();
  const [dialog, setDialog] = useState<Dialog | null>(null);

  function onUnblock(user: AdminUser) {
    unblock.mutate(user.id, {
      onSuccess: () => toast.show(t('admin.confirm.unblockDone', { name: personName(user) }), { icon: 'check' }),
      onError: (error) => toast.show(errorMessage(error), { icon: 'alert' }),
    });
  }

  function itemsFor(user: AdminUser, { withCard = true }: { withCard?: boolean } = {}): ActionMenuEntry[] {
    const mine = user.id === me.id;
    const admin = user.role === 'admin';
    const open = (kind: DialogKind) => () => setDialog({ kind, user });
    const items: ActionMenuEntry[] = [];
    if (withCard) {
      items.push({
        id: 'card',
        icon: 'history',
        label: t('admin.menu.activity'),
        hint: t('admin.menu.activityHint'),
        onSelect: open('card'),
      });
    }
    if (mine) {
      items.push({
        id: 'profile',
        icon: 'user',
        label: t('admin.menu.profile'),
        hint: t('admin.menu.profileHint'),
        onSelect: () => void navigate(paths.profile('security')),
      });
    }
    if (items.length) items.push('separator');
    items.push({
      id: 'reset-code',
      icon: 'lock',
      label: t('admin.menu.resetCode'),
      disabled: mine || admin,
      hint: mine ? t('admin.menu.resetCodeMe') : admin ? t('admin.menu.resetCodeAdmin') : t('admin.menu.resetCodeHint'),
      onSelect: () => {
        const state: AccessNavState = { resetUserId: user.id };
        void navigate(paths.admin('access'), { state });
      },
    });
    items.push({
      id: 'reset-2fa',
      icon: 'shield',
      label: t('admin.menu.reset2fa'),
      disabled: mine || admin || !user.totp_enabled,
      hint: mine
        ? t('admin.menu.reset2faMe')
        : admin
          ? t('admin.menu.reset2faAdmin')
          : !user.totp_enabled
            ? t('admin.menu.reset2faOff')
            : t('admin.menu.reset2faHint'),
      onSelect: open('reset2fa'),
    });
    items.push({
      id: 'sessions',
      icon: 'logout',
      label: t('admin.menu.endSessions'),
      disabled: mine,
      hint: mine ? t('admin.menu.endSessionsMe') : null,
      onSelect: open('sessions'),
    });
    items.push({
      id: 'role',
      icon: 'admin',
      label: admin ? t('admin.menu.makeMember') : t('admin.menu.makeAdmin'),
      disabled: mine,
      hint: mine ? t('admin.menu.roleMe') : t('admin.menu.roleHint'),
      onSelect: open('role'),
    });
    items.push('separator');
    if (user.status === 'blocked') {
      items.push({ id: 'unblock', icon: 'check', label: t('admin.menu.unblock'), onSelect: () => onUnblock(user) });
    } else {
      items.push({
        id: 'block',
        icon: 'ban',
        label: t('admin.menu.block'),
        danger: !mine,
        disabled: mine,
        hint: mine ? t('admin.menu.blockMe') : null,
        onSelect: open('block'),
      });
    }
    items.push({
      id: 'delete',
      icon: 'trash',
      label: t('admin.menu.delete'),
      danger: !mine,
      disabled: mine,
      hint: mine ? t('admin.menu.deleteMe') : t('admin.menu.deleteHint'),
      onSelect: open('delete'),
    });
    return items;
  }

  const close = () => setDialog(null);
  const dialogs = dialog ? (
    <UserDialog
      key={`${dialog.kind}-${dialog.user.id}`}
      dialog={dialog}
      me={me}
      onClose={close}
      cardActions={(user) => itemsFor(user, { withCard: false })}
    />
  ) : null;

  return {
    itemsFor,
    dialogs,
    /** Открыть окно действия, например сброс 2FA из вкладки «Сброс доступа». */
    open: (kind: DialogKind, user: AdminUser) => setDialog({ kind, user }),
  };
}

interface UserDialogProps {
  dialog: Dialog;
  me: Me;
  onClose: () => void;
  /** Пункты действий в карточке: по свежим данным участника, а не по строке списка. */
  cardActions: (user: AdminUser) => ActionMenuEntry[];
}

function UserDialog({ dialog, me, onClose, cardActions }: UserDialogProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const block = useBlockUser();
  const sessions = useRevokeSessions();
  const reset2fa = useResetTwoFactor();
  const role = useChangeRole();
  const remove = useDeleteUser();
  const { user } = dialog;
  const name = personName(user);
  const person = <PersonRow user={user} meId={me.id} boxed />;
  const done = (message: string, icon: Parameters<typeof toast.show>[1]) => () => {
    onClose();
    toast.show(message, icon);
  };

  switch (dialog.kind) {
    case 'card':
      return <UserCard user={user} me={me} actions={cardActions} onClose={onClose} />;
    case 'block':
      return (
        <ConfirmDialog
          title={t('admin.confirm.block.title')}
          confirmLabel={t('admin.confirm.block.go')}
          icon="ban"
          danger
          run={() => block.mutateAsync(user.id)}
          onDone={done(t('admin.confirm.block.done', { name }), { icon: 'ban' })}
          onClose={onClose}
        >
          {person}
          <p className="small soft">{t('admin.confirm.block.text')}</p>
        </ConfirmDialog>
      );
    case 'sessions':
      return (
        <ConfirmDialog
          title={t('admin.confirm.sessions.title')}
          confirmLabel={t('admin.confirm.sessions.go')}
          icon="logout"
          run={() => sessions.mutateAsync(user.id)}
          onDone={done(t('admin.confirm.sessions.done', { name }), { icon: 'logout' })}
          onClose={onClose}
        >
          {person}
          <p className="small soft">{t('admin.confirm.sessions.text')}</p>
        </ConfirmDialog>
      );
    case 'reset2fa':
      return (
        <ConfirmDialog
          title={t('admin.confirm.reset2fa.title')}
          confirmLabel={t('admin.confirm.reset2fa.go')}
          icon="shield"
          danger
          otp
          run={(code) => reset2fa.mutateAsync({ id: user.id, totpCode: code })}
          onDone={done(t('admin.confirm.reset2fa.done', { name }), { icon: 'shield' })}
          onClose={onClose}
        >
          {person}
          <p className="small soft">{t('admin.confirm.reset2fa.text')}</p>
          <ul className="adm-bul gone">
            <Bullet icon="x">{t('admin.confirm.reset2fa.gone1')}</Bullet>
            <Bullet icon="x">{t('admin.confirm.reset2fa.gone2')}</Bullet>
            <Bullet icon="check">{t('admin.confirm.reset2fa.stay')}</Bullet>
          </ul>
        </ConfirmDialog>
      );
    case 'role': {
      const toAdmin = user.role !== 'admin';
      const next = toAdmin ? 'admin' : 'member';
      const label = toAdmin ? t('admin.confirm.role.toAdmin') : t('admin.confirm.role.toMember');
      return (
        <ConfirmDialog
          title={label}
          confirmLabel={label}
          icon="admin"
          otp
          run={(code) => role.mutateAsync({ id: user.id, role: next, totpCode: code })}
          onDone={done(t('admin.confirm.role.done', { name, role: t(`admin.roleLower.${next}`) }), {
            icon: 'admin',
          })}
          onClose={onClose}
        >
          {person}
          <p className="small soft">
            {toAdmin ? t('admin.confirm.role.toAdminText') : t('admin.confirm.role.toMemberText')}
          </p>
        </ConfirmDialog>
      );
    }
    case 'delete':
      return <DeleteDialog user={user} me={me} onClose={onClose} run={remove.mutateAsync} />;
  }
}

function Bullet({ icon, children }: { icon: 'x' | 'check'; children: ReactNode }) {
  return (
    <li>
      <Icon name={icon} />
      {children}
    </li>
  );
}

interface DeleteDialogProps {
  user: AdminUser;
  me: Me;
  onClose: () => void;
  run: (vars: { id: number; confirmEmail: string; totpCode: string }) => Promise<unknown>;
}

/**
 * Удаление по Р15: что удалится и что останется, ввод email участника и код 2FA.
 * Согласия участника на обезличенное обучение в ответе API нет, поэтому про прогнозы
 * сказано с условием: сервер сам оставит их без имени или удалит.
 */
function DeleteDialog({ user, me, onClose, run }: DeleteDialogProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const [email, setEmail] = useState('');
  const month = spendMonth();
  const matches = email.trim().toLowerCase() === user.email.toLowerCase();
  const gone = [
    t('admin.confirm.delete.gone1'),
    t('admin.confirm.delete.gone2'),
    t('admin.confirm.delete.gone3'),
    user.ai_mode === 'own' ? t('admin.confirm.delete.goneOwn') : t('admin.confirm.delete.goneShared'),
    t('admin.confirm.delete.gone5'),
    t('admin.confirm.delete.gone6'),
  ];
  const stay = [t('admin.confirm.delete.stayPredictions'), t('admin.confirm.delete.stayAudit')];
  if (user.ai_spent_month_usd > 0) {
    stay.push(
      t('admin.confirm.delete.staySpent', { month, amount: formatUsd(user.ai_spent_month_usd) }),
    );
  }
  return (
    <ConfirmDialog
      title={t('admin.confirm.delete.title')}
      confirmLabel={t('admin.confirm.delete.go')}
      icon="trash"
      danger
      wide
      otp
      ready={matches}
      run={(code) => run({ id: user.id, confirmEmail: email.trim(), totpCode: code })}
      onDone={() => {
        onClose();
        toast.show(t('admin.confirm.delete.done', { name: personName(user) }), { icon: 'trash' });
      }}
      onClose={onClose}
    >
      <PersonRow user={user} meId={me.id} boxed />
      <div className="adm-two">
        <div className="adm-box">
          <h4 className="bad-text">{t('admin.confirm.delete.goneTitle')}</h4>
          <ul className="adm-bul gone">
            {gone.map((text) => (
              <Bullet key={text} icon="x">
                {text}
              </Bullet>
            ))}
          </ul>
        </div>
        <div className="adm-box">
          <h4 className="good-text">{t('admin.confirm.delete.stayTitle')}</h4>
          <ul className="adm-bul stay">
            {stay.map((text) => (
              <Bullet key={text} icon="check">
                {text}
              </Bullet>
            ))}
          </ul>
        </div>
      </div>
      <Callout kind="warn" icon="alert">
        {t('admin.confirm.delete.warn')}
      </Callout>
      <Field
        id="adm-del-email"
        type="email"
        label={
          <>
            {t('admin.confirm.delete.emailLabel')} <b className="mono">{user.email}</b>
          </>
        }
        hint={t('admin.confirm.delete.emailHint')}
        value={email}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => setEmail(e.target.value)}
      />
    </ConfirmDialog>
  );
}
