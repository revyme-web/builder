// plugins/sdk-impl/localization.ts — localization.* namespace.
//
// Reads Revyme's `locale-ops` module which manages the project's
// I18n config (locales + per-locale-override JSON files). Wires:
//
//   - getLocales        → reads I18nConfig.locales
//   - getActiveLocale   → reads activeLocaleAtom
//   - getDefaultLocale  → reads I18nConfig.defaultLocale
//   - getLocalizationGroups → walks page files + extracts text
//                              localizable strings (best-effort)
//   - setLocalizationData   → writes per-locale overrides
//
// Localization is deeper than the public SDK exposes — Revyme
// has overrides per-page-per-node, plus collection-item overrides.
// We map onto the simpler "groups + sources + values" SDK shape:
//   - One LocalizationGroup per page file
//   - Sources are the text nodes within
//   - Values come from the per-locale override JSON

import { getDefaultStore } from 'jotai';
import {
  getI18nConfig,
  getLocaleOverrides,
  setNodeOverride,
} from '@/code/project/locale-ops';
import { activeLocaleAtom } from '@/code/stores/locale-store';
import type {
  Locale,
  LocalizationGroup,
  LocalizationSource,
  LocalizationValue,
} from '@revyme/plugin-sdk';
import type { RpcHandler } from '../plugin-types';

const store = getDefaultStore();

interface I18nLocale {
  code: string;
  label: string;
  fallback?: string;
}

function localeOpsToPublic(l: I18nLocale): Locale {
  return {
    id: l.code,
    code: l.code,
    name: l.label,
    slug: l.code,
    fallbackLocaleId: l.fallback ?? null,
  };
}

export const localizationHandlers: Record<string, RpcHandler> = {
  'localization.getLocales': async (): Promise<Locale[]> => {
    const cfg = getI18nConfig() as { locales?: I18nLocale[] };
    return (cfg.locales ?? []).map(localeOpsToPublic);
  },

  'localization.getActiveLocale': async (): Promise<Locale | null> => {
    const code = store.get(activeLocaleAtom);
    if (!code) return null;
    const cfg = getI18nConfig() as { locales?: I18nLocale[] };
    const found = (cfg.locales ?? []).find((l) => l.code === code);
    return found ? localeOpsToPublic(found) : null;
  },

  'localization.getDefaultLocale': async (): Promise<Locale | null> => {
    const cfg = getI18nConfig() as { locales?: I18nLocale[]; defaultLocale?: string };
    const code = cfg.defaultLocale;
    if (!code) return null;
    const found = (cfg.locales ?? []).find((l) => l.code === code);
    return found ? localeOpsToPublic(found) : null;
  },

  'localization.getLocalizationGroups': async (): Promise<LocalizationGroup[]> => {
    // Best-effort: produce one group per locale showing what overrides
    // exist. Real per-page enumeration would scan every page's nodes,
    // which requires parsing every file — too expensive for a sync call.
    // Plugins that need richer enumeration can list pages + use
    // `text.getText` / per-locale override APIs directly.
    const cfg = getI18nConfig() as { locales?: I18nLocale[] };
    const groups: LocalizationGroup[] = [];
    for (const loc of cfg.locales ?? []) {
      const overrides = getLocaleOverrides(loc.code) as unknown as Record<string, Record<string, unknown>>;
      const sources: LocalizationSource[] = [];
      let i = 0;
      for (const [pagePath, byNode] of Object.entries(overrides)) {
        for (const [nodeId, override] of Object.entries(byNode)) {
          const ov = override as { text?: string };
          if (typeof ov?.text !== 'string') continue;
          const valueByLocale: Record<string, LocalizationValue> = {
            [loc.code]: {
              value: ov.text,
              status: 'published',
              readonly: false,
              lastEdited: 0,
            },
          };
          sources.push({
            id: `${pagePath}#${nodeId}`,
            name: `${pagePath} > ${nodeId}`,
            type: 'string',
            value: ov.text,
            valueByLocale,
          });
          i++;
        }
      }
      groups.push({
        id: loc.code,
        name: loc.label,
        type: 'page',
        sources,
        statusByLocale: { [loc.code]: i > 0 ? 'complete' : 'incomplete' },
        supportsExcludedStatus: false,
      });
    }
    return groups;
  },

  'localization.setLocalizationData': async (params): Promise<void> => {
    const p = params as { updates?: unknown };
    if (!Array.isArray(p?.updates)) throw new Error('localization.setLocalizationData: updates[] required');
    for (const u of p.updates) {
      if (!u || typeof u !== 'object') continue;
      const upd = u as { sourceId: string; localeId: string; value: string };
      // sourceId format: `<pagePath>#<nodeId>` (matches what
      // getLocalizationGroups emits).
      const sep = upd.sourceId.lastIndexOf('#');
      if (sep < 0) continue;
      const pagePath = upd.sourceId.slice(0, sep);
      const nodeId = upd.sourceId.slice(sep + 1);
      setNodeOverride(upd.localeId, pagePath, nodeId, { text: upd.value });
    }
  },
};
