import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { errorMessage } from '../../api/errors';
import { Button, Callout, Chip, DataTable, Modal, Skeleton, useToast } from '../../components';
import type { EvalSet, StrategyVersion } from '../../features/learning/types';
import {
  ciNum3,
  compareRows,
  dec3,
  ecePct,
  reasonText,
  rowVerdict,
  signed3,
  tokensText,
  VERDICT_CALLOUT,
  VERSION_CHIP,
  type CompareRow,
} from '../../features/learning/versionView';
import { useVersionCompare, useVersionDecision } from '../../features/learning/versions';
import { formatDateLong, formatNumber, formatUsd } from '../../lib/format';
import { MOBILE_QUERY, useMediaQuery } from '../../lib/useMediaQuery';

// Окна «Версии стратегии» (versionModal и compareModal макета): версия с метриками прогона на
// наборе и что изменилось; сравнение кандидата с активной — разницы с ДИ парного бутстрэпа по
// дням и вывод кода по правилу приема. Включает, отклоняет и возвращает только администратор;
// отказ сервера (не было прогона, урок отклонен, предел уроков) — его текстом.

export function VersionChip({ status }: { status: StrategyVersion['status'] }) {
  const { t } = useTranslation();
  const chip = VERSION_CHIP[status];
  return (
    <Chip kind={chip.kind} icon={chip.icon}>
      {t(`learning.versions.status.${status}`)}
    </Chip>
  );
}

type Fact = readonly [string, string] | null | false;

function Facts({ items }: { items: readonly Fact[] }) {
  return (
    <dl className="learning-facts">
      {items
        .filter((item): item is readonly [string, string] => Boolean(item))
        .map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
    </dl>
  );
}

function Changes({ title, changes }: { title: string; changes: readonly string[] }) {
  if (!changes.length) return null;
  return (
    <div className="learning-cond-box">
      <div className="eyebrow">{title}</div>
      <ul className="learning-changes">
        {changes.map((change) => (
          <li key={change}>{change}</li>
        ))}
      </ul>
    </div>
  );
}

interface VersionModalProps {
  version: StrategyVersion;
  active: StrategyVersion | null;
  set: EvalSet | null;
  admin: boolean;
  onCompare: () => void;
  onClose: () => void;
}

export function VersionModal({ version, active, set, admin, onCompare, onClose }: VersionModalProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const rollback = useVersionDecision('rollback');
  const reject = useVersionDecision('reject');
  const activate = useVersionDecision('activate');
  const [error, setError] = useState<string | null>(null);
  // «Отклонить» необратимо (кандидат уходит в «Не включена»): сначала подтверждение
  const [confirmReject, setConfirmReject] = useState(false);
  const rejectRef = useRef<HTMLButtonElement>(null);
  const ev = version.eval;
  const n = ev?.n ?? set?.n_events ?? 0;
  const candidate = version.status === 'candidate';

  function decide(action: 'rollback' | 'reject' | 'activate') {
    setError(null);
    const mutation = action === 'rollback' ? rollback : action === 'reject' ? reject : activate;
    mutation.mutate(version.id, {
      onSuccess: (saved) => {
        onClose();
        const text =
          action === 'rollback'
            ? t('learning.versions.toastRollback', { code: saved.code, prev: active?.code ?? '' })
            : action === 'reject'
              ? t('learning.versions.toastReject', { code: saved.code })
              : t('learning.versions.toastActivate', { code: saved.code, prev: active?.code ?? '' });
        toast.show(text, { icon: action === 'reject' ? 'x' : action === 'rollback' ? 'history' : 'check', duration: 5000 });
      },
      onError: (failure) => setError(errorMessage(failure)),
    });
  }

  const market = ev?.to_market ?? null;
  const facts: Fact[] = ev
    ? [
        ev.log_loss !== null && [
          t('learning.versions.facts.logLoss'),
          market && set?.market_log_loss != null
            ? t('learning.versions.facts.logLossValue', { ll: dec3(ev.log_loss), market: dec3(set.market_log_loss), diff: signed3(market.value), ci: ciNum3(market) })
            : dec3(ev.log_loss),
        ],
        ev.brier !== null && [t('learning.versions.facts.brier'), dec3(ev.brier)],
        ev.ece !== null && [t('learning.versions.facts.ece'), ecePct(ev.ece)],
        [t('learning.versions.facts.format'), t('learning.compare.ofN', { value: formatNumber(ev.format_errors), n: formatNumber(n) })],
        (ev.max_tokens > 0 || ev.refusals > 0) && [
          t('learning.versions.facts.cutoffs'),
          t('learning.versions.facts.cutoffsValue', { cut: formatNumber(ev.max_tokens), refusals: formatNumber(ev.refusals) }),
        ],
        [t('learning.versions.facts.runs'), `${formatNumber(ev.runs)} · ${ev.eval_set_code}`],
        ev.noise !== null && [t('learning.versions.facts.noise'), dec3(ev.noise)],
        ev.tokens_per_event !== null && [t('learning.versions.facts.tokens'), tokensText(ev.tokens_per_event, t)],
        ev.cost_per_event_usd !== null && [t('learning.versions.facts.cost'), formatUsd(ev.cost_per_event_usd, 3)],
      ]
    : [];
  const meta: Fact[] = [
    version.base_prompt !== null && [t('learning.versions.facts.prompt'), version.base_prompt],
    version.lessons.length > 0 && [t('learning.versions.facts.lessons'), version.lessons.join(', ')],
    version.parent_code !== null && [t('learning.versions.facts.parent'), version.parent_code],
    version.activated_at !== null && [t('learning.versions.facts.activated'), formatDateLong(version.activated_at)],
  ];

  const footer = confirmReject ? (
    <>
      <Button
        kind="secondary"
        onClick={() => {
          setConfirmReject(false);
          requestAnimationFrame(() => rejectRef.current?.focus());
        }}
      >
        {t('learning.versions.rejectNo')}
      </Button>
      <Button id="learning-reject-yes" kind="danger" icon="x" loading={reject.isPending} onClick={() => decide('reject')}>
        {t('learning.versions.rejectYes', { code: version.code })}
      </Button>
    </>
  ) : (
    <>
      {admin && version.can_rollback && (
        <Button kind="secondary" icon="history" loading={rollback.isPending} onClick={() => decide('rollback')}>
          {t('learning.versions.rollback', { code: version.code })}
        </Button>
      )}
      {candidate && active && (
        <Button
          kind="secondary"
          icon="layers"
          onClick={() => {
            onClose();
            onCompare();
          }}
        >
          {t('learning.versions.compareWith', { code: active.code })}
        </Button>
      )}
      {admin && candidate && (
        <Button
          ref={rejectRef}
          kind="ghost"
          icon="x"
          onClick={() => {
            setError(null);
            setConfirmReject(true);
            requestAnimationFrame(() => document.getElementById('learning-reject-yes')?.focus());
          }}
        >
          {t('learning.versions.reject')}
        </Button>
      )}
      {admin && candidate && (
        <Button kind="primary" icon="check" disabled={!version.can_activate} loading={activate.isPending} onClick={() => decide('activate')}>
          {t('learning.versions.activate', { code: version.code })}
        </Button>
      )}
      {!(admin && candidate) && (
        <Button kind="primary" onClick={onClose}>
          {t('common.close')}
        </Button>
      )}
    </>
  );

  return (
    <Modal open onClose={onClose} title={t('learning.versions.modalTitle', { name: version.name })} className="learning-modal" footer={footer}>
      <div className="row">
        <VersionChip status={version.status} />
        <span className="small muted">{t('learning.versions.created', { date: formatDateLong(version.created_at) })}</span>
      </div>
      {ev ? <Facts items={facts} /> : <p className="small soft">{set ? t('learning.versions.noEval') : t('learning.versions.noEvalNoSet')}</p>}
      <Facts items={meta} />
      <Changes title={t('learning.versions.changes')} changes={version.changes} />
      {admin && candidate && !version.can_activate && version.activate_reason && (
        <Callout kind="warn" icon="alert" role="status">
          {reasonText(version.activate_reason, t, { lesson: version.lessons.join(', ') })}
        </Callout>
      )}
      {!admin && candidate && (
        <Callout kind="info" icon="admin">
          {t('learning.versions.adminDecides')}
        </Callout>
      )}
      {confirmReject && (
        <Callout kind="warn" icon="alert" role="status">
          {t('learning.versions.rejectConfirm', { code: version.code })}
        </Callout>
      )}
      {error && (
        <Callout kind="bad" icon="alert" role="alert">
          {error}
        </Callout>
      )}
    </Modal>
  );
}

function Verdict({ row, rule }: { row: CompareRow; rule: 'improve' | 'non_inferior' }) {
  const { t } = useTranslation();
  const verdict = rowVerdict(row, rule);
  if (!verdict) return null;
  return (
    <Chip kind={verdict.kind} icon={verdict.icon}>
      {t(`learning.compare.verdicts.${verdict.text}`)}
    </Chip>
  );
}

interface CompareModalProps {
  a: StrategyVersion;
  b: StrategyVersion;
  admin: boolean;
  onClose: () => void;
}

export function CompareModal({ a, b, admin, onClose }: CompareModalProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const mobile = useMediaQuery(MOBILE_QUERY);
  const query = useVersionCompare(a.id, b.id);
  const activate = useVersionDecision('activate');
  const [error, setError] = useState<string | null>(null);
  const data = query.data;
  const comparison = data?.comparison ?? null;
  // свежая версия кандидата из ответа сравнения: можно ли включать — по ней
  const candidate = data?.b ?? b;

  function turnOn() {
    setError(null);
    activate.mutate(candidate.id, {
      onSuccess: (saved) => {
        onClose();
        toast.show(t('learning.versions.toastActivate', { code: saved.code, prev: a.code }), { icon: 'check', duration: 5000 });
      },
      onError: (failure) => setError(errorMessage(failure)),
    });
  }

  let body;
  if (query.isPending) body = <Skeleton lines={5} />;
  else if (!data) {
    body = (
      <Callout kind="bad" icon="alert" role="alert">
        {errorMessage(query.error)}
      </Callout>
    );
  } else if (!comparison) {
    body = (
      <>
        <p className="small soft">{t('learning.compare.noRun', { code: candidate.code })}</p>
        {data.diff.length > 0 && (
          <ul className="learning-changes">
            {data.diff.map((row) => (
              <li key={row.key}>{t('learning.compare.paramDiff', { key: row.key, a: row.a ?? '—', b: row.b ?? '—' })}</li>
            ))}
          </ul>
        )}
      </>
    );
  } else {
    const rows = compareRows(comparison, t);
    const label = (row: CompareRow) => t(`learning.compare.rows.${row.key}`);
    const call = VERDICT_CALLOUT[comparison.verdict];
    body = (
      <>
        <p className="small soft">
          {t('learning.compare.lead', {
            matches: t('learning.plural.onMatches', { count: comparison.n, n: formatNumber(comparison.n) }),
            seed: comparison.seed,
            b: formatNumber(comparison.bootstrap),
          })}{' '}
          {t(`learning.compare.rule_${comparison.rule}`, { code: candidate.code })}
        </p>
        {mobile ? (
          <div className="learning-cmp-list">
            {rows.map((row) => (
              <div key={row.key} className="learning-cmp-item">
                <div className="learning-cmp-top">
                  <b>{label(row)}</b>
                  <Verdict row={row} rule={comparison.rule} />
                </div>
                <div className="small num">{t('learning.compare.mobileLine', { a: a.code, av: row.a, b: candidate.code, bv: row.b, diff: row.diff })}</div>
                {(row.ci || row.tolerance) && <div className="xsmall muted">{[row.ci, row.tolerance].filter(Boolean).join(' · ')}</div>}
              </div>
            ))}
          </div>
        ) : (
          <DataTable
            mobileLayout="table"
            caption={t('learning.compare.title', { a: a.code, b: candidate.code })}
            rows={rows}
            rowKey={(row) => row.key}
            columns={[
              { key: 'k', label: t('learning.compare.cols.metric'), render: (row) => <b className="learning-strong">{label(row)}</b> },
              { key: 'a', label: t('learning.compare.cols.a', { code: a.code }), align: 'r', render: (row) => row.a },
              { key: 'b', label: t('learning.compare.cols.b', { code: candidate.code }), align: 'r', render: (row) => row.b },
              {
                key: 'd',
                label: t('learning.compare.cols.diff'),
                align: 'r',
                render: (row) => (
                  <div>
                    <div>{row.diff}</div>
                    {[row.ci, row.tolerance].filter(Boolean).map((text) => (
                      <div key={text} className="xsmall muted learning-nowrap">
                        {text}
                      </div>
                    ))}
                  </div>
                ),
              },
              { key: 'v', label: t('learning.compare.cols.verdict'), render: (row) => <Verdict row={row} rule={comparison.rule} /> },
            ]}
          />
        )}
        <Changes title={t('learning.compare.changes', { code: candidate.code })} changes={candidate.changes} />
        <Callout kind={call.kind} icon={call.icon}>
          <b>{t('learning.compare.verdictTitle')} </b>
          {t(`learning.compare.verdict.${comparison.verdict}`, { a: a.code, b: candidate.code })}
        </Callout>
      </>
    );
  }

  const footer = admin ? (
    <>
      <Button
        kind="secondary"
        onClick={() => {
          onClose();
          toast.show(t('learning.compare.toastKeep', { a: a.code, b: candidate.code }), { icon: 'clock' });
        }}
      >
        {t('learning.compare.keep', { code: a.code })}
      </Button>
      <Button kind="primary" icon="check" disabled={!candidate.can_activate} loading={activate.isPending} onClick={turnOn}>
        {t('learning.versions.activate', { code: candidate.code })}
      </Button>
    </>
  ) : (
    <Button kind="primary" onClick={onClose}>
      {t('common.close')}
    </Button>
  );

  return (
    <Modal open onClose={onClose} wide title={t('learning.compare.title', { a: a.code, b: candidate.code })} className="learning-modal" footer={footer}>
      {body}
      {admin && !candidate.can_activate && candidate.activate_reason && (
        <Callout kind="warn" icon="alert" role="status">
          {reasonText(candidate.activate_reason, t, { lesson: candidate.lessons.join(', ') })}
        </Callout>
      )}
      {!admin && (
        <Callout kind="info" icon="admin">
          {t('learning.versions.adminDecides')}
        </Callout>
      )}
      {error && (
        <Callout kind="bad" icon="alert" role="alert">
          {error}
        </Callout>
      )}
    </Modal>
  );
}
