import { useEffect } from 'react';
import { useLocation } from 'react-router';

import type { Me } from '../../api/hooks/useMe';
import type { LoginEvent } from '../../features/profile/types';
import { LoginLogCard } from './LoginLogCard';
import { PasswordCard } from './PasswordCard';
import { SessionsCard } from './SessionsCard';
import { TwoFactorCard } from './TwoFactorCard';

// Куда ведут ссылки сводки: #profile-password — к смене пароля (фокус в поле), #profile-log — к журналу
const FOCUS_ON: Record<string, string> = { 'profile-password': 'profile-pass-cur' };

interface SecurityTabProps {
  me: Me;
  suspicious: LoginEvent | null;
  onDismissSuspicious: () => void;
}

/** Вкладка «Безопасность» (panelSecurity макета). */
export function SecurityTab({ me, suspicious, onDismissSuspicious }: SecurityTabProps) {
  const { hash, key } = useLocation();

  useEffect(() => {
    const id = decodeURIComponent(hash.replace(/^#/, ''));
    if (!id) return;
    const frame = requestAnimationFrame(() => {
      const target = document.getElementById(id);
      if (!target) return;
      target.scrollIntoView({ block: 'start' });
      const field = FOCUS_ON[id];
      if (field) document.getElementById(field)?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [hash, key]);

  return (
    <div className="grid">
      <div className="col-6 profile-col">
        <PasswordCard me={me} />
      </div>
      <div className="col-6 profile-col">
        <TwoFactorCard me={me} />
      </div>
      <div className="col-12 profile-col">
        <SessionsCard />
      </div>
      <div className="col-12 profile-col">
        <LoginLogCard suspicious={suspicious} onDismissSuspicious={onDismissSuspicious} />
      </div>
    </div>
  );
}
