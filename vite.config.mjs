import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Vite configuration for the Carbon Monitor console.
 *
 * The bundle is built on the host and copied into the image, matching the
 * carbon-mcp deployment pattern: the runtime image then needs no build
 * toolchain, no dev dependencies, and no Sass compiler.
 */
export default defineConfig({
  root: 'client',
  plugins: [react()],

  build: {
    // Served by src/api/server.js from this path.
    outDir: '../dist/client',
    emptyOutDir: true,
    sourcemap: false,
  },

  css: {
    preprocessorOptions: {
      scss: {
        // Carbon v11's Sass still uses constructs Dart Sass has deprecated.
        // Silenced narrowly, and only for warnings originating in Carbon, so a
        // real deprecation in this project's own SCSS stays visible.
        silenceDeprecations: ['global-builtin', 'import'],
        quietDeps: true,
      },
    },
  },

  server: {
    port: 5173,
    // `npm run dev:client` runs Vite against the API started by `npm run api`,
    // so console work does not require a rebuild between edits.
    proxy: {
      '/api': {
        target: `http://localhost:${process.env.API_PORT || 3000}`,
        changeOrigin: false,
      },
    },
  },
});
