import { useTranslation } from 'react-i18next';

import type { Me } from '../../api/hooks/useMe';
import { ActionMenuList, Chip, Modal, Skeleton, type ActionMenuEntry } from '../../components';
import { maskIp, spendMonth } from '../../features/admin/display';
import type { AdminUser } from '../../features/admin/types';
import { useAdminUser } from '../../features/admin/useAdminUsers';
import { deviceName } from '../../features/profile/devices';
import { RESULT_CHIPS } from '../../features/profile/loginLog';
import { formatDateTime, formatUsd } from '../../lib/format';
import { HowTo, LoadError, PersonRow, RoleChip, StatusChip, TwoFactorChip } from './parts';

interface UserCardProps {
  user: AdminUser;
  me: Me;
  actions: (user: AdminUser) => ActionMenuEntry[];
  onClose: () => void;
}

/**
 * Карточка участника: активность (последний вход, сеансы, входы) и те же действия, что в меню.
 * В макете ее нет — она нужна, чтобы администратор видел входы участника перед блокировкой
 * или сбросом. Только активность и расход на ИИ: ставок, банка и стратегии здесь нет (Р14).
 */
export function UserCard({ user, me, actions, onClose }: UserCardProps) {
  const { t } = useTranslation();
  const detail = useAdminUser(user.id);
  const current: AdminUser = detail.data ?? user;
  const month = spendMonth();
  const unknown = t('profile.unknownDevice');

  return (
    <Modal open wide onClose={onClose} title={t('admin.card.title')}>
      <PersonRow user={current} meId={me.id} boxed />
      <div className="row adm-chips">
        <RoleChip role={current.role} />
        <StatusChip status={current.status} />
        <TwoFactorChip enabled={current.totp_enabled} />
        <Chip kind={current.ai_mode === 'own' ? 'info' : 'outline'} icon="key">
          {current.ai_mode === 'own' ? t('admin.users.keyOwn') : t('admin.users.keyShared')}
        </Chip>
      </div>
      <dl className="adm-facts four">
        <div>
          <dt>{t('admin.card.lastLogin')}</dt>
          <dd>{current.last_login_at ? formatDateTime(current.last_login_at) : t('admin.users.never')}</dd>
        </div>
        <div>
          <dt>{t('admin.card.sessions')}</dt>
          <dd>{detail.data ? detail.data.active_sessions : <Skeleton width={24} />}</dd>
        </div>
        <div>
          <dt>{t('admin.card.analyses', { month })}</dt>
          <dd>{current.analyses_month}</dd>
        </div>
        <div>
          <dt>{t('admin.card.spent', { month })}</dt>
          <dd>{formatUsd(current.ai_spent_month_usd)}</dd>
        </div>
      </dl>
      <div className="stack" style={{ gap: 6 }}>
        <div className="eyebrow">{t('admin.card.recent')}</div>
        <div className="xsmall muted">{t('admin.card.recentHint')}</div>
        {detail.isPending && <Skeleton lines={3} height={16} />}
        {detail.isError && <LoadError error={detail.error} onRetry={() => void detail.refetch()} />}
        {detail.data &&
          (detail.data.recent_logins.length ? (
            <ul className="adm-logins" aria-label={t('admin.card.recent')}>
              {detail.data.recent_logins.map((event, i) => {
                const chip = RESULT_CHIPS[event.result];
                return (
                  <li key={`${event.at}-${i}`}>
                    <span className="adm-nowrap">{formatDateTime(event.at)}</span>
                    <Chip kind={chip.kind} icon={chip.icon}>
                      {t(`profile.log.results.${event.result}`)}
                    </Chip>
                    <span className="adm-logins-meta">
                      {deviceName(event.device_label, unknown)} · <span className="adm-ip">{maskIp(event.ip)}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="small soft">{t('admin.card.recentEmpty')}</p>
          ))}
      </div>
      <div className="stack" style={{ gap: 6 }}>
        <div className="eyebrow">{t('admin.card.actions')}</div>
        <div className="adm-card-actions">
          <ActionMenuList
            items={actions(current)}
            label={t('admin.card.actions')}
            onPick={(item) => item.onSelect()}
          />
        </div>
      </div>
      <HowTo>{t('admin.card.privacy')}</HowTo>
    </Modal>
  );
}
