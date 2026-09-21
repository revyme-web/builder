import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { existsSync } from 'node:fs';

// `@revyme/runtime` is published from a SIBLING repository, not from this one.
// Two suites import its source directly (`../../../runtime/src/...`) to test
// the SSR variant-copy behaviour end to end. A standalone checkout of this repo
// has no sibling `runtime/`, so those files cannot resolve and CI failed before
// a single test ran. Skip exactly those two when the package isn't present —
// they still run in a full working copy, where the behaviour they cover lives.
const HAS_RUNTIME_SRC = existsSync(path.resolve(__dirname, '../runtime/src'));
const RUNTIME_DEPENDENT_TESTS = [
  'src/canvas/runtime-variant-copies.test.tsx',
  'src/canvas/runtime-variant-copies.hydrate.test.tsx',
];

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
    exclude: [
      '**/node_modules/**', '**/dist/**',
      ...(HAS_RUNTIME_SRC ? [] : RUNTIME_DEPENDENT_TESTS),
    ],
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
