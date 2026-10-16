import type { TFunction } from 'i18next';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { errorMessage } from '../../../api/errors';
import { Button, Callout, Dropdown, Field, FieldShell, KeyValue, Modal, Skeleton, useToast } from '../../../components';
import { formatShare } from '../../../features/analysis/markets';
import type { Adaptation, Bank, Strategy } from '../../../features/bank/types';
import { currencyOf } from '../../../features/bets/display';
import type { RulesCandidateIn, RulesCheck, StrategyVersion } from '../../../features/learning/types';
import { findActive, findCandidate, ruleCode, rulesCodes, versionShort } from '../../../features/learning/versionList';
import { useCreateRulesCandidate, useStrategyVersions, useVersionDecision } from '../../../features/learning/versions';
import { formatDate, formatMoney, formatNumber, formatOdds, formatPercent } from '../../../lib/format';
import { ruleText } from './AdaptCard';

// Правила суммы ставки — у каждого участника свои (В5 этапа 5) и меняются новой версией:
// «Предложить изменение» → кандидат, сервер сразу проверяет его на ваших ставках (как
// изменились бы суммы и прибыль при тех же исходах, сколько раз сработало бы правило) →
// «Включить», откат — «Вернуть». Пересчет делает код сервера, без ИИ и бесплатно.

/** Итог проверки кандидата на своих ставках словами. */
export function checkText(check: RulesCheck, bank: Pick<Bank, 'currency'>, labels: ReadonlyMap<string, string>, t: TFunction): string {
  if (check.bets === 0) return t('profile.bank.rules.checkNone');
  const currency = currencyOf(check.currency || bank.currency);
  const money = (value: string) => formatMoney(value, currency);
  const parts = [
    t('profile.bank.rules.checkBets', {
      since: formatDate(check.since),
      bets: t('profile.bank.rules.bets', { count: check.bets }),
      changed: formatNumber(check.changed),
    }),
    t('profile.bank.rules.checkStake', {
      old: money(check.stake_old),
      next: money(check.stake_new),
      change: check.stake_change !== null ? ` (${formatPercent(check.stake_change, { digits: 0, signed: true })})` : '',
    }),
    t('profile.bank.rules.checkProfit', { old: money(check.profit_old), next: money(check.profit_new) }),
  ];
  const fired = Object.entries(check.triggered).filter(([, n]) => n > 0);
  if (fired.length) {
    parts.push(
      t('profile.bank.rules.checkFired', {
        list: fired.map(([key, n]) => t('profile.bank.rules.firedItem', { rule: labels.get(key) ?? key, times: t('profile.bank.rules.times', { count: n }) })).join('; '),
      }),
    );
  }
  return parts.join(' ');
}

function useAdaptLabels(bank: Bank, strategy: Strategy | undefined): Map<string, string> {
  const { t } = useTranslation();
  return new Map(bank.adaptations.map((rule: Adaptation) => [rule.key, ruleText(rule, strategy?.params ?? null, t)]));
}

interface BlockProps {
  bank: Bank;
  strategy: Strategy | undefined;
}

/** «Версия правил» в «Правилах стратегии»: действует, кандидат с проверкой, включить, вернуть. */
export function RuleVersionsBlock({ bank, strategy }: BlockProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const versions = useStrategyVersions();
  const activate = useVersionDecision('activate');
  const reject = useVersionDecision('reject');
  const rollback = useVersionDecision('rollback');
  const labels = useAdaptLabels(bank, strategy);
  const [error, setError] = useState<string | null>(null);
  const rules = versions.data?.rules ?? [];
  const active = findActive(rules);
  const candidate = findCandidate(rules);
  const codes = rulesCodes(rules);
  const code = (version: StrategyVersion) => ruleCode(codes, version);
  const name = (version: StrategyVersion | null) => (version ? [code(version), versionShort(version)].filter(Boolean).join(' · ') : '—');

  function decide(version: StrategyVersion, action: 'activate' | 'reject' | 'rollback') {
    setError(null);
    const mutation = action === 'activate' ? activate : action === 'reject' ? reject : rollback;
    mutation.mutate(version.id, {
      onSuccess: (saved) => {
        const text =
          action === 'activate'
            ? t('profile.bank.rules.toastOn', { code: code(saved), prev: active ? code(active) : '' })
            : action === 'reject'
              ? t('profile.bank.rules.toastReject', { code: code(saved) })
              : t('profile.bank.rules.toastRollback', { code: code(saved) });
        toast.show(text, { icon: action === 'reject' ? 'x' : action === 'rollback' ? 'history' : 'check', duration: 5000 });
      },
      onError: (failure) => setError(errorMessage(failure)),
    });
  }

  // «Вернуть» — любую архивную версию, которая уже действовала (can_rollback решает сервер:
  // исходные правила — да, история старого бота — нет); ушедшая в архив последней — первой
  const returnable = !candidate
    ? [...rules]
        .filter((version) => version.can_rollback && version.status === 'archived')
        .sort((a, b) => (b.archived_at ?? '').localeCompare(a.archived_at ?? '') || b.id - a.id)
    : [];
  return (
    <div className="stack profile-tight">
      <div className="profile-section-title">
        <h4>{t('profile.bank.rules.title')}</h4>
        <span className="xsmall muted">{t('profile.bank.rules.own')}</span>
      </div>
      {versions.isPending ? (
        <Skeleton lines={2} />
      ) : (
        <KeyValue
          items={[
            { key: 'active', label: t('profile.bank.rules.active'), value: name(active) },
            { key: 'candidate', label: t('profile.bank.rules.candidate'), value: candidate ? name(candidate) : t('profile.bank.rules.noCandidate') },
          ]}
        />
      )}
      {candidate?.check && <Callout kind="info" icon="history">{checkText(candidate.check, bank, labels, t)}</Callout>}
      {candidate && (
        <div className="row">
          <Button kind="primary" size="sm" icon="check" loading={activate.isPending} disabled={!candidate.can_activate} onClick={() => decide(candidate, 'activate')}>
            {t('profile.bank.rules.enable', { code: code(candidate) })}
          </Button>
          <Button kind="ghost" size="sm" loading={reject.isPending} onClick={() => decide(candidate, 'reject')}>
            {t('profile.bank.rules.reject')}
          </Button>
        </div>
      )}
      {returnable.length > 0 && (
        <div className="row">
          {returnable.map((version) => (
            <Button
              key={version.id}
              kind="ghost"
              size="sm"
              icon="history"
              loading={rollback.isPending && rollback.variables === version.id}
              disabled={rollback.isPending}
              onClick={() => decide(version, 'rollback')}
            >
              {t('profile.bank.rules.rollback', { code: code(version) })}
            </Button>
          ))}
        </div>
      )}
      {error && (
        <Callout kind="bad" icon="alert" role="alert">
          {error}
        </Callout>
      )}
    </div>
  );
}

const PCT_MIN = 0.1;
const PCT_MAX = 5;

/** «Предложить изменение правил»: одно изменение — один кандидат (как в макете). */
export function ProposeRulesModal({ bank, strategy, onClose }: BlockProps & { onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const create = useCreateRulesCandidate();
  const activate = useVersionDecision('activate');
  const versions = useStrategyVersions();
  // новый кандидат уже в списке версий (storeVersion): его код по порядку в линии
  const code = (version: StrategyVersion) => ruleCode(rulesCodes(versions.data?.rules ?? []), version);
  const labels = useAdaptLabels(bank, strategy);
  const [choice, setChoice] = useState<string | null>(null);
  const [pct, setPct] = useState('');
  const [pctError, setPctError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<StrategyVersion | null>(null);
  const bands = strategy?.params.stake_bands ?? [];
  const options = [
    ...bank.adaptations.map((rule) => ({
      value: `adapt:${rule.key}`,
      label: t(rule.enabled ? 'profile.bank.rules.turnOff' : 'profile.bank.rules.turnOn', { rule: labels.get(rule.key) ?? rule.key }),
    })),
    ...bands.map((band, index) => ({
      value: `band:${index}`,
      label: t('profile.bank.rules.band', { range: `${formatOdds(band.low)}–${formatOdds(band.high)}`, pct: formatShare(Number(band.pct)) }),
    })),
  ];
  const bandIndex = choice?.startsWith('band:') ? Number(choice.slice(5)) : null;

  function submit() {
    setError(null);
    if (!choice) {
      setError(t('profile.bank.rules.pickError'));
      return;
    }
    const body: RulesCandidateIn = {};
    if (bandIndex !== null) {
      const value = Number(pct.replace(',', '.'));
      if (!Number.isFinite(value) || value < PCT_MIN || value > PCT_MAX) {
        setPctError(t('profile.bank.rules.pctError', { min: formatNumber(PCT_MIN, 1), max: formatNumber(PCT_MAX) }));
        return;
      }
      body.stake_bands = [{ index: bandIndex, pct: Math.round(value * 100) / 10000 }];
    } else {
      const key = choice.slice(6);
      const rule = bank.adaptations.find((item) => item.key === key);
      body.adapt = { [key]: !(rule?.enabled ?? false) };
    }
    create.mutate(body, {
      onSuccess: (version) => {
        setCreated(version);
        toast.show(t('profile.bank.rules.toastCreated', { code: code(version) }), { icon: 'flask' });
      },
      onError: (failure) => setError(errorMessage(failure)),
    });
  }

  if (created) {
    return (
      <Modal
        open
        onClose={onClose}
        title={t('profile.bank.rules.createdTitle', { code: code(created) })}
        footer={
          <>
            <Button kind="secondary" onClick={onClose}>
              {t('profile.bank.rules.later')}
            </Button>
            <Button
              kind="primary"
              icon="check"
              loading={activate.isPending}
              disabled={!created.can_activate}
              onClick={() =>
                activate.mutate(created.id, {
                  onSuccess: (saved) => {
                    onClose();
                    toast.show(t('profile.bank.rules.toastOn', { code: code(saved), prev: '' }), { icon: 'check', duration: 5000 });
                  },
                  onError: (failure) => setError(errorMessage(failure)),
                })
              }
            >
              {t('profile.bank.rules.enable', { code: code(created) })}
            </Button>
          </>
        }
      >
        {created.changes.length > 0 && (
          <ul className="profile-changes">
            {created.changes.map((change) => (
              <li key={change}>{change}</li>
            ))}
          </ul>
        )}
        <Callout kind="info" icon="history">
          <b>{t('profile.bank.rules.checkTitle')} </b>
          {created.check ? checkText(created.check, bank, labels, t) : t('profile.bank.rules.checkNone')}
        </Callout>
        <p className="small soft">{t('profile.bank.rules.createdNote')}</p>
        {error && (
          <Callout kind="bad" icon="alert" role="alert">
            {error}
          </Callout>
        )}
      </Modal>
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('profile.bank.rules.proposeTitle')}
      footer={
        <>
          <Button kind="secondary" onClick={onClose}>
            {t('profile.bank.rules.cancel')}
          </Button>
          <Button kind="primary" icon="flask" loading={create.isPending} onClick={submit}>
            {t('profile.bank.rules.create')}
          </Button>
        </>
      }
    >
      <p className="small soft">{t('profile.bank.rules.proposeLead')}</p>
      <FieldShell id="profile-rule-change" label={t('profile.bank.rules.what')}>
        <Dropdown
          id="profile-rule-change"
          label={t('profile.bank.rules.what')}
          placeholder={t('profile.bank.rules.pick')}
          options={options}
          value={choice}
          onChange={(value) => {
            setChoice(value);
            setError(null);
            setPctError(null);
          }}
        />
      </FieldShell>
      {bandIndex !== null && (
        <Field
          id="profile-rule-pct"
          label={t('profile.bank.rules.pct')}
          hint={t('profile.bank.rules.pctHint', { min: formatNumber(PCT_MIN, 1), max: formatNumber(PCT_MAX) })}
          error={pctError}
          inputMode="decimal"
          suffix="%"
          value={pct}
          onChange={(event) => {
            setPct(event.target.value);
            setPctError(null);
          }}
        />
      )}
      <Callout kind="info" icon="history">
        {t('profile.bank.rules.proposeNote')}
      </Callout>
      {error && (
        <Callout kind="bad" icon="alert" role="alert">
          {error}
        </Callout>
      )}
    </Modal>
  );
}
