// vite.preview.config.ts — In-house preview iframe.
//
// This is a separate Vite project from the editor and the canvas sandbox.
// It boots a real React runtime that interprets the user's ProjectFS as a
// Next.js-style app (file-system routing, layout chains, dynamic params).
// The parent Revyme opens it in a fullscreen iframe overlay when the
// user hits the Preview button in the right header.
//
// Why a separate process from the canvas sandbox: the canvas iframe is
// imperative (the parent ships DOM diffs over a bridge) for editing perf;
// the preview iframe runs a full React tree so user code, hooks, animations,
// and theme switching behave exactly like production. Putting them in the
// same iframe would mix the two render models and break either editing perf
// or preview fidelity.

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const src = path.resolve(__dirname, 'src');

export default defineConfig({
  root: path.resolve(__dirname, 'src/preview-sandbox'),
  // Per-config cache. Without this, all three Vite servers (parent on 3333,
  // canvas sandbox on 5174, preview on 5175) write to the same
  // `node_modules/.vite/deps/` and stomp each other's optimize-dep hashes —
  // produces phantom 504 "Outdated Optimize Dep" errors that survive
  // restarts because each server boots, rebuilds, then the next server
  // invalidates again. Separate cacheDir per config keeps them disjoint.
  cacheDir: path.resolve(__dirname, 'node_modules/.vite-preview'),
  plugins: [react()],
  server: {
    port: 5175,
    strictPort: true,
    cors: true,
    // CORP cross-origin is enough — the parent (3333) runs under
    // `Cross-Origin-Embedder-Policy: credentialless`, which allows it to
    // embed cross-origin iframes that send CORP. We deliberately do NOT
    // set COOP/COEP on the preview iframe itself: the user's app inside
    // needs to embed third-party iframes (YouTube, Vimeo, Calendly, Spline,
    // Google Maps, …) and those origins don't ship CORP headers. Adding
    // COEP=credentialless on this iframe would block every one of them
    // (`chrome-error://chromewebdata/` for the nested iframe). The canvas
    // sandbox keeps COEP because it doesn't host third-party embeds; the
    // preview is the customer-facing render path and must match real
    // production behavior.
    headers: {
      'Cross-Origin-Resource-Policy': 'cross-origin',
    },
  },
  // `vite preview` rejects unknown Hosts. Served publicly as https://<host>:5175
  // (nginx terminates TLS → proxies here), so the prod host must be allowed.
  preview: {
    // Env-driven so self-hosters can serve `vite preview` under their own
    // domain: VITE_ALLOWED_HOSTS="example.com,.example.com". Localhost/IPs
    // are always allowed by Vite regardless.
    allowedHosts: (process.env.VITE_ALLOWED_HOSTS ?? 'revyme.com,.revyme.com').split(','),
  },
  resolve: {
    alias: { '@': src },
    // `@revyme/runtime` (npm-installed) ships peer deps
    // (`react`, `framer-motion`) — without dedupe Vite pulls duplicate React
    // copies through the linked package, which crashes hooks. Same fix as
    // Revyme/vite.config.ts.
    dedupe: ['react', 'react-dom', 'react/jsx-runtime', 'framer-motion', 'motion/react'],
  },
  optimizeDeps: {
    // Pre-bundle deps that user code may `import` from inside the preview.
    // The in-iframe runtime maps these import names to the bundled copies
    // via MODULE_MAP (see preview-sandbox/main.tsx). Without pre-bundle,
    // Vite cold-compiles them on first request, which can throw 504
    // "Outdated Optimize Dep" errors when other Vite servers in the
    // workspace re-trigger optimize-dep passes.
    include: ['next-themes', 'react', 'react-dom', 'motion/react', 'next-intl', '@revyme/runtime'],
  },
  define: {
    'process.env': {},
  },
  build: {
    outDir: path.resolve(__dirname, 'dist/preview-sandbox'),
    emptyOutDir: true,
  },
});
