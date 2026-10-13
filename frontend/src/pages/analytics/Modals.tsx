import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button, Callout, Checkbox, Modal } from '../../components';
import { exportHref, type AnalyticsFilters } from '../../features/analytics/filters';
import type { ExportPart } from '../../features/analytics/types';

// Окна «Аналитики»: «Brier и CLV простыми словами» (explainModal) и выгрузка CSV (exportModal, В13).

const EXPLAIN = ['brier', 'market', 'clv', 'ci'] as const;

export function ExplainModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <Modal
      open
      onClose={onClose}
      title={t('analytics.explain.title')}
      footer={
        <Button kind="primary" onClick={onClose}>
          {t('analytics.explain.ok')}
        </Button>
      }
    >
      {EXPLAIN.map((key) => (
        <div key={key} className="analytics-explain">
          <h4>{t(`analytics.explain.${key}.title`)}</h4>
          <p className="small soft">{t(`analytics.explain.${key}.text`)}</p>
        </div>
      ))}
    </Modal>
  );
}

/** Галочки окна выгрузки: третья — калибровка и скользящий Brier вместе, как в макете. */
const CHOICES = [
  { key: 'bets', parts: ['bets'], on: true },
  { key: 'events', parts: ['events'], on: true },
  { key: 'accuracy', parts: ['calibration', 'brier'], on: false },
] as const satisfies readonly { key: string; parts: readonly ExportPart[]; on: boolean }[];

type ChoiceKey = (typeof CHOICES)[number]['key'];

interface ExportModalProps {
  filters: AnalyticsFilters;
  /** «за 30 дней, 12 ставок, 25 событий» — что попадет в выгрузку. */
  scope: string;
  onClose: () => void;
}

export function ExportModal({ filters, scope, onClose }: ExportModalProps) {
  const { t } = useTranslation();
  const [picked, setPicked] = useState<ReadonlySet<ChoiceKey>>(() => new Set(CHOICES.filter((c) => c.on).map((c) => c.key)));
  const parts = CHOICES.filter((c) => picked.has(c.key)).flatMap((c) => c.parts);
  const href = exportHref(filters, parts);
  return (
    <Modal
      open
      onClose={onClose}
      title={t('analytics.export.title')}
      footer={
        <>
          <Button kind="ghost" onClick={onClose}>
            {t('analytics.export.cancel')}
          </Button>
          {href ? (
            <Button kind="primary" icon="download" href={href} download onClick={onClose}>
              {t('analytics.export.download')}
            </Button>
          ) : (
            <Button kind="primary" icon="download" disabled>
              {t('analytics.export.download')}
            </Button>
          )}
        </>
      }
    >
      <p className="small soft">{t('analytics.export.text')}</p>
      <fieldset className="analytics-check">
        <legend className="field-label">{t('analytics.export.what')}</legend>
        {CHOICES.map((choice) => (
          <Checkbox
            key={choice.key}
            label={t(`analytics.export.parts.${choice.key}`)}
            checked={picked.has(choice.key)}
            onChange={(on) =>
              setPicked((prev) => {
                const next = new Set(prev);
                if (on) next.add(choice.key);
                else next.delete(choice.key);
                return next;
              })
            }
          />
        ))}
      </fieldset>
      <Callout kind="neutral" icon="filter">
        {t('analytics.export.scope', { scope })}
      </Callout>
      {!href && <p className="field-error">{t('analytics.export.nothing')}</p>}
    </Modal>
  );
}
