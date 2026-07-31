import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


/**
 * Parse debug trace into multiple output files for easy analysis.
 */
function parseDebugTrace(raw: string, outDir: string): void {
  const data = JSON.parse(raw);
  const entries = data.entries || [];

  // 1. Full trace (as-is)
  fs.writeFileSync(path.join(outDir, 'debug-trace-full.json'), raw, 'utf-8');

  // 2. Summary — counts by type:category
  const counts: Record<string, number> = {};
  for (const e of entries) {
    const key = `${e.type}:${e.category}`;
    counts[key] = (counts[key] || 0) + 1;
  }
  const sortedCounts = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const summary = [
    `Debug Trace Summary`,
    `Duration: ${data.duration}`,
    `Total entries: ${entries.length}`,
    `Captured: ${data.capturedAt}`,
    ``,
    `--- Counts by type:category ---`,
    ...sortedCounts.map(([k, v]) => `${String(v).padStart(5)}  ${k}`),
  ].join('\n');
  fs.writeFileSync(path.join(outDir, 'debug-summary.txt'), summary, 'utf-8');

  // 3. DOM rebuilds (child-added/child-removed = replaceChildren)
  const rebuilds = entries.filter((e: any) => e.type === 'dom' && (e.category === 'child-added' || e.category === 'child-removed'));
  const rebuildReport = [
    `DOM Rebuilds (replaceChildren events)`,
    `Total: ${rebuilds.length}`,
    ``,
    ...rebuilds.map((r: any) => `t=${(r.ts / 1000).toFixed(3)}s  ${r.category}  ${JSON.stringify(r.data?.added || r.data?.removed || [])}`),
  ].join('\n');
  fs.writeFileSync(path.join(outDir, 'debug-dom-rebuilds.txt'), rebuildReport, 'utf-8');

  // 4. Style changes (attr-change on specific nodes)
  const styleChanges = entries.filter((e: any) => e.type === 'dom' && e.category === 'attr-change');
  const nodeStyleCounts: Record<string, number> = {};
  for (const e of styleChanges) {
    const nodeId = e.data?.nodeId || 'unknown';
    nodeStyleCounts[nodeId] = (nodeStyleCounts[nodeId] || 0) + 1;
  }
  const styleReport = [
    `DOM Style Changes`,
    `Total: ${styleChanges.length}`,
    ``,
    `--- By node ---`,
    ...Object.entries(nodeStyleCounts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${String(v).padStart(5)}  ${k}`),
    ``,
    `--- Timeline ---`,
    ...styleChanges.map((e: any) => `t=${(e.ts / 1000).toFixed(3)}s  ${e.data?.nodeId}  ${e.data?.attr}`),
  ].join('\n');
  fs.writeFileSync(path.join(outDir, 'debug-style-changes.txt'), styleReport, 'utf-8');

  // 5. Actions timeline (human-readable flow)
  const actions = entries.filter((e: any) => e.type === 'action' || e.type === 'fn' || e.type === 'error');
  const icons: Record<string, string> = { action: '▶', fn: '⚡', error: '❌' };
  const timeline = [
    `Actions Timeline`,
    ``,
    ...actions.map((e: any) => {
      const t = (e.ts / 1000).toFixed(3);
      const icon = icons[e.type] || '•';
      const dataStr = e.data ? '  ' + JSON.stringify(e.data) : '';
      return `${t}s ${icon} [${e.type}] ${e.category}${dataStr}`;
    }),
  ].join('\n');
  fs.writeFileSync(path.join(outDir, 'debug-actions-timeline.txt'), timeline, 'utf-8');

  // 6. Performance hotspots — find gaps > 100ms between entries (potential jank)
  const hotspots: string[] = ['Performance Hotspots (gaps > 100ms between entries)', ''];
  for (let i = 1; i < entries.length; i++) {
    const gap = entries[i].ts - entries[i - 1].ts;
    if (gap > 100) {
      hotspots.push(`${(gap).toFixed(0)}ms gap at t=${(entries[i].ts / 1000).toFixed(3)}s`);
      hotspots.push(`  before: [${entries[i - 1].type}] ${entries[i - 1].category}`);
      hotspots.push(`  after:  [${entries[i].type}] ${entries[i].category}`);
      hotspots.push('');
    }
  }
  if (hotspots.length === 2) hotspots.push('No gaps > 100ms found.');
  fs.writeFileSync(path.join(outDir, 'debug-performance-hotspots.txt'), hotspots.join('\n'), 'utf-8');

  // 7. React state updates (state type entries)
  const stateUpdates = entries.filter((e: any) => e.type === 'state');
  if (stateUpdates.length > 0) {
    const stateReport = [
      `State Updates`,
      `Total: ${stateUpdates.length}`,
      ``,
      ...stateUpdates.map((e: any) => `t=${(e.ts / 1000).toFixed(3)}s  ${e.category}  ${JSON.stringify(e.data)}`),
    ].join('\n');
    fs.writeFileSync(path.join(outDir, 'debug-state-updates.txt'), stateReport, 'utf-8');
  }

  console.log(`\x1b[32m📊 Debug output parsed into ${outDir}/\x1b[0m`);
  console.log(`   debug-trace-full.json    — raw trace`);
  console.log(`   debug-summary.txt        — counts by type`);
  console.log(`   debug-dom-rebuilds.txt   — replaceChildren events`);
  console.log(`   debug-style-changes.txt  — DOM style mutations`);
  console.log(`   debug-actions-timeline.txt — action/fn flow`);
  console.log(`   debug-performance-hotspots.txt — gaps > 100ms`);
}

/**
 * Parse a mutation error (with recentTrace) into readable files + a structured error_full.json.
 */
function parseMutationError(detail: any, outDir: string, timestamp: string): void {
  const entries: any[] = detail.recentTrace || [];

  // ── Counts by type:category ────────────────────────────────────────────────
  const counts: Record<string, number> = {};
  for (const e of entries) {
    const key = `${e.type}:${e.category}`;
    counts[key] = (counts[key] || 0) + 1;
  }
  const sortedCounts = Object.entries(counts).sort((a, b) => b[1] - a[1]);

  // ── Performance hotspots — gaps > 50ms ────────────────────────────────────
  const hotspots: Array<{ gapMs: number; atTs: number; before: string; after: string }> = [];
  for (let i = 1; i < entries.length; i++) {
    const gap = entries[i].ts - entries[i - 1].ts;
    if (gap > 50) {
      hotspots.push({
        gapMs: +gap.toFixed(0),
        atTs: +(entries[i].ts / 1000).toFixed(3),
        before: `[${entries[i - 1].type}] ${entries[i - 1].category}`,
        after: `[${entries[i].type}] ${entries[i].category}`,
      });
    }
  }

  // ── summary.txt ───────────────────────────────────────────────────────────
  fs.writeFileSync(path.join(outDir, 'summary.txt'), [
    `Mutation Error Report`,
    `Timestamp: ${timestamp}`,
    ``,
    `--- Error ---`,
    detail.message,
    ``,
    `--- Mutations ---`,
    `Types: ${(detail.mutationTypes || []).join(', ')}`,
    ``,
    `--- Code Excerpt ---`,
    detail.codeExcerpt || '(none)',
    ``,
    `--- Trace ---`,
    `Total recent entries: ${entries.length}`,
    `Duration: ${entries.length > 1 ? ((entries[entries.length - 1].ts - entries[0].ts) / 1000).toFixed(2) + 's' : '0s'}`,
  ].join('\n'), 'utf-8');

  // ── actions-timeline.txt ──────────────────────────────────────────────────
  const actions = entries.filter((e: any) => e.type === 'action' || e.type === 'fn' || e.type === 'error');
  const icons: Record<string, string> = { action: '▶', fn: '⚡', error: '❌' };
  fs.writeFileSync(path.join(outDir, 'actions-timeline.txt'), [
    `Actions Timeline (${actions.length} entries)`,
    ``,
    ...actions.map((e: any) => {
      const t = (e.ts / 1000).toFixed(3);
      const icon = icons[e.type] || '•';
      const dataStr = e.data ? '  ' + JSON.stringify(e.data) : '';
      return `${t}s ${icon} [${e.type}] ${e.category}${dataStr}`;
    }),
  ].join('\n'), 'utf-8');

  // ── dom-events.txt ────────────────────────────────────────────────────────
  const domEvents = entries.filter((e: any) => e.type === 'dom');
  fs.writeFileSync(path.join(outDir, 'dom-events.txt'), [
    `DOM Events (${domEvents.length} entries)`,
    ``,
    ...domEvents.map((e: any) =>
      `t=${(e.ts / 1000).toFixed(3)}s  ${e.category}  ${JSON.stringify(e.data || {})}`
    ),
  ].join('\n'), 'utf-8');

  // ── performance-hotspots.txt ──────────────────────────────────────────────
  const hotspotsLines = [`Performance Hotspots (gaps > 50ms)`, ``];
  for (const h of hotspots) {
    hotspotsLines.push(`${h.gapMs}ms gap at t=${h.atTs}s`);
    hotspotsLines.push(`  before: ${h.before}`);
    hotspotsLines.push(`  after:  ${h.after}`);
    hotspotsLines.push('');
  }
  if (hotspots.length === 0) hotspotsLines.push('No gaps > 50ms found.');
  fs.writeFileSync(path.join(outDir, 'performance-hotspots.txt'), hotspotsLines.join('\n'), 'utf-8');

  // ── state-updates.txt ─────────────────────────────────────────────────────
  const stateUpdates = entries.filter((e: any) => e.type === 'state');
  if (stateUpdates.length > 0) {
    fs.writeFileSync(path.join(outDir, 'state-updates.txt'), [
      `State Updates (${stateUpdates.length} entries)`,
      ``,
      ...stateUpdates.map((e: any) => `t=${(e.ts / 1000).toFixed(3)}s  ${e.category}  ${JSON.stringify(e.data)}`),
    ].join('\n'), 'utf-8');
  }

  // ── trace-counts.txt ──────────────────────────────────────────────────────
  fs.writeFileSync(path.join(outDir, 'trace-counts.txt'), [
    `Trace Counts by type:category`,
    `Total: ${entries.length}`,
    ``,
    ...sortedCounts.map(([k, v]) => `${String(v).padStart(5)}  ${k}`),
  ].join('\n'), 'utf-8');

  // ── error_full.json ───────────────────────────────────────────────────────
  fs.writeFileSync(path.join(outDir, 'error_full.json'), JSON.stringify({
    error: {
      timestamp,
      message: detail.message,
      mutationTypes: detail.mutationTypes || [],
      codeExcerpt: detail.codeExcerpt || null,
    },
    traceSummary: {
      totalEntries: entries.length,
      durationMs: entries.length > 1 ? +(entries[entries.length - 1].ts - entries[0].ts).toFixed(0) : 0,
      countsByCategory: Object.fromEntries(sortedCounts),
    },
    actionsTimeline: actions.map((e: any) => ({ ts: +(e.ts / 1000).toFixed(3), type: e.type, category: e.category, data: e.data })),
    domEvents: domEvents.map((e: any) => ({ ts: +(e.ts / 1000).toFixed(3), category: e.category, data: e.data })),
    stateUpdates: stateUpdates.map((e: any) => ({ ts: +(e.ts / 1000).toFixed(3), category: e.category, data: e.data })),
    performanceHotspots: hotspots,
    recentTrace: entries,
  }, null, 2), 'utf-8');
}

/**
 * Vite plugin: saves debug trace + code to debug_output/ folder with parsed views.
 */
function debugTracePlugin(): Plugin {
  return {
    name: 'debug-trace-save',
    configureServer(server) {
      // Helper: mount middleware that works with any base path.
      // Vite's connect doesn't strip base from the mount path, so we match the URL ourselves.
      const mount = (route: string, handler: (req: any, res: any) => void) => {
        server.middlewares.use((req: any, res: any, next: any) => {
          if (req.url?.endsWith(route) || req.url?.includes(route + '?')) {
            handler(req, res);
          } else {
            next();
          }
        });
      };

      // Save debug trace — writes to debug_output/ with multiple parsed files
      mount('/__debug_save', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          const outDir = path.resolve(process.cwd(), 'debug_output');
          if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

          // Also save to root for backward compat
          fs.writeFileSync(path.resolve(process.cwd(), 'debug-trace.json'), body, 'utf-8');

          try {
            parseDebugTrace(body, outDir);
          } catch (e) {
            console.error('Failed to parse debug trace:', e);
            // Still save the raw file
            fs.writeFileSync(path.join(outDir, 'debug-trace-full.json'), body, 'utf-8');
          }

          console.log(`\x1b[32m📁 Debug trace saved\x1b[0m`);
          res.statusCode = 200;
          res.end('OK');
        });
      });

      // Save current code snapshot
      mount('/__debug_code', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          const outDir = path.resolve(process.cwd(), 'debug_output');
          if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

          // Use custom filename from header, or default
          const filename = (req.headers['x-debug-filename'] as string) || 'debug-code.jsx';

          // Save to both locations (ensure parent dirs exist)
          const rootPath = path.resolve(process.cwd(), filename);
          const outPath = path.join(outDir, filename);
          fs.mkdirSync(path.dirname(rootPath), { recursive: true });
          fs.mkdirSync(path.dirname(outPath), { recursive: true });
          fs.writeFileSync(rootPath, body, 'utf-8');
          fs.writeFileSync(outPath, body, 'utf-8');

          console.log(`\x1b[36m📋 Code snapshot saved to debug_output/${filename}\x1b[0m`);
          res.statusCode = 200;
          res.end('OK');
        });
      });

      // Log canvas-side mutation validation errors to debug_output/mutation-errors/
      mount('/__mutation_error', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
        let body = '';
        req.on('data', (chunk: string) => { body += chunk; });
        req.on('end', () => {
          const baseDir = path.resolve(process.cwd(), 'debug_output', 'mutation-errors');
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const outDir = path.join(baseDir, timestamp);
          fs.mkdirSync(outDir, { recursive: true });

          const detail = JSON.parse(body);

          // Raw error (no trace) — small, quick to open
          const { recentTrace: _trace, ...rawDetail } = detail;
          fs.writeFileSync(path.join(outDir, 'error.json'), JSON.stringify(rawDetail, null, 2), 'utf-8');

          // Folder of parsed views + error_full.json
          parseMutationError(detail, outDir, timestamp);

          console.error(`\x1b[31m❌ Mutation error → debug_output/mutation-errors/${timestamp}/\x1b[0m`);
          console.error(`   ${detail.message}`);
          if (detail.mutationTypes?.length) console.error(`   mutations: ${detail.mutationTypes.join(', ')}`);
          res.statusCode = 200;
          res.end('OK');
        });
      });

      // Save all project files with directory structure
      mount('/__debug_project', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
        let body = '';
        req.on('data', (chunk: string) => { body += chunk; });
        req.on('end', () => {
          const outDir = path.resolve(process.cwd(), 'debug_output', 'project');

          // Clean previous project snapshot
          if (fs.existsSync(outDir)) {
            fs.rmSync(outDir, { recursive: true, force: true });
          }

          const files: Record<string, string> = JSON.parse(body);
          let count = 0;
          for (const [filePath, content] of Object.entries(files)) {
            const fullPath = path.join(outDir, filePath);
            const dir = path.dirname(fullPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(fullPath, content, 'utf-8');
            count++;
          }

          console.log(`\x1b[36m📁 ${count} project files saved to debug_output/project/\x1b[0m`);
          res.statusCode = 200;
          res.end('OK');
        });
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const cloudMode = env.VITE_REVYME_CLOUD === 'true';
  return {
  plugins: [react(), tailwindcss(), debugTracePlugin()],
  // In cloud mode assets must be served under /builder/ so Next.js rewrite proxy can forward them.
  // Standalone mode uses root path (no proxy).
  base: cloudMode ? '/builder/' : '/',
  server: {
    port: 3333,
    watch: {
      ignored: ['**/debug_output/**', '**/debug-code*.jsx'],
    },
    // No cross-origin isolation headers on the parent. We previously set
    // `Cross-Origin-Embedder-Policy: credentialless` here for process
    // isolation of the canvas iframe — but the policy CASCADES into nested
    // iframes (the preview at 5175), and once it does, every third-party
    // iframe inside the preview (YouTube, Vimeo, Calendly, Spline, Google
    // Maps, …) ends up at `chrome-error://chromewebdata/` because none of
    // those origins ship CORP headers. The editor doesn't use
    // SharedArrayBuffer or any other cross-origin-isolated API, so dropping
    // COEP only loses the process-separation nicety; Chrome's Site
    // Isolation heuristic still keeps cross-origin iframes in their own
    // process most of the time.
    // In cloud mode, browser is at localhost:3000 but HMR WebSocket must connect
    // directly to Vite at port 3333 (Next.js rewrite doesn't proxy WebSockets).
    ...(cloudMode ? {
      hmr: { port: 3333 },
    } : {}),
  },
  // `vite preview` (prod) rejects unknown Hosts. The dispatcher proxies
  // /builder here with the public host, so revyme.com must be allowed or
  // the editor 404s under the domain. (IPs + localhost stay allowed.)
  preview: {
    // Env-driven so self-hosters can serve `vite preview` under their own
    // domain: VITE_ALLOWED_HOSTS="example.com,.example.com". Localhost/IPs
    // are always allowed by Vite regardless.
    allowedHosts: (process.env.VITE_ALLOWED_HOSTS ?? 'revyme.com,.revyme.com').split(','),
  },
  resolve: {
    alias: {
      '@': '/src',
    },
    // `@revyme/runtime` (npm-installed) imports `react`
    // / `framer-motion`. Without `dedupe`, Vite resolves those imports from
    // the runtime package's own `node_modules`, producing duplicate React
    // instances → all hooks crash on null dispatcher. Forcing dedupe makes
    // every `react` request resolve to Revyme's copy.
    dedupe: ['react', 'react-dom', 'react/jsx-runtime', 'framer-motion'],
  },
  // preview.html uses import maps (esm.sh CDN) for gsap/framer-motion —
  // tell Vite's dep scanner to skip them so it doesn't fail on missing node_modules.
  optimizeDeps: {
    exclude: ['gsap', 'gsap/ScrollTrigger', 'framer-motion', '@react-spring/web'],
  },
  define: {
    'process.env': {},
  },
  };
});
