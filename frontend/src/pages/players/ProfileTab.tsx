import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

import { Callout, Card, Chip, EmptyState, Icon, KeyValue, Meter } from '../../components';
import { hasContent, legacyView, psychTone, type Rating } from '../../features/players/legacy';
import type { LegacyProfile, PlayerCard } from '../../features/players/types';
import { formatDateLong, formatNumber } from '../../lib/format';

// Вкладка «Профиль из бота» (tabProfile макета, Р24): только у игроков, перенесенных из старого
// бота. Профиль заполняла модель бота сама, часто по памяти; программа его не обновляет и в
// анализ не передает — поэтому сверху пометка, а у каждой карточки строка «из старого бота».

function MetaLine({ legacy, source }: { legacy: LegacyProfile; source: string | null }) {
  const { t } = useTranslation();
  return (
    <div className="players-meta-line">
      <Icon name="history" />
      <span>
        {t('players.profile.meta', {
          date: formatDateLong(legacy.updated_at),
          source: source ? t('players.profile.sourceText', { source }) : t('players.profile.sourceNone'),
        })}
      </span>
    </div>
  );
}

function Rates({ items }: { items: readonly Rating[] }) {
  return (
    <div className="stack players-gap4">
      {items.map((item) => (
        <div key={item.label} className="players-rate" title={item.comment ?? undefined}>
          <span className="players-rate-l">{item.label}</span>
          <Meter value={item.value} max={10} kind={item.value <= 5 ? 'warn' : undefined} label={item.label} valueText={formatNumber(item.value)} />
          <span className="players-rate-v">{formatNumber(item.value)}</span>
        </div>
      ))}
    </div>
  );
}

/** «средняя 8,5 из 10» — средняя, которую записал бот; не записал — без подзаголовка. */
function avgText(value: number | null, t: TFunction): string | undefined {
  return value === null ? undefined : t('players.profile.avg', { value: formatNumber(value, 1) });
}

export function ProfileTab({ card, legacy }: { card: PlayerCard; legacy: LegacyProfile }) {
  const { t } = useTranslation();
  const view = legacyView(legacy);
  const source = view.source;
  const note = (
    <Callout kind="warn" icon="history">
      <b>{t('players.profile.noteStrong', { date: formatDateLong(legacy.updated_at) })}</b>
      {t('players.profile.note')}
    </Callout>
  );
  if (!hasContent(view)) {
    return (
      <>
        {note}
        <Card>
          <EmptyState>{t('players.profile.empty')}</EmptyState>
        </Card>
      </>
    );
  }
  const hand = card.hand === 'R' || card.hand === 'L' || card.hand === 'A' ? t(`players.card.handCap.${card.hand}`) : null;
  const backhand = card.backhand === 'one' || card.backhand === 'two' ? t(`players.card.backhandCap.${card.backhand}`) : null;
  const game = [
    { key: 'style', label: t('players.profile.game.style'), value: view.style },
    { key: 'position', label: t('players.profile.game.position'), value: view.position },
    { key: 'serve', label: t('players.profile.game.serve'), value: view.serveType },
    { key: 'grip', label: t('players.profile.game.grip'), value: view.grip },
    { key: 'hand', label: t('players.profile.game.hand'), value: hand },
    { key: 'backhand', label: t('players.profile.game.backhand'), value: backhand },
  ].filter((item) => item.value !== null);
  const meta = <MetaLine legacy={legacy} source={source} />;
  const psychKind = psychTone(view.psychType);
  return (
    <>
      {note}
      <div className="grid">
        {game.length > 0 && (
          <Card className="col-4 players-card players-fill" title={t('players.profile.game.title')}>
            <KeyValue items={game.map((item) => ({ key: item.key, label: item.label, value: item.value }))} />
            {meta}
          </Card>
        )}
        {view.physical.length > 0 && (
          <Card className="col-4 players-card players-fill" title={t('players.profile.physical')} subtitle={avgText(view.physicalAvg, t)}>
            <Rates items={view.physical} />
            {meta}
          </Card>
        )}
        {view.technical.length > 0 && (
          <Card className="col-4 players-card players-fill" title={t('players.profile.technical')} subtitle={avgText(view.technicalAvg, t)}>
            <Rates items={view.technical} />
            {meta}
          </Card>
        )}
        {(view.psychType || view.patterns.length > 0 || view.psychRatings.length > 0 || view.notes) && (
          <Card
            className="col-8 players-card players-fill"
            title={t('players.profile.psych.title')}
            subtitle={t('players.profile.psych.subtitle')}
            actions={
              view.psychType ? (
                <Chip kind={psychKind} icon={psychKind === 'good' ? 'shield' : 'alert'}>
                  {view.psychType}
                </Chip>
              ) : undefined
            }
          >
            {view.patterns.length > 0 && (
              <div className="players-patterns">
                {view.patterns.map((pattern) => (
                  <div key={pattern.label} className="players-pattern">
                    <h4>{pattern.label}</h4>
                    <p>{pattern.text}</p>
                  </div>
                ))}
              </div>
            )}
            {view.psychRatings.length > 0 && (
              <>
                <div className="eyebrow">{t('players.profile.psych.ratings')}</div>
                <div className="players-patterns players-rates2">
                  {view.psychRatings.map((item) => (
                    <div key={item.label} className="players-rate stacked" title={item.comment ?? undefined}>
                      <span className="players-rate-l">{item.label}</span>
                      <span className="players-rate-v">{t('players.profile.psych.outOf', { value: formatNumber(item.value) })}</span>
                      <Meter value={item.value} max={10} kind={item.value <= 5 ? 'warn' : undefined} label={item.label} valueText={formatNumber(item.value)} />
                    </div>
                  ))}
                </div>
              </>
            )}
            {view.notes && (
              <p className="small">
                <b>{t('players.profile.psych.notes')}</b> {view.notes}
              </p>
            )}
            {meta}
          </Card>
        )}
        {(view.strengths.length > 0 || view.weaknesses.length > 0) && (
          <Card className="col-4 players-card" title={t('players.profile.strengths.title')}>
            {view.strengths.length > 0 && (
              <>
                <div className="eyebrow">{t('players.profile.strengths.strong')}</div>
                <ul className="players-bullets">
                  {view.strengths.map((item) => (
                    <li key={item}>
                      <span className="good-text players-flex">
                        <Icon name="check" />
                      </span>
                      {item}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {view.weaknesses.length > 0 && (
              <>
                <div className="eyebrow">{t('players.profile.strengths.weak')}</div>
                <ul className="players-bullets">
                  {view.weaknesses.map((item) => (
                    <li key={item}>
                      <span className="bad-text players-flex">
                        <Icon name="alert" />
                      </span>
                      {item}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {meta}
          </Card>
        )}
      </div>
    </>
  );
}
