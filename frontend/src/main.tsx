import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import './i18n';
// Шрифты макета лежат локально (CSP: font-src 'self'), браузер грузит только нужные алфавиты
import '@fontsource/golos-text/400.css';
import '@fontsource/golos-text/500.css';
import '@fontsource/golos-text/600.css';
import '@fontsource/geologica/500.css';
import '@fontsource/geologica/600.css';
import '@fontsource/geologica/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import './styles/tokens.css';
import './styles/global.css';
import './styles/components.css';
import './styles/shell.css';
import { App } from './app/App';

const root = document.getElementById('root');
if (!root) throw new Error('Нет элемента #root в index.html');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
