import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { isApiError } from '../../../api/errors';
import { Button, Callout, Card, Field, Icon, IconButton, Modal, Skeleton, useToast } from '../../../components';
import { apiErrorText } from '../../../features/analysis/codes';
import {
  bookmakerMark,
  nameTaken,
  useAddBookmaker,
  useBookmakerList,
  useDeleteBookmaker,
  useUpdateBookmaker,
  type Bookmaker,
} from '../../../features/bookmakers/api';
import { currencyOf } from '../../../features/bets/display';
import { formatMoney, formatNumber, type Currency } from '../../../lib/format';
import { LoadError } from '../LoadError';
import { MetaLine } from '../ProfileItem';

// «Мои букмекеры» (booksCard макета, В9): список для выбора при анализе и сохранении ставки
// (GET /api/me/bookmakers/list): добавить, переименовать, скрыть и вернуть; скрытого — удалить
// из списка. Скрыть или удалить букмекера со ставками в игре нельзя — окно «Пока нельзя».
// Балансов и сверки с банком нет (позже).

type Dialog =
  | { kind: 'add' }
  | { kind: 'rename'; item: Bookmaker }
  | { kind: 'hide'; item: Bookmaker }
  | { kind: 'delete'; item: Bookmaker }
  | { kind: 'blocked'; item: Bookmaker; text: string | null; action: 'hide' | 'delete' };

/** Значок букмекера: две буквы названия. */
function Mark({ name }: { name: string }) {
  return (
    <span className="profile-item-ic" aria-hidden="true">
      {bookmakerMark(name)}
    </span>
  );
}

export function BooksCard() {
  const { t } = useTranslation();
  const list = useBookmakerList();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const items = list.data?.items ?? [];
  const active = items.filter((item) => item.archived_at === null);
  const hidden = items.filter((item) => item.archived_at !== null);
  const currency = currencyOf(list.data?.currency);
  const close = () => setDialog(null);

  let body;
  if (list.error && !list.data) {
    body = <LoadError error={list.error} onRetry={() => void list.refetch()} />;
  } else if (!list.data) {
    body = <Skeleton lines={2} />;
  } else {
    body = (
      <>
        {active.length ? (
          <div className="profile-list">
            {active.map((item) => (
              <ActiveRow key={item.id} item={item} currency={currency} onDialog={setDialog} />
            ))}
          </div>
        ) : (
          <p className="small muted">{t('profile.bank.books.empty')}</p>
        )}
        {hidden.length > 0 && (
          <div className="stack profile-tight">
            <div className="eyebrow">{t('profile.bank.books.hidden')}</div>
            <div className="profile-list">
              {hidden.map((item) => (
                <HiddenRow key={item.id} item={item} onDialog={setDialog} />
              ))}
            </div>
          </div>
        )}
      </>
    );
  }

  return (
    <Card
      id="profile-books"
      className="profile-anchor"
      title={t('profile.bank.books.title')}
      subtitle={t('profile.bank.books.subtitle')}
      foot={
        <>
          <Button icon="plus" disabled={!list.data} onClick={() => setDialog({ kind: 'add' })} ro>
            {t('profile.bank.books.add')}
          </Button>
          <span className="xsmall muted">{t('profile.bank.books.later')}</span>
        </>
      }
    >
      {body}
      <p className="profile-note">
        <Icon name="target" />
        <span>{t('profile.bank.books.note')}</span>
      </p>
      {dialog && (dialog.kind === 'add' || dialog.kind === 'rename') && (
        <NameModal item={dialog.kind === 'rename' ? dialog.item : null} items={items} onClose={close} />
      )}
      {dialog?.kind === 'hide' && (
        <HideModal item={dialog.item} onClose={close} onBlocked={(text) => setDialog({ kind: 'blocked', item: dialog.item, text, action: 'hide' })} />
      )}
      {dialog?.kind === 'delete' && (
        <DeleteModal item={dialog.item} onClose={close} onBlocked={(text) => setDialog({ kind: 'blocked', item: dialog.item, text, action: 'delete' })} />
      )}
      {dialog?.kind === 'blocked' && <BlockedModal item={dialog.item} text={dialog.text} action={dialog.action} currency={currency} onClose={close} />}
    </Card>
  );
}

function ActiveRow({ item, currency, onDialog }: { item: Bookmaker; currency: Currency; onDialog: (dialog: Dialog) => void }) {
  const { t } = useTranslation();
  const inPlay = Number(item.in_play);
  return (
    <div className="profile-item wrap-mobile">
      <Mark name={item.name} />
      <div className="profile-item-body">
        <div className="profile-item-title">{item.name}</div>
        <div className="profile-item-meta">
          <MetaLine
            parts={[
              t('profile.bank.books.bets', { count: item.bets }),
              item.open_bets > 0 && inPlay > 0 ? t('profile.bank.books.inPlay', { amount: formatMoney(item.in_play, currency) }) : null,
            ]}
          />
        </div>
      </div>
      <div className="profile-item-side">
        <IconButton icon="edit" size="sm" label={t('profile.bank.books.rename', { name: item.name })} onClick={() => onDialog({ kind: 'rename', item })} ro />
        <IconButton
          icon="eyeOff"
          size="sm"
          label={t('profile.bank.books.hide', { name: item.name })}
          ro
          // Ставки в игре — сразу «Пока нельзя», как в макете; сервер проверит еще раз
          onClick={() => onDialog(item.open_bets > 0 ? { kind: 'blocked', item, text: null, action: 'hide' } : { kind: 'hide', item })}
        />
      </div>
    </div>
  );
}

function HiddenRow({ item, onDialog }: { item: Bookmaker; onDialog: (dialog: Dialog) => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const update = useUpdateBookmaker();
  return (
    <div className="profile-item wrap-mobile">
      <Mark name={item.name} />
      <div className="profile-item-body">
        <div className="profile-item-title">{item.name}</div>
        <div className="profile-item-meta">
          <MetaLine parts={[t('profile.bank.books.bets', { count: item.bets }), t('profile.bank.books.notInForms')]} />
        </div>
      </div>
      <div className="profile-item-side">
        <Button
          size="sm"
          icon="refresh"
          loading={update.isPending}
          aria-label={t('profile.bank.books.restoreLabel', { name: item.name })}
          ro
          onClick={() =>
            update.mutate(
              { id: item.id, archived: false },
              {
                onSuccess: () => toast.show(t('profile.bank.books.restored', { name: item.name }), { icon: 'check' }),
                onError: (error) => toast.show(apiErrorText(error), { icon: 'alert' }),
              },
            )
          }
        >
          {t('profile.bank.books.restore')}
        </Button>
        <IconButton icon="trash" size="sm" label={t('profile.bank.books.delete', { name: item.name })} onClick={() => onDialog({ kind: 'delete', item })} ro />
      </div>
    </div>
  );
}

/** Новый букмекер или новое название: поле, проверка повтора и «Другого», ответ сервера. */
function NameModal({ item, items, onClose }: { item: Bookmaker | null; items: readonly Bookmaker[]; onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const add = useAddBookmaker();
  const update = useUpdateBookmaker();
  const fieldId = useId();
  const formId = useId();
  const [name, setName] = useState(item?.name ?? '');
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const pending = add.isPending || update.isPending;

  async function submit() {
    const value = name.trim();
    if (!value) return setError(t('profile.bank.books.errors.empty'));
    if (item && value === item.name) return onClose();
    if (nameTaken(items, value, item?.id)) return setError(t('errors.bookmaker.name_taken', { name: value }));
    if (busy.current) return;
    busy.current = true;
    try {
      if (item) {
        await update.mutateAsync({ id: item.id, name: value });
        toast.show(t('profile.bank.books.renamed', { from: item.name, to: value }), { icon: 'check' });
      } else {
        await add.mutateAsync(value);
        toast.show(t('profile.bank.books.added', { name: value }), { icon: 'check' });
      }
      onClose();
    } catch (err) {
      setError(apiErrorText(err));
    } finally {
      busy.current = false;
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={item ? t('profile.bank.books.renameTitle', { name: item.name }) : t('profile.bank.books.addTitle')}
      footer={
        <>
          <Button kind="ghost" onClick={onClose}>
            {t('profile.form.cancel')}
          </Button>
          <Button kind="primary" type="submit" form={formId} icon="check" loading={pending}>
            {item ? t('profile.bank.books.saveName') : t('profile.bank.books.addSubmit')}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="stack"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field
          id={fieldId}
          label={item ? t('profile.bank.books.newName') : t('profile.bank.books.name')}
          placeholder={t('profile.bank.books.placeholder')}
          autoComplete="off"
          maxLength={64}
          value={name}
          hint={item ? t('profile.bank.books.renameHint') : t('profile.bank.books.addHint')}
          error={error ?? undefined}
          onChange={(event) => {
            setName(event.target.value);
            setError(null);
          }}
        />
      </form>
    </Modal>
  );
}

/** Ответ 409 bookmaker.open_bets: на экране было старое — окно «Пока нельзя» с текстом сервера. */
function openBetsText(error: unknown): string | null {
  return isApiError(error) && error.code === 'bookmaker.open_bets' ? apiErrorText(error) : null;
}

function HideModal({ item, onClose, onBlocked }: { item: Bookmaker; onClose: () => void; onBlocked: (text: string) => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const update = useUpdateBookmaker();
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal
      open
      onClose={onClose}
      title={t('profile.bank.books.hideTitle', { name: item.name })}
      footer={
        <>
          <Button kind="ghost" onClick={onClose}>
            {t('profile.form.cancel')}
          </Button>
          <Button
            kind="primary"
            icon="eyeOff"
            loading={update.isPending}
            onClick={() =>
              update.mutate(
                { id: item.id, archived: true },
                {
                  onSuccess: () => {
                    toast.show(t('profile.bank.books.hiddenDone', { name: item.name }), { icon: 'eyeOff' });
                    onClose();
                  },
                  onError: (err) => {
                    const blocked = openBetsText(err);
                    if (blocked) onBlocked(blocked);
                    else setError(apiErrorText(err));
                  },
                },
              )
            }
          >
            {t('profile.bank.books.hideSubmit')}
          </Button>
        </>
      }
    >
      <p className="small soft">{t('profile.bank.books.hideText', { name: item.name, count: item.bets })}</p>
      {error && (
        <Callout kind="bad" role="alert">
          {error}
        </Callout>
      )}
    </Modal>
  );
}

function DeleteModal({ item, onClose, onBlocked }: { item: Bookmaker; onClose: () => void; onBlocked: (text: string) => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const remove = useDeleteBookmaker();
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal
      open
      onClose={onClose}
      title={t('profile.bank.books.deleteTitle', { name: item.name })}
      footer={
        <>
          <Button kind="ghost" onClick={onClose}>
            {t('profile.form.cancel')}
          </Button>
          <Button
            kind="danger"
            icon="trash"
            loading={remove.isPending}
            onClick={() =>
              remove.mutate(item.id, {
                onSuccess: () => {
                  toast.show(t('profile.bank.books.deleted', { name: item.name }), { icon: 'trash' });
                  onClose();
                },
                onError: (err) => {
                  const blocked = openBetsText(err);
                  if (blocked) onBlocked(blocked);
                  else setError(apiErrorText(err));
                },
              })
            }
          >
            {t('profile.bank.books.deleteSubmit')}
          </Button>
        </>
      }
    >
      <p className="small soft">{t('profile.bank.books.deleteText', { name: item.name, count: item.bets })}</p>
      {error && (
        <Callout kind="bad" role="alert">
          {error}
        </Callout>
      )}
    </Modal>
  );
}

/** «Пока нельзя скрыть»: ставки в игре — сначала расчет. text — ответ сервера, если он пришел. */
function BlockedModal({
  item,
  text,
  action,
  currency,
  onClose,
}: {
  item: Bookmaker;
  text: string | null;
  action: 'hide' | 'delete';
  currency: Currency;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const okRef = useRef<HTMLButtonElement>(null);
  useEffect(() => okRef.current?.focus({ preventScroll: true }), []);
  return (
    <Modal
      open
      onClose={onClose}
      title={action === 'hide' ? t('profile.bank.books.blockedTitle', { name: item.name }) : t('profile.bank.books.blockedDeleteTitle', { name: item.name })}
      footer={
        <Button ref={okRef} kind="primary" onClick={onClose}>
          {t('profile.bank.books.blockedOk')}
        </Button>
      }
    >
      <p className="small soft">
        {text ??
          t('profile.bank.books.blockedText', {
            name: item.name,
            count: item.open_bets,
            bets: formatNumber(item.open_bets),
            amount: formatMoney(item.in_play, currency),
          })}
      </p>
    </Modal>
  );
}
