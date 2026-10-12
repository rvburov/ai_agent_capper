import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { errorMessage } from '../../api/errors';
import type { Me } from '../../api/hooks/useMe';
import { paths } from '../../app/paths';
import { Callout, Card, Chip, Icon, Skeleton, useToast } from '../../components';
import { formatLimitUsd } from '../../features/admin/limits';
import type { AiBudget, AiMode } from '../../features/ai/types';
import { useAiBudget } from '../../features/ai/useAiBudget';
import { useSetAiMode } from '../../features/ai/useOwnKey';
import { cx } from '../../lib/cx';
import { KeyGuideCard, KeyStorageCard } from './KeyGuide';
import { AdminOwnerCard, MemberLimitCard } from './KeyLimitCards';
import { LoadError } from './LoadError';
import { OwnKeyCard, OwnSetupCard, ReturnCard } from './OwnKeyCards';

/** Какую карточку режима выбрали на экране. base — режим в тот момент: сменился режим — выбор забыт. */
interface Choice {
  base: AiMode;
  view: AiMode;
}

/** Есть что проверить во вкладке (точка у вкладки, как tabAttention в макете). */
export function keyNeedsAttention(budget: AiBudget | undefined, admin: boolean): boolean {
  if (!budget) return false;
  if (budget.mode === 'own') return !budget.own_key;
  if (admin || budget.monthly_usd === null) return false;
  return budget.paused || (budget.monthly_usd > 0 && (budget.spent_usd / budget.monthly_usd) * 100 >= budget.alert_pct);
}

/**
 * Вкладка «Ключ Claude» (panelKey макета, mockup/js/screens/profile.js): чей ключ использовать,
 * лимит на ключе администратора или свой ключ, просьба вернуть ключ администратора (Р7, Р12)
 * и справка. Администратор всегда на ключе администратора: «Свой ключ» ему недоступен.
 */
export function KeyTab({ me }: { me: Me }) {
  const { t } = useTranslation();
  const toast = useToast();
  const budget = useAiBudget();
  const setMode = useSetAiMode();
  const [choice, setChoice] = useState<Choice | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);
  const admin = me.role === 'admin';

  if (budget.isPending) {
    return (
      <Card>
        <Skeleton lines={4} height={18} />
      </Card>
    );
  }
  if (budget.isError) {
    return (
      <Card>
        <LoadError error={budget.error} onRetry={() => void budget.refetch()} />
      </Card>
    );
  }

  const data = budget.data;
  const mode = data.mode;
  const view = choice && choice.base === mode ? choice.view : mode;
  const ownKey = data.own_key;
  const showOwnCard = mode === 'own' && ownKey !== null && !replacing;

  function choose(next: AiMode) {
    setReplacing(false);
    // На свой ключ — сразу, если ключ уже сохранен и проверен (Р12); иначе — форма ключа
    const ready = ownKey !== null && ownKey.verified_at !== null && !ownKey.last_error;
    if (next === 'own' && mode === 'shared' && ready && !admin) {
      setMode.mutate('own', {
        onSuccess: () => toast.show(t('profile.key.own.switched'), { icon: 'key' }),
        onError: (error) => toast.show(errorMessage(error), { icon: 'alert' }),
      });
    }
    setChoice({ base: mode, view: next });
  }

  // «К полю ключа» из инструкции: карточка своего ключа, а если ключ уже есть — его замена
  function gotoKeyInput() {
    setChoice({ base: mode, view: 'own' });
    if (mode === 'own' && ownKey) setReplacing(true);
    setFocusRequest((n) => n + 1);
  }

  let main: ReactNode;
  if (view === 'shared') {
    if (mode === 'shared') main = admin ? <AdminOwnerCard budget={data} /> : <MemberLimitCard budget={data} />;
    else main = <ReturnCard budget={data} admin={admin} />;
  } else if (showOwnCard) {
    main = <OwnKeyCard budget={data} onReplace={gotoKeyInput} />;
  } else {
    main = (
      <OwnSetupCard
        budget={data}
        replacing={replacing && mode === 'own' && ownKey !== null}
        focusRequest={focusRequest}
        onCancel={() => setReplacing(false)}
        onSaved={() => {
          setReplacing(false);
          setChoice(null);
        }}
      />
    );
  }

  const needKey = view === 'own' && !showOwnCard;
  return (
    <>
      {admin && (
        <Callout kind="accent" icon="admin">
          <div className="row-between profile-admin-note">
            <span>
              <b>{t('profile.key.adminNoteStrong')}</b> {t('profile.key.adminNote')}
            </span>
            <Link className="profile-strong-link" to={paths.admin('key')}>
              {t('profile.key.adminNoteOpen')}
            </Link>
          </div>
        </Callout>
      )}
      <ModeCard budget={data} admin={admin} view={view} onChoose={choose} />
      <div className="grid">
        <div className="col-7 profile-col">{main}</div>
        <div className="col-5 profile-col">
          <KeyGuideCard budget={data} needKey={needKey} onGotoInput={gotoKeyInput} />
          <KeyStorageCard />
        </div>
      </div>
    </>
  );
}

interface ModeCardProps {
  budget: AiBudget;
  admin: boolean;
  view: AiMode;
  onChoose: (mode: AiMode) => void;
}

/** «Чей ключ Claude использовать» (modeCard макета): две карточки-переключателя. */
function ModeCard({ budget, admin, view, onChoose }: ModeCardProps) {
  const { t } = useTranslation();
  const actual = budget.mode;
  const requested = actual === 'own' && budget.return_requested_at !== null;
  const sharedText = admin
    ? t('profile.key.mode.sharedAdmin', { budget: formatLimitUsd(budget.budget?.budget_usd ?? 0) })
    : budget.monthly_usd !== null
      ? t('profile.key.mode.sharedMember', { limit: formatLimitUsd(budget.monthly_usd) })
      : t('profile.key.mode.sharedMemberOwn');
  const options: { id: AiMode; title: string; text: string }[] = [
    { id: 'shared', title: t('profile.key.mode.sharedTitle'), text: sharedText },
    {
      id: 'own',
      title: t('profile.key.mode.ownTitle'),
      text: admin ? t('profile.key.mode.ownAdmin') : t('profile.key.mode.ownMember'),
    },
  ];
  return (
    <Card
      id="profile-key-mode"
      className="profile-anchor"
      title={t('profile.key.mode.title')}
      subtitle={t('profile.key.mode.subtitle')}
    >
      <div className="profile-modes" role="radiogroup" aria-label={t('profile.key.mode.title')}>
        {options.map((option) => {
          const on = view === option.id;
          // Этап 3: администратор всегда на ключе администратора (свой ключ — только у участников)
          const locked = admin && option.id === 'own' && actual !== 'own';
          const inputId = `profile-mode-${option.id}`;
          return (
            <label
              key={option.id}
              htmlFor={inputId}
              className={cx('profile-mode', on && 'is-on', locked && 'is-locked')}
            >
              <input
                type="radio"
                name="profile-key-mode"
                id={inputId}
                value={option.id}
                checked={on}
                disabled={locked}
                className="profile-mode-input"
                onChange={() => onChoose(option.id)}
              />
              <span className="profile-mode-dot" aria-hidden="true" />
              <span className="profile-mode-body">
                <span className="profile-mode-title">
                  {option.title}
                  {actual === option.id && (
                    <Chip kind="good" icon="check">
                      {t('profile.key.mode.active')}
                    </Chip>
                  )}
                  {option.id === 'shared' && requested && (
                    <Chip kind="info" icon="clock">
                      {t('profile.key.mode.requested')}
                    </Chip>
                  )}
                </span>
                <span className="profile-mode-text">{option.text}</span>
              </span>
            </label>
          );
        })}
      </div>
      <p className="profile-note">
        <Icon name="info" />
        <span>{admin ? t('profile.key.mode.noteAdmin') : t('profile.key.mode.noteMember')}</span>
      </p>
    </Card>
  );
}
