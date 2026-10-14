import { useTranslation } from 'react-i18next';

import type { Me } from '../../../api/hooks/useMe';
import { BrandMark } from '../../../app/layout/BrandMark';
import { Button, Callout, useToast } from '../../../components';
import { useCancelDeletion } from '../../../features/account/api';
import { apiErrorText } from '../../../features/analysis/codes';
import { useLogout } from '../../../features/auth/useLogout';
import { formatDateLong } from '../../../lib/format';
import './deletion.css';

/**
 * Аккаунт ждет удаления (В10): вместо оболочки и экранов — один экран с датой и «Отменить
 * удаление». Сервер в это время отвечает на все, кроме профиля, отмены и выхода, 403
 * account.deletion_pending, поэтому экраны приложения не открываются вовсе. После отмены
 * профиль перечитывается — приложение снова открыто там же, куда человек шел.
 */
export function DeletionPendingScreen({ me }: { me: Me }) {
  const { t } = useTranslation();
  const toast = useToast();
  const cancel = useCancelDeletion();
  const { logout, pending } = useLogout();
  const date = me.deletion_at ? formatDateLong(me.deletion_at) : null;

  return (
    <main className="full-state deletion-screen" id="main">
      <section className="card deletion-card" aria-labelledby="deletion-title">
        <div className="card-head">
          <div className="card-head-text">
            <div className="eyebrow deletion-brand">
              <BrandMark />
              {t('app.name')}
            </div>
            {/* Единственный экран приложения в это время — заголовок первого уровня */}
            <h1 className="deletion-title" id="deletion-title">
              {date ? t('profile.deletion.title', { date }) : t('profile.deletion.titlePlain')}
            </h1>
          </div>
        </div>
        <div className="card-body">
          <Callout kind="bad" icon="trash" role="status">
            {t('profile.deletion.text')}
          </Callout>
          <p className="small soft deletion-p">{t('profile.deletion.who', { email: me.email })}</p>
          <p className="xsmall muted deletion-p">{t('profile.deletion.after')}</p>
        </div>
        <div className="card-foot">
          <Button
            kind="primary"
            icon="refresh"
            loading={cancel.isPending}
            onClick={() =>
              cancel.mutate(undefined, {
                onSuccess: () => toast.show(t('profile.deletion.cancelled'), { icon: 'check' }),
                onError: (error) => toast.show(apiErrorText(error), { icon: 'alert' }),
              })
            }
          >
            {t('profile.deletion.cancel')}
          </Button>
          <Button kind="ghost" icon="logout" loading={pending} onClick={logout}>
            {t('profile.deletion.logout')}
          </Button>
        </div>
      </section>
    </main>
  );
}
