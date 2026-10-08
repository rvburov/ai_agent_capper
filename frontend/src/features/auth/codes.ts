// Коды входа: приглашение CAP-XXXX-XXXX, сброс пароля RST-XXXX-XXXX, резервные коды xxxx-xxxx,
// код из приложения (6 цифр), секрет 2FA и QR-код. Сервер сам нормализует ввод (регистр, пробелы,
// дефисы); здесь — только удобный вид и проверка формы до отправки.

export type CodePrefix = 'CAP' | 'RST';

/** Маска кода вида PFX-XXXX-XXXX: заглавные буквы, дефисы ставятся сами. */
export function maskCode(prefix: CodePrefix, raw: string): string {
  let text = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!text) return '';
  if (text.startsWith(prefix)) text = text.slice(prefix.length);
  else if (prefix.startsWith(text)) return text;
  text = text.slice(0, 8);
  if (!text) return prefix;
  return `${prefix}-${text.slice(0, 4)}${text.length > 4 ? `-${text.slice(4)}` : ''}`;
}

/** Код набран полностью: PFX и 8 букв или цифр. */
export function isCodeComplete(prefix: CodePrefix, value: string): boolean {
  return new RegExp(`^${prefix}-[A-Z0-9]{4}-[A-Z0-9]{4}$`).test(value);
}

/** Резервный код без пробелов и дефисов: 8 букв и цифр. */
export function isRecoveryCodeShape(value: string): boolean {
  return /^[a-z0-9]{8}$/i.test(value.replace(/[\s-]/g, ''));
}

export const OTP_LENGTH = 6;

export function isOtpComplete(value: string): boolean {
  return new RegExp(`^\\d{${OTP_LENGTH}}$`).test(value);
}

/** Простая проверка вида name@example.com: точную проверяет сервер. */
export function isEmailShape(value: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.trim());
}

/** Секрет 2FA группами по 4 символа: так его проще перепечатать в приложение. */
export function groupSecret(secret: string): string {
  return (secret.replace(/\s/g, '').match(/.{1,4}/g) ?? []).join(' ');
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * QR-код с сервера как адрес data: для <img>. Разметку не вставляем в страницу (innerHTML):
 * картинка не выполняет скрипты. Сервер отдает SVG для встраивания в HTML — без xmlns и viewBox,
 * а отдельной картинке они нужны: без xmlns браузер ее не покажет, без viewBox — не масштабирует.
 */
export function svgDataUri(svg: string): string {
  let text = svg.trim();
  const open = /^<svg\b[^>]*>/i.exec(text)?.[0];
  if (open) {
    let tag = open;
    if (!/\sxmlns=/.test(tag)) tag = tag.replace(/^<svg\b/i, `<svg xmlns="${SVG_NS}"`);
    const width = /\swidth="(\d+(?:\.\d+)?)"/.exec(tag)?.[1];
    const height = /\sheight="(\d+(?:\.\d+)?)"/.exec(tag)?.[1];
    if (!/\sviewBox=/.test(tag) && width && height) {
      tag = tag.replace(/^<svg\b/i, `<svg viewBox="0 0 ${width} ${height}"`);
    }
    text = tag + text.slice(open.length);
  }
  return `data:image/svg+xml;utf8,${encodeURIComponent(text)}`;
}

/** Размер QR-кода в пикселях из атрибута width (для четких модулей без растяжения). */
export function svgSize(svg: string): number | undefined {
  const width = /^<svg\b[^>]*\swidth="(\d+)"/i.exec(svg.trim())?.[1];
  return width ? Number(width) : undefined;
}
