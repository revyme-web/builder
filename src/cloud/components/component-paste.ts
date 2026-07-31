// component-paste.ts — Detects Component CDN URLs in clipboard paste and
// imports them. When a user pastes a URL like
//   https://assets.revyme.app/components/<Name>@<hash>.js
// the editor adds the URL as an `import` statement on the active page
// and inserts a JSX instance using the regular paste rules.
//
// The bundle stays remote — `cdn-component-cache.loadCdnComponent(url)`
// dynamic-imports it once and caches the loaded React component. Design
// components AND code components both flow through this same path; the
// URL pattern is identical (`components/<Name>@<hash>.js`). For multi-
// file design bundles, the consumer's browser handles recursive URL
// imports natively — each child is imported via a baked-in URL inside
// the parent's JS bundle (mirroring the reference's `a hosted CDN`
// model).
//
// "Unlink Instance" downloads the original TSX source(s) from
// `/api/components/source` and writes them to `components/`. For multi-
// file design bundles, the manifest at `<root>.manifest.json` lists every
// transitive file → unlink fetches and writes them all, restoring the
// full tree to the user's project.

import { getDefaultStore } from 'jotai';
import { escapeRegExp } from '@/shared/regex-utils';
import { CDN_HOST } from '@/shared/hosts';
import { queueMutation } from '@/code/mutation/mutation-queue';
import { modifyProjectFile } from '@/code/project/modify-file';
import { generateNodeId } from '@/shared/id-utils';
import { selectedIdsAtom, selectedNodeAtom, nodesAtom } from '@/code/stores/store';
import { activeFilePathAtom } from '@/code/project/active-file-store';
import { findMatchingRule, resolveTargets } from '@/code/features/paste-engine';
import { CODE_COMPONENT_FALLBACK_SIZE } from '@/code/components/component-registry';
import { changeTagInCode } from '@/code/generation/generator-attrs';
import { trace } from '@/shared/debug-trace';

// JS bundle URLs (compiled ESM). Code components AND design components
// both share at this single path now — the consumer detects "this is a
// design component" from the bundled source's shape (`withResponsiveProps`
// + `variantConfig` markers), not from the URL. Multi-file design bundles
// use the SAME URL pattern; the manifest sibling is a separate JSON file
// at `<rootUrl>.manifest.json`, used only by Unlink.
// Matches `components/<Name>@<hash>.js` and `vectors/<Name>@<hash>.js`.
// The prefix is captured (group 1)
// so callers can route on it — vectors need `name="icon-1"`
// on the inserted JSX so the master
// grid view doesn't render in place of a single variant.
const COMPONENT_URL_PATTERN = new RegExp(`^${escapeRegExp(CDN_HOST)}/(components|vectors)/([^@]+)@([a-f0-9]+)\\.js$`);
// Recognize the legacy TSX URL pattern only to surface a clear warning —
// the editor's dynamic-import path can't load TSX.
const LEGACY_TSX_PATTERN = new RegExp(`^${escapeRegExp(CDN_HOST)}/(?:components|vectors)/([^@]+)@([a-f0-9]+)\\.tsx$`);

/** Convert CDN URL to a same-origin proxy URL to avoid CORS issues during dev */
function toProxyUrl(cdnUrl: string): string {
  const path = cdnUrl.replace(`${CDN_HOST}/`, '');
  return `/api/components/fetch?path=${encodeURIComponent(path)}`;
}

// ─── Manifest types + fetch helpers ────────────────────────────────────

interface BundleManifestEntry {
  /** Original projectFS path (e.g. `components/Hero.tsx`). Re-used at
   *  unlink time to put the file back where it came from. */
  path: string;
  /** Slug used in the R2 key (e.g. `Hero`) — informational, not load-bearing. */
  basename: string;
  /** Content hash of the compiled JS (16 hex chars). Pass to
   *  `/api/components/source?hash=` to retrieve original TSX. */
  hash: string;
  /** Absolute R2 URL of the JS bundle. Used for proxy fallback. */
  url: string;
}

interface BundleManifest {
  version: number;
  /** projectFS path of the entry-point file (e.g. `components/Hero.tsx`). */
  root: string;
  /** Every file in the transitive bundle. */
  files: BundleManifestEntry[];
}

/**
 * Try fetching the sibling manifest for a multi-file bundle. Returns null
 * for single-file bundles (no manifest exists) or on any fetch error —
 * unlink falls back to the single-file flow in either case.
 */
async function fetchManifest(manifestUrl: string): Promise<BundleManifest | null> {
  try {
    const proxied = toProxyUrl(manifestUrl);
    const r = await fetch(proxied);
    if (!r.ok) return null;
    const text = await r.text();
    const parsed = JSON.parse(text) as BundleManifest;
    if (!parsed.files || !Array.isArray(parsed.files)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Rename the file's exported component identifier so it matches the
 * file's basename. Required for "Unlink Instance" — we save the bundle
 * source under a unique file name like `BaWeUxLocal_<suffix>.tsx` but
 * the source's `function BaWeUx(...)` declaration still uses the
 * ORIGINAL name. The component-registry keys by that internal name,
 * so the page tag `<BaWeUxLocal_<suffix>>` would never match the
 * registry entry (key = `BaWeUx`) and the renderer would render an
 * empty wrapper instead of expanding the design component's children.
 *
 * The rename is a global word-boundary substitution of the exported
 * identifier — same approach as a Babel rename pass. Safe in practice
 * because the bundle author's other identifiers don't collide with
 * the component's own name.
 *
 * Returns { source, oldName } so the caller can rewrite cross-file
 * imports of the same name in dependents (multi-file bundles only).
 */
function renameExportedComponent(
  source: string,
  newName: string,
): { source: string; oldName: string | null } {
  // Mirrors the patterns parseComponentFile recognizes (in priority
  // order). First match wins — same as the registry's own name extractor.
  const funcMatch = source.match(/export\s+default\s+function\s+(\w+)\s*\(/);
  let oldName: string | null = null;
  if (funcMatch) oldName = funcMatch[1];
  if (!oldName) {
    const hocMatch = source.match(/export\s+default\s+\w+\s*\(\s*(\w+)\s*\)/);
    if (hocMatch) oldName = hocMatch[1];
  }
  if (!oldName) {
    const bareMatch = source.match(/export\s+default\s+(\w+)\s*;?\s*$/m);
    if (bareMatch && /^[A-Z]/.test(bareMatch[1])) oldName = bareMatch[1];
  }
  if (!oldName || oldName === newName) return { source, oldName };
  // \b doesn't catch `$` boundaries — irrelevant for PascalCase identifiers.
  const renamed = source.replace(new RegExp(`\\b${oldName}\\b`, 'g'), newName);
  return { source: renamed, oldName };
}

/**
 * Fetch a single component's TSX source by its content hash. Tries the
 * auth-gated `/api/components/source` endpoint first, falls back to the
 * public CDN URL via the proxy. Returns null on failure.
 */
async function fetchSourceByHash(hash: string, fallbackUrl?: string): Promise<string | null> {
  try {
    const r = await fetch(`/api/components/source?hash=${encodeURIComponent(hash)}`, {
      credentials: 'include',
    });
    if (r.ok) return await r.text();
  } catch { /* fall through */ }
  if (fallbackUrl) {
    try {
      const r = await fetch(toProxyUrl(fallbackUrl));
      if (r.ok) return await r.text();
    } catch { /* fall through */ }
  }
  return null;
}

/**
 * Check if a string is a Component CDN URL. Logs a verbose console
 * warning on a near-miss (e.g. legacy `.tsx` URL) so a paste that
 * "does nothing" can be diagnosed from DevTools.
 */
export function isComponentUrl(text: string): boolean {
  const trimmed = text.trim();
  if (COMPONENT_URL_PATTERN.test(trimmed)) return true;
  if (LEGACY_TSX_PATTERN.test(trimmed)) {
    console.warn(
      '[component-paste] URL ends in .tsx (old format). The editor now ' +
      'expects compiled JS bundles at .../components/<Name>@<hash>.js. ' +
      'Re-share the component to get a new URL.',
    );
  }
  return false;
}


/** Extract `{ name, hash, kind }` from a CDN URL. Returns null on
 *  format mismatch. `kind` is one of `'vector'` (icon-set bundles
 *  at `/vectors/...`) or `'component'` (code + design components at
 *  `/components/...`, the latter share the same prefix). Callers
 *  route on `kind` to seed `name="icon-1"` on
 *  variant-bearing instances. */
export function parseCdnComponentUrl(url: string): {
  name: string;
  hash: string;
  kind: 'component' | 'vector';
} | null {
  const m = url.trim().match(COMPONENT_URL_PATTERN);
  if (m) {
    return {
      kind: m[1] === 'vectors' ? 'vector' : 'component',
      name: m[2],
      hash: m[3],
    };
  }
  const legacy = url.trim().match(LEGACY_TSX_PATTERN);
  if (legacy) {
    return { kind: 'component', name: legacy[1], hash: legacy[2] };
  }
  return null;
}

/**
 * Add a CDN URL import to the page code if not already present.
 * Inserts: import ComponentName from "https://assets.revyme.app/components/...@hash.tsx"
 *
 * Tracks block-comment state across lines. Pages start with a multi-line
 * `/** @canvas { ... } *\/` JSON config block — without this state machine,
 * the loop sees the first line `/** @canvas {`, treats it as part of the
 * import region (it starts with `/*`), then bails on line 2 (` "viewports":
 * ...` doesn't match any import marker) and INSERTS the new import wedged
 * between them, corrupting the canvas-config JSON. The fix: stay in the
 * "import region" until the block comment actually closes.
 */
function ensureUrlImport(code: string, componentName: string, cdnUrl: string): string {
  // Check if already imported (by URL or by name)
  if (code.includes(cdnUrl) || new RegExp(`import\\s+${componentName}\\s+from`).test(code)) {
    return code;
  }
  return insertImportLine(code, `import ${componentName} from "${cdnUrl}";`);
}

/**
 * Insert an import line at the end of the file's import region — the
 * block-comment-aware walk documented above (a page's `/** @canvas … *\/`
 * config block must never be split by the insertion).
 */
export function insertImportLine(code: string, importLine: string): string {
  const lines = code.split('\n');
  let lastImportIdx = -1;
  let inBlockComment = false;

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();

    // If we're already inside a block comment, every line is part of it
    // until we see the closing `*/`. The line that contains the close is
    // still part of the block (advance lastImportIdx through it).
    if (inBlockComment) {
      lastImportIdx = i;
      if (t.includes('*/')) inBlockComment = false;
      continue;
    }

    // Block-comment opener on this line. If it doesn't ALSO contain `*/`,
    // we've entered a multi-line block.
    if (t.startsWith('/*') || t.startsWith('/**')) {
      lastImportIdx = i;
      // `/** foo */` (single-line block) — closes here, stay open=false.
      // `/** @canvas {` (multi-line) — no `*/` yet, mark block open.
      const afterOpen = t.slice(2);
      if (!afterOpen.includes('*/')) inBlockComment = true;
      continue;
    }

    // Normal import-region markers.
    if (
      t === '' ||
      t.startsWith('import ') ||
      t.startsWith("'use client'") ||
      t.startsWith('"use client"') ||
      t.startsWith('//') ||
      t.startsWith('*') ||
      t.startsWith('gsap.registerPlugin')
    ) {
      lastImportIdx = i;
      continue;
    }

    // First non-import-region line outside any block comment → stop.
    if (lastImportIdx >= 0) break;
  }

  lines.splice(lastImportIdx + 1, 0, importLine);
  trace.action('component-paste:import-added', { importLine });
  return lines.join('\n');
}

/**
 * Ensure a DEFAULT import of `specifier` exists, returning the local name
 * the caller must use on its JSX tags. Alias-aware — the cross-project
 * paste primitive (`specifier` is a CDN URL in cloud mode, an
 * `@/components/X` path for local materialization):
 *
 *   - `specifier` already imported (any name)      → reuse that name
 *   - `desiredName` free                           → import under it
 *   - `desiredName` taken by a DIFFERENT import or
 *     a local declaration (the target project has
 *     its own `Marquee`)                           → alias `MarqueeLinked`,
 *                                                    `MarqueeLinked2`, …
 */
export function ensureDefaultImport(
  code: string,
  desiredName: string,
  specifier: string,
): { code: string; localName: string } {
  // Already imported from this exact specifier — reuse its local name.
  const existing = code.match(new RegExp(`import\\s+([A-Za-z_$][\\w$]*)\\s+from\\s+['"]${escapeRegExp(specifier)}['"]`));
  if (existing) return { code, localName: existing[1]! };

  const taken = (name: string) =>
    new RegExp(`import\\s+${name}\\s+from`).test(code) ||
    new RegExp(`\\b(?:function|const|class)\\s+${name}\\b`).test(code);

  let localName = desiredName;
  if (taken(localName)) {
    localName = `${desiredName}Linked`;
    for (let i = 2; taken(localName); i++) localName = `${desiredName}Linked${i}`;
  }

  return {
    code: insertImportLine(code, `import ${localName} from "${specifier}";`),
    localName,
  };
}

/**
 * The px size to seed a pasted CDN component instance at. Reads the
 * creator's `@defaultWidth`/`@defaultHeight` annotations via the public
 * `/api/components/metadata` endpoint (the server parses the stored
 * source, so this works for CLOSED-source listings without exposing any
 * code). Any failure — offline, 404, missing annotations — falls back to
 * the shared 200×200 default; a paste must never block on metadata.
 */
async function fetchCdnInsertSize(hash: string): Promise<{ width: string; height: string }> {
  const fallback = {
    width: `${CODE_COMPONENT_FALLBACK_SIZE.width}px`,
    height: `${CODE_COMPONENT_FALLBACK_SIZE.height}px`,
  };
  try {
    const r = await fetch(`/api/components/metadata?hash=${encodeURIComponent(hash)}`);
    if (!r.ok) {
      trace.action('component-paste:insert-size-fallback', { hash, status: r.status });
      return fallback;
    }
    const meta = (await r.json()) as { defaultWidth?: number | null; defaultHeight?: number | null };
    const size = {
      width: meta.defaultWidth != null ? `${meta.defaultWidth}px` : fallback.width,
      height: meta.defaultHeight != null ? `${meta.defaultHeight}px` : fallback.height,
    };
    trace.action('component-paste:insert-size', { hash, ...size });
    return size;
  } catch (err) {
    trace.error('component-paste:insert-size-error', err as Error);
    return fallback;
  }
}

/**
 * Import a Component from a CDN URL into the current project.
 * 1. Derive component name from the URL slug
 * 2. Trigger the dynamic-import load (warms the cache so the renderer
 *    picks it up the moment the new instance node mounts)
 * 3. Adds URL import to the active page code
 * 4. Inserts a component instance using paste rules
 */
export async function importComponentFromUrl(url: string): Promise<boolean> {
  const match = url.trim().match(COMPONENT_URL_PATTERN);
  if (!match) return false;

  const prefix = match[1];   // 'components' | 'vectors'
  const slug = match[2];
  const version = match[3];
  const cdnUrl = url.trim();
  const isVector = prefix === 'vectors';
  // Vector bundles export a master component that
  // takes a `name` prop to pick a single variant —
  // instance-side seeding covers default styles + name attr.
  const isContainerSet = isVector;

  // Component name = the slug, sanitized to JSX-tag legal chars. The
  // backend's R2 key uses exactly this slug so name parity is automatic.
  // No fetch-and-regex like the older flow — that was a leftover from
  // when the URL pointed at TSX source we needed to parse.
  const componentName = slug.replace(/[^a-zA-Z0-9]/g, '') || 'Component';

  trace.action('component-paste:start', { slug, version, componentName, url: cdnUrl, isVector });

  try {
    // The actual rendering happens inside the canvas sandbox iframe (see
    // `sandbox-code-host.ts`'s URL detection path), which has its own
    // importmap to resolve the bundle's bare `react`/`framer-motion`
    // imports. The PARENT frame can't dynamic-import the bundle (no
    // importmap here, can't safely add one without conflicting with
    // Vite's own dep resolution) — so we deliberately skip the
    // parent-side cache warm. It was a leftover from the legacy parent-
    // frame rendering path that's no longer used for URL-loaded
    // components. The sandbox handles all the loading.

    // 2. Add URL import to the active page code
    const store = getDefaultStore();
    const activeFile = store.get(activeFilePathAtom);
    modifyProjectFile(activeFile, (code) => ensureUrlImport(code, componentName, cdnUrl));

    // 3. Insert instance using paste rules
    //    Synthesize a minimal PasteContext with a single fake clipboard node so
    //    the rules engine engages — we only need it to resolve a parent + index.
    const selectedId = store.get(selectedNodeAtom);
    const nodes = store.get(nodesAtom);
    const nodeId = generateNodeId('component');
    // CODE COMPONENTS ARE FIXED-SIZE ON THE CANVAS — every paste seeds an
    // explicit px width/height. Leaving the instance sizeless (the old
    // "render at natural size" idea) collapses the wrapper whenever the
    // bundle's root draws via absolute/100% children: the user saw a
    // ~placeholder-sized selection overlay with content overflowing it,
    // and Size showed an un-editable "auto". The size comes from the
    // creator's `/** @defaultWidth N */` + `/** @defaultHeight N */`
    // annotations (served by the public /metadata endpoint so it works
    // for closed-source listings too), falling back to the shared
    // 200×200 default. The `...style` spread sits last in the bundle's
    // root, so any size the user sets later still wins.
    // Vector instances keep their explicit 240×240 box — matching the
    // Library-panel iconSet drag's `defaultStyles` (icon bundles render
    // an outer relative div containing an absolute SVG with 0 intrinsic
    // size). `position: relative` + `flex: 0 0 auto` mirror the library
    // drag defaults so the instance isn't squashed inside flex parents
    // (the canvas-drop branch below overwrites position with absolute).
    const styles: Record<string, string> = isContainerSet
      ? { width: '240px', height: '240px' }
      : { position: 'relative', flex: '0 0 auto', ...(await fetchCdnInsertSize(version)) };
    // Vector (icon set) instances need a
    // `name=...` prop on the JSX tag — without it the master
    // component returns its grid view (every variant laid out
    // together) instead of a single one. Same defaults the local
    // Library-panel drag uses. The user can change `name` to any
    // other entry via the IconSetTool after
    // insertion.
    const attrs: Record<string, string> | undefined = isVector
      ? { name: 'icon-1' }
      : undefined;

    const fakeCtx = {
      selectedIds: selectedId ? [selectedId] : [],
      nodes,
      clipboardNodes: [{ id: 'fake', type: componentName, parentId: null, children: [], styles, order: 0 }],
    };
    const rule = findMatchingRule(fakeCtx);
    const targets = rule ? resolveTargets(fakeCtx, rule.config.targetMode) : [];
    const target = targets[0];

    trace.action('component-paste:inserting', { componentName, ruleId: rule?.id, parentId: target?.parentId });

    if (!target || target.parentId === null) {
      queueMutation({
        type: 'addCanvasNode',
        node: { id: nodeId, type: componentName, styles: { ...styles, position: 'absolute', left: '100px', top: '100px' }, name: componentName, attrs },
      });
    } else {
      queueMutation({
        type: 'addNode',
        parentId: target.parentId,
        node: { id: nodeId, type: componentName, styles, name: componentName, attrs },
        index: target.insertIndex,
      });
    }

    requestAnimationFrame(() => {
      store.set(selectedIdsAtom, [nodeId]);
    });

    trace.action('component-paste:inserted', { nodeId, componentName, parentId: target?.parentId ?? null });
    return true;
  } catch (err: any) {
    trace.error('component-paste:error', err);
    return false;
  }
}

/**
 * Unlink a CDN-linked component instance: fetch the TSX source(s) from
 * the marketplace, save as local file(s) under `components/`, and
 * either rewrite the page's URL import (replaceAll) or just retarget
 * one specific instance's JSX tag (instance unlink).
 *
 * Two modes:
 *   • `replaceAll: true`  → rewrite the existing `import X from
 *     "<cdnUrl>"` to point at the local root. EVERY tag named `<X>` on
 *     the page silently inherits the local copy. Best when the user
 *     wants to fork the component wholesale.
 *
 *   • `replaceAll: false` + `instanceNodeId` → save the source under a
 *     UNIQUE local file name (`<Name>_local_<nodeIdSuffix>.tsx`) so it
 *     never collides with the CDN-linked siblings, add a NEW import
 *     line for that name, then change ONLY the targeted JSX tag from
 *     `<X>` to `<XLocal_…>`. The original CDN import stays put and
 *     every other instance keeps tracking the marketplace.
 *
 * Multi-file bundles (design components with nested deps): if a manifest
 * exists at `<rootUrl>.manifest.json`, fetch every file listed and
 * write them all. Each gets its original projectFS path (`components/Hero.tsx`,
 * `components/Card.tsx`, …). Their cross-imports use `@/components/X`
 * paths — these resolve naturally once the files are local.
 *
 * Single-file bundles (code components, single-file design components):
 * fetch and write just the root file, same as the previous flow.
 *
 * Mirrors the reference's "Unlink Instance" semantics: once unlinked, the link
 * to the marketplace listing is severed permanently for that instance
 * (or all instances in replaceAll mode). Future updates from the
 * original creator no longer flow into the unlinked copy.
 *
 * Returns true on success.
 */
export async function unlinkCdnComponent(opts: {
  cdnUrl: string;
  replaceAll: boolean;
  /** When `replaceAll` is false, the instance whose JSX tag should be
   *  retargeted to the local copy. Required in single-instance mode. */
  instanceNodeId?: string | null;
}): Promise<boolean> {
  const { cdnUrl, replaceAll } = opts;
  const instanceNodeId = opts.instanceNodeId ?? null;
  const match = cdnUrl.trim().match(COMPONENT_URL_PATTERN);
  if (!match) {
    trace.error('unlink-component:invalid-url', { cdnUrl });
    return false;
  }
  // Group 1 = prefix ('components' | 'vectors'). Used
  // to write the local copy under the matching projectFS folder so
  // the consumer's existing iconSet / component detection
  // picks it up the same way it would for any local file. Without
  // this, an unlinked vector would land in `components/...` and the
  // parser would treat it as a code component, missing the
  // `@iconSet` annotation pathway.
  const prefix = match[1];
  const slug = match[2];
  const hash = match[3];
  const isVector = prefix === 'vectors';
  const localFolder = isVector ? 'icons' : 'components';

  trace.action('unlink-component:start', { cdnUrl, replaceAll, slug, hash, isVector });

  try {
    // 1. Try fetching the manifest first. If present → multi-file bundle.
    //    The manifest URL is the JS URL with `.js` swapped for `.manifest.json`.
    const manifestUrl = cdnUrl.replace(/\.js$/, '.manifest.json');
    const manifest = await fetchManifest(manifestUrl);

    const { projectFS } = await import('@/code/project/project-fs');

    // Files we write to projectFS, indexed by the manifest path so
    // cross-imports between bundle files keep resolving correctly.
    const writes: Array<{ manifestPath: string; localPath: string }> = [];

    if (manifest && manifest.files && manifest.files.length > 0) {
      // ── Multi-file flow ─────────────────────────────────────────
      trace.action('unlink-component:manifest-found', {
        cdnUrl,
        fileCount: manifest.files.length,
      });

      // Fetch every file's TSX source by hash, in parallel.
      const fetched = await Promise.all(manifest.files.map(async (entry) => {
        const tsx = await fetchSourceByHash(entry.hash, entry.url);
        return { entry, tsx };
      }));

      // Decide local paths with collision rules. Only RENAME a file
      // whose target already exists with different content — and only
      // record the rename so the OTHER bundle files' imports of that
      // name can be rewritten in step 3. The ROOT entry is special-
      // cased for instance-unlink mode: we always force a unique
      // suffix derived from the instance's node id so two unlinked
      // siblings of the same CDN bundle each get their own forkable
      // root (their dependency graphs can dedupe content-identically
      // — only the ROOT must diverge for the per-tag retarget below).
      const rootManifestPathForRename = manifest.root ?? manifest.files[0]?.path;
      const instanceSuffix = instanceNodeId
        ? (instanceNodeId.replace(/[^a-zA-Z0-9]/g, '').slice(-6) || 'local')
        : null;
      const renames = new Map<string, string>(); // baseName → renamedBaseName
      for (const { entry, tsx } of fetched) {
        if (!tsx) {
          trace.error('unlink-component:source-missing', { entry });
          continue;
        }
        const target = entry.path; // e.g. `components/Card.tsx`
        const baseName = (target.match(/([^/]+)\.tsx$/)?.[1] ?? 'Component');
        let local = target;
        let sourceToWrite = tsx;
        const isRoot = entry.path === rootManifestPathForRename;
        if (isRoot && instanceSuffix) {
          // Force a unique root file for instance unlink.
          const renamed = `${baseName}Local_${instanceSuffix}`;
          local = target.replace(`${baseName}.tsx`, `${renamed}.tsx`);
          renames.set(baseName, renamed);
          // Align the source's internal exported identifier with the
          // new filename. Without this the component-registry keys
          // the parsed file under the ORIGINAL component name and
          // the page tag (which we'll rewrite to the new local name
          // below) wouldn't resolve to a registry entry — the
          // design-component children would never expand.
          sourceToWrite = renameExportedComponent(tsx, renamed).source;
        } else if (projectFS.exists(target) && projectFS.readFile(target) !== tsx) {
          const renamed = `${baseName}_${entry.hash.slice(0, 6)}`;
          local = target.replace(`${baseName}.tsx`, `${renamed}.tsx`);
          renames.set(baseName, renamed);
          // Same rename rationale as above — when a dependency had to
          // be disambiguated by content hash, its registry key must
          // line up with the new file/import name too.
          sourceToWrite = renameExportedComponent(tsx, renamed).source;
        }
        writes.push({ manifestPath: entry.path, localPath: local });
        projectFS.writeFile(local, sourceToWrite);
      }

      // 3a. If any renames happened, rewrite cross-imports in the
      //     just-written bundle files. e.g. if `Card` was renamed to
      //     `Card_abc123`, rewrite `Hero.tsx`'s `@/components/Card` → `@/components/Card_abc123`.
      if (renames.size > 0) {
        for (const { localPath } of writes) {
          const code = projectFS.readFile(localPath);
          if (!code) continue;
          let updated = code;
          for (const [from, to] of renames) {
            updated = updated.replace(
              new RegExp(`(from\\s*["']@/components/)${from}(["'])`, 'g'),
              `$1${to}$2`,
            );
            updated = updated.replace(
              new RegExp(`(from\\s*["']@/icons/)${from}(["'])`, 'g'),
              `$1${to}$2`,
            );
          }
          if (updated !== code) projectFS.writeFile(localPath, updated);
        }
      }

      trace.action('unlink-component:multi-file-saved', {
        fileCount: writes.length,
        renames: Array.from(renames.entries()),
      });
    } else {
      // ── Single-file flow (no manifest) ──────────────────────────
      let sourceCode: string | null = null;
      try {
        const r = await fetch(`/api/components/source?hash=${encodeURIComponent(hash)}`, {
          credentials: 'include',
        });
        if (r.ok) sourceCode = await r.text();
      } catch { /* fall through to proxy */ }
      if (!sourceCode) {
        const r = await fetch(toProxyUrl(cdnUrl));
        if (r.ok) sourceCode = await r.text();
      }
      if (!sourceCode) {
        trace.error('unlink-component:fetch-failed', { cdnUrl });
        return false;
      }

      const componentName = (sourceCode.match(/function\s+([A-Z][a-zA-Z0-9]*)\s*\(/)?.[1])
        ?? slug.replace(/[^a-zA-Z0-9]/g, '')
        ?? 'Component';
      const baseName = componentName.replace(/[^a-zA-Z0-9]/g, '') || 'Component';
      let localPath: string;
      if (instanceNodeId) {
        // Instance unlink → ALWAYS write a unique copy keyed by the
        // instance's node id. Two unlinked instances of the same CDN
        // component must produce two independent local files so
        // editing one doesn't bleed into the other (the whole point
        // of "Unlink Instance" vs "Replace All"). Suffix is the node
        // id's tail, kept short for readable filenames.
        const suffix = instanceNodeId.replace(/[^a-zA-Z0-9]/g, '').slice(-6) || 'local';
        const localBaseName = `${baseName}Local_${suffix}`;
        // `localFolder` is `icons/` for vectors, `components/` for
        // everything else — keeps the parser's iconSet detection
        // (looking for `@iconSet` annotation under `icons/`) lined up.
        localPath = `${localFolder}/${localBaseName}.tsx`;
        // Rename the exported identifier inside the source so it
        // matches the new filename. Without this, the
        // component-registry would key the parsed file under the
        // ORIGINAL name (e.g. `BaWeUx`) and the page tag
        // `<BaWeUxLocal_<suffix>>` would never resolve to a registry
        // entry — design-component expansion would be skipped and
        // the canvas would show an empty wrapper.
        const { source: renamedSource } = renameExportedComponent(sourceCode, localBaseName);
        projectFS.writeFile(localPath, renamedSource);
      } else {
        // Replace-all → reuse an existing local file if its content
        // already matches (re-running unlink is idempotent), otherwise
        // disambiguate with the content hash.
        localPath = `${localFolder}/${baseName}.tsx`;
        if (projectFS.exists(localPath) && projectFS.readFile(localPath) !== sourceCode) {
          localPath = `${localFolder}/${baseName}_${hash.slice(0, 6)}.tsx`;
        }
        projectFS.writeFile(localPath, sourceCode);
      }
      writes.push({ manifestPath: `${localFolder}/${baseName}.tsx`, localPath });
      trace.action('unlink-component:single-file-saved', {
        localPath,
        size: sourceCode.length,
        mode: instanceNodeId ? 'instance' : 'replaceAll',
      });
    }

    if (writes.length === 0) {
      trace.error('unlink-component:no-files-written', { cdnUrl });
      return false;
    }

    // 3. Rewrite the page — different strategies for the two modes:
    //
    //    • Replace-all: rewrite the existing `import X from "<cdnUrl>"`
    //      to point at the local root path. Every `<X>` tag on the
    //      page silently inherits the local copy.
    //
    //    • Instance unlink: ADD a NEW import for the unique local root
    //      (its file name carries the instance's node id suffix), then
    //      retarget JUST that one JSX tag from `<X>` → `<XLocal_…>`.
    //      The original CDN import stays put and every other instance
    //      keeps tracking the marketplace.
    const rootManifestPath = manifest?.root ?? writes[0].manifestPath;
    const rootWrite = writes.find(w => w.manifestPath === rootManifestPath) ?? writes[0];
    const rootLocalPath = rootWrite.localPath;
    // Component identifier used in JSX + the import statement. For
    // instance unlink the file name is `<Base>Local_<suffix>.tsx` and
    // we use the matching identifier so the import + tag rename agree.
    const rootLocalBaseName = rootLocalPath.match(/([^/]+)\.tsx$/)?.[1] ?? 'Component';
    const localImportPath = '@/' + rootLocalPath.replace(/\.tsx$/, '');
    const store = getDefaultStore();
    const activeFile = store.get(activeFilePathAtom);

    if (instanceNodeId) {
      // ── Instance unlink ─────────────────────────────────────────
      modifyProjectFile(activeFile, (code) => {
        let next = code;
        // Add the new import after the last existing import line, but
        // only if it isn't already present (re-running unlink on the
        // same node should be a no-op, not a duplicate import).
        const importLine = `import ${rootLocalBaseName} from "${localImportPath}";`;
        if (!next.includes(importLine)) {
          const lines = next.split('\n');
          let lastImportIdx = -1;
          for (let i = 0; i < lines.length; i++) {
            if (/^\s*import\s+/.test(lines[i])) lastImportIdx = i;
            else if (lastImportIdx >= 0 && lines[i].trim() !== '') break;
          }
          if (lastImportIdx >= 0) {
            lines.splice(lastImportIdx + 1, 0, importLine);
            next = lines.join('\n');
          } else {
            next = importLine + '\n' + next;
          }
        }
        // Retarget JUST this instance's tag from <X> to <X_local>.
        next = changeTagInCode(next, instanceNodeId, rootLocalBaseName);
        return next;
      });
    } else {
      // ── Replace-all ──────────────────────────────────────────────
      void replaceAll; // applies on this page; project-wide rewrite TBD
      modifyProjectFile(activeFile, (code) => {
        const escapedUrl = cdnUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const importRegex = new RegExp(
          `import\\s+([A-Za-z0-9_$]+)\\s+from\\s+["']${escapedUrl}["'];?`,
          'g',
        );
        return code.replace(importRegex, (_, name) => `import ${name} from "${localImportPath}";`);
      });
    }

    trace.action('unlink-component:done', {
      cdnUrl,
      rootLocalPath,
      fileCount: writes.length,
      mode: instanceNodeId ? 'instance' : 'replaceAll',
    });
    return true;
  } catch (err) {
    trace.error('unlink-component:error', { error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

