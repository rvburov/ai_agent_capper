/** Буквы для кружка-аватара: «Роман Буров» → «РБ», «roman» → «R». */
export function initials(displayName: string, email: string): string {
  const words = displayName.trim().split(/\s+/).filter(Boolean);
  const letters = words.slice(0, 2).map((w) => w.charAt(0));
  const text = letters.join('') || email.trim().charAt(0);
  return text.toUpperCase();
}
