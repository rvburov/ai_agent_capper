import { useMemo, useState, type FormEvent } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { errorMessage } from '../../api/errors';
import type { Me } from '../../api/hooks/useMe';
import {
  Button,
  Callout,
  Card,
  Checkbox,
  Dropdown,
  Field,
  FieldShell,
  Icon,
  PushNotice,
  Segmented,
  Skeleton,
  useToast,
} from '../../components';
import { limitText } from '../../features/admin/limits';
import {
  MESSAGE_MAX,
  MESSAGE_WARN_LEFT,
  SENT_SHOWN,
  messageText,
  recipientsOf,
  useAdminMessages,
  useRecipientPush,
  useSendMessage,
  type AdminMessage,
} from '../../features/admin/messages';
import { personName } from '../../features/admin/people';
import { useAdminLimits } from '../../features/admin/useAdminAi';
import { useAdminUsers } from '../../features/admin/useAdminUsers';
import { cx } from '../../lib/cx';
import { formatDateTime } from '../../lib/format';
import { Item, LoadError } from './parts';
import './MessagesTab.css';

type Audience = 'all' | 'one';

const TEXT_ID = 'adm-msg-text';
const USER_ID = 'adm-msg-user';

/**
 * «Администрирование → Сообщение» (PANELS.message макета admin.js): короткое уведомление всем
 * активным участникам или одному — в центр уведомлений на сайте и с флажком «Также push» (В8)
 * — push тем, у кого он включен («Push включен у N из M», только число, Р14). Справа — как его
 * увидят в колокольчике и push на телефоне, последние отправленные (те же записи, что в журнале).
 */
export function MessagesTab({ me }: { me: Me }) {
  const { t } = useTranslation();
  const toast = useToast();
  const users = useAdminUsers();
  const messages = useAdminMessages();
  const limits = useAdminLimits();
  const send = useSendMessage();
  const recipients = useMemo(() => recipientsOf(users.data, me.id), [users.data, me.id]);
  const [audience, setAudience] = useState<Audience>('all');
  const [picked, setPicked] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [alsoPush, setAlsoPush] = useState(true);

  const chosen = recipients.find((user) => String(user.id) === picked) ?? recipients[0] ?? null;
  // Сколько получит «всем» — число сервера (правило получателей — его, app/services/admin_messages.py);
  // список «одному» — люди из /admin/users, сервер все равно проверит выбранного
  const everyone = messages.data?.recipients_all ?? null;
  const count = audience === 'all' ? (everyone ?? 0) : chosen ? 1 : 0;
  const body = messageText(text);
  const canSend = body !== '' && count > 0 && !send.isPending;
  // У скольких получателей push: «всем» — число сервера, одному — из предпросмотра (нужен текст)
  const one = useRecipientPush(audience === 'one' && chosen ? chosen.id : null, body);
  const pushCount = audience === 'all' ? (messages.data?.push_recipients_all ?? null) : (one.data ?? null);
  let pushHint: string;
  if (audience === 'all') pushHint = t('admin.messages.pushAll', { count: pushCount ?? 0, total: everyone ?? 0 });
  else if (pushCount === null) pushHint = t('admin.messages.pushOneUnknown');
  else pushHint = pushCount > 0 ? t('admin.messages.pushOne') : t('admin.messages.pushOneOff');
  const left = MESSAGE_MAX - text.length;

  const templates = [
    { id: 'server', label: t('admin.messages.templateServer'), text: t('admin.messages.templateServerText') },
    ...(limits.data
      ? [
          {
            id: 'limits',
            label: t('admin.messages.templateLimits'),
            text: t('admin.messages.templateLimitsText', { limit: limitText(limits.data.defaults) }),
          },
        ]
      : []),
    { id: 'push', label: t('admin.messages.templatePush'), text: t('admin.messages.templatePushText') },
  ];

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canSend) return;
    setError(null);
    send.mutate(
      { text: body, userId: audience === 'one' && chosen ? chosen.id : null, alsoPush },
      {
        onSuccess: (sent) => {
          setText('');
          toast.show(
            sent.push_recipients > 0
              ? t('admin.messages.sentPush', { count: sent.recipients, push: sent.push_recipients })
              : t('admin.messages.sent', { count: sent.recipients }),
            { icon: 'send' },
          );
        },
        onError: setError,
      },
    );
  }

  let form;
  if (users.isError) {
    form = <LoadError error={users.error} onRetry={() => void users.refetch()} />;
  } else if (messages.isError) {
    form = <LoadError error={messages.error} onRetry={() => void messages.refetch()} />;
  } else if (!users.data || everyone === null) {
    form = <Skeleton lines={4} />;
  } else {
    form = (
      <div className="stack">
        <div className="field">
          <span className="field-label">
            <span>{t('admin.messages.to')}</span>
          </span>
          <Segmented<Audience>
            label={t('admin.messages.to')}
            value={audience}
            onChange={setAudience}
            items={[
              { value: 'all', label: t('admin.messages.toAll', { count: everyone }) },
              { value: 'one', label: t('admin.messages.toOne') },
            ]}
          />
        </div>
        {audience === 'one' && chosen && (
          <FieldShell id={USER_ID} label={t('admin.messages.recipient')}>
            <Dropdown
              id={USER_ID}
              label={t('admin.messages.recipient')}
              value={String(chosen.id)}
              options={recipients.map((user) => ({ value: String(user.id), label: personName(user) }))}
              onChange={setPicked}
            />
          </FieldShell>
        )}
        {(audience === 'all' ? everyone === 0 : recipients.length === 0) && (
          <Callout kind="info">{t('admin.messages.noRecipients')}</Callout>
        )}
        <Field
          multiline
          id={TEXT_ID}
          rows={4}
          label={t('admin.messages.text')}
          labelAside={
            <span className={cx('adm-count', left < MESSAGE_WARN_LEFT && 'warn')} aria-live="polite">
              {t('admin.messages.counter', { count: text.length, max: MESSAGE_MAX })}
            </span>
          }
          hint={t('admin.messages.hint', { max: MESSAGE_MAX })}
          placeholder={t('admin.messages.placeholder')}
          maxLength={MESSAGE_MAX}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setError(null);
          }}
        />
        <Checkbox
          id="adm-msg-push"
          label={<Trans i18nKey="admin.messages.alsoPush" components={{ b: <b /> }} />}
          hint={pushHint}
          checked={alsoPush}
          onChange={setAlsoPush}
        />
        <div className="adm-presets">
          <span>{t('admin.messages.templates')}</span>
          {templates.map((template) => (
            <button
              key={template.id}
              type="button"
              className="adm-pill"
              onClick={() => {
                setText(template.text.slice(0, MESSAGE_MAX));
                setError(null);
                document.getElementById(TEXT_ID)?.focus();
              }}
            >
              {template.label}
            </button>
          ))}
        </div>
        {error !== null && (
          <Callout kind="bad" role="alert">
            {errorMessage(error)}
          </Callout>
        )}
      </div>
    );
  }

  return (
    <div className="adm-main">
      <form noValidate onSubmit={onSubmit} className="adm-msg-form">
        <Card
          className="adm-fill"
          title={t('admin.messages.title')}
          subtitle={t('admin.messages.subtitle')}
          foot={
            <Button kind="primary" type="submit" icon="send" disabled={!canSend && !send.isPending} loading={send.isPending}>
              {t('admin.messages.send')}
            </Button>
          }
        >
          {form}
        </Card>
      </form>
      <div className="adm-col">
        <PreviewCard text={body} push={alsoPush && (pushCount ?? 0) > 0} />
        <SentCard />
      </div>
    </div>
  );
}

/** Как сообщение покажет колокольчик участника (notif-item центра уведомлений) и push на телефоне. */
function PreviewCard({ text, push }: { text: string; push: boolean }) {
  const { t } = useTranslation();
  return (
    <Card title={t('admin.messages.preview.title')} subtitle={t('admin.messages.preview.subtitle')}>
      <div className="adm-notif">
        <div className="notif-head">
          <div className="notif-head-title">{t('admin.messages.preview.head')}</div>
        </div>
        <div className="notif-list">
          <div className="notif-item unread">
            <span className="notif-ic info" aria-hidden="true">
              <Icon name="megaphone" />
            </span>
            <span className="notif-text">
              <span className="notif-title">{t('admin.messages.preview.itemTitle')}</span>
              <span className={cx('notif-body', !text && 'muted')}>{text || t('admin.messages.preview.empty')}</span>
              <span className="notif-time">{t('admin.messages.preview.now')}</span>
            </span>
            <span className="notif-dot" aria-hidden="true" />
          </div>
        </div>
      </div>
      {push && (
        <div className="stack adm-msg-push">
          <div className="xsmall muted">{t('admin.messages.preview.push')}</div>
          <PushNotice title={t('admin.messages.preview.itemTitle')} body={text || t('admin.messages.preview.empty')} solo />
        </div>
      )}
    </Card>
  );
}

/** Последние отправленные: когда, кому, текст и кто отправил. */
function SentCard() {
  const { t } = useTranslation();
  const messages = useAdminMessages();

  let body;
  if (messages.isError) {
    body = <LoadError error={messages.error} onRetry={() => void messages.refetch()} />;
  } else if (!messages.data) {
    body = <Skeleton lines={3} />;
  } else if (messages.data.items.length === 0) {
    body = <p className="small soft">{t('admin.messages.history.empty')}</p>;
  } else {
    body = (
      <div className="adm-list">
        {messages.data.items.slice(0, SENT_SHOWN).map((message) => (
          <SentItem key={message.id ?? message.at} message={message} />
        ))}
      </div>
    );
  }
  return (
    <Card
      id="adm-msg-sent"
      title={t('admin.messages.history.title')}
      subtitle={t('admin.messages.history.subtitle')}
    >
      {body}
    </Card>
  );
}

function SentItem({ message }: { message: AdminMessage }) {
  const { t } = useTranslation();
  const target =
    message.user_id === null
      ? t('admin.messages.history.all', { count: message.recipients })
      : message.recipient_name ?? t('admin.messages.history.someone');
  return (
    <Item
      icon="megaphone"
      title={`${formatDateTime(message.at)} · ${target}`}
      meta={
        <>
          <span className="adm-msg-text">{message.text}</span>
          {message.push_recipients > 0 && (
            <span className="xsmall muted adm-msg-by">{t('admin.messages.history.push', { count: message.push_recipients })}</span>
          )}
          {message.actor_name && (
            <span className="xsmall muted adm-msg-by">
              {t('admin.messages.history.by', { name: message.actor_name })}
            </span>
          )}
        </>
      }
    />
  );
}
