import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { paths } from '../../app/paths';
import { Icon, type IconName } from '../../components';
import { roundLabel } from '../../features/analysis/rounds';
import { playerName } from '../../features/players/display';
import type { LastMatch, PlayerRef } from '../../features/players/types';
import { formatDate, formatDateTime } from '../../lib/format';
import { cx } from '../../lib/cx';

// Мелкие части «Игроков» и карточки игрока (общие кусочки players.js макета).

/** Имя игрока ссылкой на карточку; клик не долетает до строки таблицы (она тоже открывает карточку). */
export function PlayerNameLink({ player, className }: { player: Pick<PlayerRef, 'id' | 'name' | 'name_ru'>; className?: string }) {
  return (
    <Link className={cx('players-link', className)} to={paths.player(player.id)} onClick={(event) => event.stopPropagation()}>
      {playerName(player)}
    </Link>
  );
}

/** Код страны серой плашкой: «ITA», полное название — в подсказке. */
export function CountryCode({ code, title }: { code: string | null; title: string | null }) {
  if (!code) return null;
  return (
    <span className="players-cc" title={title ?? undefined}>
      {code}
    </span>
  );
}

/** «турнир, круг» последнего матча: «Шанхай, 1/8 финала». */
export function matchPlace(match: Pick<LastMatch, 'tournament' | 'round'>): string {
  return [match.tournament, roundLabel(match.round)].filter(Boolean).join(', ');
}

/** Дата и время внутри фразы: «сегодня, 04:10»; utc — по UTC (загрузка архива, как в макете). */
export function inlineWhen(value: string, utc = false): string {
  const text = formatDateTime(value, utc ? { timeZone: 'UTC' } : {});
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** Последний матч в базе: дата и под ней турнир с кругом. */
export function LastMatchCell({ match }: { match: LastMatch | null }) {
  if (!match) return <span className="muted">—</span>;
  const place = matchPlace(match);
  return (
    <div className="players-cell-2">
      <span className="players-nowrap">{formatDate(match.day)}</span>
      {place && <small>{place}</small>}
    </div>
  );
}

/** Строка «иконка — текст» (низ карточки игрока в списке, источник новости). */
export function IconLine({ icon, children, className }: { icon: IconName; children: ReactNode; className?: string }) {
  return (
    <span className={cx('players-iconline', className)}>
      <Icon name={icon} />
      <span>{children}</span>
    </span>
  );
}

/** Строка авторства данных: Сакманн (CC BY-NC-SA) — если в базе его архив, и tennis-data. */
export function Attribution({ sackmann }: { sackmann: boolean }) {
  const { t } = useTranslation();
  return (
    <p className="players-attrib">
      <Icon name="database" />
      <span>{sackmann ? t('players.attribution') : t('players.attributionTd')}</span>
    </p>
  );
}

const SEARCH_DELAY_MS = 300;

interface SearchBoxProps {
  value: string;
  maxLength: number;
  placeholder: string;
  label: string;
  id: string;
  onSearch: (q: string) => void;
}

/** Поиск игрока: в адрес уходит после паузы ввода; адрес изменили снаружи — поле показывает его. */
export function SearchBox({ value, maxLength, placeholder, label, id, onSearch }: SearchBoxProps) {
  const [text, setText] = useState(value);
  const sent = useRef(value.trim());
  const search = useRef(onSearch);
  useEffect(() => {
    search.current = onSearch;
  });
  useEffect(() => {
    if (value.trim() !== sent.current) {
      sent.current = value.trim();
      setText(value);
    }
  }, [value]);
  useEffect(() => {
    if (text.trim() === sent.current) return undefined;
    const timer = window.setTimeout(() => {
      sent.current = text.trim();
      search.current(text);
    }, SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [text]);
  return (
    <div className="field players-search">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <div className="input-wrap">
        <Icon name="search" className="players-search-ic" />
        <input
          id={id}
          className="input"
          type="search"
          value={text}
          maxLength={maxLength}
          placeholder={placeholder}
          autoComplete="off"
          onChange={(event) => setText(event.target.value)}
        />
      </div>
    </div>
  );
}
