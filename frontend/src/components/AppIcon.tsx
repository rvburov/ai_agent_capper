import './Pwa.css';

/**
 * Значок приложения AI Capper (mockup/js/pwa.js, appIcon): корт с мячом на зеленом. Цвета не
 * меняются с темой — это картинка с экрана «Домой» (PNG — public/icons, из mockup/icons).
 */
export function AppIcon({ size = 48 }: { size?: number }) {
  return (
    <svg className="app-icon" viewBox="0 0 48 48" width={size} height={size} aria-hidden="true" focusable="false">
      <rect width={48} height={48} rx={11} fill="var(--app-icon-bg)" />
      <path
        d="M12 9.5v29M36 9.5v29M12 17.5h24M12 30.5h24M24 17.5v13"
        stroke="var(--app-icon-fg)"
        strokeWidth={2.1}
        fill="none"
        strokeLinecap="round"
        opacity={0.88}
      />
      <circle cx={31.3} cy={24} r={4.3} fill="var(--app-icon-ball)" stroke="var(--app-icon-bg)" strokeWidth={1.3} />
    </svg>
  );
}
