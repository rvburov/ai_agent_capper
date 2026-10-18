import { useTranslation } from 'react-i18next';

import { Button, Callout, Modal } from '../../components';

/** Окно «Формат текста»: как писать матчи и кэфы (formatModal в макете). */
export function FormatModal({
  open,
  template,
  onClose,
  onInsert,
}: {
  open: boolean;
  template: string;
  onClose: () => void;
  onInsert: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('new.format.title')}
      wide
      footer={
        <>
          <Button icon="copy" onClick={onInsert}>
            {t('new.format.insert')}
          </Button>
          <Button kind="primary" onClick={onClose}>
            {t('new.format.ok')}
          </Button>
        </>
      }
    >
      <p className="soft">{t('new.format.lead')}</p>
      <pre className="new-pre mono">{template}</pre>
      <ul className="new-format-list">
        <li>
          <b>{t('new.format.playersTitle')}</b> {t('new.format.players')}
        </li>
        <li>
          <b>{t('new.format.afterTitle')}</b> {t('new.format.after')}
        </li>
        <li>
          <b>{t('new.format.oddsTitle')}</b> {t('new.format.odds')}
        </li>
        <li>
          <b>{t('new.format.othersTitle')}</b> {t('new.format.others')}
        </li>
        <li>{t('new.format.unit')}</li>
        <li>{t('new.format.decimal')}</li>
        <li>{t('new.format.bank')}</li>
        <li>{t('new.format.currency')}</li>
        <li>{t('new.format.unknown')}</li>
      </ul>
      <Callout kind="info">{t('new.format.note')}</Callout>
    </Modal>
  );
}
