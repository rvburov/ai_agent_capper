import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { isApiError } from '../../../api/errors';
import type { Me } from '../../../api/hooks/useMe';
import { paths } from '../../../app/paths';
import { Button, Callout, Card, Chip, Field, Icon, KeyValue, Skeleton, Toggle, useToast } from '../../../components';
import { useExportData, useConsent, useRequestDeletion, type ExportFormat } from '../../../features/account/api';
import { useLeaveAccount } from '../../../features/account/useLeaveAccount';
import { useAdminUsers } from '../../../features/admin/useAdminUsers';
import { apiErrorText } from '../../../features/analysis/codes';
import { useBetSummary } from '../../../features/bets/api';
import { useBookmakerList } from '../../../features/bookmakers/api';
import { formatDayMonth } from '../../../lib/format';
import { useHashTarget } from '../useHashTarget';
import './data.css';

/*
 * Кабинет → «Данные» (panelData макета, GDPR, Р15, В10): экспорт всех своих данных сразу
 * скачиванием, откуда берутся данные о матчах, согласие на обезличенные прогнозы, статус
 * импорта старого бота и удаление аккаунта с паролем и кодом 2FA (7 дней на отмену).
 */

export function DataTab({ me }: { me: Me }) {
  useHashTarget(true);
  const admin = me.role === 'admin';
  const summary = useBetSummary({});
  const legacy = useBetSummary({ source: 'legacy' });
  const legacyBets = legacy.data ? legacy.data.settled + legacy.data.open : null;
  // Импорт выполняет администратор командой на сервере: статус видит он и тот, кому перенесли ставки
  const showImport = admin || (legacyBets ?? 0) > 0;
  const total = summary.data ? summary.data.settled + summary.data.open : null;
  return (
    <div className="grid">
      <div className="col-7 profile-col">
        <ExportCard />
        <SourcesCard />
      </div>
      <div className="col-5 profile-col">
        <ConsentCard me={me} />
        {showImport && <ImportCard legacyBets={legacyBets} legacyOpen={legacy.data?.open ?? 0} />}
      </div>
      <div className="col-12 profile-col">
        <DangerCard me={me} bets={total} />
      </div>
    </div>
  );
}

function ExportCard() {
  const { t } = useTranslation();
  const toast = useToast();
  const exportData = useExportData();
  const summary = useBetSummary({});
  const books = useBookmakerList();
  const busy = useRef(false);

  function download(format: ExportFormat) {
    if (busy.current) return;
    busy.current = true;
    exportData.mutate(format, {
      onSuccess: (name) => toast.show(t('profile.data.export.started', { name }), { icon: 'download' }),
      onError: (error) => toast.show(apiErrorText(error), { icon: 'alert' }),
      onSettled: () => {
        busy.current = false;
      },
    });
  }

  const s = summary.data;
  const betsText = s
    ? [
        t('profile.data.export.bets', { count: s.settled + s.open }),
        s.open ? t('profile.data.export.betsOpen', { count: s.open }) : null,
        s.legacy_settled ? t('profile.data.export.betsBot', { count: s.legacy_settled }) : null,
      ]
        .filter(Boolean)
        .join(', ')
    : null;
  const items = books.data?.items ?? [];
  const hidden = items.filter((item) => item.archived_at !== null).length;
  const booksText = books.data
    ? [t('profile.data.export.books', { count: items.length }), hidden ? t('profile.data.export.booksHidden', { count: hidden }) : null]
        .filter(Boolean)
        .join(', ')
    : null;
  const pending = exportData.isPending ? exportData.variables : null;

  return (
    <Card
      id="profile-export"
      className="profile-anchor"
      title={t('profile.data.export.title')}
      subtitle={t('profile.data.export.subtitle')}
      foot={
        <>
          <Button kind="primary" icon="download" loading={pending === 'json'} disabled={pending === 'csv'} onClick={() => download('json')}>
            {t('profile.data.export.json')}
          </Button>
          <Button icon="download" loading={pending === 'csv'} disabled={pending === 'json'} onClick={() => download('csv')}>
            {t('profile.data.export.csv')}
          </Button>
        </>
      }
    >
      <KeyValue
        items={[
          { key: 'bets', label: t('profile.data.export.rows.bets'), value: betsText ?? <Skeleton width={120} /> },
          { key: 'events', label: t('profile.data.export.rows.events'), value: t('profile.data.export.rows.eventsValue') },
          { key: 'bank', label: t('profile.data.export.rows.bank'), value: t('profile.data.export.rows.bankValue') },
          { key: 'books', label: t('profile.data.export.rows.books'), value: booksText ?? <Skeleton width={100} /> },
          { key: 'strategy', label: t('profile.data.export.rows.strategy'), value: t('profile.data.export.rows.strategyValue') },
          { key: 'ai', label: t('profile.data.export.rows.ai'), value: t('profile.data.export.rows.aiValue') },
          { key: 'notif', label: t('profile.data.export.rows.notif'), value: t('profile.data.export.rows.notifValue') },
          { key: 'without', label: t('profile.data.export.rows.without'), value: t('profile.data.export.rows.withoutValue') },
        ]}
      />
      <p className="xsmall muted profile-data-p">{t('profile.data.export.note')}</p>
    </Card>
  );
}

function SourcesCard() {
  const { t } = useTranslation();
  const items = [
    { icon: 'database', key: 'archives' },
    { icon: 'globe', key: 'news' },
    { icon: 'edit', key: 'odds' },
    { icon: 'target', key: 'closing' },
    { icon: 'clock', key: 'paid' },
  ] as const;
  return (
    <Card title={t('profile.data.sources.title')} subtitle={t('profile.data.sources.subtitle')}>
      <ul className="profile-bullets">
        {items.map((item) => (
          <li key={item.key}>
            <Icon name={item.icon} />
            <span>
              <b>{t(`profile.data.sources.${item.key}.title`)}</b> {t(`profile.data.sources.${item.key}.text`)}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function ConsentCard({ me }: { me: Me }) {
  const { t } = useTranslation();
  const toast = useToast();
  const consent = useConsent();
  const on = consent.isPending && consent.variables !== undefined ? consent.variables : me.consent_training;
  return (
    <Card id="profile-consent" className="profile-anchor" title={t('profile.data.consent.title')} subtitle={t('profile.data.consent.subtitle')}>
      <Toggle
        id="profile-consent-on"
        label={t('profile.data.consent.label')}
        hint={t('profile.data.consent.hint')}
        checked={on}
        disabled={consent.isPending}
        onChange={(value) =>
          consent.mutate(value, {
            onSuccess: () => toast.show(t(value ? 'profile.data.consent.given' : 'profile.data.consent.revoked'), { icon: value ? 'check' : 'x' }),
            onError: (error) => toast.show(apiErrorText(error), { icon: 'alert' }),
          })
        }
      />
      <p className="profile-note">
        <Icon name={on ? 'check' : 'info'} />
        <span>{t(on ? 'profile.data.consent.noteOn' : 'profile.data.consent.noteOff')}</span>
      </p>
    </Card>
  );
}

function ImportCard({ legacyBets, legacyOpen }: { legacyBets: number | null; legacyOpen: number }) {
  const { t } = useTranslation();
  const done = (legacyBets ?? 0) > 0;
  return (
    <Card
      id="profile-import"
      className="profile-anchor"
      title={t('profile.data.import.title')}
      subtitle={t('profile.data.import.subtitle')}
      actions={
        legacyBets === null ? undefined : done ? (
          <Chip kind="good" icon="check">
            {t('profile.data.import.done')}
          </Chip>
        ) : (
          <Chip kind="outline">{t('profile.data.import.none')}</Chip>
        )
      }
    >
      <KeyValue
        items={[
          {
            key: 'moved',
            label: t('profile.data.import.moved'),
            value:
              legacyBets === null ? (
                <Skeleton width={100} />
              ) : done ? (
                [t('profile.data.import.movedValue', { count: legacyBets }), legacyOpen ? t('profile.data.import.open', { count: legacyOpen }) : null]
                  .filter(Boolean)
                  .join(', ')
              ) : (
                t('profile.data.import.movedNone')
              ),
          },
          { key: 'who', label: t('profile.data.import.who'), value: t('profile.data.import.whoValue') },
        ]}
      />
      <p className="xsmall muted profile-data-p">{t('profile.data.import.note')}</p>
      <p className="xsmall muted profile-data-p">
        {t('profile.data.import.again')} <span className="mono">{t('profile.data.import.command')}</span> {t('profile.data.import.againTail')}
      </p>
    </Card>
  );
}

/** Что удалится и что останется (одинаково в форме и для единственного администратора). */
function DeleteLists({ consent, bets }: { consent: boolean; bets: number | null }) {
  const { t } = useTranslation();
  return (
    <div className="profile-del-grid">
      <div>
        <h4>{t('profile.data.danger.removed')}</h4>
        <ul className="profile-bullets badlist">
          <li>
            <Icon name="trash" />
            <span>{bets === null ? t('profile.data.danger.betsPlain') : t('profile.data.danger.bets', { count: bets })}</span>
          </li>
          {(['strategy', 'key', 'sessions'] as const).map((key) => (
            <li key={key}>
              <Icon name="trash" />
              <span>{t(`profile.data.danger.list.${key}`)}</span>
            </li>
          ))}
        </ul>
      </div>
      <div>
        <h4>{t('profile.data.danger.kept')}</h4>
        <ul className="profile-bullets lock">
          {consent ? (
            <li>
              <Icon name="shield" />
              <span>
                {t('profile.data.danger.forecastsKept')} <a href="#profile-consent">{t('profile.data.danger.change')}</a>)
              </span>
            </li>
          ) : (
            <li>
              <Icon name="x" />
              <span>{t('profile.data.danger.forecastsGone')}</span>
            </li>
          )}
          <li>
            <Icon name="coins" />
            <span>{t('profile.data.danger.spent')}</span>
          </li>
          <li>
            <Icon name="history" />
            <span>{t('profile.data.danger.audit')}</span>
          </li>
        </ul>
      </div>
    </div>
  );
}

// Ошибки сервера — к полю: пароль или код; остальное — плашкой
const PASSWORD_CODES: ReadonlySet<string> = new Set(['auth.current_password_invalid']);
const CODE_CODES: ReadonlySet<string> = new Set(['auth.invalid_code', 'auth.two_factor_locked']);

function DangerHead() {
  const { t } = useTranslation();
  return (
    <div className="card-head">
      <div className="card-head-text">
        <div className="eyebrow">{t('profile.data.danger.eyebrow')}</div>
        <h3 id="profile-delete-title">{t('profile.data.danger.title')}</h3>
        <div className="card-sub">{t('profile.data.danger.subtitle')}</div>
      </div>
    </div>
  );
}

// Участнику список пользователей не нужен и не положен (/admin/* — только администратор, Р14):
// запрос делает только карточка администратора
function DangerCard({ me, bets }: { me: Me; bets: number | null }) {
  if (me.role === 'admin') return <AdminDangerCard me={me} bets={bets} />;
  return (
    <section className="card profile-anchor profile-danger" id="profile-delete" aria-labelledby="profile-delete-title">
      <DangerHead />
      <DeleteForm me={me} bets={bets} />
    </section>
  );
}

/** Единственного активного администратора удалить нельзя: сначала назначить другого. */
function AdminDangerCard({ me, bets }: { me: Me; bets: number | null }) {
  const { t } = useTranslation();
  const users = useAdminUsers();
  const otherAdmins = users.data
    ? users.data.filter((u) => u.role === 'admin' && u.status === 'active' && u.id !== me.id).length
    : null;

  if (otherAdmins === 0) {
    return (
      <section className="card profile-anchor profile-danger" id="profile-delete" aria-labelledby="profile-delete-title">
        <DangerHead />
        <div className="card-body">
          <Callout kind="info" icon="admin">
            <b>{t('profile.data.danger.lastAdminTitle')}</b> {t('profile.data.danger.lastAdminText')}
          </Callout>
          <DeleteLists consent={me.consent_training} bets={bets} />
        </div>
        <div className="card-foot">
          <Button kind="danger" icon="trash" disabled>
            {t('profile.data.danger.submit')}
          </Button>
          <Button icon="users" to={paths.admin('users')}>
            {t('profile.data.danger.users')}
          </Button>
        </div>
      </section>
    );
  }
  return (
    <section className="card profile-anchor profile-danger" id="profile-delete" aria-labelledby="profile-delete-title">
      <DangerHead />
      <DeleteForm me={me} bets={bets} />
    </section>
  );
}

function DeleteForm({ me, bets }: { me: Me; bets: number | null }) {
  const { t } = useTranslation();
  const request = useRequestDeletion();
  const leave = useLeaveAccount();
  const passwordId = useId();
  const codeId = useId();
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [errors, setErrors] = useState<{ password?: string; code?: string; form?: string }>({});
  const busy = useRef(false);

  // Кнопка на время запроса неактивна и теряет фокус: после ошибки ставим его в поле с ошибкой,
  // иначе клавиатура и программа чтения экрана начинают со страницы целиком
  function focusField(id: string) {
    requestAnimationFrame(() => document.getElementById(id)?.focus());
  }

  async function submit() {
    if (busy.current) return;
    const digits = code.replace(/\s/g, '');
    const next: typeof errors = {};
    if (!password) next.password = t('profile.data.danger.errors.password');
    if (!/^\d{6}$/.test(digits)) next.code = t('profile.data.danger.errors.code');
    setErrors(next);
    if (next.password || next.code) {
      focusField(next.password ? passwordId : codeId);
      return;
    }
    busy.current = true;
    try {
      const done = await request.mutateAsync({ password, code: digits });
      leave(t('profile.data.danger.requested', { date: formatDayMonth(done.delete_at) }));
    } catch (error) {
      const text = apiErrorText(error);
      if (isApiError(error) && PASSWORD_CODES.has(error.code)) {
        setErrors({ password: text });
        focusField(passwordId);
      } else if (isApiError(error) && CODE_CODES.has(error.code)) {
        setErrors({ code: text });
        focusField(codeId);
      } else {
        setErrors({ form: text });
        // код одноразовый — поле очищено, вводить заново начинают с него
        focusField(codeId);
      }
      setCode('');
    } finally {
      busy.current = false;
    }
  }

  return (
    <form
      className="profile-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="card-body">
        <DeleteLists consent={me.consent_training} bets={bets} />
        <p className="small soft profile-data-p">{t('profile.data.danger.text')}</p>
        <div className="profile-fields collapse profile-del-fields">
          <Field
            id={passwordId}
            label={t('profile.data.danger.password')}
            type="password"
            autoComplete="current-password"
            value={password}
            error={errors.password}
            onChange={(event) => {
              setPassword(event.target.value);
              setErrors((e) => ({ ...e, password: undefined, form: undefined }));
            }}
          />
          <Field
            id={codeId}
            label={t('profile.data.danger.code')}
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="123456"
            maxLength={7}
            value={code}
            hint={t('profile.data.danger.codeHint')}
            error={errors.code}
            onChange={(event) => {
              setCode(event.target.value);
              setErrors((e) => ({ ...e, code: undefined, form: undefined }));
            }}
          />
        </div>
        {errors.form && (
          <Callout kind="bad" role="alert">
            {errors.form}
          </Callout>
        )}
      </div>
      <div className="card-foot">
        <Button kind="danger" type="submit" icon="trash" loading={request.isPending}>
          {t('profile.data.danger.submit')}
        </Button>
      </div>
    </form>
  );
}
