/** Знак AI Capper: корт сверху — линии одиночной разметки и мяч (как в макете). */
export function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 36 36" aria-hidden="true" focusable="false">
      <rect x={1} y={1} width={34} height={34} rx={9} fill="var(--accent)" />
      <path
        d="M9 7v22M27 7v22M9 13h18M9 23h18M18 13v10"
        stroke="var(--accent-fg)"
        strokeWidth={1.6}
        fill="none"
        opacity={0.85}
      />
      <circle cx={23.5} cy={18} r={3.2} fill="var(--brand-ball)" stroke="var(--accent)" strokeWidth={1} />
    </svg>
  );
}
