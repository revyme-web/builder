import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const stubs = path.resolve(__dirname, 'src/canvas-sandbox/stubs');
const src = path.resolve(__dirname, 'src');

/**
 * Vite plugin that redirects parent-side module imports to sandbox stubs.
 * Handles both @/ prefixed and relative imports (which regex aliases can't).
 */
function sandboxStubsPlugin(): Plugin {
  const stubMap: Record<string, string> = {
    'node-ops': path.resolve(stubs, 'node-ops.ts'),
    'canvas-bridge': path.resolve(stubs, 'canvas-bridge.ts'),
    'project-fs': path.resolve(stubs, 'project-fs.ts'),
    'cms-ops': path.resolve(stubs, 'cms-ops.ts'),
    'store': path.resolve(stubs, 'store.ts'),
  };

  return {
    name: 'sandbox-stubs',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer) return null;

      // Match relative imports like ./node-ops, ../code/stores/store
      // and @ imports like @/canvas/node-ops, @/code/stores/store
      for (const [key, stubPath] of Object.entries(stubMap)) {
        const normalized = source.replace(/\.ts$/, '');
        if (normalized.endsWith('/' + key) || normalized === './' + key || normalized === key) {
          return stubPath;
        }
      }
      return null;
    },
  };
}

export default defineConfig({
  root: path.resolve(__dirname, 'src/canvas-sandbox'),
  // Own cache — see vite.preview.config.ts for rationale (multiple Vite
  // servers in one workspace stomp on `node_modules/.vite/deps/` if they
  // share it).
  cacheDir: path.resolve(__dirname, 'node_modules/.vite-sandbox'),
  plugins: [react(), sandboxStubsPlugin()],
  server: {
    port: 5174,
    strictPort: true,
    cors: true,
    // CORP `cross-origin` lets the parent (3333) embed sandbox responses under
    // its `Cross-Origin-Embedder-Policy: credentialless` policy. Without this
    // header on the iframe HTML + JS, the parent would refuse to load it.
    // COOP same-origin on the iframe itself opens the iframe in its own
    // browsing-context group → distinct renderer process from the parent.
    headers: {
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
      // PROCESS isolation for the canvas. COOP above does NOT do this — COOP
      // only applies to TOP-LEVEL documents and is ignored on iframes, so
      // parent (3001/3333) and sandbox (5174) shared one renderer process
      // (same SITE: ports don't split sites) and one GPU/raster budget: a
      // heavy canvas zoom starved the editor chrome's tiles (toolbar / menus
      // blanking, live find 2026-07-19). Origin-Agent-Cluster keys the agent
      // cluster by ORIGIN, which Chrome implements with a dedicated renderer
      // process — canvas raster load can no longer stall the editor UI.
      'Origin-Agent-Cluster': '?1',
    },
  },
  // `vite preview` rejects unknown Hosts. Served publicly as https://<host>:5174
  // (nginx terminates TLS → proxies here), so the prod host must be allowed.
  preview: {
    // Env-driven so self-hosters can serve `vite preview` under their own
    // domain: VITE_ALLOWED_HOSTS="example.com,.example.com". Localhost/IPs
    // are always allowed by Vite regardless.
    allowedHosts: (process.env.VITE_ALLOWED_HOSTS ?? 'revyme.com,.revyme.com').split(','),
    // Same process-isolation trio as the dev server above — without
    // Origin-Agent-Cluster a same-site deployment shares one renderer
    // process between editor and canvas (see server.headers rationale).
    headers: {
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
      'Origin-Agent-Cluster': '?1',
    },
  },
  resolve: {
    alias: {
      '@': src,
    },
    // `@revyme/runtime` is linked via `file:../runtime` and brings peer
    // deps (`react`, `framer-motion`) — without dedupe Vite resolves them
    // through the linked package's own node_modules, producing duplicate
    // React instances → hooks crash on null dispatcher. Same fix as
    // Revyme/vite.config.ts and vite.preview.config.ts.
    dedupe: ['react', 'react-dom', 'react/jsx-runtime', 'framer-motion'],
  },
  optimizeDeps: {
    exclude: ['gsap', 'gsap/ScrollTrigger', 'framer-motion', '@react-spring/web'],
  },
  define: {
    'process.env': {},
  },
  build: {
    outDir: path.resolve(__dirname, 'dist/sandbox'),
    emptyOutDir: true,
  },
});
