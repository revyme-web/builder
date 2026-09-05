// translations-reinject.ts — Re-seed translations on pasted copies.
//
// Copy bakes the DEFAULT locale into textContent (right call for pasting into
// a project with no messages files — the 2026-07-23 "all texts missing"
// find), but it used to STOP there: a same-page Cmd+D of a translated node
// produced a copy with no `t()` call at all, so every non-default locale
// silently showed the baked default ("bonjour" next to a duplicate stuck on
// "hello", live find 2026-09-05).
//
// The clipboard now carries every OTHER locale's string; this pass runs after
// the paste lands and, for each locale the DESTINATION project has
// configured, routes through the same `commitTranslationText`/`Attr` pipeline
// the Localization view uses — which converts the child to `{t('<newId>')}`
// on the first non-default write and seeds the default from the baked text.
// Locales the destination doesn't know are skipped: pasting into a
// non-localized project keeps the plain-text fallback unchanged.
//
// SEQUENCING: everything here writes via translation-ops' modifyProjectFile,
// which flushes the pending addNode mutations first — the pasted node is
// guaranteed to be IN the file before the transform looks for it (same
// contract rehydratePastedCmsBindings relies on).

import { trace } from '@/shared/debug-trace';
import { getI18nConfig } from '@/code/project/locale-ops';
import { commitTranslationText, commitTranslationAttr } from '@/code/project/translation-ops';
import type { ClipboardNode } from '../types';
import type { IdMapper } from '../core/id-mapper';

export function reinjectTranslations(
  clipboardNodes: ClipboardNode[],
  idMapper: IdMapper,
  destFilePath: string,
): void {
  const config = getI18nConfig();
  const known = new Set(config.locales.map((l) => l.code));
  let seeded = 0;

  // The clipboard list is FLAT — descendants are their own entries,
  // individually id-mapped (same contract motion-reinject relies on).
  for (const cn of clipboardNodes) {
    if (cn.translations || cn.attrTranslations) {
      const newIds = idMapper.getNewIdsForClipboard(cn.id);
      for (const newId of newIds) {
        for (const [locale, text] of Object.entries(cn.translations ?? {})) {
          if (!known.has(locale) || locale === config.defaultLocale) continue;
          try {
            commitTranslationText({
              filePath: destFilePath, nodeId: newId, locale,
              defaultLocale: config.defaultLocale, text,
              fallbackDefaultText: cn.textContent,
            });
            seeded++;
          } catch (err) {
            trace.error('paste:translation-reinject-failed', { newId, locale, error: err instanceof Error ? err.message : String(err) });
          }
        }
        for (const [attr, byLocale] of Object.entries(cn.attrTranslations ?? {})) {
          for (const [locale, text] of Object.entries(byLocale)) {
            if (!known.has(locale) || locale === config.defaultLocale) continue;
            try {
              commitTranslationAttr({
                filePath: destFilePath, nodeId: newId, attr, locale,
                defaultLocale: config.defaultLocale, text, transformed: false,
                fallbackDefaultValue: cn.attrs?.[attr],
              });
              seeded++;
            } catch (err) {
              trace.error('paste:translation-attr-reinject-failed', { newId, attr, locale, error: err instanceof Error ? err.message : String(err) });
            }
          }
        }
      }
    }
  }
  if (seeded > 0) trace.action('paste:translations-reinjected', { seeded });
}
