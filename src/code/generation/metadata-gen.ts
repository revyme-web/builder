// metadata-gen.ts — Parse and generate Next.js-style metadata exports in layout.tsx.
// Code-first: SEO metadata lives as `export const metadata = { ... }` in app/layout.tsx.
// The SettingsOverlay reads/writes through these functions.

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

export const siteConfig = {
  language: 'en',
  theme: 'light',
  customHead: '',
  customBody: '',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <Providers>{children}</Providers>
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

/**
 * Parse `export const metadata = { ... }` from code string.
 * Uses regex + JSON-ish extraction for speed.
 *
 * Accepts BOTH the compact `{};` form (what fresh page wrappers ship
 * with) and the multi-line form (what the writer emits after the user
 * fills any field). The lazy `[\s\S]*?` stops at the first `}` that's
 * followed by a `;`, which is unambiguous for our generator's output —
 * we never emit functions inside metadata so an internal `};` can't
 * collide.
 */
export function parseMetadataFromCode(code: string): SiteMetadata {
  trace.fn('metadata-gen:parse');
  const match = code.match(/export\s+const\s+metadata\s*=\s*(\{[\s\S]*?\})\s*;/);
  if (!match) return {};

  try {
    let objStr = match[1];
    // Replace single-quoted strings with double-quoted
    objStr = objStr.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, '"$1"');
    // Quote unquoted property keys: `  key:` → `  "key":`
    objStr = objStr.replace(/(\s)(\w+)\s*:/g, '$1"$2":');
    // Remove trailing commas before } or ]
    objStr = objStr.replace(/,\s*([\]}])/g, '$1');
    return JSON.parse(objStr);
  } catch {
    trace.error('metadata-gen:parse-failed', { raw: match[1] });
    return {};
  }
}

/**
 * Parse `export const siteConfig = { ... }` from code string.
 */
export function parseSiteConfigFromCode(code: string): Record<string, string> {
  trace.fn('metadata-gen:parseSiteConfig');
  // Same loosened regex as `parseMetadataFromCode` — accepts both
  // `{};` (compact) and the multi-line form.
  const match = code.match(/export\s+const\s+siteConfig\s*=\s*(\{[\s\S]*?\})\s*;/);
  if (!match) return {};

  try {
    let objStr = match[1];
    objStr = objStr.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, '"$1"');
    objStr = objStr.replace(/(\s)(\w+)\s*:/g, '$1"$2":');
    objStr = objStr.replace(/,\s*([\]}])/g, '$1');
    return JSON.parse(objStr);
  } catch {
    return {};
  }
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
      lines.push(`${indent}${key}: '${value.replace(/'/g, "\\'")}'`);
    } else if (Array.isArray(value)) {
      const items = value.map(v => typeof v === 'string' ? `'${v.replace(/'/g, "\\'")}'` : JSON.stringify(v));
      lines.push(`${indent}${key}: [${items.join(', ')}]`);
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

  // Replace existing metadata block or insert before first export default.
  // Loosened regex matches both `{};` (compact, what fresh page
  // wrappers ship with) and the multi-line form (what we emit after
  // the user fills a field). Without this loosening, the first save
  // on a fresh page would skip the placeholder block and INSERT a
  // second one above it — corrupting the file on the next re-read.
  const metaMatch = code.match(/export\s+const\s+metadata\s*=\s*\{[\s\S]*?\}\s*;/);
  if (metaMatch) {
    return code.replace(metaMatch[0], newBlock);
  }

  // No existing metadata — insert before first export default
  const defaultIdx = code.indexOf('export default');
  if (defaultIdx >= 0) {
    return code.slice(0, defaultIdx) + newBlock + '\n\n' + code.slice(defaultIdx);
  }

  return newBlock + '\n\n' + code;
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

  const lines = Object.entries(merged).map(([k, v]) => `  ${k}: '${String(v).replace(/'/g, "\\'")}'`);
  const newBlock = lines.length > 0
    ? `export const siteConfig = {\n${lines.join(',\n')},\n};`
    : `export const siteConfig = {};`;

  const configMatch = code.match(/export\s+const\s+siteConfig\s*=\s*\{[\s\S]*?\}\s*;/);
  if (configMatch) {
    return code.replace(configMatch[0], newBlock);
  }

  // Insert before export default
  const defaultIdx = code.indexOf('export default');
  if (defaultIdx >= 0) {
    return code.slice(0, defaultIdx) + newBlock + '\n\n' + code.slice(defaultIdx);
  }

  return newBlock + '\n\n' + code;
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
