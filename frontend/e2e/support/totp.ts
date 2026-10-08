import { createHmac } from 'node:crypto';

/*
 * Коды 2FA по RFC 6238 (6 цифр, шаг 30 секунд, HMAC-SHA1), как в приложении-аутентификаторе.
 * Сервер принимает шаги текущий −1, текущий и текущий +1, но каждый шаг только один раз:
 * код того же или более раннего шага, чем последний принятый, отклоняется (users.totp_last_step).
 * Поэтому Totp помнит последний использованный шаг и выдает следующий: текущий или, если он
 * уже потрачен, следующий (сервер его примет, запас — 30 секунд и больше). Ждать приходится,
 * только когда и следующий шаг потрачен.
 */

const STEP_SECONDS = 30;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(input: string): Buffer {
  const clean = input.replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error(`секрет 2FA не в base32: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function codeAtStep(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0x0f;
  const number = hmac.readUInt32BE(offset) & 0x7fffffff;
  return String(number % 1_000_000).padStart(6, '0');
}

export function currentStep(now = Date.now()): number {
  return Math.floor(now / 1000 / STEP_SECONDS);
}

export class Totp {
  private lastStep = -1;

  constructor(readonly secret: string) {
    // проверка формата сразу, а не на первом коде
    base32Decode(secret);
  }

  /** Код, который сервер примет сейчас и который еще не использован. */
  async next(): Promise<string> {
    let now = currentStep();
    let step = Math.max(now, this.lastStep + 1);
    if (step > now + 1) {
      // текущий и следующий шаги уже потрачены: ждем начала следующего шага
      const wait = (now + 1) * STEP_SECONDS * 1000 - Date.now() + 200;
      await new Promise((resolve) => setTimeout(resolve, wait));
      now = currentStep();
      step = Math.max(now, this.lastStep + 1);
    }
    this.lastStep = step;
    return codeAtStep(this.secret, step);
  }
}
