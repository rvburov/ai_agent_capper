import type { ReactNode } from 'react';

import { cx } from '../lib/cx';
import './ChoiceCards.css';

export interface ChoiceCardOption<V extends string> {
  value: V;
  title: ReactNode;
  text?: ReactNode;
}

export interface ChoiceCardsProps<V extends string> {
  /** Подпись группы над карточками: «Ключ Claude». */
  legend: ReactNode;
  /** Имя группы переключателей (атрибут name). */
  name: string;
  options: readonly ChoiceCardOption<V>[];
  value: V;
  onChange: (value: V) => void;
  className?: string;
}

/**
 * Выбор одного варианта карточками с пояснением (.choices, как .adm-choices в макете):
 * «Ключ администратора» или «Свой ключ». Внутри — обычные радиокнопки: стрелки переключают вариант.
 */
export function ChoiceCards<V extends string>({
  legend,
  name,
  options,
  value,
  onChange,
  className,
}: ChoiceCardsProps<V>) {
  return (
    <fieldset className={cx('choices', options.length === 3 && 'three', className)}>
      <legend>{legend}</legend>
      {options.map((option) => (
        <label key={option.value} className="choice">
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={option.value === value}
            onChange={() => onChange(option.value)}
          />
          <span>
            <b>{option.title}</b>
            {option.text !== undefined && <small>{option.text}</small>}
          </span>
        </label>
      ))}
    </fieldset>
  );
}
