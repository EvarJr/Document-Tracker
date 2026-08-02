import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base: '/document-scanner/' should match your GitHub repo name so
// GitHub Pages serves assets from the right path. Update if you rename the repo.
export default defineConfig({
  plugins: [react()],
  base: '/document-scanner/',
});
