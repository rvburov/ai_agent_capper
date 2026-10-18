import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button, Card, Chip, Skeleton, useToast } from '../../components';
import { EXTRA_FAMILIES, type ExtraFamily } from '../../features/analysis/markets';
import { useMarkets, useSetMarketExpress } from '../../features/markets/api';
import { familyTitle, statusChipLabel } from '../../features/markets/labels';
import type { MarketFamilyOut } from '../../features/markets/types';
import { formatPercent } from '../../lib/format';
import { ConfirmDialog, HowTo } from './parts';

/*
 * «Администрирование → Настройки → Новые рынки» (Р28; в макете места нет — отступление): новые
 * семейства «для сравнения», счетчик событий и CLV, кнопка «Перевести в экспресс», когда
 * программа сообщила, что порог пройден (150 событий, из них 50 с закрытием, и нижняя граница ДИ
 * CLV выше нуля), и
 * «Вернуть «для сравнения»» для переведенного. Общая настройка для всех участников, в журнале
 * администратора. Грузится лениво: экран «Администрирование» близок к бюджету JS.
 */

interface Pending {
  family: ExtraFamily;
  express: boolean;
}

function isExtra(family: string): family is ExtraFamily {
  return (EXTRA_FAMILIES as readonly string[]).includes(family);
}

function Row({ m, need, clvNeed, onAsk }: { m: MarketFamilyOut; need: number; clvNeed: number; onAsk: (p: Pending) => void }) {
  const { t } = useTranslation();
  if (!isExtra(m.family)) return null;
  const family = m.family;
  const clv = m.clv === null ? '—' : formatPercent(m.clv, { signed: true });
  return (
    <li className="adm-mk">
      <div className="adm-mk-head">
        <b>{familyTitle(family)}</b>
        <Chip kind={m.status === 'express' ? 'good' : m.status === 'suspended' ? 'warn' : 'info'} icon={m.status === 'express' ? 'ticket' : 'flask'}>
          {statusChipLabel(m.status)}
        </Chip>
        {m.status === 'compare' && m.ready && (
          <Chip kind="good" icon="check">
            {t('analysis.marketChip.ready')}
          </Chip>
        )}
      </div>
      <div className="xsmall muted">
        {t('admin.settings.markets.line', { events: t('analysis.marketChip.of', { n: m.events, need }), clv, n: m.clv_n, clvNeed })}
        {!m.has_model && ` · ${t('analysis.marketChip.noModel')}`}
      </div>
      <div className="row">
        {m.promoted ? (
          <Button size="sm" icon="refresh" onClick={() => onAsk({ family, express: false })}>
            {t('admin.settings.markets.back')}
          </Button>
        ) : (
          <Button size="sm" kind="primary" icon="ticket" disabled={!m.can_promote} onClick={() => onAsk({ family, express: true })}>
            {t('admin.settings.markets.promote')}
          </Button>
        )}
      </div>
    </li>
  );
}

export default function MarketsAdminCard() {
  const { t } = useTranslation();
  const toast = useToast();
  const { data } = useMarkets();
  const change = useSetMarketExpress();
  const [ask, setAsk] = useState<Pending | null>(null);
  return (
    <Card title={t('admin.settings.markets.title')} subtitle={t('admin.settings.markets.subtitle')}>
      {!data ? (
        <Skeleton lines={4} />
      ) : (
        <ul className="adm-mk-list">
          {data.families.map((m) => (
            <Row key={m.family} m={m} need={data.need} clvNeed={data.clv_need} onAsk={setAsk} />
          ))}
        </ul>
      )}
      <HowTo>{t('admin.settings.markets.howto', { need: data?.need ?? 150, clvNeed: data?.clv_need ?? 50 })}</HowTo>
      {ask && (
        <ConfirmDialog
          title={ask.express ? t('admin.settings.markets.promoteTitle', { market: familyTitle(ask.family) }) : t('admin.settings.markets.backTitle', { market: familyTitle(ask.family) })}
          confirmLabel={ask.express ? t('admin.settings.markets.promote') : t('admin.settings.markets.back')}
          icon={ask.express ? 'ticket' : 'refresh'}
          run={() => change.mutateAsync(ask)}
          onDone={() => {
            toast.show(t('admin.settings.markets.done', { market: familyTitle(ask.family), status: statusChipLabel(ask.express ? 'express' : 'compare') }), { icon: 'check' });
            setAsk(null);
          }}
          onClose={() => setAsk(null)}
        >
          <p className="small">{ask.express ? t('admin.settings.markets.promoteText') : t('admin.settings.markets.backText')}</p>
        </ConfirmDialog>
      )}
    </Card>
  );
}
