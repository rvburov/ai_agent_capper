import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { paths } from '../../app/paths';
import {
  Button,
  Callout,
  Card,
  Chip,
  DataTable,
  EmptyState,
  Segmented,
  Skeleton,
  useToast,
  type DataColumn,
} from '../../components';
import { deviceName, maskIp } from '../../features/profile/devices';
import { isFailed, RESULT_CHIPS } from '../../features/profile/loginLog';
import type { LoginEvent } from '../../features/profile/types';
import { useLoginEvents } from '../../features/profile/useLoginEvents';
import { formatDateTime } from '../../lib/format';
import { MOBILE_QUERY, useMediaQuery } from '../../lib/useMediaQuery';
import { LoadError } from './LoadError';

type Filter = 'all' | 'failed';

interface LoginLogCardProps {
  suspicious: LoginEvent | null;
  onDismissSuspicious: () => void;
}

function ResultChip({ event }: { event: LoginEvent }) {
  const { t } = useTranslation();
  const view = RESULT_CHIPS[event.result];
  return (
    <Chip kind={view.kind} icon={view.icon}>
      {t(`profile.log.results.${event.result}`)}
    </Chip>
  );
}

/** «Журнал входов» (logCard макета): время в поясе пользователя, устройство, IP и результат. */
export function LoginLogCard({ suspicious, onDismissSuspicious }: LoginLogCardProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const mobile = useMediaQuery(MOBILE_QUERY);
  const events = useLoginEvents();
  const [filter, setFilter] = useState<Filter>('all');
  const unknown = t('profile.unknownDevice');

  const rows = events.data ? (filter === 'failed' ? events.data.filter(isFailed) : events.data) : [];
  const empty = filter === 'failed' ? t('profile.log.emptyFailed') : t('profile.log.empty');

  const columns: DataColumn<LoginEvent>[] = [
    {
      key: 'at',
      label: t('profile.log.when'),
      render: (row) => <span className="profile-nowrap">{formatDateTime(row.at)}</span>,
    },
    {
      key: 'device',
      label: t('profile.log.device'),
      render: (row) => <span className="profile-nowrap">{deviceName(row.device_label, unknown)}</span>,
    },
    {
      key: 'ip',
      label: t('profile.log.ip'),
      render: (row) => <span className="profile-ip">{maskIp(row.ip)}</span>,
    },
    { key: 'result', label: t('profile.log.result'), render: (row) => <ResultChip event={row} /> },
  ];

  let body;
  if (events.isPending) body = <Skeleton lines={4} height={18} />;
  else if (events.isError) body = <LoadError error={events.error} onRetry={() => void events.refetch()} />;
  else if (mobile) {
    body = rows.length ? (
      <ul className="profile-log" aria-label={t('profile.log.title')}>
        {rows.map((row, i) => (
          <li key={`${row.at}-${i}`}>
            <div className="profile-log-top">
              <span className="profile-log-when">{formatDateTime(row.at)}</span>
              <ResultChip event={row} />
            </div>
            <div>{deviceName(row.device_label, unknown)}</div>
            <div className="muted">
              <span className="profile-ip">{maskIp(row.ip)}</span>
            </div>
          </li>
        ))}
      </ul>
    ) : (
      <EmptyState>{empty}</EmptyState>
    );
  } else {
    body = (
      <div className="profile-log-table">
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(row) => `${row.at}-${row.result}-${row.ip ?? ''}`}
          caption={t('profile.log.title')}
          empty={empty}
          mobileLayout="table"
        />
      </div>
    );
  }

  return (
    <Card
      id="profile-log"
      className="profile-anchor"
      title={t('profile.log.title')}
      subtitle={t('profile.log.subtitle')}
      actions={
        <Segmented
          label={t('profile.log.filter')}
          items={[
            { value: 'all', label: t('profile.log.all') },
            { value: 'failed', label: t('profile.log.failed') },
          ]}
          value={filter}
          onChange={setFilter}
        />
      }
      foot={<span className="xsmall muted">{t('profile.log.foot')}</span>}
    >
      {suspicious && (
        <Callout kind="warn" role="note">
          <div className="stack" style={{ gap: 8 }}>
            <div>
              <b>
                {t('profile.log.suspiciousStrong', { when: formatDateTime(suspicious.at) })}
              </b>{' '}
              {t('profile.log.suspicious', {
                device: deviceName(suspicious.device_label, unknown),
                ip: maskIp(suspicious.ip),
              })}
            </div>
            <div className="row">
              <Button
                kind="primary"
                size="sm"
                icon="lock"
                to={{ pathname: paths.profile('security'), hash: '#profile-password' }}
              >
                {t('profile.log.changePassword')}
              </Button>
              <Button
                kind="ghost"
                size="sm"
                onClick={() => {
                  onDismissSuspicious();
                  toast.show(t('profile.log.dismissed'), { icon: 'check' });
                }}
              >
                {t('profile.log.itWasMe')}
              </Button>
            </div>
          </div>
        </Callout>
      )}
      {body}
    </Card>
  );
}
