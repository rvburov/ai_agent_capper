import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { paths } from '../../app/paths';
import { Disclosure, Icon } from '../../components';
import { keyText } from '../../features/analysis/codes';
import { modelName, usdSmall } from '../../features/analysis/markets';
import { analysisNumber } from '../../features/analysis/number';
import type { Analysis, Result } from '../../features/analysis/types';
import { formatDuration, formatTokens, formatUsd } from '../../lib/format';
import { MOBILE_QUERY, useMediaQuery } from '../../lib/useMediaQuery';
import { matchTitle, type MatchNames } from './MatchCard';
import { runNumbers } from './Progress';

// «Почему так» (whyCard в mockup/js/screens/analysis.js): пояснения Claude по матчам и проверка
// экспресса по правилам стратегии; на компьютере раскрыто, на телефоне свернуто.
export function WhyCard({ result, names, strategyCode }: { result: Result; names: MatchNames; strategyCode: string }) {
  const { t } = useTranslation();
  const mobile = useMediaQuery(MOBILE_QUERY);
  const [open, setOpen] = useState<boolean | null>(null);
  const rules = result.express?.rules ?? [];
  const bad = rules.filter((r) => !r.ok).length;
  const reasons = result.matches.length;
  const sub = [t('analysis.why.sub', { count: reasons }), rules.length ? t('analysis.why.rules', { count: rules.length }) : null, bad ? t('analysis.why.bad', { count: bad }) : null]
    .filter(Boolean)
    .join(' · ');
  return (
    <section className="card analysis-why" aria-label={t('analysis.why.title')}>
      <Disclosure
        variant="header"
        open={open ?? !mobile}
        onToggle={setOpen}
        summary={
          <span className="analysis-why-text">
            <span className="analysis-why-title">{t('analysis.why.title')}</span>
            <span className="card-sub">{sub}</span>
          </span>
        }
        bodyClassName="analysis-why-body"
      >
        <ol className="analysis-reasons">
          {result.matches.map((match) => (
            <li key={match.match_id}>
              <b>{matchTitle(match, names, t)}.</b> {match.explanation}
              {match.highlight && match.divergence_note ? ` ${match.divergence_note}` : ''}
            </li>
          ))}
        </ol>
        {rules.length > 0 && (
          <div className="stack analysis-rules-block">
            <h4>{t('analysis.why.rulesTitle', { code: strategyCode })}</h4>
            <ul className="analysis-rules">
              {rules.map((rule) => (
                <li key={rule.key} className={rule.ok ? 'ok' : 'warn'}>
                  <Icon name={rule.ok ? 'check' : 'alert'} />
                  <div>
                    <span className="sr-only">{rule.ok ? t('analysis.why.ok') : t('analysis.why.notOk')}</span>
                    {keyText(rule.key, rule.params, rule.key)}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Disclosure>
    </section>
  );
}

/** Строка расходов анализа со ссылкой на «ИИ и расходы». */
export function MetaLine({ analysis }: { analysis: Analysis }) {
  const { t } = useTranslation();
  const costs = analysis.result?.costs;
  if (!costs) return null;
  // Те же числа, что в счетчиках «Анализ готов» (runNumbers)
  const numbers = runNumbers(analysis);
  const parts = [
    t('analysis.meta.mode'),
    t('analysis.meta.tokens', { tokens: formatTokens(numbers.tokens), share: Math.round(costs.cache_share * 100) }),
    costs.searches ? t('analysis.meta.searches', { count: costs.searches }) : t('analysis.meta.noSearch'),
    costs.estimate_usd !== null
      ? t('analysis.meta.costEst', { cost: usdSmall(numbers.costUsd), est: formatUsd(costs.estimate_usd) })
      : usdSmall(numbers.costUsd),
    formatDuration(numbers.elapsedMs),
    costs.models.map(modelName).join(' + '),
  ].filter(Boolean);
  return (
    <Link className="analysis-meta" to={paths.costs} title={t('analysis.meta.title')}>
      <Icon name="coins" />
      <span>
        <b>{t('analysis.meta.id', { id: analysisNumber(analysis.id) })}</b> · {parts.join(' · ')}
      </span>
      <Icon name="chevronRight" />
    </Link>
  );
}

