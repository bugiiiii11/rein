import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { reinConsole } from './server/vite-plugin';

export default defineConfig({
  plugins: [react(), reinConsole()],
  server: { port: 5173 },
});
