import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  Button,
  Card,
  DataTable,
  Dropdown,
  EmptyState,
  FieldShell,
  Icon,
  Skeleton,
  type DataColumn,
} from '../../components';
import { AUDIT_GROUPS, auditDetails, auditTarget, isTerminal, type AuditGroup } from '../../features/admin/audit';
import { maskIp } from '../../features/admin/display';
import type { AuditEntry } from '../../features/admin/types';
import { useAudit } from '../../features/admin/useAudit';
import { formatDateTime } from '../../lib/format';
import { useMediaQuery } from '../../lib/useMediaQuery';
import { NARROW_QUERY } from './media';
import { LoadError } from './parts';

/** Вкладка «Журнал» (PANELS.audit макета): таблица на компьютере, список на узком экране. */
export function AuditTab() {
  const { t } = useTranslation();
  const narrow = useMediaQuery(NARROW_QUERY);
  const [group, setGroup] = useState<AuditGroup>('all');
  const audit = useAudit(group);
  const entries = audit.data?.pages.flat() ?? [];

  const who = (entry: AuditEntry) => <Actor entry={entry} />;
  const target = (entry: AuditEntry) => auditTarget(entry) ?? <span className="muted">{t('admin.audit.wholeApp')}</span>;
  const ip = (entry: AuditEntry) => (
    <span className="adm-ip">{isTerminal(entry) ? t('admin.audit.server') : maskIp(entry.ip)}</span>
  );

  const selectId = 'adm-audit-filter';
  const toolbar = (
    <div className="adm-toolbar adm-audit-toolbar">
      <FieldShell id={selectId} label={t('admin.audit.filter')}>
        <Dropdown
          id={selectId}
          label={t('admin.audit.filter')}
          options={AUDIT_GROUPS.map((value) => ({ value, label: t(`admin.audit.groups.${value}`) }))}
          value={group}
          onChange={setGroup}
        />
      </FieldShell>
      {audit.data && (
        <span className="small muted">
          {t('admin.audit.count', { count: entries.length })} · {t('admin.audit.readonly')}
        </span>
      )}
    </div>
  );

  let body;
  if (audit.isPending) body = <div className="adm-audit-list"><Skeleton lines={5} height={18} /></div>;
  else if (audit.isError) {
    body = (
      <div className="adm-audit-list">
        <LoadError error={audit.error} onRetry={() => void audit.refetch()} />
      </div>
    );
  } else if (narrow) {
    body = (
      <div className="adm-audit-list">
        {entries.length ? (
          <ul className="adm-log" aria-label={t('admin.audit.caption')}>
            {entries.map((entry) => {
              const whom = auditTarget(entry);
              const details = auditDetails(entry);
              return (
                <li key={entry.id}>
                  <div className="adm-log-top">
                    <b>
                      {t(`admin.audit.actions.${entry.action}`)}
                      {whom ? `: ${whom}` : ''}
                    </b>
                    <span className="adm-log-when">{formatDateTime(entry.at)}</span>
                  </div>
                  {details && <div className="adm-log-det">{details}</div>}
                  <div className="adm-log-who">
                    {who(entry)}
                    {ip(entry)}
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <EmptyState>{t('admin.audit.empty')}</EmptyState>
        )}
      </div>
    );
  } else {
    const columns: DataColumn<AuditEntry>[] = [
      {
        key: 'at',
        label: t('admin.audit.columns.at'),
        render: (entry) => <span className="adm-nowrap">{formatDateTime(entry.at)}</span>,
      },
      {
        key: 'who',
        label: t('admin.audit.columns.who'),
        render: (entry) => (
          <div className="adm-cell2">
            {who(entry)}
            {ip(entry)}
          </div>
        ),
      },
      {
        key: 'action',
        label: t('admin.audit.columns.action'),
        render: (entry) => <b>{t(`admin.audit.actions.${entry.action}`)}</b>,
      },
      { key: 'target', label: t('admin.audit.columns.target'), render: target },
      {
        key: 'details',
        label: t('admin.audit.columns.details'),
        render: (entry) => <span className="soft">{auditDetails(entry)}</span>,
      },
    ];
    body = (
      <DataTable
        className="adm-audit-table"
        caption={t('admin.audit.caption')}
        columns={columns}
        rows={entries}
        rowKey={(entry) => entry.id}
        empty={t('admin.audit.empty')}
        mobileLayout="table"
      />
    );
  }

  return (
    <Card title={t('admin.audit.title')} subtitle={t('admin.audit.subtitle')} flush>
      {toolbar}
      {body}
      {audit.hasNextPage && (
        <div className="adm-more-row">
          <Button
            icon="chevronDown"
            loading={audit.isFetchingNextPage}
            onClick={() => void audit.fetchNextPage()}
          >
            {t('admin.audit.more')}
          </Button>
        </div>
      )}
    </Card>
  );
}

/**
 * Кто: имя администратора или «терминал» с иконкой. Пометки макета «(участник)» нет: на этапе 1
 * в журнал пишут только администраторы и терминал, а текущая роль человека может не совпадать
 * с ролью в момент действия. Пометка появится, когда сервер начнет отдавать роль автора записи
 * (этап 3: участники со своим ключом Claude).
 */
function Actor({ entry }: { entry: AuditEntry }) {
  const { t } = useTranslation();
  if (isTerminal(entry)) {
    return (
      <span className="adm-actor">
        <Icon name="terminal" />
        {t('admin.audit.terminal')}
      </span>
    );
  }
  return <span className="adm-actor">{entry.actor_name}</span>;
}
