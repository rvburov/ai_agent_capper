import { useTranslation } from 'react-i18next';

import type { ThemeChoice } from '../../app/theme/theme';
import { useTheme } from '../../app/theme/themeContext';
import { Card, Segmented, useToast } from '../../components';

const THEMES: readonly ThemeChoice[] = ['system', 'light', 'dark'];

/** «Внешний вид»: тема на этом устройстве, как в меню пользователя. */
export function AppearanceCard() {
  const { t } = useTranslation();
  const { choice, setChoice } = useTheme();
  const toast = useToast();
  return (
    <Card title={t('profile.appearance.title')} subtitle={t('profile.appearance.subtitle')}>
      <Segmented
        label={t('profile.appearance.label')}
        items={THEMES.map((value) => ({ value, label: t(`shell.themeOption.${value}`) }))}
        value={choice}
        onChange={(value) => {
          setChoice(value);
          toast.show(
            t('profile.appearance.toast', { name: t(`shell.themeOption.${value}`).toLowerCase() }),
            { icon: value === 'dark' ? 'moon' : 'sun' },
          );
        }}
      />
      <p className="xsmall muted">{t('profile.appearance.note')}</p>
    </Card>
  );
}
