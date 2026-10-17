import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { Me } from '../../../api/hooks/useMe';
import { Chip, Icon, type ChipKind, type IconName } from '../../../components';
import { personName } from '../../../features/admin/people';
import { useAdminUsers } from '../../../features/admin/useAdminUsers';

/*
 * «Кто видит мои данные» (whoCard макета, Р27): вы — все; администратор — ставки, банк,
 * стратегию и анализы, только просмотр, каждый просмотр в журнале администратора; другие
 * участники — нет; никто — пароль, коды 2FA, резервные коды и ключ Claude. Дату и экран
 * последнего просмотра участнику не показываем (решение В1): они — в журнале администратора.
 */

interface RowProps {
  icon: IconName;
  kind?: 'good' | 'info' | 'bad';
  who: string;
  what: string;
  note?: string;
  tag: ReactNode;
}

function Row({ icon, kind, who, what, note, tag }: RowProps) {
  return (
    <li>
      <span className={['profile-who-ic', kind].filter(Boolean).join(' ')} aria-hidden="true">
        <Icon name={icon} />
      </span>
      <div className="profile-who-text">
        <b>{who}</b>
        <span>{what}</span>
        {note && <small>{note}</small>}
      </div>
      {tag}
    </li>
  );
}

function tag(kind: ChipKind, text: string, icon?: IconName) {
  return (
    <Chip kind={kind} icon={icon}>
      {text}
    </Chip>
  );
}

/** Другие администраторы — администратору (список людей ему доступен). */
function OtherAdmins({ me }: { me: Me }) {
  const { t } = useTranslation();
  const users = useAdminUsers();
  const others = (users.data ?? []).filter((u) => u.role === 'admin' && u.status !== 'deleted' && u.id !== me.id);
  return (
    <Row
      icon="admin"
      kind="info"
      who={t('profile.data.who.otherAdmins')}
      what={t('profile.data.who.adminWhat')}
      note={others.length ? others.map(personName).join(', ') : t('profile.data.who.noOtherAdmins')}
      tag={tag('info', t('profile.data.who.tagView'), 'eye')}
    />
  );
}

export function WhoCard({ me }: { me: Me }) {
  const { t } = useTranslation();
  const admin = me.role === 'admin';
  return (
    <section className="card profile-anchor" id="profile-who" aria-labelledby="profile-who-title">
      <div className="card-head">
        <div className="card-head-text">
          <h3 id="profile-who-title">{t('profile.data.who.title')}</h3>
          <div className="card-sub">{t('profile.data.who.subtitle')}</div>
        </div>
      </div>
      <div className="card-body">
        <ul className="profile-who">
          <Row icon="user" kind="good" who={t('profile.data.who.you')} what={t('profile.data.who.youWhat')} tag={tag('good', t('profile.data.who.tagAll'))} />
          {admin ? (
            <OtherAdmins me={me} />
          ) : (
            <Row
              icon="admin"
              kind="info"
              who={t('profile.data.who.admin')}
              what={t('profile.data.who.adminWhatMember')}
              note={t('profile.data.who.adminNote')}
              tag={tag('info', t('profile.data.who.tagView'), 'eye')}
            />
          )}
          <Row
            icon="users"
            who={t('profile.data.who.others')}
            what={t('profile.data.who.othersWhat')}
            note={t('profile.data.who.othersNote')}
            tag={tag('outline', t('profile.data.who.tagNo'))}
          />
          <Row
            icon="lock"
            kind="bad"
            who={t('profile.data.who.nobody')}
            what={t('profile.data.who.nobodyWhat')}
            note={t('profile.data.who.nobodyNote')}
            tag={tag('bad', t('profile.data.who.tagNobody'), 'lock')}
          />
        </ul>
        <p className="profile-note">
          <Icon name="info" />
          <span>{t('profile.data.who.rule')}</span>
        </p>
      </div>
    </section>
  );
}
