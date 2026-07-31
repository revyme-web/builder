// ServerPreview.tsx -- Server-based preview
// Sends project files to a preview server running Next.js
// Preview server renders them with real Next.js + HMR
//
// NOTE: Import sync is handled by syncImports() in mutation-queue.ts.
// Code uses real @media queries — no transforms needed for preview.
// This file ensures layout.tsx + globals.css exist before sending.

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { CDN_HOST } from '@/shared/hosts';
import { useAtomValue } from 'jotai';
import { projectFS } from '@/code/project/project-fs';
import { activeFilePathAtom, isComponentFilePath, filePathToSlug } from '@/code/project/active-file-store';
import { getProjectId } from '@/backend/project-id';
import { ensureLayoutFile } from '@/code/generation/metadata-gen';
import { trace } from '@/shared/debug-trace';
import ComponentLivePreview from './ComponentLivePreview';
import { templateGroupFromLayoutFile, templatePreviewRoute, templatePreviewPages } from './template-preview';

const CDN_COMPONENT_IMPORT_RE = /import\s+(\w+)\s+from\s+["'](https:\/\/assets\.revyme\.app\/sparks\/[^"']+)["'];?/g;

/**
 * Resolve CDN Code component imports in all files.
 * Downloads source from CDN, saves as local code components/ files, rewrites import paths.
 * This makes Webpack/Next.js happy (can't handle https:// imports natively).
 */
async function resolveCdnCodeComponentImports(files: Record<string, string>): Promise<void> {
  // Collect all CDN Code component URLs across all files
  const urlsToFetch = new Map<string, string>(); // url → componentName

  for (const [filePath, content] of Object.entries(files)) {
    let match: RegExpExecArray | null;
    CDN_COMPONENT_IMPORT_RE.lastIndex = 0;
    while ((match = CDN_COMPONENT_IMPORT_RE.exec(content)) !== null) {
      urlsToFetch.set(match[2], match[1]); // url → ComponentName
    }
  }

  if (urlsToFetch.size === 0) return;
  trace.action('server-preview:resolving-cdn-code-components', { count: urlsToFetch.size });

  // Fetch all CDN Component sources in parallel
  const resolved = new Map<string, { name: string; localPath: string; source: string }>();

  await Promise.all(
    Array.from(urlsToFetch.entries()).map(async ([cdnUrl, componentName]) => {
      try {
        const path = cdnUrl.replace(`${CDN_HOST}/`, '');
        const res = await fetch(`/api/components/fetch?path=${encodeURIComponent(path)}`);
        if (!res.ok) return;
        const source = await res.text();
        const localPath = `components/${componentName}.tsx`;
        resolved.set(cdnUrl, { name: componentName, localPath, source });
        trace.action('server-preview:cdn-code-component-resolved', { componentName, cdnUrl, size: source.length });
      } catch (err) {
        trace.error('server-preview:cdn-code-component-fetch-failed', { cdnUrl, error: String(err) });
      }
    })
  );

  // Add fetched Code component files to the file map
  for (const [, { localPath, source }] of resolved) {
    files[localPath] = source;
  }

  // Rewrite imports in all files: CDN URL → local path
  for (const filePath of Object.keys(files)) {
    let content = files[filePath];
    for (const [cdnUrl, { name, localPath }] of resolved) {
      // Rewrite: import Name from "https://..." → import Name from "@/components/Name"
      // Use @/ alias which the preview server resolves
      const codeComponentImportPath = `@/${localPath.replace('.tsx', '')}`;
      content = content.replace(
        new RegExp(`import\\s+${name}\\s+from\\s+["']${cdnUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'];?`),
        `import ${name} from '${codeComponentImportPath}';`
      );
    }
    files[filePath] = content;
  }

  trace.action('server-preview:cdn-code-components-resolved', { count: resolved.size });
}
import { stripCanvasConfig } from '@/code/project/canvas-config';
import PreviewFrame from './PreviewFrame';

const PREVIEW_HOST = import.meta.env.VITE_PREVIEW_HOST || 'http://localhost:5173';

// ─── File Building Utilities ───────────────────────────────────────────────

/**
 * Build all project files into a flat map for the preview server.
 * Keys are file paths like "app/page.tsx", "components/Hero.tsx".
 * Values are the processed source code (imports already handled by mutation-queue syncImports).
 * Source code uses real @media queries — no transforms needed for preview/production.
 */
function buildFiles(sessionId: string): Record<string, string> {
  const files: Record<string, string> = {};
  const allFiles = projectFS.listFiles();

  for (const filePath of allFiles) {
    const content = projectFS.readFile(filePath);
    if (content == null) continue;

    if (filePath.endsWith('.tsx') || filePath.endsWith('.jsx') || filePath.endsWith('.ts') || filePath.endsWith('.js')) {
      let processed = content;
      // Strip @canvas comment block (builder-only metadata, not real code)
      processed = stripCanvasConfig(processed);
      // Rewrite internal page hrefs to include session prefix for preview server.
      // Match both string literals AND paths in data arrays
      processed = processed
        // href="/path" → href="/{sessionId}/path"
        .replace(/href="\/([^"]*?)"/g, (_, path) => `href="/${sessionId}${path ? '/' + path : ''}"`)
        .replace(/href='\/([^']*?)'/g, (_, path) => `href='/${sessionId}${path ? '/' + path : ''}'`)
        // path: "/something" in data arrays → path: "/{sessionId}/something"
        .replace(/path:\s*"\/([^"]*?)"/g, (_, path) => `path: "/${sessionId}${path ? '/' + path : ''}"`)
        .replace(/path:\s*'\/([^']*?)'/g, (_, path) => `path: '/${sessionId}${path ? '/' + path : ''}'`)
        // href: "/something" in data arrays
        .replace(/href:\s*"\/([^"]*?)"/g, (_, path) => `href: "/${sessionId}${path ? '/' + path : ''}"`)
        .replace(/href:\s*'\/([^']*?)'/g, (_, path) => `href: '/${sessionId}${path ? '/' + path : ''}'`)
        // url: "/something" in data arrays
        .replace(/url:\s*"\/([^"]*?)"/g, (_, path) => `url: "/${sessionId}${path ? '/' + path : ''}"`)
        .replace(/url:\s*'\/([^']*?)'/g, (_, path) => `url: '/${sessionId}${path ? '/' + path : ''}'`);
      files[filePath] = processed;
    } else if (filePath.endsWith('.css') || filePath.endsWith('.json')) {
      files[filePath] = content;
    }
  }

  // Build the root server layout if missing. The bare `app/LayoutClient.tsx`
  // is no longer auto-created — pages without a Template render against
  // `app/layout.tsx`'s `{children}` directly; pages with a Template
  // resolve their LayoutClient via the route-group folder.
  if (!files['app/layout.tsx']) {
    files['app/layout.tsx'] = ensureLayoutFile();
  }

  // Inject a placeholder page per template (route-group LayoutClient) so every
  // template is previewable around a page-content placeholder. Unconditional so
  // any template is reachable without re-syncing when switching between them.
  for (const { file, content } of templatePreviewPages(Object.keys(files))) {
    files[file] = content;
  }

  trace.fn('server-preview:buildFiles', { fileCount: Object.keys(files).length, files: Object.keys(files) });
  return files;
}

// ─── Component ─────────────────────────────────────────────────────────────

export default function ServerPreview() {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [status, setStatus] = useState('Syncing files to preview server...');
  const [ready, setReady] = useState(false);
  // Bumps on each manual reload so the iframe element is recreated by React.
  // Setting iframe.src directly is blocked by Chrome when the frame has dropped
  // into chrome-error://chromewebdata/ from a prior failed load — recreating
  // the element gives us a brand-new frame with no stuck error state.
  const [reloadKey, setReloadKey] = useState(0);
  const sessionId = useMemo(() => getProjectId() || 'local', []);
  const sentRef = useRef(false);

  const activeFile = useAtomValue(activeFilePathAtom);
  const componentPreviewFile = useMemo(
    () => (activeFile && isComponentFilePath(activeFile) ? activeFile : null),
    [activeFile],
  );

  // A Template (route-group LayoutClient/layout file) has no page route of its
  // own — preview it via the injected placeholder page (see buildFiles).
  const templateGroup = useMemo(() => templateGroupFromLayoutFile(activeFile), [activeFile]);

  // Path suffix of the preview URL. Templates point at their placeholder route;
  // pages map via their slug (home → site root).
  const previewPath = useMemo(() => {
    if (templateGroup) return templatePreviewRoute(templateGroup).url;
    const slug = filePathToSlug(activeFile);
    return !activeFile || slug === 'home' ? '' : '/' + slug;
  }, [activeFile, templateGroup]);

  // Send all files to preview server on mount
  const syncAllFiles = useCallback(async () => {
    trace.action('server-preview:sync-start', { sessionId });
    setStatus('');

    const files = buildFiles(sessionId);

    // Resolve CDN Code component imports — download source, save as local files, rewrite imports
    await resolveCdnCodeComponentImports(files);

    // Add globals.css with reset
    const tokensCss = projectFS.readFile('app/globals.css') || '';
    files['app/globals.css'] = `*, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }\nbody { min-height: 100vh; }\nimg { display: block; max-width: 100%; }\na { text-decoration: inherit; color: inherit; }\n${tokensCss}`;

    // Ensure layout imports globals.css
    if (files['app/layout.tsx'] && !files['app/layout.tsx'].includes('globals.css')) {
      files['app/layout.tsx'] = `import './globals.css';\n` + files['app/layout.tsx'];
    }

    trace.action('server-preview:sending-files', { files: Object.keys(files) });

    try {
      const res = await fetch(`${PREVIEW_HOST}/api/session/write-batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, files }),
      });
      const data = await res.json();
      trace.action('server-preview:sync-done', { filesWritten: data.filesWritten });

      // Warm up the route — Next.js needs one request to compile a new session directory.
      // Without this, the iframe's first load hits a 404 (route not yet compiled).
      // Single no-cors fetch triggers compilation (can't read status due to CORS, but that's fine).
      const url = `${PREVIEW_HOST}/${sessionId}${previewPath}`;
      try { await fetch(url, { mode: 'no-cors' }); } catch { /* ignore */ }
      trace.action('server-preview:warmup-done');

      setStatus('Preview ready');
      setReady(true);
    } catch (err: any) {
      trace.error('server-preview:sync-error', err);
      setStatus(`Error: ${err.message}`);
    }
  }, [sessionId, previewPath]);

  // Initial sync — only when previewing a real page. Component masters skip
  // this entirely since they preview in-process via ComponentLivePreview.
  useEffect(() => {
    if (componentPreviewFile) return;
    if (!sentRef.current) {
      sentRef.current = true;
      syncAllFiles();
    }
  }, [syncAllFiles, componentPreviewFile]);

  // Sync individual file changes (only relevant for the page-iframe path)
  useEffect(() => {
    if (!ready || componentPreviewFile) return;

    let timer: ReturnType<typeof setTimeout>;
    const unsub = projectFS.subscribe(() => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        trace.action('server-preview:file-change-detected');
        const files = buildFiles(sessionId);
        for (const [filePath, content] of Object.entries(files)) {
          try {
            await fetch(`${PREVIEW_HOST}/api/session/write`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ sessionId, filePath, content }),
            });
          } catch (err: any) {
            trace.error('server-preview:file-sync-error', { filePath, message: err.message });
          }
        }
        trace.action('server-preview:files-synced', { fileCount: Object.keys(files).length });
      }, 300);
    });

    return () => { unsub(); clearTimeout(timer); };
  }, [ready, sessionId, componentPreviewFile]);

  // Component master → render in-process via compileCodeComponent. No iframe,
  // no preview server — interactive React just like the Component Editor preview.
  if (componentPreviewFile) {
    return (
      <PreviewFrame onReload={() => { setReloadKey(k => k + 1); }}>
        <ComponentLivePreview key={`${componentPreviewFile}#${reloadKey}`} componentFilePath={componentPreviewFile} />
      </PreviewFrame>
    );
  }

  // Build preview URL from the active page path (see `previewPath`). Route-group
  // folders are stripped so a Template assignment doesn't leak into a page's URL
  // (Templates are URL-invisible by Next.js convention); a Template selected on
  // its own previews via its injected placeholder route.
  const previewUrl = `${PREVIEW_HOST}/${sessionId}${previewPath}`;

  return (
    <PreviewFrame onReload={() => { setReloadKey(k => k + 1); }}>
      {ready ? (
        <iframe
          key={`${previewUrl}#${reloadKey}`}
          ref={iframeRef}
          src={previewUrl}
          // Revyme parent sets `Cross-Origin-Embedder-Policy: credentialless`
          // (vite.config.ts). Without `credentialless=""` on this cross-origin
          // iframe, COEP blocks the load and Chrome falls into chrome-error.
          // React JSX type doesn't ship the attr — spread it via cast.
          {...({ credentialless: '' } as Record<string, string>)}
          style={{ width: '100%', height: '100%', border: 'none', background: 'var(--bg-canvas, #1a1a2e)' }}
        />
      ) : (
        <div style={{
          width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: '#666', fontSize: 13, fontFamily: 'monospace', background: 'var(--bg-canvas, #1a1a2e)',
        }}>
          {status}
        </div>
      )}
    </PreviewFrame>
  );
}
