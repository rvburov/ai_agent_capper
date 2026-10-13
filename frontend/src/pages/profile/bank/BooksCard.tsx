import { useTranslation } from 'react-i18next';

import { Button, Card, IconButton, Icon, Skeleton } from '../../../components';
import { useBookmakers } from '../../../features/analysis/api';

// «Мои букмекеры» (booksCard макета, В9): список для выбора при анализе и сохранении ставки.
// Сейчас — названия из GET /api/me/bookmakers (из ставок и анализов). Добавить, переименовать
// и скрыть — API волны 4 этапа 4 (POST/PATCH/DELETE /api/me/bookmakers); кнопки пока неактивны.

/** Две буквы названия для значка: «Fonbet» → «FO». */
function mark(name: string): string {
  return name.replace(/[^A-Za-zЀ-ӿ0-9]/g, '').slice(0, 2).toUpperCase() || '?';
}

export function BooksCard() {
  const { t } = useTranslation();
  const books = useBookmakers();
  const list = books.data ?? [];
  return (
    <Card
      id="profile-books"
      className="profile-anchor"
      title={t('profile.bank.books.title')}
      subtitle={t('profile.bank.books.subtitle')}
      foot={
        <>
          {/* Волна 4: окно «Новый букмекер» (POST /api/me/bookmakers) */}
          <Button icon="plus" disabled>
            {t('profile.bank.books.add')}
          </Button>
          <span className="xsmall muted">{t('profile.bank.books.later')}</span>
        </>
      }
    >
      {books.isLoading ? (
        <Skeleton lines={2} />
      ) : list.length ? (
        <div className="profile-list">
          {list.map((name) => (
            <div key={name} className="profile-item wrap-mobile">
              <span className="profile-item-ic" aria-hidden="true">
                {mark(name)}
              </span>
              <div className="profile-item-body">
                <div className="profile-item-title">{name}</div>
              </div>
              <div className="profile-item-side">
                {/* Волна 4: переименовать (PATCH) и скрыть (DELETE /api/me/bookmakers/{id}) */}
                <IconButton icon="edit" size="sm" label={t('profile.bank.books.rename', { name })} disabled />
                <IconButton icon="eyeOff" size="sm" label={t('profile.bank.books.hide', { name })} disabled />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="small muted">{t('profile.bank.books.empty')}</p>
      )}
      <p className="profile-note">
        <Icon name="target" />
        <span>{t('profile.bank.books.note')}</span>
      </p>
    </Card>
  );
}
