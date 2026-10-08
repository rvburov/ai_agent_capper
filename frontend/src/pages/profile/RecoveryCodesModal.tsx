import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { errorMessage, isApiError } from '../../api/errors';
import { Button, Callout, Checkbox, Field, Modal, useToast } from '../../components';
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
 * В отличие от макета, где коды можно открыть снова, окно с новыми кодами закрывается только
 * после отметки «Я сохранил(а)» — как шаг кодов при настройке 2FA.
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
  const [saved, setSaved] = useState(false);
  const [savedError, setSavedError] = useState<string | null>(null);
  const savedRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLOListElement>(null);

  // Окно с кодами монтируется заново (key="codes") и ставит фокус на первое поле — флажок
  // под кодами. Переносим фокус на сам список, чтобы коды прочитали первыми. В следующем
  // кадре: после эффектов окна (в StrictMode они выполняются дважды)
  useEffect(() => {
    if (!codes) return;
    const frame = requestAnimationFrame(() => listRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [codes]);

  // Пока сервер выпускает коды, окно не закрываем: иначе старые уже не действуют,
  // а новые некому показать
  function closeConfirm() {
    if (!reissue.isPending) onClose();
  }

  // Esc, фон, крестик и «Готово» закрывают окно с кодами только после отметки «сохранил»
  function closeCodes() {
    if (saved) {
      onClose();
      return;
    }
    setSavedError(t('profile.codes.savedRequired'));
    savedRef.current?.focus();
  }

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
        // Файл хранят годами: дата с годом, чтобы отличать выпуски
        created: t('profile.codes.fileCreated', {
          date: formatDateTime(createdAt, { calendar: false, year: 'always' }),
        }),
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
        onClose={closeCodes}
        title={t('profile.codes.title')}
        footer={
          <>
            <Button icon="download" onClick={() => onDownload(codes)}>
              {t('profile.codes.download')}
            </Button>
            <Button kind="ghost" icon="copy" onClick={() => void onCopy(codes)}>
              {t('profile.codes.copy')}
            </Button>
            <Button kind="primary" onClick={closeCodes}>
              {t('profile.codes.done')}
            </Button>
          </>
        }
      >
        <Callout kind="good" role="status">
          {t('profile.codes.created')}
        </Callout>
        <p className="small soft">{t('profile.codes.keep')}</p>
        <ol ref={listRef} className="profile-codes" tabIndex={-1} aria-label={t('profile.codes.listLabel')}>
          {codes.map((value) => (
            <li key={value}>{value}</li>
          ))}
        </ol>
        <div className="xsmall muted">{t('profile.codes.once')}</div>
        <div className="profile-codes-saved">
          <Checkbox
            ref={savedRef}
            id="profile-codes-saved"
            checked={saved}
            aria-invalid={savedError ? true : undefined}
            label={t('profile.codes.saved')}
            onChange={(value) => {
              setSaved(value);
              if (value) setSavedError(null);
            }}
          />
          {savedError && (
            <div className="field-error" role="alert">
              {savedError}
            </div>
          )}
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      key="confirm"
      open
      onClose={closeConfirm}
      title={t('profile.codes.title')}
      footer={
        <>
          <Button kind="ghost" disabled={reissue.isPending} onClick={closeConfirm}>
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
