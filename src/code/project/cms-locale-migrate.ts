// cms-locale-migrate.ts — one-time upgrade of a project's CMS localization.
//
// Kept OUT of `translation-ops.ts` on purpose. That module is pulled into the
// canvas sandbox bundle, where `cms-ops` resolves to a thin stub
// (`canvas-sandbox/stubs/cms-ops.ts`) holding only what the Renderer needs.
// Importing the CMS translation read/write from there broke the iframe with
// "does not provide an export named 'getCollectionItemTranslation'" and the
// viewports stopped loading entirely. This migration is a parent-only,
// load-time concern, so it lives in its own module and the sandbox never sees
// it.

import { projectFS } from './project-fs';
import { getCollectionItemTranslation, setCollectionItemTranslation } from './cms-ops';
import { localizeCollectionListsInCode } from '@/code/generation/cms-locale-gen';
import { trace } from '@/shared/debug-trace';
import type { I18nConfig } from '@/shared/types';

/**
 * ON LOAD: upgrade existing collection lists so they resolve their own locale,
 * and move CMS translations out of the retired store onto the rows.
 *
 * Two halves of the same migration:
 *   1. `i18n/{locale}.json` → `collections[slug][itemId][field]` moves to the
 *      item's own `_i18n`. That legacy store was canvas-only and unreachable
 *      from the published site — a user could translate a collection, watch it
 *      save, and see English everywhere (user report 2026-08-10). Mirrors what
 *      `migrateLegacyLocaleTextOverrides` already did for page text.
 *   2. Every unlocalized `<slug>.map(…)` gets wrapped in `localizeRows(...)`,
 *      so lists built before this shipped start translating.
 *
 * Both idempotent, and both skipped entirely on a single-locale project —
 * nothing to resolve, and an untouched project must not come back modified.
 */
export function migrateCmsLocalization(config: I18nConfig): void {
  if ((config.locales?.length ?? 0) < 2) return;

  // ── 1. Legacy store → `_i18n` on the row ────────────────────────────────
  for (const { code: locale } of config.locales) {
    const legacyPath = `i18n/${locale}.json`;
    const raw = projectFS.readFile(legacyPath);
    if (!raw) continue;
    let parsed: { pages?: unknown; collections?: Record<string, Record<string, Record<string, unknown>>> };
    try { parsed = JSON.parse(raw); } catch { continue; }
    const collections = parsed.collections;
    if (!collections || Object.keys(collections).length === 0) continue;

    let movedAny = false;
    for (const [slug, items] of Object.entries(collections)) {
      for (const [itemId, fields] of Object.entries(items)) {
        for (const [field, value] of Object.entries(fields)) {
          if (typeof value !== 'string' || !value) continue;
          // Never clobber a translation already on the row — the row is the
          // live store now, so it wins over the retired copy.
          if (getCollectionItemTranslation(slug, itemId, locale, field)) continue;
          setCollectionItemTranslation(slug, itemId, locale, field, value);
          movedAny = true;
        }
      }
    }
    if (movedAny) {
      projectFS.writeFile(legacyPath, JSON.stringify({ ...parsed, collections: {} }, null, 2));
      trace.action('translation-ops:cms-migrated', { locale });
    }
  }

  // ── 2. Wrap unlocalized collection sources ──────────────────────────────
  for (const filePath of [...projectFS.listFiles('app/'), ...projectFS.listFiles('components/')]) {
    if (!filePath.endsWith('.tsx')) continue;
    const code = projectFS.readFile(filePath);
    if (!code) continue;
    const next = localizeCollectionListsInCode(code);
    if (next !== code) {
      projectFS.writeFile(filePath, next);
      trace.action('translation-ops:cms-list-localized', { filePath });
    }
  }
}
