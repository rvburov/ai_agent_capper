import { useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { errorMessage } from '../../api/errors';
import type { Me } from '../../api/hooks/useMe';
import { Button, Dropdown, FieldShell, KeyValue, Skeleton, describedById, useToast } from '../../components';
import { timeZoneDative, timeZoneName, timeZoneOptions } from '../../features/profile/timezones';
import { usePublicSettings } from '../../features/profile/usePublicSettings';
import { useUpdateProfile } from '../../features/profile/useUpdateProfile';

/** «Регион и язык»: часовой пояс (единый Dropdown), валюта программы и язык. */
export function RegionCard({ me }: { me: Me }) {
  const { t } = useTranslation();
  const toast = useToast();
  const update = useUpdateProfile();
  const settings = usePublicSettings();
  const [tz, setTz] = useState(me.tz);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const options = useMemo(() => timeZoneOptions(t, me.tz), [t, me.tz]);
  const dirty = tz !== me.tz;
  const hint = t('profile.region.tzHint');

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!dirty) return;
    update.mutate(
      { tz },
      {
        onSuccess: (me) => {
          setSaved(true);
          const name = timeZoneName(t, me.tz);
          const city = timeZoneDative(t, me.tz);
          toast.show(
            city ? t('profile.region.toastCity', { name, city }) : t('profile.region.toast', { name }),
            { icon: 'globe' },
          );
        },
        onError: (err) => setError(errorMessage(err)),
      },
    );
  }

  const status = dirty ? t('profile.form.dirty') : saved ? t('profile.form.saved') : '';
  return (
    <section className="card profile-anchor" id="profile-region" aria-labelledby="profile-region-title">
      <div className="card-head">
        <div className="card-head-text">
          <h3 id="profile-region-title">{t('profile.region.title')}</h3>
          <div className="card-sub">{t('profile.region.subtitle')}</div>
        </div>
      </div>
      <form className="profile-form" noValidate onSubmit={onSubmit}>
        <div className="card-body">
          <FieldShell id="profile-tz" label={t('profile.region.tz')} hint={hint} error={error}>
            <Dropdown
              id="profile-tz"
              label={t('profile.region.tz')}
              options={options}
              value={tz}
              invalid={Boolean(error)}
              describedBy={describedById('profile-tz', hint, error)}
              onChange={(value) => {
                setTz(value);
                setError(null);
                setSaved(false);
              }}
            />
          </FieldShell>
          <KeyValue
            items={[
              {
                label: t('profile.region.currency'),
                value: settings.data ? (
                  t(`profile.currency.${settings.data.currency}`)
                ) : settings.isError ? (
                  '—'
                ) : (
                  <Skeleton width={90} />
                ),
              },
              { label: t('profile.region.language'), value: t('profile.region.languageValue') },
            ]}
          />
          <p className="xsmall muted">{t('profile.region.note')}</p>
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
