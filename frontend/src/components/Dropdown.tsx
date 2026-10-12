import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { cx } from '../lib/cx';
import { matchesMedia, SHEET_QUERY } from '../lib/useMediaQuery';
import { Icon } from './Icon';
import { IconButton } from './IconButton';
import './Combobox.css';

/*
 * Единственный выпадающий список приложения (CLAUDE.md: без системных select и datalist).
 * Повторяет UI.enhanceSelect из макета (mockup/js/ui.js): кнопка со стрелкой, список под ней,
 * на телефоне (до 720 px) — шторка снизу. Клавиатура: стрелки, Home/End, Enter и пробел выбирают,
 * Esc закрывает и возвращает фокус, Tab закрывает, буква — переход к варианту на эту букву.
 * В длинном списке (больше SEARCH_THRESHOLD вариантов) сверху поле поиска.
 */

export const SEARCH_THRESHOLD = 10;

export interface DropdownOption<V extends string = string> {
  value: V;
  label: string;
  disabled?: boolean;
}

export interface DropdownProps<V extends string = string> {
  /** Название поля: подпись для читалки экрана и заголовок шторки на телефоне. */
  label: string;
  options: readonly DropdownOption<V>[];
  value: V | null;
  onChange: (value: V) => void;
  id?: string;
  /** Текст, пока ничего не выбрано. */
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  /** Поиск по списку; по умолчанию включается сам у длинных списков. */
  searchable?: boolean;
  /** id подсказки или ошибки поля (FieldShell). */
  describedBy?: string;
  className?: string;
}

// Поиск без учета регистра; «е» и «е с точками» не различаем
export function normalize(text: string): string {
  return text.toLowerCase().replace(/\u0451/g, 'е');
}

export function highlight(label: string, query: string): ReactNode {
  const q = normalize(query.trim());
  if (!q) return label;
  const at = normalize(label).indexOf(q);
  if (at < 0) return label;
  return (
    <>
      {label.slice(0, at)}
      <mark>{label.slice(at, at + q.length)}</mark>
      {label.slice(at + q.length)}
    </>
  );
}

export interface Placement {
  above: boolean;
  style: CSSProperties;
}

interface PlacementOptions {
  open: boolean;
  /** Шторка снизу (телефон): положение не считается. */
  sheet: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  layerRef: RefObject<HTMLElement | null>;
  /** Якорь ушел из вида или из документа: закрыть (true — вернуть фокус на якорь). */
  onAway: (returnFocus: boolean) => void;
  /** Число вариантов: список меняет высоту — положение пересчитывается. */
  itemsCount: number;
}

/**
 * Положение всплывающего списка (dd-pop) под якорем, а если снизу мало места — над ним.
 * Общая часть выпадающего списка и поля с подсказками (Combobox): так у обоих один вид
 * и одно поведение при прокрутке, смене размера окна и экранной клавиатуре.
 */
export function usePopupPlacement({
  open,
  sheet,
  anchorRef,
  layerRef,
  onAway,
  itemsCount,
}: PlacementOptions): Placement | null {
  const [placement, setPlacement] = useState<Placement | null>(null);

  useLayoutEffect(() => {
    if (!open || sheet) {
      setPlacement(null);
      return;
    }
    function viewport() {
      const vv = window.visualViewport;
      return {
        top: vv?.offsetTop ?? 0,
        height: vv?.height ?? window.innerHeight,
        width: vv?.width ?? window.innerWidth,
      };
    }
    function topbarBottom() {
      const topbar = document.querySelector('.topbar');
      return topbar ? Math.max(0, topbar.getBoundingClientRect().bottom) : 0;
    }
    function place() {
      const trigger = anchorRef.current;
      const pop = layerRef.current;
      if (!trigger || !pop) return;
      if (!trigger.isConnected) {
        onAway(false);
        return;
      }
      const r = trigger.getBoundingClientRect();
      const vp = viewport();
      const top0 = Math.max(vp.top, topbarBottom()) + 8;
      const bottom0 = vp.top + vp.height - 8;
      const gap = 6;
      const below = bottom0 - r.bottom - gap;
      const above = r.top - gap - top0;
      const want = Math.min(pop.scrollHeight, 360);
      const up = below < Math.min(want, 180) && above > below;
      const width = Math.max(pop.offsetWidth, r.width);
      const left = r.left + width > vp.width - 12 ? Math.max(12, r.right - width) : Math.max(12, r.left);
      setPlacement({
        above: up,
        style: {
          minWidth: r.width,
          maxHeight: Math.max(110, Math.min(360, up ? above : below)),
          left,
          ...(up ? { bottom: window.innerHeight - r.top + gap } : { top: r.bottom + gap }),
        },
      });
    }
    // Как в макете: кнопка ушла под шапку или за низ экрана — список закрывается, а не висит
    // поверх шапки или за краем с фокусом внутри. Фокус — на кнопку, без прокрутки к ней
    function onScroll(event: Event) {
      if (event.target instanceof Node && layerRef.current?.contains(event.target)) return;
      const trigger = anchorRef.current;
      if (trigger?.isConnected) {
        const r = trigger.getBoundingClientRect();
        const vp = viewport();
        if (r.bottom < topbarBottom() || r.top > vp.top + vp.height) {
          onAway(Boolean(layerRef.current?.contains(document.activeElement)));
          return;
        }
      }
      place();
    }
    const vv = window.visualViewport;
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', onScroll, true);
    // экранная клавиатура и масштаб на телефоне меняют видимую область, а не окно
    vv?.addEventListener('resize', place);
    vv?.addEventListener('scroll', place);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', onScroll, true);
      vv?.removeEventListener('resize', place);
      vv?.removeEventListener('scroll', place);
    };
  }, [open, sheet, itemsCount, onAway, anchorRef, layerRef]);

  return open && !sheet ? placement : null;
}

export function Dropdown<V extends string>({
  label,
  options,
  value,
  onChange,
  id,
  placeholder,
  disabled = false,
  invalid = false,
  searchable,
  describedBy,
  className,
}: DropdownProps<V>) {
  const { t } = useTranslation();
  const autoId = useId();
  const triggerId = id ?? autoId;
  const listId = `${triggerId}-list`;
  const optionId = (index: number) => `${listId}-${index}`;

  const triggerRef = useRef<HTMLButtonElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const [open, setOpen] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(-1);

  const withSearch = searchable ?? options.length > SEARCH_THRESHOLD;
  const items = useMemo(() => {
    const q = normalize(query.trim());
    return q ? options.filter((o) => normalize(o.label).includes(q)) : options;
  }, [options, query]);
  const selectedIndex = options.findIndex((o) => o.value === value);
  const current = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus({ preventScroll: true });
  }, []);

  function openList() {
    if (disabled) return;
    setSheet(matchesMedia(SHEET_QUERY));
    setQuery('');
    setActive(selectedIndex);
    setOpen(true);
  }

  function pick(index: number) {
    const item = items[index];
    if (!item || item.disabled) return;
    close(true);
    if (item.value !== value) onChange(item.value);
  }

  // Недоступные варианты пропускаем по ходу движения
  function move(from: number, dir: 1 | -1) {
    if (!items.length) return;
    let i = Math.max(0, Math.min(items.length - 1, from));
    while (items[i]?.disabled) {
      i += dir;
      if (i < 0 || i >= items.length) return;
    }
    setActive(i);
  }

  function typeahead(key: string) {
    const q = normalize(key);
    for (let k = 1; k <= items.length; k++) {
      const i = (active + k + items.length) % items.length;
      const item = items[i];
      if (item && !item.disabled && normalize(item.label).startsWith(q)) {
        setActive(i);
        return;
      }
    }
  }

  function onListKeyDown(event: KeyboardEvent<HTMLElement>) {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        move(active < 0 ? 0 : active + 1, 1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        move(active < 0 ? items.length - 1 : active - 1, -1);
        return;
      case 'Home':
      case 'End':
        if (withSearch) return; // в поле поиска Home и End двигают курсор
        event.preventDefault();
        if (event.key === 'Home') move(0, 1);
        else move(items.length - 1, -1);
        return;
      case 'Enter':
      case ' ':
        if (event.key === ' ' && withSearch) return;
        event.preventDefault();
        if (active >= 0) pick(active);
        else if (!withSearch) close(true);
        return;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        close(true);
        return;
      case 'Tab':
        // фокус возвращается на кнопку, и Tab ведет к следующему полю
        close(true);
        return;
      default:
        if (!withSearch && event.key.length === 1 && /\S/.test(event.key)) typeahead(event.key);
    }
  }

  function onLayerKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close(true);
  }

  // Положение списка на компьютере: под кнопкой, а если места мало — над ней
  const placement = usePopupPlacement({
    open,
    sheet,
    anchorRef: triggerRef,
    layerRef,
    onAway: close,
    itemsCount: items.length,
  });

  // После открытия фокус — в поле поиска или в сам список. На компьютере — только когда список
  // уже стоит на месте: пока он скрыт (visibility: hidden), браузер фокус не принимает
  const ready = open && (sheet || placement !== null);
  useEffect(() => {
    if (!ready) return;
    (withSearch ? searchRef.current : listRef.current)?.focus({ preventScroll: true });
  }, [ready, withSearch]);

  // Активный вариант всегда в поле зрения
  useEffect(() => {
    if (!open || active < 0) return;
    document.getElementById(`${listId}-${active}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [open, active, listId]);

  // Клик вне списка закрывает его; как у системного списка, этот клик дальше не проходит
  // (например, не закрывает модальное окно под списком)
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node | null;
      if (target && (layerRef.current?.contains(target) || triggerRef.current?.contains(target))) return;
      const swallow = (e: Event) => {
        e.stopPropagation();
        e.preventDefault();
      };
      document.addEventListener('click', swallow, { capture: true, once: true });
      window.setTimeout(() => document.removeEventListener('click', swallow, true), 700);
      close(false);
    }
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [open, close]);

  const search = withSearch && (
    <div className="dd-search">
      <input
        ref={searchRef}
        className="input"
        type="search"
        role="combobox"
        aria-label={t('common.search')}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={active >= 0 ? optionId(active) : undefined}
        placeholder={t('common.search')}
        autoComplete="off"
        value={query}
        onChange={(event) => {
          const next = event.target.value;
          const q = normalize(next.trim());
          const filtered = q ? options.filter((o) => normalize(o.label).includes(q)) : options;
          setQuery(next);
          setActive(filtered.findIndex((o) => !o.disabled));
        }}
        onKeyDown={onListKeyDown}
      />
    </div>
  );

  const list = (
    <div
      ref={listRef}
      className="dd-list"
      role="listbox"
      id={listId}
      tabIndex={-1}
      aria-label={label}
      aria-activedescendant={!withSearch && active >= 0 ? optionId(active) : undefined}
      onKeyDown={withSearch ? undefined : onListKeyDown}
      // при поиске фокус остается в поле: клик по варианту его не уводит
      onMouseDown={withSearch ? (event) => event.preventDefault() : undefined}
    >
      {items.length === 0 ? (
        <div className="dd-empty">{t('common.nothingFound')}</div>
      ) : (
        items.map((option, index) => {
          const selected = option.value === value;
          return (
            <div
              key={option.value}
              id={optionId(index)}
              role="option"
              aria-selected={selected}
              aria-disabled={option.disabled || undefined}
              className={cx('dd-opt', selected && 'is-selected', index === active && 'is-active')}
              onPointerMove={() => {
                if (index !== active && !option.disabled) setActive(index);
              }}
              onClick={(event) => {
                event.preventDefault();
                pick(index);
              }}
            >
              <span className="dd-opt-label">{highlight(option.label, query)}</span>
              <span className="dd-opt-check">
                <Icon name="check" size={18} />
              </span>
            </div>
          );
        })
      )}
    </div>
  );

  const popup = !open
    ? null
    : sheet
      ? createPortal(
          <div ref={layerRef} className="dd-layer" onKeyDown={onLayerKeyDown}>
            <div className="dd-sheet-back" onClick={() => close(true)} />
            <div className="dd-sheet" role="dialog" aria-modal="true" aria-label={label}>
              <div className="dd-sheet-grip" aria-hidden="true" />
              <div className="dd-sheet-head">
                <div className="dd-sheet-title">{label}</div>
                <IconButton icon="x" label={t('common.close')} size="sm" onClick={() => close(true)} />
              </div>
              {search}
              {list}
            </div>
          </div>,
          document.body,
        )
      : createPortal(
          <div
            ref={layerRef}
            className={cx('dd-pop', placement?.above && 'above')}
            style={{ ...placement?.style, visibility: placement ? undefined : 'hidden' }}
            onKeyDown={onLayerKeyDown}
          >
            {search}
            {list}
          </div>,
          document.body,
        );

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        id={triggerId}
        className={cx('select', 'dd-trigger', invalid && 'invalid', className)}
        disabled={disabled}
        aria-haspopup={matchesMedia(SHEET_QUERY) ? 'dialog' : 'listbox'}
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={`${label}: ${current?.label ?? t('common.notSelected')}`}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        onClick={() => (open ? close(true) : openList())}
        onKeyDown={(event) => {
          if (open) return;
          if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
            event.preventDefault();
            openList();
          }
        }}
      >
        {/* все подписи лежат стопкой: кнопка шириной с самый длинный вариант и не прыгает */}
        <span className="dd-value">
          {options.map((option, index) => (
            <span key={option.value} className={index === selectedIndex ? 'is-current' : undefined}>
              {option.label}
            </span>
          ))}
          {selectedIndex < 0 && (
            <span className="is-current is-placeholder">{placeholder ?? t('common.choose')}</span>
          )}
        </span>
        <span className="dd-chev" aria-hidden="true">
          <Icon name="chevronDown" />
        </span>
      </button>
      {popup}
    </>
  );
}

// ---------- поле с подсказками ----------

export interface ComboOption {
  value: string;
  label: string;
  /** Пояснение мелким текстом справа: «ITA · №1 по Эло». */
  hint?: string;
}

export interface ComboboxProps {
  /** Название поля: подпись списка подсказок для читалки экрана. */
  label: string;
  /** Текст в поле. */
  value: string;
  onChange: (text: string) => void;
  /** Подсказки к набранному тексту (источник может быть асинхронным: loading). */
  options: readonly ComboOption[];
  /** Выбрана подсказка: в поле остается то, что поставит владелец (обычно label). */
  onPick: (option: ComboOption) => void;
  /** Подсказки еще грузятся: вместо «Ничего не найдено» — «Ищем…». */
  loading?: boolean;
  /** С какой длины текста показывать подсказки. */
  minChars?: number;
  id?: string;
  placeholder?: string;
  invalid?: boolean;
  describedBy?: string;
  className?: string;
  onBlur?: () => void;
}

/**
 * Поле ввода с подсказками (как enhanceCombo в макете, mockup/js/ui.js): тот же всплывающий
 * список dd-pop, что у Dropdown, под полем и на телефоне — фокус остается в поле, клавиатура
 * не прячется. Стрелки выбирают подсказку, Enter ставит ее, Esc и Tab закрывают список.
 */
export function Combobox({
  label,
  value,
  onChange,
  options,
  onPick,
  loading = false,
  minChars = 2,
  id,
  placeholder,
  invalid = false,
  describedBy,
  className,
  onBlur,
}: ComboboxProps) {
  const { t } = useTranslation();
  const autoId = useId();
  const inputId = id ?? autoId;
  const listId = `${inputId}-list`;
  const optionId = (index: number) => `${listId}-${index}`;
  const inputRef = useRef<HTMLInputElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);

  const enough = value.trim().length >= minChars;
  const shown = open && enough && (options.length > 0 || loading || value.trim().length > 0);

  const close = useCallback((_returnFocus: boolean) => {
    setOpen(false);
    setActive(-1);
  }, []);

  const placement = usePopupPlacement({
    open: shown,
    sheet: false,
    anchorRef: inputRef,
    layerRef,
    onAway: close,
    itemsCount: options.length,
  });

  // Новые подсказки — активной нет: Enter без выбора не подставляет случайного игрока
  useEffect(() => setActive(-1), [options]);

  useEffect(() => {
    if (!shown || active < 0) return;
    document.getElementById(`${listId}-${active}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [shown, active, listId]);

  // Клик вне поля и списка закрывает подсказки
  useEffect(() => {
    if (!shown) return;
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node | null;
      if (target && (layerRef.current?.contains(target) || inputRef.current?.contains(target))) return;
      close(false);
    }
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [shown, close]);

  function pick(index: number) {
    const option = options[index];
    if (!option) return;
    close(false);
    onPick(option);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        if (!open) setOpen(true);
        if (options.length) setActive((i) => Math.min(options.length - 1, i + 1));
        return;
      case 'ArrowUp':
        event.preventDefault();
        if (options.length) setActive((i) => (i <= 0 ? options.length - 1 : i - 1));
        return;
      case 'Enter':
        if (shown && active >= 0) {
          event.preventDefault();
          pick(active);
        }
        return;
      case 'Escape':
        if (shown) {
          event.preventDefault();
          event.stopPropagation();
          close(false);
        }
        return;
      case 'Tab':
        close(false);
        return;
      default:
    }
  }

  const popup =
    shown &&
    createPortal(
      <div
        ref={layerRef}
        className={cx('dd-pop', placement?.above && 'above')}
        style={{ ...placement?.style, visibility: placement ? undefined : 'hidden' }}
      >
        <div
          className="dd-list"
          role="listbox"
          id={listId}
          aria-label={label}
          // клик по подсказке не уводит фокус из поля
          onMouseDown={(event) => event.preventDefault()}
        >
          {options.length === 0 ? (
            <div className="dd-empty">{loading ? t('common.searching') : t('common.nothingFound')}</div>
          ) : (
            options.map((option, index) => (
              <div
                key={option.value}
                id={optionId(index)}
                role="option"
                aria-selected={index === active}
                className={cx('dd-opt', index === active && 'is-active')}
                onPointerMove={() => {
                  if (index !== active) setActive(index);
                }}
                onClick={(event) => {
                  event.preventDefault();
                  pick(index);
                }}
              >
                <span className="dd-opt-label">{highlight(option.label, value)}</span>
                {option.hint && <span className="dd-opt-hint">{option.hint}</span>}
              </div>
            ))
          )}
        </div>
      </div>,
      document.body,
    );

  return (
    <div className={cx('input-wrap', 'dd-combo-wrap', className)}>
      <input
        ref={inputRef}
        id={inputId}
        type="text"
        role="combobox"
        className={cx('input', 'dd-combo', invalid && 'invalid')}
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        aria-autocomplete="list"
        aria-expanded={Boolean(shown)}
        aria-controls={shown ? listId : undefined}
        aria-activedescendant={shown && active >= 0 ? optionId(active) : undefined}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onKeyDown={onKeyDown}
        onBlur={() => {
          close(false);
          onBlur?.();
        }}
      />
      <span className="dd-combo-chev" aria-hidden="true">
        <Icon name={loading && shown ? 'clock' : 'search'} />
      </span>
      {popup}
    </div>
  );
}
