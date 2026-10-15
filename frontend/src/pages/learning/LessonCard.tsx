import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

import { errorMessage } from '../../api/errors';
import { Button, Chip, Meter, Toggle, useToast } from '../../components';
import {
  baseText,
  ci3,
  conditionText,
  dec3,
  historyReason,
  LESSON_CHIP,
  lessonTone,
  plural,
  signed3,
} from '../../features/learning/display';
import { quickRunning, useLessonAction } from '../../features/learning/lessons';
import type { Lesson } from '../../features/learning/types';
import { formatDate, formatNumber, formatPp } from '../../lib/format';
import { cx } from '../../lib/cx';

// Карточка урока (lessonItem макета): слева — код, статус, текст, условие из словаря и числа
// проверки; справа — что можно сделать: администратор включает и выключает урок в анализе,
// участник видит решение; у гипотезы — свои случаи из порога и «Сообщить, когда наберется».

/** Метка статуса урока: «Подтвержден», «Ждет решения», «Гипотеза»… */
export function LessonChip({ lesson }: { lesson: Pick<Lesson, 'status'> }) {
  const { t } = useTranslation();
  const chip = LESSON_CHIP[lesson.status];
  return (
    <Chip kind={chip.kind} icon={chip.icon}>
      {t(`learning.lessons.status.${lesson.status}`)}
    </Chip>
  );
}

/** Условие урока чипами: направление поправки и признаки словаря. */
export function ConditionChips({ lesson }: { lesson: Pick<Lesson, 'scope' | 'kind'> }) {
  const { t } = useTranslation();
  if (!lesson.scope) return null;
  // направление поправки — только у урока про вероятность: урок про сбор данных вероятность не меняет
  return (
    <div className="learning-cond" aria-label={t('learning.lessons.condLabel')} role="list">
      {lesson.kind === 'numeric' && (
        <span role="listitem">
          <Chip kind="outline">{t(`learning.scope.direction.${lesson.scope.direction}`)}</Chip>
        </span>
      )}
      {lesson.scope.conditions.map((condition) => (
        <span role="listitem" key={`${condition.feature}-${condition.op}`}>
          <Chip kind="outline">{conditionText(condition, t)}</Chip>
        </span>
      ))}
    </div>
  );
}

/** «Поправка −4,2 п.п. с усадкой (сырая −5,0 п.п.)». */
export function shiftText(lesson: Pick<Lesson, 'effect' | 'effect_shrunk'>, t: TFunction): string | null {
  if (lesson.effect_shrunk === null) return null;
  const shift = formatPp(lesson.effect_shrunk, { zero: '±' });
  return lesson.effect === null ? shift : t('learning.lessons.shiftValue', { shift, raw: formatPp(lesson.effect, { zero: '±' }) });
}

function Meta({ lesson }: { lesson: Lesson }) {
  const { t } = useTranslation();
  const history = lesson.history;
  const gain = history?.gain ?? null;
  const shift = lesson.kind === 'numeric' && (lesson.status === 'confirmed' || lesson.status === 'ready') ? shiftText(lesson, t) : null;
  const rows: { key: string; label: string; value: string }[] = [];
  if (lesson.status !== 'hypothesis') rows.push({ key: 'base', label: t('learning.lessons.meta.base'), value: baseText(lesson, t) });
  if (history && history.log_loss_with !== null && history.log_loss_without !== null && gain) {
    rows.push({
      key: 'effect',
      label: t('learning.lessons.meta.effect'),
      value: t('learning.lessons.effectValue', { with: dec3(history.log_loss_with), without: dec3(history.log_loss_without), gain: signed3(gain.value), ci: ci3(gain) }),
    });
  }
  if (shift) rows.push({ key: 'shift', label: t('learning.lessons.meta.shift'), value: shift });
  if (!rows.length) return null;
  return (
    <dl className="learning-meta">
      {rows.map((row) => (
        <div key={row.key}>
          <dt>{row.label}</dt>
          <dd>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

interface SideProps {
  lesson: Lesson;
  admin: boolean;
  onEnable: (lesson: Lesson) => void;
}

function ConfirmedSide({ lesson, admin, onEnable }: SideProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const disable = useLessonAction('disable');
  if (!admin) {
    return lesson.in_prompt ? (
      <Chip kind="good" icon="book">
        {t('learning.lessons.inPrompt')}
      </Chip>
    ) : (
      <Chip kind="outline" icon="eyeOff">
        {t('learning.lessons.offByAdmin')}
      </Chip>
    );
  }
  return (
    <Toggle
      label={t('learning.lessons.use')}
      hint={
        lesson.in_prompt
          ? lesson.decided_at
            ? t('learning.lessons.useOnSince', { date: formatDate(lesson.decided_at) })
            : t('learning.lessons.inPrompt')
          : t('learning.lessons.useOff')
      }
      checked={lesson.in_prompt}
      disabled={disable.isPending}
      onChange={(next) => {
        if (next) {
          onEnable(lesson);
          return;
        }
        disable.mutate(lesson.id, {
          onSuccess: () => toast.show(t('learning.lessons.toastOff', { code: lesson.code }), { icon: 'eyeOff', duration: 4000 }),
          onError: (error) => toast.show(errorMessage(error), { icon: 'alert', duration: 5000 }),
        });
      }}
    />
  );
}

function HypothesisSide({ lesson }: { lesson: Lesson }) {
  const { t } = useTranslation();
  const toast = useToast();
  const watch = useLessonAction('notify-when-ready');
  const progress =
    lesson.n_cases === null
      ? t('learning.lessons.fewOf', { need: lesson.need_cases })
      : t('learning.lessons.ownOf', { n: lesson.n_cases, need: lesson.need_cases });
  return (
    <>
      <div className="learning-progress">
        <div className="row-between">
          <span className="soft">{t('learning.lessons.ownCases')}</span>
          <b className="num">{progress}</b>
        </div>
        {/* меньше 5 случаев участнику числом не показываются — и полосой тоже */}
        {lesson.n_cases !== null && (
          <Meter
            value={Math.min(lesson.n_cases, lesson.need_cases)}
            max={lesson.need_cases}
            label={t('learning.lessons.ownCases')}
            valueText={progress}
          />
        )}
        {lesson.own_cases > 0 && (
          <span className="xsmall soft">{t('learning.lessons.yoursOf', { n: formatNumber(lesson.own_cases) })}</span>
        )}
        <span className="xsmall muted">{t('learning.lessons.noEffectYet')}</span>
      </div>
      {lesson.watching ? (
        <Chip kind="info" icon="bell">
          {t('learning.lessons.watching', { onCases: plural(t, 'onCases', lesson.need_cases) })}
        </Chip>
      ) : (
        <Button
          kind="secondary"
          size="sm"
          icon="bell"
          loading={watch.isPending}
          onClick={() =>
            watch.mutate(lesson.id, {
              onSuccess: () => toast.show(t('learning.lessons.toastWatch', { code: lesson.code, cases: t('learning.lessons.cases', { count: lesson.need_cases }) }), {
                  icon: 'bell',
                  duration: 4000,
                }),
              onError: (error) => toast.show(errorMessage(error), { icon: 'alert', duration: 5000 }),
            })
          }
        >
          {t('learning.lessons.watch')}
        </Button>
      )}
    </>
  );
}

function rejectedText(lesson: Lesson, t: TFunction): string {
  const history = lesson.history;
  if (history && history.log_loss_with !== null && history.log_loss_without !== null) {
    return t('learning.lessons.rejectedText', { with: dec3(history.log_loss_with), without: dec3(history.log_loss_without) });
  }
  const reason = historyReason(history?.reason);
  return reason ? t(`learning.lessons.historyReason.${reason}`) : t('learning.lessons.rejectedPlain');
}

/**
 * «Списан ‹дата› при ежемесячной перепроверке: эффект пропал (ДИ … задевает ноль)»: ДИ —
 * выигрыша на отложенной части, если урок не удержался на ней, иначе выигрыша на истории;
 * ДИ не задевает ноль (урок списан по другой причине) — без скобок.
 */
function retiredText(lesson: Lesson, t: TFunction): string {
  const history = lesson.history;
  const estimate = history?.reason === 'holdout' ? history.holdout_gain : (history?.gain ?? null);
  const ci = estimate && estimate.low <= 0 && estimate.high >= 0 ? ci3(estimate) : null;
  const date = lesson.retired_at ? formatDate(lesson.retired_at) : null;
  if (date) return ci ? t('learning.lessons.retiredTextCi', { date, ci }) : t('learning.lessons.retiredText', { date });
  return ci ? t('learning.lessons.retiredPlainCi', { ci }) : t('learning.lessons.retiredPlain');
}

function Side(props: SideProps) {
  const { t } = useTranslation();
  const { lesson, admin, onEnable } = props;
  switch (lesson.status) {
    case 'confirmed':
      return <ConfirmedSide {...props} />;
    case 'ready':
      return (
        <>
          <p className="small soft learning-side-text">
            {lesson.validated_at ? t('learning.lessons.readyText', { date: formatDate(lesson.validated_at) }) : t('learning.lessons.readyTextNoDate')}
          </p>
          {quickRunning(lesson) && (
            <Chip kind="info" icon="refresh">
              {t('learning.lessons.quickRunning')}
            </Chip>
          )}
          {admin ? (
            <Button kind="primary" size="sm" icon="check" onClick={() => onEnable(lesson)}>
              {t('learning.lessons.use')}
            </Button>
          ) : (
            <Chip kind="outline" icon="admin">
              {t('learning.lessons.waitsAdmin')}
            </Chip>
          )}
        </>
      );
    case 'hypothesis':
      return <HypothesisSide lesson={lesson} />;
    case 'rejected':
      return <p className="small soft learning-side-text">{rejectedText(lesson, t)}</p>;
    default:
      return <p className="small soft learning-side-text">{retiredText(lesson, t)}</p>;
  }
}

interface LessonCardProps {
  lesson: Lesson;
  admin: boolean;
  onEnable: (lesson: Lesson) => void;
  onOpen: (lesson: Lesson) => void;
}

export function LessonCard({ lesson, admin, onEnable, onOpen }: LessonCardProps) {
  const { t } = useTranslation();
  const off = lesson.status === 'confirmed' && !lesson.in_prompt;
  return (
    <article
      className={cx('learning-lesson', `is-${lessonTone(lesson.status)}`, off && 'is-off')}
      aria-label={t('learning.lessons.cardLabel', { code: lesson.code })}
      data-lesson-id={lesson.id}
    >
      <div className="learning-lesson-main">
        <div className="learning-lesson-head">
          <Chip kind="outline" className="mono">
            {lesson.code}
          </Chip>
          <LessonChip lesson={lesson} />
          {lesson.origin === 'manual' && (
            <Chip kind="outline" icon="user">
              {t('learning.lessons.manual')}
            </Chip>
          )}
          <span className="learning-kind">{t(`learning.lessons.kind.${lesson.kind}`)}</span>
          <span className="learning-date">{t('learning.lessons.since', { date: formatDate(lesson.created_at) })}</span>
        </div>
        <p className="learning-lesson-text">{lesson.text}</p>
        <ConditionChips lesson={lesson} />
        <Meta lesson={lesson} />
      </div>
      <div className="learning-lesson-side">
        <Side lesson={lesson} admin={admin} onEnable={onEnable} />
        <Button kind="ghost" size="sm" iconRight="chevronRight" className="learning-more" onClick={() => onOpen(lesson)}>
          {t('learning.lessons.more')}
        </Button>
      </div>
    </article>
  );
}
