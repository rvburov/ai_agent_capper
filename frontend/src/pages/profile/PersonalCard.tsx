import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { errorMessage } from '../../api/errors';
import type { Me } from '../../api/hooks/useMe';
import { Button, Field, useToast } from '../../components';
import { useUpdateProfile } from '../../features/profile/useUpdateProfile';
import { formatDateLong } from '../../lib/format';

const NAME_MIN = 2;
const NAME_MAX = 100;

/** «Личные данные»: имя меняется, email — только для чтения (это логин). */
export function PersonalCard({ me }: { me: Me }) {
  const { t } = useTranslation();
  const toast = useToast();
  const update = useUpdateProfile();
  const [name, setName] = useState(me.display_name);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const dirty = name.trim() !== me.display_name;

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const value = name.trim();
    const length = Array.from(value).length;
    if (length < NAME_MIN) return setError(t('profile.personal.nameShort'));
    if (length > NAME_MAX) return setError(t('profile.personal.nameLong'));
    update.mutate(
      { display_name: value },
      {
        onSuccess: (me) => {
          setName(me.display_name);
          setSaved(true);
          toast.show(t('profile.personal.toast', { name: me.display_name }), { icon: 'check' });
        },
        onError: (err) => setError(errorMessage(err)),
      },
    );
  }

  const status = dirty ? t('profile.form.dirty') : saved ? t('profile.form.saved') : '';
  return (
    <section className="card profile-anchor" id="profile-personal" aria-labelledby="profile-personal-title">
      <div className="card-head">
        <div className="card-head-text">
          <h3 id="profile-personal-title">{t('profile.personal.title')}</h3>
          <div className="card-sub">
            {t('profile.personal.created', { date: formatDateLong(me.created_at) })}
          </div>
        </div>
      </div>
      <form className="profile-form" noValidate onSubmit={onSubmit}>
        <div className="card-body">
          <Field
            id="profile-name"
            label={t('profile.personal.name')}
            value={name}
            autoComplete="name"
            maxLength={NAME_MAX + 20}
            hint={
              me.role === 'admin' ? t('profile.personal.nameHintAdmin') : t('profile.personal.nameHintMember')
            }
            error={error}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
              setSaved(false);
            }}
          />
          <Field
            id="profile-email"
            type="email"
            label={t('profile.personal.email')}
            value={me.email}
            readOnly
            hint={t('profile.personal.emailHint')}
          />
        </div>
        <div className="card-foot">
          <Button kind="primary" type="submit" icon="check" disabled={!dirty} loading={update.isPending}>
            {t('profile.form.save')}
          </Button>
          <span className="profile-status" aria-live="polite">
            {status}
          </span>
        </div>
      </form>
    </section>
  );
}
