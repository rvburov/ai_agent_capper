import type { TFunction } from 'i18next';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { paths } from '../../app/paths';
import { Button, Chip, Skeleton, type ChipKind, type IconName } from '../../components';
import { modelLabel } from '../../features/ai/models';
import { marketLabel } from '../../features/analysis/markets';
import { reviewShown, useBetReview, type LegReview, type ReviewLesson, type ReviewVerdict } from '../../features/bets/review';
import type { BetItem } from '../../features/bets/types';
import { PUBLIC_CASES_MIN } from '../../features/learning/limits';
import { formatDateTime, formatUsd } from '../../lib/format';
import { reviewText } from './marks';
import { legMarket, matchText, VerdictChip } from './parts';

// Блок «Разбор ИИ» (reviewBlock макета, этап 5, В3): вывод по ноге участника, общий разбор матча
// (что произошло, почему, гипотеза со ссылкой на урок и его статусом); вердикт по CLV (считает
// код, без ИИ) — строкой внутри. Разбор пишет сервер (Sonnet 5.5 через Batch, один на матч), экран только рисует. У
// экспресса — разбор каждого матча с исходом.

const VERDICT_LOOK: Record<ReviewVerdict, { kind: ChipKind; icon: IconName }> = {
  fine: { kind: 'good', icon: 'check' },
  lucky: { kind: 'warn', icon: 'alert' },
  luck: { kind: 'info', icon: 'info' },
  model_error: { kind: 'serious', icon: 'alert' },
  data_gap: { kind: 'warn', icon: 'alert' },
};

function lessonState(lesson: ReviewLesson, t: TFunction): string {
  switch (lesson.status) {
    case 'hypothesis': {
      // общее число случаев участнику — с порога (сервер: n_cases = null и n_cases_few), как
      // на «Уроках»; свои — отдельно
      const base =
        lesson.n_cases === null
          ? t('bets.ai.lesson.hypothesisFew', { few: PUBLIC_CASES_MIN, min: lesson.need_cases })
          : t('bets.ai.lesson.hypothesis', { cases: lesson.n_cases, min: lesson.need_cases });
      return lesson.own_cases > 0 ? t('bets.ai.lesson.yours', { base, n: lesson.own_cases }) : base;
    }
    case 'confirmed':
      return lesson.in_prompt ? t('bets.ai.lesson.confirmedOn') : t('bets.ai.lesson.confirmedOff');
    default:
      return t(`bets.ai.lesson.${lesson.status}`);
  }
}

/**
 * Вывод по ноге участника (считает сервер): сыграла — «подтвердился» или «повезло», проиграла на
 * ту же сторону, что разбирали, — вывод общего разбора, иначе — по CLV.
 */
function VerdictOf({ review }: { review: LegReview }) {
  const { t } = useTranslation();
  if (!review.verdict) return null;
  const look = VERDICT_LOOK[review.verdict];
  return (
    <span title={t('bets.ai.verdictTitle', { result: review.won ? t('bets.ai.legWon') : t('bets.ai.legLost') })}>
      <Chip kind={look.kind} icon={look.icon}>
        {t(`bets.ai.verdict.${review.verdict}`)}
      </Chip>
    </span>
  );
}

/** «По CLV, без ИИ: [вердикт] пояснение» — вердикт кодом по закрывающим кэфам. */
function ClvLine({ bet }: { bet: BetItem }) {
  const { t } = useTranslation();
  return (
    <div className="bets-review-v">
      <span className="small muted">{t('bets.ai.clv')}</span>
      <VerdictChip verdict={bet.verdict} />
      <span className="small soft">{reviewText(bet, t)}</span>
    </div>
  );
}

/** Разбор одного матча: что произошло, почему, гипотеза и урок. */
function LegBody({ review }: { review: LegReview }) {
  const { t } = useTranslation();
  const lesson = review.lesson;
  return (
    <>
      {!review.same_pick && <p className="xsmall muted">{t('bets.ai.otherPick', { market: marketLabel(review.market, review.selection) })}</p>}
      {review.what && (
        <p>
          <b>{t('bets.ai.what')}</b> {review.what}
        </p>
      )}
      {review.why && (
        <p>
          <b>{t('bets.ai.why')}</b> {review.why}
        </p>
      )}
      <p>
        <b>{t('bets.ai.hypothesis')}</b>{' '}
        {lesson ? (
          <>
            <Link to={paths.learning()} title={t('bets.ai.lessonTitle', { code: lesson.code })}>
              {lesson.code}
            </Link>
            {` — ${lessonState(lesson, t)}. ${review.hypothesis ?? lesson.text}`}
          </>
        ) : (
          (review.hypothesis ?? t('bets.ai.noHypothesis'))
        )}
      </p>
    </>
  );
}

function metaText(review: LegReview, t: TFunction): string {
  const model = review.model ? modelLabel(review.model) : t('bets.ai.modelDefault');
  const parts = [
    review.cost_usd !== null ? t('bets.ai.meta', { model, cost: formatUsd(review.cost_usd, 2) }) : t('bets.ai.metaNoCost', { model }),
    review.done_at ? formatDateTime(review.done_at, { calendar: false }) : null,
    t('bets.ai.shared'),
  ];
  return parts.filter(Boolean).join(' · ');
}

export function ReviewBlock({ bet }: { bet: BetItem }) {
  const { t } = useTranslation();
  const query = useBetReview(bet);
  const head = (chip?: ReactNode) => (
    <div className="row-between">
      <span className="eyebrow">{t('bets.ai.title')}</span>
      {chip}
    </div>
  );
  const shown = reviewShown(bet, query.data);
  if (shown.kind === 'open') {
    return (
      <>
        {head()}
        <p>{t('bets.ai.open')}</p>
      </>
    );
  }
  if (shown.kind === 'not_reviewed') {
    return (
      <>
        {head()}
        <p>{t(`bets.ai.notReviewed.${shown.reason}`)}</p>
        {shown.reason !== 'legacy' && <ClvLine bet={bet} />}
      </>
    );
  }
  if (query.isPending) {
    return (
      <>
        {head()}
        <Skeleton lines={2} />
        <ClvLine bet={bet} />
      </>
    );
  }
  if (query.isError) {
    return (
      <>
        {head()}
        <p>
          {t('bets.ai.loadFailed')}{' '}
          <Button kind="ghost" size="sm" icon="refresh" onClick={() => void query.refetch()}>
            {t('common.retry')}
          </Button>
        </p>
        <ClvLine bet={bet} />
      </>
    );
  }
  if (shown.kind === 'failed') {
    return (
      <>
        {head()}
        <p>{t('bets.ai.failed')}</p>
        <ClvLine bet={bet} />
      </>
    );
  }
  const legs = shown.legs;
  const single = legs.length === 1 && shown.kind === 'done' ? legs[0] : undefined;
  const byId = new Map(bet.legs.map((leg) => [leg.id, leg]));
  const first = legs[0];
  return (
    <>
      {head(single ? <VerdictOf review={single} /> : undefined)}
      {single ? (
        <LegBody review={single} />
      ) : (
        legs.map((review) => {
          const leg = byId.get(review.leg_id);
          return (
            <div key={review.leg_id} className="bets-review-leg">
              <div className="bets-review-leg-head">
                <b>{leg ? `${matchText(leg)} · ${legMarket(leg)}` : marketLabel(review.market, review.selection)}</b>
                <VerdictOf review={review} />
              </div>
              <LegBody review={review} />
            </div>
          );
        })
      )}
      {shown.kind === 'pending' && <p>{legs.length ? t('bets.ai.pendingRest') : t('bets.ai.pending')}</p>}
      <ClvLine bet={bet} />
      {first && <div className="bets-review-meta">{metaText(first, t)}</div>}
    </>
  );
}
