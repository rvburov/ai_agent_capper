import { useTranslation } from 'react-i18next';

import type { Me } from '../../api/hooks/useMe';
import { Button, Dropdown, EmptyState, Icon } from '../../components';
import { useViewMode } from '../../features/view/context';
import { useViewPeople, type ViewPerson } from '../../features/view/people';
import { cx } from '../../lib/cx';
import { MOBILE_QUERY, useMediaQuery } from '../../lib/useMediaQuery';
import { paths } from '../paths';
import './ViewBar.css';

/*
 * Режим просмотра данных участника в оболочке (mockup/js/view.js, Р27): выбор «Чьи данные
 * смотреть» и плашка «Вы смотрите данные: … · только просмотр · Вернуться к своим».
 */

const OWN = 'me';

function PeopleDropdown({ me, className }: { me: Me; className?: string }) {
  const { t } = useTranslation();
  const view = useViewMode();
  const { people } = useViewPeople(me.id);
  const options = [
    { value: OWN, label: t('view.own') },
    ...people.map((p) => ({ value: String(p.id), label: p.blocked ? t('view.blocked', { name: p.name }) : p.name })),
  ];
  // Участника, которого уже нет в списке (удален), показываем номером: так видно, чьи данные открыты
  if (view.asUser !== null && !people.some((p) => p.id === view.asUser)) {
    options.push({ value: String(view.asUser), label: t('view.unknown', { id: view.asUser }) });
  }
  return (
    <Dropdown
      label={t('view.pickLabel')}
      className={cx('vw-select', className)}
      options={options}
      value={view.asUser === null ? OWN : String(view.asUser)}
      onChange={(value) => {
        if (value === OWN) view.exit();
        else view.open(Number(value));
      }}
    />
  );
}

/** «Чьи данные смотреть», пока режим выключен: в шапке на компьютере, строкой над экраном на телефоне. */
export function ViewPicker({ me, row = false }: { me: Me; row?: boolean }) {
  const { t } = useTranslation();
  const picker = (
    <label className="vw-pick">
      <Icon name="eye" />
      <span>{row ? t('view.pickLabel') : t('view.pickShort')}</span>
      <PeopleDropdown me={me} />
    </label>
  );
  return row ? <div className="vw-row">{picker}</div> : picker;
}

function nameOf(people: readonly ViewPerson[], id: number, fallback: string): string {
  return people.find((p) => p.id === id)?.name ?? fallback;
}

/** Плашка режима просмотра: под шапкой, прилипает при прокрутке. */
export function ViewBanner({ me }: { me: Me }) {
  const { t } = useTranslation();
  const view = useViewMode();
  const mobile = useMediaQuery(MOBILE_QUERY);
  const { people, loaded } = useViewPeople(me.id);
  if (view.asUser === null) return null;
  const name = loaded ? nameOf(people, view.asUser, t('view.unknown', { id: view.asUser })) : '…';
  return (
    <div className="vw-bar" role="region" aria-label={t('view.regionLabel')}>
      <span className="vw-ic" aria-hidden="true">
        <Icon name="eye" />
      </span>
      <div className="vw-text">
        <span>
          {t('view.watching')} <b>{name}</b> · {t('view.readOnly')}
        </span>
        <small>{t('view.bannerNote')}</small>
      </div>
      <div className="vw-acts">
        <PeopleDropdown me={me} />
        <Button icon="user" className="vw-back" onClick={view.exit}>
          {mobile ? t('view.backShort') : t('view.back')}
        </Button>
      </div>
    </div>
  );
}

/** Участник открыл адрес с ?as= чужого: вместо экрана — понятная ошибка (сервер ответил бы 403). */
export function ViewDenied() {
  const { t } = useTranslation();
  return (
    <EmptyState
      icon="lock"
      title={t('view.deniedTitle')}
      titleAs="h2"
      text={t('view.deniedText')}
      action={
        <Button kind="primary" icon="home" to={paths.home}>
          {t('view.deniedBack')}
        </Button>
      }
    />
  );
}
