// Тексты интерфейса частями (плагин capperTexts в vite.config.ts, состав — sections.ts):
// ядро, тексты экрана и все тексты вне ядра. Каждый модуль — { <язык>: тексты }.
declare module 'virtual:capper-texts/core' {
  const texts: Record<string, Record<string, unknown>>;
  export default texts;
}

declare module 'virtual:capper-texts/rest' {
  const texts: Record<string, Record<string, unknown>>;
  export default texts;
}

declare module 'virtual:capper-texts/screen/*' {
  const texts: Record<string, Record<string, unknown>>;
  export default texts;
}
