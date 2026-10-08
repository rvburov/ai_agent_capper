import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { errorMessage, isApiError } from '../../api/errors';
import { Button, Callout, Field, Modal, useToast } from '../../components';
import { downloadText, recoveryCodesText } from '../../features/profile/recoveryCodesFile';
import { useReissueRecoveryCodes } from '../../features/profile/useRecoveryCodes';
import { formatDateTime } from '../../lib/format';

interface RecoveryCodesModalProps {
  open: boolean;
  onClose: () => void;
  email: string;
}

/**
 * Перевыпуск резервных кодов (codesModal макета). Сервер хранит только хеши, поэтому
 * прежние коды показать нельзя: подтверждаем текущим кодом 2FA и показываем новые один раз.
 */
export function RecoveryCodesModal({ open, onClose, email }: RecoveryCodesModalProps) {
  if (!open) return null;
  return <RecoveryCodesDialog onClose={onClose} email={email} />;
}

function RecoveryCodesDialog({ onClose, email }: Omit<RecoveryCodesModalProps, 'open'>) {
  const { t } = useTranslation();
  const toast = useToast();
  const reissue = useReissueRecoveryCodes();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [createdAt, setCreatedAt] = useState<Date | null>(null);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const digits = code.replace(/\s/g, '');
    if (!/^\d{6}$/.test(digits)) {
      setError(t('profile.codes.codeError'));
      return;
    }
    reissue.mutate(digits, {
      onSuccess: (fresh) => {
        setCodes(fresh);
        setCreatedAt(new Date());
        toast.show(t('profile.codes.toast'), { icon: 'refresh' });
      },
      onError: (err) => {
        // 401 — сеанс завершен после 5 неверных кодов: клиент запросов уведет на вход
        if (isApiError(err) && err.status === 401) {
          toast.show(errorMessage(err), { icon: 'alert' });
          onClose();
          return;
        }
        setError(errorMessage(err));
        setCode('');
      },
    });
  }

  async function onCopy(list: readonly string[]) {
    try {
      await navigator.clipboard.writeText(list.join('\n'));
      toast.show(t('profile.codes.copied'), { icon: 'copy' });
    } catch {
      toast.show(t('profile.codes.copyFailed'), { icon: 'alert' });
    }
  }

  function onDownload(list: readonly string[]) {
    downloadText(
      t('profile.codes.fileName'),
      recoveryCodesText({
        title: t('profile.codes.fileTitle'),
        account: t('profile.codes.fileAccount', { email }),
        created: t('profile.codes.fileCreated', { date: formatDateTime(createdAt, { calendar: false }) }),
        note: t('profile.codes.fileNote'),
        codes: list,
      }),
    );
  }

  if (codes) {
    return (
      <Modal
        key="codes"
        open
        onClose={onClose}
        title={t('profile.codes.title')}
        footer={
          <>
            <Button icon="download" onClick={() => onDownload(codes)}>
              {t('profile.codes.download')}
            </Button>
            <Button kind="ghost" icon="copy" onClick={() => void onCopy(codes)}>
              {t('profile.codes.copy')}
            </Button>
            <Button kind="primary" onClick={onClose}>
              {t('profile.codes.done')}
            </Button>
          </>
        }
      >
        <Callout kind="good" role="status">
          {t('profile.codes.created')}
        </Callout>
        <p className="small soft">{t('profile.codes.keep')}</p>
        <ol className="profile-codes" aria-label={t('profile.codes.listLabel')}>
          {codes.map((value) => (
            <li key={value}>{value}</li>
          ))}
        </ol>
        <div className="xsmall muted">{t('profile.codes.once')}</div>
      </Modal>
    );
  }

  return (
    <Modal
      key="confirm"
      open
      onClose={onClose}
      title={t('profile.codes.title')}
      footer={
        <>
          <Button kind="ghost" onClick={onClose}>
            {t('profile.form.cancel')}
          </Button>
          <Button kind="primary" type="submit" form="profile-codes-form" icon="refresh" loading={reissue.isPending}>
            {t('profile.codes.create')}
          </Button>
        </>
      }
    >
      <Callout kind="warn">
        <b>{t('profile.codes.warnStrong')}</b> {t('profile.codes.warn')}
      </Callout>
      <p className="small soft">{t('profile.codes.why')}</p>
      <form id="profile-codes-form" noValidate onSubmit={onSubmit}>
        <Field
          id="profile-codes-otp"
          label={t('profile.codes.code')}
          hint={t('profile.codes.codeHint')}
          error={error}
          value={code}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={7}
          placeholder="123456"
          onChange={(e) => {
            setCode(e.target.value.replace(/[^\d\s]/g, ''));
            setError(null);
          }}
        />
      </form>
    </Modal>
  );
}
