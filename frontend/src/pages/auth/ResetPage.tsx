import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router';

import { useDocumentTitle } from '../../app/useDocumentTitle';
import { AuthLayout } from './AuthLayout';
import { ResetDoneStep } from './steps/ResetDoneStep';
import { ResetStep } from './steps/ResetStep';

function stateEmail(state: unknown): string {
  if (typeof state === 'object' && state !== null && 'email' in state) {
    const { email } = state as { email: unknown };
    if (typeof email === 'string') return email;
  }
  return '';
}

/** /reset: email, код RST-XXXX-XXXX и новый пароль → «Пароль изменен» → вход. */
export function ResetPage() {
  const { t } = useTranslation();
  const location = useLocation();
  const [doneEmail, setDoneEmail] = useState<string | null>(null);
  useDocumentTitle(t(doneEmail === null ? 'auth.titles.reset' : 'auth.titles.done'));
  return (
    <AuthLayout>
      {doneEmail === null ? (
        // Переход сюда со страницы входа («Забыли пароль?») — смена шага, как в макете: фокус на
        // первое пустое поле. При открытии страницы по адресу фокус не ставим (клавиатура телефона)
        <ResetStep
          initialEmail={stateEmail(location.state)}
          focus={location.key !== 'default'}
          onDone={setDoneEmail}
        />
      ) : (
        <ResetDoneStep email={doneEmail} focus />
      )}
    </AuthLayout>
  );
}
