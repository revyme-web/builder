// metadata-gen.ts — Parse and generate Next.js-style metadata exports in layout.tsx.
// Code-first: SEO metadata lives as `export const metadata = { ... }` in app/layout.tsx.
// The SettingsOverlay reads/writes through these functions.
//
// HARDENED 2026-08-16 (the finance-project corruption): the old writer
// wrapped values in single quotes escaping only `'`, and located the block
// with a LAZY quote-blind regex (`\{[\s\S]*?\}\s*;`). A pasted custom-code
// snippet containing newlines and an in-string `};` (any real <script>)
// produced invalid JS on the first save, and every following save replaced
// only up to the `};` INSIDE the stored string — stranding the string's
// tail as top-level garbage (three stacked tails in the wild file). Now:
// values serialize via JSON.stringify (any content is a valid literal), the
// block is located with a balanced string-aware scan, values parse back via
// Babel (content-proof), and every write is parse-gated — an output that
// doesn't parse as a module is never written.

import { parse, parseExpression } from '@babel/parser';
import { trace } from '@/shared/debug-trace';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SiteMetadata {
  title?: string;
  description?: string;
  icons?: { icon?: string };
  openGraph?: {
    title?: string;
    description?: string;
    images?: string[];
  };
  [key: string]: unknown;
}

// ─── Default Layout ─────────────────────────────────────────────────────────

/**
 * Server-side layout shell: metadata, siteConfig, html/body, imports LayoutClient.
 * This is a pure server component — no motion, hooks, or event handlers.
 */
export function ensureLayoutFile(): string {
  // Providers MUST wrap children — next-themes AND next-intl
  // (NextIntlClientProvider) live there; a bare layout made every
  // localized page crash with "context from NextIntlClientProvider was
  // not found" in preview and on the live build (2026-07-22).
  return `import './globals.css';
import { Providers } from './providers';

export const metadata = {
  title: '',
  description: '',
};

export const siteConfig: Record<string, string> = {
  language: 'en',
  theme: 'light',
  customHead: '',
  customBody: '',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        {siteConfig.customHead ? (
          <div data-custom-code="head" style={{ display: 'contents' }} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: siteConfig.customHead }} />
        ) : null}
        <Providers>{children}</Providers>
        {siteConfig.customBody ? (
          <div data-custom-code="body" style={{ display: 'contents' }} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: siteConfig.customBody }} />
        ) : null}
      </body>
    </html>
  );
}
`;
}

// `ensureLayoutClientFile()` was removed alongside the bare root
// `app/LayoutClient.tsx`. Pages without a Template now render directly
// against `app/layout.tsx`'s `{children}` slot; pages with a Template
// resolve via the route-group's own `(name)/LayoutClient.tsx`. Callers
// that previously auto-created the bare file no longer need to.

// ─── Parse ──────────────────────────────────────────────────────────────────

/** Locate `export const <name> = { … };` with a BALANCED, string-aware scan
 *  (quotes, template literals, escapes). Returns the full statement span and
 *  the object literal's text. Never confused by `};` inside stored strings. */
function extractExportObject(code: string, name: string): { start: number; end: number; objStr: string } | null {
  // optional type annotation (`: Record<string, string>`) between name and `=`
  const declRe = new RegExp(`export\\s+const\\s+${name}(?:\\s*:\\s*[\\w<>,.\\[\\]\\s]+?)?\\s*=\\s*\\{`);
  const m = declRe.exec(code);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  let depth = 0, inStr = '';
  for (let i = open; i < code.length; i++) {
    const ch = code[i];
    if (inStr) { if (ch === inStr && code[i - 1] !== '\\') inStr = ''; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { inStr = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        // absorb the trailing `;` (and whitespace before it)
        let j = i + 1;
        while (j < code.length && /\s/.test(code[j])) j++;
        const end = code[j] === ';' ? j + 1 : i + 1;
        return { start: m.index, end, objStr: code.slice(open, i + 1) };
      }
    }
  }
  return null;
}

/** Evaluate a static object literal to plain data via Babel — content-proof
 *  (any escapes, quotes, `};` inside strings). Non-literal values are
 *  skipped. Falls back to the legacy regex→JSON conversion for shapes Babel
 *  rejects (historic hand-edited files). */
function objectLiteralToRecord(objStr: string): Record<string, any> | null {
  try {
    const node: any = parseExpression(objStr, { plugins: ['jsx', 'typescript'] });
    const toValue = (n: any): any => {
      if (!n) return undefined;
      if (n.type === 'StringLiteral' || n.type === 'NumericLiteral' || n.type === 'BooleanLiteral') return n.value;
      if (n.type === 'ObjectExpression') {
        const out: Record<string, any> = {};
        for (const p of n.properties) {
          if (p.type !== 'ObjectProperty') continue;
          const key = p.key.type === 'Identifier' ? p.key.name : (p.key.type === 'StringLiteral' ? p.key.value : null);
          if (key === null) continue;
          const v = toValue(p.value);
          if (v !== undefined) out[key] = v;
        }
        return out;
      }
      if (n.type === 'ArrayExpression') return n.elements.map(toValue).filter((v: any) => v !== undefined);
      return undefined;
    };
    const out = toValue(node);
    return out && typeof out === 'object' && !Array.isArray(out) ? out : null;
  } catch {
    return null;
  }
}

function legacyObjectToRecord(objStr: string): Record<string, any> {
  try {
    let s = objStr;
    s = s.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, '"$1"');
    s = s.replace(/(\s)(\w+)\s*:/g, '$1"$2":');
    s = s.replace(/,\s*([\]}])/g, '$1');
    return JSON.parse(s);
  } catch {
    return {};
  }
}

/** Does the generated module still parse? The last line of defense — a
 *  writer bug must surface as a bounced edit, never a broken layout.tsx
 *  (a syntax error in the server layout takes down every route). */
function moduleParses(code: string): boolean {
  try {
    parse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'] });
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse `export const metadata = { ... }` from code string.
 */
export function parseMetadataFromCode(code: string): SiteMetadata {
  trace.fn('metadata-gen:parse');
  const block = extractExportObject(code, 'metadata');
  if (!block) return {};
  const viaBabel = objectLiteralToRecord(block.objStr);
  if (viaBabel) return viaBabel;
  trace.error('metadata-gen:parse-failed', { raw: block.objStr.slice(0, 200) });
  return legacyObjectToRecord(block.objStr);
}

/**
 * Parse `export const siteConfig = { ... }` from code string.
 */
export function parseSiteConfigFromCode(code: string): Record<string, string> {
  trace.fn('metadata-gen:parseSiteConfig');
  const block = extractExportObject(code, 'siteConfig');
  if (!block) return {};
  const viaBabel = objectLiteralToRecord(block.objStr);
  if (viaBabel) return viaBabel as Record<string, string>;
  return legacyObjectToRecord(block.objStr) as Record<string, string>;
}

// ─── Generate ───────────────────────────────────────────────────────────────

/**
 * Serialize a metadata object back to JS source with single quotes.
 */
function serializeMetadata(meta: Record<string, any>, indent: string = '  '): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(meta)) {
    if (value === undefined || value === '') continue;
    if (typeof value === 'string') {
      // JSON.stringify: newlines, quotes, backslashes — any pasted content
      // is a single valid literal (the single-quote-escape-only form let a
      // multi-line value corrupt the module).
      lines.push(`${indent}${key}: ${JSON.stringify(value)}`);
    } else if (Array.isArray(value)) {
      lines.push(`${indent}${key}: ${JSON.stringify(value)}`);
    } else if (typeof value === 'object' && value !== null) {
      const inner = serializeMetadata(value, indent + '  ');
      lines.push(`${indent}${key}: {\n${inner}\n${indent}}`);
    } else {
      lines.push(`${indent}${key}: ${JSON.stringify(value)}`);
    }
  }
  return lines.join(',\n');
}

/**
 * Update metadata fields in layout code. Merges with existing metadata.
 * Empty string values remove the field. Missing fields are preserved.
 */
export function updateMetadataInCode(code: string, updates: SiteMetadata): string {
  trace.fn('metadata-gen:updateMetadata', { updates });

  const existing = parseMetadataFromCode(code);
  const merged = deepMerge(existing, updates);

  // Remove empty string values (empty = delete)
  cleanEmpty(merged);

  const body = serializeMetadata(merged);
  const newBlock = body.length > 0
    ? `export const metadata = {\n${body},\n};`
    : `export const metadata = {};`;

  const block = extractExportObject(code, 'metadata');
  const out = block
    ? code.slice(0, block.start) + newBlock + code.slice(block.end)
    : insertBeforeDefaultExport(code, newBlock);
  if (!moduleParses(out)) {
    trace.error('metadata-gen:update-metadata-parse-gate', { updates: Object.keys(updates) });
    return code;
  }
  return out;
}

function insertBeforeDefaultExport(code: string, blockText: string): string {
  const defaultIdx = code.indexOf('export default');
  if (defaultIdx >= 0) {
    return code.slice(0, defaultIdx) + blockText + '\n\n' + code.slice(defaultIdx);
  }
  return blockText + '\n\n' + code;
}

/**
 * Update siteConfig fields in layout code.
 */
export function updateSiteConfigInCode(code: string, updates: Record<string, string>): string {
  trace.fn('metadata-gen:updateSiteConfig', { updates });

  const existing = parseSiteConfigFromCode(code);
  const merged = { ...existing, ...updates };

  // Remove empty values
  for (const k of Object.keys(merged)) {
    if (merged[k] === '') delete merged[k];
  }

  const lines = Object.entries(merged).map(([k, v]) => `  ${k}: ${JSON.stringify(String(v))}`);
  // `Record<string, string>`: the layout JSX reads `siteConfig.customHead`
  // even when the save removed the (empty) key — loosely typed so exported
  // projects stay clean under tsc.
  const newBlock = lines.length > 0
    ? `export const siteConfig: Record<string, string> = {\n${lines.join(',\n')},\n};`
    : `export const siteConfig: Record<string, string> = {};`;

  const block = extractExportObject(code, 'siteConfig');
  const out = block
    ? code.slice(0, block.start) + newBlock + code.slice(block.end)
    : insertBeforeDefaultExport(code, newBlock);
  if (!moduleParses(out)) {
    trace.error('metadata-gen:update-site-config-parse-gate', { updates: Object.keys(updates) });
    return code;
  }
  return out;
}

/**
 * Recover an UNPARSEABLE app/layout.tsx (the pre-hardening custom-code
 * corruption left files with stranded string tails in module scope — a
 * syntax error in the server layout takes the whole site down, and no
 * incremental edit can fix a file the parser can't read). Rebuild from the
 * canonical template, salvaging what the broken source still legibly
 * carries: the metadata block (it sits above the corruption), any readable
 * siteConfig fields, and the CursorPortal import + render (the cursor
 * feature's layout footprint). Parseable input returns unchanged.
 */
export function healLayoutFile(code: string): string {
  if (moduleParses(code)) return code;
  trace.error('metadata-gen:heal-layout', { reason: 'layout.tsx does not parse — rebuilding' });
  const salvagedMeta = (() => {
    const block = extractExportObject(code, 'metadata');
    return block ? (objectLiteralToRecord(block.objStr) ?? legacyObjectToRecord(block.objStr)) : {};
  })();
  const salvagedConfig = (() => {
    const block = extractExportObject(code, 'siteConfig');
    return block ? (objectLiteralToRecord(block.objStr) ?? {}) : {};
  })();
  let out = ensureLayoutFile();
  if (Object.keys(salvagedMeta).length > 0) out = updateMetadataInCode(out, salvagedMeta);
  const cfgUpdates: Record<string, string> = {};
  for (const [k, v] of Object.entries(salvagedConfig)) {
    if (typeof v === 'string' && v !== '') cfgUpdates[k] = v;
  }
  if (Object.keys(cfgUpdates).length > 0) out = updateSiteConfigInCode(out, cfgUpdates);
  if (code.includes('CursorPortal') && !out.includes('CursorPortal')) {
    out = out.replace("import { Providers } from './providers';", "import { Providers } from './providers';\nimport { CursorPortal } from '@revyme/runtime';");
    out = out.replace('<Providers>{children}</Providers>', '<Providers>{children}</Providers>\n        <CursorPortal />');
  }
  return moduleParses(out) ? out : ensureLayoutFile();
}

// ─── Custom-code native render ──────────────────────────────────────────────

const CUSTOM_HEAD_RENDER = `        {siteConfig.customHead ? (
          <div data-custom-code="head" style={{ display: 'contents' }} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: siteConfig.customHead }} />
        ) : null}`;
const CUSTOM_BODY_RENDER = `        {siteConfig.customBody ? (
          <div data-custom-code="body" style={{ display: 'contents' }} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: siteConfig.customBody }} />
        ) : null}`;

/**
 * Ensure the layout RENDERS siteConfig.customHead/customBody natively — the
 * snippets ship in the server layout's SSR output verbatim, so the published
 * site needs NO publish-time injection at all (source = deploy reality).
 * Server-rendered <script> tags inside the initial document execute
 * normally; `display: 'contents'` keeps the carrier divs out of layout.
 * Idempotent (keyed on the data-custom-code markers); a layout without a
 * recognizable <body> is left untouched; output is parse-gated.
 */
export function ensureCustomCodeRenderInCode(code: string): string {
  if (!extractExportObject(code, 'siteConfig')) return code;
  let out = code;
  if (!out.includes('data-custom-code="head"')) {
    const bodyOpen = out.search(/<body[^>]*>/);
    if (bodyOpen === -1) return code;
    const insertAt = out.indexOf('>', bodyOpen) + 1;
    out = out.slice(0, insertAt) + '\n' + CUSTOM_HEAD_RENDER + out.slice(insertAt);
  }
  if (!out.includes('data-custom-code="body"')) {
    const bodyClose = out.lastIndexOf('</body>');
    if (bodyClose === -1) return code;
    out = out.slice(0, bodyClose) + CUSTOM_BODY_RENDER + '\n      ' + out.slice(bodyClose);
  }
  if (out !== code && !moduleParses(out)) {
    trace.error('metadata-gen:ensure-custom-code-render-parse-gate', {});
    return code;
  }
  return out;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function deepMerge(target: Record<string, any>, source: Record<string, any>): Record<string, any> {
  const result = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && typeof result[key] === 'object' && !Array.isArray(result[key])) {
      result[key] = deepMerge(result[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function cleanEmpty(obj: Record<string, any>): void {
  for (const key of Object.keys(obj)) {
    if (obj[key] === '') {
      delete obj[key];
    } else if (typeof obj[key] === 'object' && obj[key] !== null && !Array.isArray(obj[key])) {
      cleanEmpty(obj[key]);
      if (Object.keys(obj[key]).length === 0) delete obj[key];
    }
  }
}
