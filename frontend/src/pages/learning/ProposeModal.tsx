import type { TFunction } from 'i18next';
import { useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { errorMessage } from '../../api/errors';
import { Button, Callout, Dropdown, Field, FieldShell, Modal, Segmented, Skeleton, describedById, useToast } from '../../components';
import { scopeNumberText, scopeValueText } from '../../features/learning/display';
import { useLessonDictionary, useProposeLesson } from '../../features/learning/lessons';
import type { FeatureName, LessonDictionary, LessonFeature, LessonKind, ScopeCondition, ScopeDirection, ScopeOp } from '../../features/learning/types';

// «Предложить урок» (proposeLesson макета): наблюдение одной фразой и условие только из
// словаря признаков (GET /api/lessons/dictionary) — так урок можно проверить на архиве. Урок
// проходит ту же проверку, что и гипотезы из разборов. Процессный урок («про сбор данных») —
// только администратор. Ошибки условия, повтор и предел в сутки — текстом сервера.

const MIN_TEXT = 10;
const MAX_TEXT = 300;
// Рынок и покрытие — отдельными полями формы, остальные признаки — «признак из словаря»
const OWN_FIELDS: readonly FeatureName[] = ['market', 'surface'];
const NONE = '';

type Translate = TFunction;

function feature(dictionary: LessonDictionary, name: FeatureName): LessonFeature | undefined {
  return dictionary.features.find((item) => item.feature === name);
}

/** «2,5» и «2.5» — одно число; пусто или не число — null. */
function parseNumber(raw: string): number | null {
  const text = raw.trim().replace(',', '.');
  if (!text || !/^-?\d+(\.\d+)?$/.test(text)) return null;
  return Number(text);
}

interface FormState {
  text: string;
  kind: LessonKind;
  direction: ScopeDirection;
  market: string;
  surface: string;
  extra: FeatureName | typeof NONE;
  op: ScopeOp;
  value: string;
  enumValue: string;
}

const INITIAL: FormState = { text: '', kind: 'numeric', direction: 'lower', market: NONE, surface: NONE, extra: NONE, op: 'ge', value: '', enumValue: '' };

interface Errors {
  text?: string;
  value?: string;
}

function conditions(form: FormState, dictionary: LessonDictionary): { list: ScopeCondition[]; valueError: boolean } {
  const list: ScopeCondition[] = [];
  if (form.market) list.push({ feature: 'market', op: 'eq', values: [form.market] });
  if (form.surface) list.push({ feature: 'surface', op: 'eq', values: [form.surface] });
  let valueError = false;
  const extra = form.extra ? feature(dictionary, form.extra) : undefined;
  if (extra) {
    if (extra.kind === 'enum') {
      if (form.enumValue) list.push({ feature: extra.feature, op: 'eq', values: [form.enumValue] });
      else valueError = true;
    } else {
      const value = parseNumber(form.value);
      const low = extra.low ?? -Infinity;
      const high = extra.high ?? Infinity;
      if (value === null || value < low || value > high) valueError = true;
      else list.push({ feature: extra.feature, op: form.op, value });
    }
  }
  return { list, valueError };
}

function valueRange(extra: LessonFeature, t: Translate): string {
  return t('learning.propose.range', { low: scopeNumberText(extra.feature, extra.low), high: scopeNumberText(extra.feature, extra.high) });
}

interface FormProps {
  formId: string;
  dictionary: LessonDictionary;
  admin: boolean;
  propose: ReturnType<typeof useProposeLesson>;
  onDone: () => void;
}

function Form({ formId, dictionary, admin, propose, onDone }: FormProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const id = useId();
  const [form, setForm] = useState<FormState>(INITIAL);
  const [errors, setErrors] = useState<Errors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const set = (patch: Partial<FormState>) => {
    setForm((prev) => ({ ...prev, ...patch }));
    setServerError(null);
  };
  const market = feature(dictionary, 'market');
  const surface = feature(dictionary, 'surface');
  const extras = dictionary.features.filter((item) => !OWN_FIELDS.includes(item.feature));
  const extra = form.extra ? feature(dictionary, form.extra) : undefined;

  function submit(event: FormEvent) {
    event.preventDefault();
    const text = form.text.trim().replace(/\s+/g, ' ');
    const { list, valueError } = conditions(form, dictionary);
    const next: Errors = {};
    if (text.length < MIN_TEXT) next.text = t('learning.propose.textShort', { min: MIN_TEXT });
    if (valueError && extra) next.value = extra.kind === 'enum' ? t('learning.propose.pickValue') : t('learning.propose.badValue', { range: valueRange(extra, t) });
    setErrors(next);
    if (next.text || next.value) {
      document.getElementById(next.text ? `${id}-text` : `${id}-value`)?.focus();
      return;
    }
    propose.mutate(
      { text, kind: admin ? form.kind : 'numeric', scope: { direction: form.direction, conditions: list } },
      {
        onSuccess: (lesson) => {
          onDone();
          toast.show(t('learning.propose.toast', { code: lesson.code }), { icon: 'flask', duration: 5000 });
        },
        onError: (failure) => setServerError(errorMessage(failure)),
      },
    );
  }

  const enumOptions = (item: LessonFeature | undefined) =>
    (item?.values ?? []).map((value) => ({ value, label: scopeValueText(item?.feature ?? '', value, t) }));
  const extraId = `${id}-extra`;
  const valueId = `${id}-value`;
  const opId = `${id}-op`;
  return (
    <form id={formId} className="stack learning-form" noValidate onSubmit={submit}>
      <Field
        id={`${id}-text`}
        multiline
        rows={3}
        maxLength={MAX_TEXT}
        label={t('learning.propose.text')}
        placeholder={t('learning.propose.textPlaceholder')}
        hint={t('learning.propose.textHint')}
        error={errors.text}
        value={form.text}
        onChange={(event) => {
          set({ text: event.target.value });
          if (errors.text && event.target.value.trim().length >= MIN_TEXT) setErrors((prev) => ({ ...prev, text: undefined }));
        }}
      />
      {admin && (
        <FieldShell id={`${id}-kind`} label={t('learning.propose.kind')}>
          <Segmented<LessonKind>
            label={t('learning.propose.kind')}
            items={(['numeric', 'process'] as const).map((value) => ({ value, label: t(`learning.lessons.kind.${value}`) }))}
            value={form.kind}
            onChange={(kind) => set({ kind })}
          />
        </FieldShell>
      )}
      <FieldShell id={`${id}-direction`} label={t('learning.propose.direction')}>
        <Dropdown<ScopeDirection>
          id={`${id}-direction`}
          label={t('learning.propose.direction')}
          options={dictionary.directions.map((value) => ({ value, label: t(`learning.propose.directions.${value}`) }))}
          value={form.direction}
          onChange={(direction) => set({ direction })}
        />
      </FieldShell>
      <div className="learning-form-2">
        <FieldShell id={`${id}-market`} label={t('learning.propose.market')}>
          <Dropdown
            id={`${id}-market`}
            label={t('learning.propose.market')}
            options={[
              { value: NONE, label: t('learning.propose.marketDefault') },
              ...enumOptions(market).filter((option) => option.value !== 'ML'),
            ]}
            value={form.market}
            onChange={(value) => set({ market: value })}
          />
        </FieldShell>
        <FieldShell id={`${id}-surface`} label={t('learning.propose.surface')}>
          <Dropdown
            id={`${id}-surface`}
            label={t('learning.propose.surface')}
            options={[{ value: NONE, label: t('learning.propose.surfaceAll') }, ...enumOptions(surface)]}
            value={form.surface}
            onChange={(value) => set({ surface: value })}
          />
        </FieldShell>
      </div>
      <div className="learning-form-2">
        <FieldShell id={extraId} label={t('learning.propose.extra')}>
          <Dropdown<FeatureName | typeof NONE>
            id={extraId}
            label={t('learning.propose.extra')}
            options={[
              { value: NONE, label: t('learning.propose.extraNone') },
              ...extras.map((item) => ({ value: item.feature, label: t(`learning.scope.featureLabels.${item.feature}`) })),
            ]}
            value={form.extra}
            onChange={(value) => {
              const picked = value ? feature(dictionary, value) : undefined;
              set({ extra: value, value: '', enumValue: '', op: picked?.ops.includes('ge') ? 'ge' : (picked?.ops[0] ?? 'ge') });
              setErrors((prev) => ({ ...prev, value: undefined }));
            }}
          />
        </FieldShell>
        {extra?.kind === 'enum' ? (
          <FieldShell id={valueId} label={t('learning.propose.value')} error={errors.value}>
            <Dropdown
              id={valueId}
              label={t('learning.propose.value')}
              options={enumOptions(extra)}
              value={form.enumValue || null}
              placeholder={t('common.choose')}
              invalid={Boolean(errors.value)}
              describedBy={describedById(valueId, null, errors.value)}
              onChange={(value) => {
                set({ enumValue: value });
                setErrors((prev) => ({ ...prev, value: undefined }));
              }}
            />
          </FieldShell>
        ) : extra ? (
          <div className="learning-form-op">
            <FieldShell id={opId} label={t('learning.propose.op')}>
              <Dropdown<ScopeOp>
                id={opId}
                label={t('learning.propose.op')}
                options={extra.ops.map((op) => ({ value: op, label: t(`learning.scope.ops.${op}`) }))}
                value={form.op}
                onChange={(op) => set({ op })}
              />
            </FieldShell>
            <Field
              id={valueId}
              label={t('learning.propose.value')}
              inputMode="decimal"
              autoComplete="off"
              placeholder={scopeNumberText(extra.feature, extra.low)}
              hint={valueRange(extra, t)}
              error={errors.value}
              value={form.value}
              onChange={(event) => {
                set({ value: event.target.value });
                setErrors((prev) => ({ ...prev, value: undefined }));
              }}
            />
          </div>
        ) : null}
      </div>
      <Callout kind="info" icon="flask">
        {t('learning.propose.callout')}
      </Callout>
      {serverError && (
        <Callout kind="bad" icon="alert" role="alert">
          {serverError}
        </Callout>
      )}
    </form>
  );
}

interface ProposeModalProps {
  admin: boolean;
  onClose: () => void;
  /** Урок добавлен (после сообщения). */
  onDone: () => void;
}

export function ProposeModal({ admin, onClose, onDone }: ProposeModalProps) {
  const { t } = useTranslation();
  const dictionary = useLessonDictionary();
  const propose = useProposeLesson();
  const formId = `${useId()}-form`;
  return (
    <Modal
      open
      onClose={onClose}
      title={t('learning.propose.title')}
      className="learning-modal"
      footer={
        <>
          <Button kind="ghost" onClick={onClose}>
            {t('learning.enable.cancel')}
          </Button>
          <Button kind="primary" icon="plus" type="submit" form={formId} disabled={!dictionary.data} loading={propose.isPending}>
            {t('learning.propose.submit')}
          </Button>
        </>
      }
    >
      {dictionary.data ? (
        <Form formId={formId} dictionary={dictionary.data} admin={admin} propose={propose} onDone={onDone} />
      ) : dictionary.isError ? (
        <Callout kind="bad" icon="alert" role="alert">
          {errorMessage(dictionary.error)}
        </Callout>
      ) : (
        <Skeleton lines={5} />
      )}
    </Modal>
  );
}
