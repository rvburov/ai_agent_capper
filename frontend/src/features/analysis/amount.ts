// Сумма из поля ввода: «48 000», «48 000 руб», «477,14», «$519.48» → строка Decimal «48000.00».
// Валюта в тексте поля не пересчитывается: банк вводится в валюте программы (Р17). Обратно
// в поле сумма выводится через formatAmountInput (src/lib/format.ts).

export function parseAmount(text: string): number | null {
  let t = text.replace(/[^\d.,]/g, '');
  if (!/\d/.test(t)) return null;
  const lastComma = t.lastIndexOf(',');
  const lastDot = t.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    const at = Math.max(lastComma, lastDot);
    t = `${t.slice(0, at).replace(/[.,]/g, '')}.${t.slice(at + 1)}`;
  } else {
    const sep = lastComma >= 0 ? ',' : lastDot >= 0 ? '.' : null;
    if (sep) {
      const parts = t.split(sep);
      // одна запятая или точка и 1–2 цифры после нее — дробная часть; иначе разделитель тысяч
      t = parts.length === 2 && (parts[1] ?? '').length <= 2 ? `${parts[0]}.${parts[1]}` : parts.join('');
    }
  }
  const value = Number.parseFloat(t);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** Сумма для API (MoneyIn, 2 знака): «48000.00»; пусто или ноль — null. */
export function amountForApi(text: string): string | null {
  const value = parseAmount(text);
  if (value === null || value >= 1e10) return null;
  return value.toFixed(2);
}
