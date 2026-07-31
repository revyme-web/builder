import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': '/src',
    },
    // Force a single copy of React / framer-motion / runtime — when a linked
    // package (`@revyme/runtime`) imports `react`, Vite would otherwise
    // resolve it from THAT package's own `node_modules/react`, producing a
    // second React instance whose hooks (`useState`, etc.) crash because
    // `ReactCurrentDispatcher.current === null` (its dispatcher belongs to
    // the OTHER instance). `dedupe` makes every `react` import go to
    // the app's copy, no matter which package issued it.
    dedupe: ['react', 'react-dom', 'react/jsx-runtime', 'framer-motion'],
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    globals: true,
    coverage: {
      include: ['src/code/**', 'src/canvas/**', 'src/editor/**', 'src/shared/**'],
    },
    // Pre-bundle the linked runtime package so Vitest's optimizer treats it
    // as one CommonJS-ish unit (otherwise jsdom + ESM linking can re-resolve
    // `react` differently than the rest of the test suite).
    server: {
      deps: {
        // @revyme/plugin-sdk's dist uses extensionless relative imports —
        // fine for bundlers, rejected by Node's ESM loader. Inlining routes
        // it through Vite's resolver like the app build does.
        inline: ['@revyme/runtime', '@revyme/plugin-sdk'],
      },
    },
  },
});
