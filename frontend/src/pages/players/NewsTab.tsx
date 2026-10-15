import { useTranslation } from 'react-i18next';

import { Button, Callout, Card, Chip, Icon, Skeleton, type ChipKind, type IconName } from '../../components';
import { modelLabel } from '../../features/ai/models';
import { apiErrorText } from '../../features/analysis/codes';
import { analysisNumber } from '../../features/analysis/number';
import { usePlayerNews } from '../../features/players/api';
import { safeHttpUrl, siteName } from '../../features/players/display';
import type { NewsItem, NewsKind, PlayerCard } from '../../features/players/types';
import { formatDate, formatTime } from '../../lib/format';
import { inlineWhen } from './parts';

// Вкладка «Новости» (tabNews макета): факты из шага новостей анализа (общий кэш для всех) с
// сайтом-источником и видом. Кнопки «Искать сейчас» нет: новости ищутся перед анализом.

// Цвета и значки видов — как NEWS_KIND макета (players.js)
const KIND: Record<NewsKind, { kind: ChipKind; icon: IconName }> = {
  result: { kind: 'outline', icon: 'trophy' },
  injury: { kind: 'warn', icon: 'alert' },
  withdrawal: { kind: 'warn', icon: 'x' },
  motivation: { kind: 'info', icon: 'target' },
  other: { kind: 'outline', icon: 'info' },
};

function NewsArticle({ item }: { item: NewsItem }) {
  const { t } = useTranslation();
  const meta = KIND[item.kind] ?? KIND.other;
  const url = safeHttpUrl(item.source_url);
  const site = siteName(item.source_name, item.source_url);
  return (
    <article className="players-news-item">
      <div className="players-news-when">
        <b>{formatDate(item.published_at)}</b>
        <Chip kind={meta.kind} icon={meta.icon}>
          {t(`players.news.kinds.${item.kind}`)}
        </Chip>
      </div>
      <div className="players-news-body">
        <p>{item.summary}</p>
        {url ? (
          <a className="players-news-src" href={url} target="_blank" rel="noopener noreferrer" title={t('players.news.sourceTitle', { site })}>
            <Icon name="link" />
            {site}
          </a>
        ) : (
          <span className="players-news-src">
            <Icon name="link" />
            {site}
          </span>
        )}
      </div>
    </article>
  );
}

export function NewsTab({ card }: { card: PlayerCard }) {
  const { t } = useTranslation();
  const news = usePlayerNews(card.id);
  const status = card.news;
  const pages = news.data?.pages ?? [];
  const items = pages.flatMap((page) => page.items);
  const checkedAt = pages[0]?.checked_at ?? status.checked_at;
  const fresh = pages[0]?.fresh ?? status.fresh;
  const ttl = pages[0]?.ttl_hours ?? status.ttl_hours;
  const days = pages[0]?.lookback_days ?? status.lookback_days;
  // Кто проверял: модель шага новостей и свой анализ (чужой анализ сервер не называет)
  const checkedModel = pages[0]?.checked_model ?? null;
  const checkedAnalysis = pages[0]?.checked_analysis_id ?? null;
  const where =
    checkedAnalysis !== null
      ? t('players.news.byAnalysis', { id: analysisNumber(checkedAnalysis) })
      : pages.length
        ? t('players.news.byShared')
        : '';
  const search = checkedModel ? t('players.news.searchModel', { model: modelLabel(checkedModel) }) : t('players.news.search');

  let body;
  if (!checkedAt) {
    body = (
      <div className="players-news-empty">
        <Icon name="globe" />
        <b>{t('players.news.neverTitle')}</b>
        <span>{t('players.news.neverText')}</span>
      </div>
    );
  } else if (news.isPending) {
    body = <Skeleton lines={4} />;
  } else if (!pages.length) {
    body = (
      <Callout kind="bad" role="alert">
        {t('players.news.failed')} {apiErrorText(news.error)}{' '}
        <Button size="sm" kind="ghost" icon="refresh" onClick={() => void news.refetch()}>
          {t('common.retry')}
        </Button>
      </Callout>
    );
  } else if (!items.length) {
    body = (
      <div className="players-news-empty">
        <Icon name="check" />
        <b>{t('players.news.emptyTitle', { days })}</b>
        <span>{t('players.news.emptyText', { when: inlineWhen(checkedAt) })}</span>
      </div>
    );
  } else {
    body = (
      <div className="players-flush">
        {items.map((item) => (
          <NewsArticle key={item.id} item={item} />
        ))}
      </div>
    );
  }

  const until = checkedAt ? new Date(new Date(checkedAt).getTime() + ttl * 3_600_000).toISOString() : null;
  return (
    <>
      <Card
        className="players-card"
        title={t('players.news.title')}
        subtitle={checkedAt ? t('players.news.subtitle', { when: inlineWhen(checkedAt), where, search, days }) : t('players.news.subtitleNever')}
        actions={
          checkedAt ? (
            fresh && until ? (
              <Chip kind="good" icon="check">
                {t('players.news.fresh', { time: formatTime(until) })}
              </Chip>
            ) : (
              <Chip kind="outline" icon="clock">
                {t('players.news.stale', { hours: ttl })}
              </Chip>
            )
          ) : undefined
        }
        foot={
          news.hasNextPage ? (
            <Button kind="secondary" size="sm" icon="list" loading={news.isFetchingNextPage} onClick={() => void news.fetchNextPage()}>
              {t('players.news.more')}
            </Button>
          ) : undefined
        }
      >
        {body}
      </Card>
      <Callout icon="info">
        <b>{t('players.news.howStrong')}</b>
        {t('players.news.how', { hours: ttl })}
      </Callout>
    </>
  );
}
