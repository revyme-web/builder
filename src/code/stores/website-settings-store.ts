// website-settings-store.ts — Website-level settings atom.
// Mirrors the old builder's websiteSettingsAtom shape.
// Source of truth for the SettingsOverlay UI state.
// Actual persistence: metadata lives in app/layout.tsx (code-first).

import { atom } from 'jotai';
import { projectFS } from '@/code/project/project-fs';
import { parseMetadataFromCode, parseSiteConfigFromCode } from '@/code/generation/metadata-gen';
import { trace } from '@/shared/debug-trace';
import type { WebsiteMeta } from '@/backend/types';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface WebsiteSettings {
  name: string;
  description: string;
  languageCode: string;
  faviconLight: string;
  socialShareImage: string;
  customCodeHead: string;
  customCodeBody: string;
  defaultTheme: 'light' | 'dark' | 'system';
}

const DEFAULT_WEBSITE_SETTINGS: WebsiteSettings = {
  name: '',
  description: '',
  languageCode: 'en',
  faviconLight: '',
  socialShareImage: '',
  customCodeHead: '',
  customCodeBody: '',
  defaultTheme: 'light',
};

// ─── Atoms ──────────────────────────────────────────────────────────────────

export const websiteSettingsAtom = atom<WebsiteSettings>(DEFAULT_WEBSITE_SETTINGS);

/** Atom controlling SettingsOverlay open/close state */
export const settingsOverlayOpenAtom = atom(false);

/** Active section within the overlay — string so plugin-registered sections work */
export type SettingsSection = string;
export const settingsSectionAtom = atom<SettingsSection>('website');

/** Page filter for the A/B Tests section. `null` = show every test; otherwise
 *  filter the list down to a single page_path (standard page drill-in
 *  from the sidebar). Set by clicking a child entry under "A/B Tests" in
 *  the settings sidebar; consumed by AbTestsSection to filter its list. */
export const selectedAbTestPageAtom = atom<string | null>(null);

/** Which page is being edited in the Pages SEO section. Holds the page's
 *  ProjectFS file path (e.g. `app/page.tsx`, `app/about/page.tsx`).
 *  `null` = no selection (PagesSeoSection auto-picks the first page). */
export const selectedSeoPageAtom = atom<string | null>(null);

// ─── Website meta (publish + subscription state) ────────────────────────────
// Populated by RightHeader's `GET /api/websites/:id` fetch. Shared so other
// chrome (e.g. the bottom toolbar's Upgrade button) can react to the site's
// plan without re-fetching. `null` until the first fetch resolves, or always
// `null` when cloud is disabled.
export const websiteMetaAtom = atom<WebsiteMeta | null>(null);

/** True when the site is on a paid plan that is currently active. A paid
 *  plan whose Stripe status isn't 'active' (past_due / canceled) reverts to
 *  free-tier gating, so it does NOT count as an active subscription. Used to
 *  hide the bottom-toolbar Upgrade button for already-subscribed sites. */
export const hasActiveSubscriptionAtom = atom((get) => {
  const meta = get(websiteMetaAtom);
  if (!meta) return false;
  const plan = (meta.plan ?? 'free').toLowerCase();
  return plan !== 'free' && meta.planStatus === 'active';
});

// ─── Load from code ─────────────────────────────────────────────────────────

/**
 * Read layout.tsx and return WebsiteSettings.
 * Call on project load (after ProjectFS is initialized).
 */
export function loadSettingsFromLayout(): WebsiteSettings {
  trace.fn('website-settings:loadFromLayout');
  const code = projectFS.readFile('app/layout.tsx');
  if (!code) return DEFAULT_WEBSITE_SETTINGS;

  const meta = parseMetadataFromCode(code);
  const config = parseSiteConfigFromCode(code);

  return {
    name: (meta.title as string) || '',
    description: (meta.description as string) || '',
    languageCode: config.language || 'en',
    faviconLight: (meta.icons as any)?.icon || '',
    socialShareImage: ((meta.openGraph as any)?.images?.[0]) || '',
    customCodeHead: config.customHead || '',
    customCodeBody: config.customBody || '',
    defaultTheme: (config.theme as 'light' | 'dark' | 'system') || 'light',
  };
}
