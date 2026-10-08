// Линии теннисного корта и траектория мяча «как в Hawk-Eye» на фоне панели входа (как в макете).
// Компьютер: корт прижат к правому краю панели; телефон: половина корта справа, слева растворяется.

type Dir = 'v' | 'h';

export function Court({ dir }: { dir: Dir }) {
  const horiz = dir === 'h';
  const p = (x: number, y: number) => (horiz ? `${y} ${x}` : `${x} ${y}`);
  const line = (x1: number, y1: number, x2: number, y2: number, cls = 'ln') => (
    <path key={`${x1}-${y1}-${x2}-${y2}`} className={cls} d={`M${p(x1, y1)}L${p(x2, y2)}`} />
  );
  const circle = (x: number, y: number, r: number, cls: string) => {
    const [cx, cy] = horiz ? [y, x] : [x, y];
    return <circle key={`${cls}-${x}-${y}`} className={cls} cx={cx} cy={cy} r={r} />;
  };
  return (
    <svg
      className={horiz ? 'login-court login-court-m' : 'login-court'}
      viewBox={horiz ? '120 20 330 360' : '-382 0 651 800'}
      preserveAspectRatio={horiz ? 'xMidYMid slice' : 'xMinYMid slice'}
      aria-hidden="true"
      focusable="false"
    >
      {/* парный корт 10,97 × 23,77 м, одиночные линии, линии подачи, центральная линия, сетка */}
      {line(60, 97, 340, 97)}
      {line(340, 97, 340, 703)}
      {line(340, 703, 60, 703)}
      {line(60, 703, 60, 97)}
      {line(95, 97, 95, 703)}
      {line(305, 97, 305, 703)}
      {line(95, 237, 305, 237)}
      {line(95, 563, 305, 563)}
      {line(200, 237, 200, 563)}
      {line(200, 97, 200, 110)}
      {line(200, 690, 200, 703)}
      {line(50, 400, 350, 400, 'ln net')}
      {circle(50, 400, 4, 'post')}
      {circle(350, 400, 4, 'post')}
      {/* подача → отскок в квадрате → мяч */}
      <path className="flight" d={`M${p(262, 650)}Q${p(372, 430)} ${p(150, 300)}`} />
      {circle(150, 300, 9, 'bounce')}
      {!horiz && <path className="flight" d={`M${p(150, 300)}Q${p(138, 250)} ${p(128, 214)}`} />}
      {!horiz && circle(128, 214, 7, 'ball')}
    </svg>
  );
}
