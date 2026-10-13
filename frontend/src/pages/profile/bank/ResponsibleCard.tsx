import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button, Callout, Chip, Field, Segmented } from '../../../components';
import { currencySign, type Currency } from '../../../lib/format';

// «Ответственная игра» (responsibleCard макета, В8): лимиты ставок в день и пауза. Разметка по
// макету; сохранения пока нет — API лимитов (GET/PUT /api/me/play-limits, POST /api/me/pause)
// появится в волне 4 этапа 4. Места подключения помечены «Волна 4».

const PAUSES = ['1', '7', '30', '90'] as const;
type Pause = (typeof PAUSES)[number];

export function ResponsibleCard({ currency }: { currency: Currency }) {
  const { t } = useTranslation();
  const countId = useId();
  const amountId = useId();
  const [pause, setPause] = useState<Pause>('7');
  return (
    <section className="card profile-anchor profile-rg" id="profile-rg" aria-labelledby="profile-rg-title">
      <div className="card-head">
        <div className="card-head-text">
          <div className="eyebrow">{t('profile.bank.rg.eyebrow')}</div>
          <h3 id="profile-rg-title">{t('profile.bank.rg.title')}</h3>
          <div className="card-sub">{t('profile.bank.rg.subtitle')}</div>
        </div>
        <div className="row">
          <Chip kind="outline" icon="clock">
            {t('profile.bank.rg.soon')}
          </Chip>
        </div>
      </div>
      <div className="card-body">
        <Callout kind="info" role="note">
          {t('profile.bank.rg.notYet')}
        </Callout>
        {/* Волна 4: «Ставок сегодня N из L» и «Сумма сегодня» — из GET /api/me/play-limits */}
        <div className="profile-fields bottom">
          <Field id={countId} label={t('profile.bank.rg.count')} inputMode="numeric" autoComplete="off" disabled defaultValue="" />
          <Field id={amountId} label={t('profile.bank.rg.amount')} inputMode="decimal" autoComplete="off" suffix={currencySign(currency)} disabled defaultValue="" />
        </div>
        <p className="xsmall muted">{t('profile.bank.rg.rules')}</p>
        <hr className="divider" />
        <h4>{t('profile.bank.rg.pauseTitle')}</h4>
        <p className="small soft">{t('profile.bank.rg.pauseText')}</p>
        <Segmented<Pause>
          label={t('profile.bank.rg.pauseLabel')}
          items={PAUSES.map((value) => ({ value, label: t('profile.bank.rg.days', { count: Number(value) }) }))}
          value={pause}
          onChange={setPause}
        />
        <div className="row">
          {/* Волна 4: POST /api/me/pause с подтверждением «Пауза до …» */}
          <Button icon="pause" disabled>
            {t('profile.bank.rg.takePause', { days: t('profile.bank.rg.days', { count: Number(pause) }) })}
          </Button>
        </div>
      </div>
      <div className="card-foot">
        {/* Волна 4: PUT /api/me/play-limits (снизить — сразу, повысить — через 24 часа) */}
        <Button icon="check" disabled>
          {t('profile.bank.rg.save')}
        </Button>
      </div>
    </section>
  );
}
