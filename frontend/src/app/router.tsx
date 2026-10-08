import { createBrowserRouter } from 'react-router';

import { HomePage } from '../pages/home/HomePage';

// Один экран — одна папка в src/pages. Экраны и адреса повторяют макет (mockup/).
export const router = createBrowserRouter([{ path: '/', element: <HomePage /> }]);
