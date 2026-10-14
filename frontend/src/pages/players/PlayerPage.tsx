import { useTranslation } from 'react-i18next';
import { Navigate, useParams } from 'react-router';

import { isApiError } from '../../api/errors';
import { useScreenTitle } from '../../app/layout/screenTitle';
import { PLAYER_TABS, paths, type PlayerTab } from '../../app/paths';
import { Button, Callout, Card, Icon, Skeleton, Tabs } from '../../components';
import { apiErrorText } from '../../features/analysis/codes';
import { usePlayerCard } from '../../features/players/api';
import { playerIdOf, playerName, shortName } from '../../features/players/display';
import { MOBILE_QUERY, useMediaQuery } from '../../lib/useMediaQuery';
import { MatchesTab } from './MatchesTab';
import { NewsTab } from './NewsTab';
import { OverviewTab } from './OverviewTab';
import { Attribution } from './parts';
import { PlayerHero } from './PlayerHero';
import { ProfileTab } from './ProfileTab';
import './players.css';

/*
 * Карточка игрока /players/:id/:tab? (renderPlayer макета): шапка и вкладки-адреса «Обзор»,
 * «Матчи», «Новости» и «Профиль из бота» (только у перенесенных из старого бота). Данные —
 * GET /api/players/{id}; матчи и новости — своими запросами страницами.
 */

function isTab(value: string): value is PlayerTab {
  return (PLAYER_TABS as readonly string[]).includes(value);
}

/** Игрока нет в базе (404) или в адресе не номер. */
function NotFound({ raw }: { raw: string }) {
  const { t } = useTranslation();
  return (
    <Card>
      <div className="players-notfound">
        <span className="players-notfound-ic">
          <Icon name="users" />
        </span>
        <h2>{t('players.card.notFound.title')}</h2>
        <p className="players-soft">{raw ? t('players.card.notFound.text', { id: raw }) : t('players.card.notFound.noId')}</p>
        <Button kind="primary" icon="chevronLeft" to={paths.players}>
          {t('players.card.notFound.back')}
        </Button>
      </div>
    </Card>
  );
}

export function PlayerPage() {
  const { t } = useTranslation();
  const { id: rawId = '', tab } = useParams();
  const mobile = useMediaQuery(MOBILE_QUERY);
  const id = playerIdOf(rawId);
  const card = usePlayerCard(id);
  const missing = id === null || (card.isError && isApiError(card.error) && card.error.status === 404);
  // в шапке и во вкладке браузера — фамилия игрока, как в макете (UI.setHeader)
  useScreenTitle(missing ? t('players.card.notFound.title') : card.data ? shortName(playerName(card.data)) : null);

  if (id === null) return <NotFound raw={rawId} />;
  if (tab !== undefined && (!isTab(tab) || tab === 'overview')) return <Navigate to={paths.player(id)} replace />;
  if (missing) return <NotFound raw={rawId} />;
  if (!card.data) {
    if (card.isError) {
      return (
        <Callout kind="bad" role="alert">
          {t('players.card.failed')} {apiErrorText(card.error)}{' '}
          <Button size="sm" kind="ghost" icon="refresh" onClick={() => void card.refetch()}>
            {t('common.retry')}
          </Button>
        </Callout>
      );
    }
    return (
      <div className="players-root stack" aria-busy="true">
        <Card>
          <Skeleton lines={5} />
        </Card>
        <Card>
          <Skeleton lines={6} />
        </Card>
      </div>
    );
  }
  const data = card.data;
  const legacy = data.legacy_profile;
  const active: PlayerTab = tab && isTab(tab) ? tab : 'overview';
  if (active === 'profile' && !legacy) return <Navigate to={paths.player(id)} replace />;
  const tabs: PlayerTab[] = legacy ? ['overview', 'matches', 'news', 'profile'] : ['overview', 'matches', 'news'];

  return (
    <div className="players-root stack">
      <PlayerHero card={data} />
      <Tabs
        label={t('players.card.tabs.label')}
        panelId="players-panel"
        active={active}
        className={mobile ? `players-tabs players-tabs-${tabs.length}` : undefined}
        items={tabs.map((item) => ({
          id: item,
          label: item === 'profile' && mobile ? t('players.card.tabs.profileShort') : t(`players.card.tabs.${item}`),
          to: paths.player(id, item),
        }))}
      />
      <div id="players-panel" className="players-tabpanel" role="tabpanel" aria-label={t(`players.card.tabs.${active}`)}>
        {active === 'overview' && <OverviewTab card={data} />}
        {active === 'matches' && <MatchesTab card={data} />}
        {active === 'news' && <NewsTab card={data} />}
        {active === 'profile' && legacy && <ProfileTab card={data} legacy={legacy} />}
      </div>
      <Attribution sackmann={data.sackmann} />
    </div>
  );
}
