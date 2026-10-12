import type { ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button, Card, Icon, KeyValue, type IconName } from '../../components';
import type { AiBudget } from '../../features/ai/types';
import { formatUsd } from '../../lib/format';

// Ссылки инструкции — как в docs/CLAUDE_API_KEY.md
const CONSOLE_URL = 'https://platform.claude.com/';
const KEYS_URL = 'https://platform.claude.com/settings/keys';
const COUNTRIES_URL = 'https://www.anthropic.com/supported-countries';
// Ориентиры цены из docs/CLAUDE_API_KEY.md, пока своих анализов нет: анализ двух матчей,
// расход в месяц при 1–2 анализах в день, новости одного матча
const GUIDE_ANALYSIS_USD = 0.3;
const GUIDE_MONTH_USD = [10, 20] as const;
const GUIDE_NEWS_USD = 0.05;

const STEPS = ['step1', 'step2', 'step3', 'step4', 'step5', 'step6', 'step7'] as const;
const HOW = [
  { id: 'paid', icon: 'coins' },
  { id: 'news', icon: 'globe' },
  { id: 'spent', icon: 'chart' },
  { id: 'shared', icon: 'users' },
  { id: 'failed', icon: 'alert' },
  { id: 'back', icon: 'refresh' },
] as const satisfies readonly { id: string; icon: IconName }[];

function External({ href, children }: { href: string; children?: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

function Details({ id, icon, title, open, children }: { id?: string; icon: IconName; title: string; open?: boolean; children: ReactNode }) {
  return (
    <details className="profile-details" id={id} open={open}>
      <summary>
        <Icon name={icon} />
        <span>{title}</span>
        <Icon name="chevronDown" className="chev" />
      </summary>
      <div className="profile-details-body">{children}</div>
    </details>
  );
}

const RICH = {
  b: <b />,
  code: <span className="mono" />,
  console: <External href={CONSOLE_URL} />,
  keys: <External href={KEYS_URL} />,
  countries: <External href={COUNTRIES_URL} />,
};

interface KeyGuideCardProps {
  budget: AiBudget;
  /** Сейчас нужен ключ (открыта форма своего ключа): шаги раскрыты, без кнопки «К полю ключа». */
  needKey: boolean;
  onGotoInput: () => void;
}

/** «Как получить свой ключ» (guideCard макета) — по docs/CLAUDE_API_KEY.md. */
export function KeyGuideCard({ budget, needKey, onGotoInput }: KeyGuideCardProps) {
  const { t } = useTranslation();
  const avg = budget.avg_analysis_usd;
  return (
    <Card
      id="profile-key-guide"
      className="profile-anchor"
      title={t('profile.key.guide.title')}
      subtitle={t('profile.key.guide.subtitle')}
    >
      <div className="stack profile-tight">
        <h4>{t('profile.key.guide.firstTitle')}</h4>
        <ul className="profile-bullets warnlist">
          <li>
            <Icon name="alert" />
            <span>
              <Trans i18nKey="profile.key.guide.subscription" components={RICH} />
            </span>
          </li>
          <li>
            <Icon name="globe" />
            <span>
              <Trans i18nKey="profile.key.guide.country" components={RICH} />
            </span>
          </li>
        </ul>
      </div>
      <Details id="profile-key-steps" icon="list" title={t('profile.key.guide.stepsTitle')} open={needKey}>
        <ol className="profile-steps">
          {STEPS.map((step, i) => (
            <li key={step}>
              <div>
                <span>
                  <Trans i18nKey={`profile.key.guide.${step}`} components={RICH} />
                </span>
                {i === STEPS.length - 1 && !needKey && (
                  <Button size="sm" icon="arrowRight" onClick={onGotoInput}>
                    {t('profile.key.guide.toInput')}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ol>
      </Details>
      <Details icon="info" title={t('profile.key.guide.howTitle')}>
        <ul className="profile-bullets">
          {HOW.map((item) => (
            <li key={item.id}>
              <Icon name={item.icon} />
              <span>{t(`profile.key.guide.how.${item.id}`, { amount: formatUsd(GUIDE_NEWS_USD) })}</span>
            </li>
          ))}
        </ul>
      </Details>
      <Details icon="book" title={t('profile.key.guide.faqTitle')}>
        <dl className="profile-faq">
          <div>
            <dt>{t('profile.key.guide.faqCostQ')}</dt>
            <dd>
              {avg !== null && avg > 0
                ? t('profile.key.guide.faqCostAvg', {
                    avg: formatUsd(avg),
                    low: formatUsd(avg * 30, 0),
                    high: formatUsd(avg * 60, 0),
                  })
                : t('profile.key.guide.faqCost', {
                    per: formatUsd(GUIDE_ANALYSIS_USD),
                    low: formatUsd(GUIDE_MONTH_USD[0], 0),
                    high: formatUsd(GUIDE_MONTH_USD[1], 0),
                  })}
            </dd>
          </div>
          <div>
            <dt>{t('profile.key.guide.faqProQ')}</dt>
            <dd>{t('profile.key.guide.faqPro')}</dd>
          </div>
          <div>
            <dt>{t('profile.key.guide.faqShareQ')}</dt>
            <dd>{t('profile.key.guide.faqShare')}</dd>
          </div>
        </dl>
      </Details>
      <p className="xsmall muted profile-plain">{t('profile.key.guide.checked')}</p>
    </Card>
  );
}

/** «Как хранится ключ» (storageCard макета) и какие модели работают на ключе. */
export function KeyStorageCard() {
  const { t } = useTranslation();
  return (
    <Card title={t('profile.key.storage.title')} subtitle={t('profile.key.storage.subtitle')}>
      <ul className="profile-bullets lock">
        <li>
          <Icon name="lock" />
          <span>{t('profile.key.storage.encrypted')}</span>
        </li>
        <li>
          <Icon name="eyeOff" />
          <span>{t('profile.key.storage.hidden')}</span>
        </li>
        <li>
          <Icon name="history" />
          <span>{t('profile.key.storage.logged')}</span>
        </li>
      </ul>
      <hr className="divider" />
      <div className="stack profile-tight">
        <h4>{t('profile.key.storage.modelsTitle')}</h4>
        <KeyValue
          items={[
            { key: 'analysis', label: t('profile.key.storage.analysis'), value: t('profile.key.storage.analysisModel') },
            { key: 'news', label: t('profile.key.storage.news'), value: t('profile.key.storage.newsModel') },
            { key: 'parse', label: t('profile.key.storage.parse'), value: t('profile.key.storage.parseModel') },
          ]}
        />
      </div>
    </Card>
  );
}
