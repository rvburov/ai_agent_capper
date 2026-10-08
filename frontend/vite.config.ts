import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// В разработке запросы /api уходят на FastAPI (uvicorn на порту 8000)
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:8000',
    },
  },
});
