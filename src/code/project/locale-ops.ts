// locale-ops.ts — CRUD operations for i18n locale files in ProjectFS.
// Pure functions for reading/writing i18n config + locale override files.

import { projectFS } from './project-fs';
import { pushHistory } from '@/code/mutation/history';
import { trace } from '@/shared/debug-trace';
import { buildProvidersSource, looksGeneratedProviders } from './providers-gen';
import { syncLocaleRoutes } from './locale-route-ops';
import type { I18nConfig, LocaleOverrides, NodeOverride } from '@/shared/types';

/** Locale-set change fan-out: providers.tsx imports one dictionary per
 *  configured locale and the /xx/ route wrappers mirror pages × locales —
 *  both are GENERATED files that must follow every config change. */
function syncLocaleArtifacts(config: I18nConfig): void {
  const current = projectFS.readFile('app/providers.tsx');
  const expected = buildProvidersSource(config);
  if (current == null || (current !== expected && looksGeneratedProviders(current))) {
    projectFS.writeFile('app/providers.tsx', expected);
    trace.action('locale-ops:providers-regenerated', { locales: config.locales.map(l => l.code) });
  }
  // Every configured locale needs its messages file (providers imports them).
  for (const l of config.locales) {
    if (!projectFS.readFile(`messages/${l.code}.json`)) projectFS.writeFile(`messages/${l.code}.json`, '{}');
  }
  syncLocaleRoutes(config);
}

// ─── Config Operations ──────────────────────────────────────────────────────

const DEFAULT_CONFIG: I18nConfig = {
  defaultLocale: 'en',
  locales: [{ code: 'en', label: 'English' }],
};

/** Read the i18n config. Returns a sensible default if no file exists. */
export function getI18nConfig(): I18nConfig {
  const raw = projectFS.readFile('i18n/config.json');
  if (!raw) {
    trace.fn('locale-ops:getI18nConfig', { found: false });
    return { ...DEFAULT_CONFIG, locales: [...DEFAULT_CONFIG.locales] };
  }
  try {
    const config = JSON.parse(raw) as I18nConfig;
    trace.fn('locale-ops:getI18nConfig', { found: true, localeCount: config.locales.length });
    return config;
  } catch (err) {
    trace.error('locale-ops:getI18nConfig:parse-error', err);
    return { ...DEFAULT_CONFIG, locales: [...DEFAULT_CONFIG.locales] };
  }
}

/** Save the i18n config to ProjectFS. */
export function saveI18nConfig(config: I18nConfig): void {
  projectFS.writeFile('i18n/config.json', JSON.stringify(config, null, 2));
  trace.action('locale-ops:saveI18nConfig', { localeCount: config.locales.length, defaultLocale: config.defaultLocale });
}

/** Add a new locale. Skips if code already exists. Creates empty overrides file. */
export function addLocale(code: string, label: string, direction?: 'ltr' | 'rtl', fallback?: string): void {
  const config = getI18nConfig();
  if (config.locales.some(l => l.code === code)) {
    trace.fn('locale-ops:addLocale:skip-duplicate', { code });
    return;
  }
  const entry: { code: string; label: string; direction?: 'ltr' | 'rtl'; fallback?: string } = { code, label };
  if (direction) entry.direction = direction;
  if (fallback) entry.fallback = fallback;
  config.locales.push(entry);
  saveI18nConfig(config);
  // Create empty overrides file
  const emptyOverrides: LocaleOverrides = { pages: {}, collections: {} };
  projectFS.writeFile(`i18n/${code}.json`, JSON.stringify(emptyOverrides, null, 2));
  syncLocaleArtifacts(config);
  trace.action('locale-ops:addLocale', { code, label, direction, fallback });
}

/** Remove a locale from config and delete its overrides file. */
export function removeLocale(code: string): void {
  const config = getI18nConfig();
  config.locales = config.locales.filter(l => l.code !== code);
  saveI18nConfig(config);
  if (projectFS.exists(`i18n/${code}.json`)) {
    projectFS.deleteFile(`i18n/${code}.json`);
  }
  syncLocaleArtifacts(config);
  trace.action('locale-ops:removeLocale', { code });
}

// ─── Override Operations ─────────────────────────────────────────────────────

const EMPTY_OVERRIDES: LocaleOverrides = { pages: {}, collections: {} };

/** Read all overrides for a locale. Returns empty structure if no file. */
export function getLocaleOverrides(localeCode: string): LocaleOverrides {
  const raw = projectFS.readFile(`i18n/${localeCode}.json`);
  if (!raw) {
    trace.fn('locale-ops:getLocaleOverrides', { localeCode, found: false });
    return { pages: {}, collections: {} };
  }
  try {
    const overrides = JSON.parse(raw) as LocaleOverrides;
    trace.fn('locale-ops:getLocaleOverrides', {
      localeCode,
      found: true,
      pageCount: Object.keys(overrides.pages ?? {}).length,
      collectionCount: Object.keys(overrides.collections ?? {}).length,
    });
    return overrides;
  } catch (err) {
    trace.error('locale-ops:getLocaleOverrides:parse-error', err);
    return { pages: {}, collections: {} };
  }
}

/** Get page-specific overrides for a given locale and file path. */
export function getPageOverrides(localeCode: string, filePath: string): Record<string, NodeOverride> {
  const all = getLocaleOverrides(localeCode);
  const result = all.pages?.[filePath] ?? {};
  trace.fn('locale-ops:getPageOverrides', { localeCode, filePath, nodeCount: Object.keys(result).length });
  return result;
}

/**
 * Set override for a specific node on a specific page + locale.
 * Merges styles and props deeply. Cleans up empty overrides.
 */
export function setNodeOverride(
  localeCode: string,
  filePath: string,
  nodeId: string,
  override: Partial<NodeOverride>,
): void {
  trace.fn('locale-ops:setNodeOverride', { localeCode, filePath, nodeId, override });

  const all = getLocaleOverrides(localeCode);
  if (!all.pages) all.pages = {};
  if (!all.pages[filePath]) all.pages[filePath] = {};

  const existing = all.pages[filePath][nodeId] || {};
  const merged: NodeOverride = {
    ...existing,
    ...override,
    // Merge styles deeply
    styles: { ...(existing.styles || {}), ...(override.styles || {}) },
    // Merge props deeply
    props: { ...(existing.props || {}), ...(override.props || {}) },
    // Merge per-viewport text overrides shallowly so writing only the tablet
    // bucket doesn't wipe a previously-saved mobile bucket. Empty-string
    // entries are treated as deletions — same convention as styles.
    textOverrides: (() => {
      const base = { ...(existing.textOverrides || {}), ...(override.textOverrides || {}) };
      for (const k of Object.keys(base)) if (base[k] === '') delete base[k];
      return base;
    })(),
  };

  // If override explicitly sets text/visible, use it; otherwise keep existing
  if (override.text !== undefined) merged.text = override.text;
  if (override.visible !== undefined) merged.visible = override.visible;

  // Drop the textOverrides field entirely when it's empty so the JSON stays
  // tidy and `isEmptyOverride` doesn't see a non-meaningful object.
  if (merged.textOverrides && Object.keys(merged.textOverrides).length === 0) {
    delete merged.textOverrides;
  }

  all.pages[filePath][nodeId] = merged;

  // Clean up: remove node override if it has no meaningful data
  if (isEmptyOverride(merged)) {
    delete all.pages[filePath][nodeId];
  }

  // Clean up: remove page entry if no node overrides remain
  if (Object.keys(all.pages[filePath]).length === 0) {
    delete all.pages[filePath];
  }

  projectFS.writeFile(`i18n/${localeCode}.json`, JSON.stringify(all, null, 2));
  // Undoable — nothing subscribes ProjectFS to history, and these writes never
  // reach the mutation queue. See the contract note on `commitTranslationText`.
  pushHistory('');
  trace.action('locale-ops:setNodeOverride:saved', { localeCode, filePath, nodeId });
}

/** Set collection item override for a specific locale. Merges fields deeply. */
export function setCollectionItemOverride(
  localeCode: string,
  collectionSlug: string,
  itemId: string,
  fieldOverrides: Record<string, any>,
): void {
  trace.fn('locale-ops:setCollectionItemOverride', { localeCode, collectionSlug, itemId, fieldOverrides });

  const all = getLocaleOverrides(localeCode);
  if (!all.collections) all.collections = {};
  if (!all.collections[collectionSlug]) all.collections[collectionSlug] = {};

  all.collections[collectionSlug][itemId] = {
    ...(all.collections[collectionSlug][itemId] || {}),
    ...fieldOverrides,
  };

  projectFS.writeFile(`i18n/${localeCode}.json`, JSON.stringify(all, null, 2));
  pushHistory('');
  trace.action('locale-ops:setCollectionItemOverride:saved', { localeCode, collectionSlug, itemId });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Check if a NodeOverride is effectively empty (no meaningful data). */
function isEmptyOverride(node: NodeOverride): boolean {
  const hasText = node.text !== undefined && node.text !== '';
  const hasTextOverrides = node.textOverrides && Object.keys(node.textOverrides).length > 0;
  const hasVisible = node.visible !== undefined;
  const hasStyles = node.styles && Object.keys(node.styles).length > 0;
  const hasProps = node.props && Object.keys(node.props).length > 0;
  return !hasText && !hasTextOverrides && !hasVisible && !hasStyles && !hasProps;
}
