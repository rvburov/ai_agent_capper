import { useNavigate } from 'react-router';

import { paths } from '../paths';
import { OfflineScreen } from './OfflineScreen';

/**
 * /offline — тот же экран «Нет связи» по адресу: ссылка «Как приложение выглядит без связи» в
 * кабинете. Открывается и без входа. Связь есть или вернулась — на главную.
 */
export function OfflinePage() {
  const navigate = useNavigate();
  return <OfflineScreen onBack={() => void navigate(paths.home, { replace: true })} />;
}
