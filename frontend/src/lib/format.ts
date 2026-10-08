// Форматирование денег и чисел. Суммы в интерфейсе выводятся только через эти функции.

export type Currency = 'RUB' | 'USD' | 'EUR';

const moneyFormats = new Map<Currency, Intl.NumberFormat>();

export function formatMoney(amount: number, currency: Currency): string {
  let format = moneyFormats.get(currency);
  if (!format) {
    format = new Intl.NumberFormat('ru-RU', {
      style: 'currency',
      currency,
      maximumFractionDigits: currency === 'RUB' ? 0 : 2,
    });
    moneyFormats.set(currency, format);
  }
  return format.format(amount);
}
