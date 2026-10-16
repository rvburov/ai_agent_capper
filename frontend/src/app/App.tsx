import { QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { RouterProvider } from 'react-router';

import { createQueryClient } from '../api/queryClient';
import { ToastProvider } from '../components';
import { OfflineGate } from './offline/OfflineGate';
import { createAppRouter } from './router';
import { ThemeProvider } from './theme/ThemeProvider';

export function App() {
  const [queryClient] = useState(createQueryClient);
  const [router] = useState(createAppRouter);
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <ToastProvider>
          <OfflineGate>
            <RouterProvider router={router} />
          </OfflineGate>
        </ToastProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
