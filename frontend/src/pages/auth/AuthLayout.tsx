import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { BrandMark } from '../../app/layout/BrandMark';
import { useTheme } from '../../app/theme/themeContext';
import { Chip, Icon, IconButton, type IconName } from '../../components';
import { MOBILE_QUERY, useMediaQuery } from '../../lib/useMediaQuery';
import { Court } from './Court';
import './auth.css';

// Раскладка экранов входа без оболочки приложения (mockup/js/screens/login.js, desktop и mobile):
// на компьютере слева панель «о сервисе и защите входа», справа форма шага;
// на телефоне сверху короткая шапка, под ней карточка формы и раскрывающийся список мер защиты.

const SECURITY: readonly { icon: IconName; key: 'password' | 'twoFactor' | 'session' | 'pause' | 'device' | 'journal' }[] = [
  { icon: 'lock', key: 'password' },
  { icon: 'shield', key: 'twoFactor' },
  { icon: 'key', key: 'session' },
  { icon: 'alert', key: 'pause' },
  { icon: 'bell', key: 'device' },
  { icon: 'history', key: 'journal' },
];

function SecurityList() {
  const { t } = useTranslation();
  return (
    <ul className="login-sec-list">
      {SECURITY.map((item) => (
        <li key={item.key} className="login-sec-item">
          <span className="login-sec-ic" aria-hidden="true">
            <Icon name={item.icon} />
          </span>
          <div className="login-sec-body">
            <div className="login-sec-t">{t(`auth.security.${item.key}Title`)}</div>
            <div className="login-sec-d">{t(`auth.security.${item.key}Text`)}</div>
          </div>
        </li>
      ))}
    </ul>
  );
}

function ThemeButton() {
  const { t } = useTranslation();
  const { resolved, toggle } = useTheme();
  const dark = resolved === 'dark';
  return (
    <IconButton
      icon={dark ? 'sun' : 'moon'}
      label={dark ? t('shell.themeLight') : t('shell.themeDark')}
      size="sm"
      onClick={toggle}
    />
  );
}

function BrandRow() {
  const { t } = useTranslation();
  return (
    <div className="login-brandrow">
      <BrandMark />
      <div className="login-brandrow-text">
        <div className="brand-name">{t('app.name')}</div>
        <div className="brand-sub">{t('auth.brand.sub')}</div>
      </div>
    </div>
  );
}

export function AuthLayout({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const mobile = useMediaQuery(MOBILE_QUERY);

  if (mobile) {
    return (
      <div className="login-m">
        <header className="login-m-hero">
          <Court dir="h" />
          <div className="login-m-top">
            <BrandRow />
            <ThemeButton />
          </div>
          <p className="login-m-lead">{t('auth.brand.mobileLead')}</p>
        </header>
        <main className="login-m-card">{children}</main>
        <details className="login-secd">
          <summary>
            <Icon name="shield" />
            <span className="login-secd-t">
              <b>{t('auth.security.title')}</b>
              <span className="xsmall muted">{t('auth.security.short')}</span>
            </span>
            <Chip kind="accent">{t('auth.security.count')}</Chip>
            <Icon name="chevronDown" className="chev" />
          </summary>
          <SecurityList />
        </details>
        <footer className="login-m-foot">
          <span>{t('auth.brand.copyright')}</span>
          <span>{t('auth.brand.https')}</span>
        </footer>
      </div>
    );
  }

  return (
    <div className="login-page">
      <aside className="login-brand" aria-label={t('auth.brand.label')}>
        <Court dir="v" />
        <BrandRow />
        <div className="login-hero">
          <div className="eyebrow">{t('auth.brand.eyebrow')}</div>
          <p className="login-hero-h">{t('auth.brand.hero')}</p>
          <p className="login-hero-p">{t('auth.brand.lead')}</p>
          <p className="login-hero-note">
            <Icon name="info" />
            {t('auth.brand.note')}
          </p>
        </div>
        <section className="login-sec" aria-labelledby="login-sec-title">
          <div className="login-sec-head">
            <Icon name="shield" />
            <h2 id="login-sec-title">{t('auth.security.title')}</h2>
            <Chip kind="accent" icon="check">
              {t('auth.security.count')}
            </Chip>
          </div>
          <SecurityList />
        </section>
        <div className="login-brandfoot">
          <span>{t('auth.brand.copyright')}</span>
          <span>{t('auth.brand.https')}</span>
        </div>
      </aside>
      <main className="login-main">
        <div className="login-topline">
          <ThemeButton />
        </div>
        <div className="login-center">{children}</div>
      </main>
    </div>
  );
}
