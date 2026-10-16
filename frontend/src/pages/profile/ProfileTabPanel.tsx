import type { Me } from '../../api/hooks/useMe';
import { AccessCard } from './AccessCard';
import { AppearanceCard } from './AppearanceCard';
import { InstallCard } from './InstallCard';
import { PersonalCard } from './PersonalCard';
import { RegionCard } from './RegionCard';

/** Вкладка «Профиль» (panelProfile макета): слева данные и доступ, справа регион, вид и приложение на телефоне. */
export function ProfileTabPanel({ me }: { me: Me }) {
  return (
    <div className="grid">
      <div className="col-7 profile-col">
        <PersonalCard me={me} />
        <AccessCard me={me} />
      </div>
      <div className="col-5 profile-col">
        <RegionCard me={me} />
        <AppearanceCard />
        <InstallCard />
      </div>
    </div>
  );
}
