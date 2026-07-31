// plugin-registry.ts — Central registration API for extensible features.
// Core components read from here instead of hardcoding sections.
// Cloud/SaaS features register themselves at boot via cloud-plugin.ts.

import type { FC } from 'react';
import { trace } from '@/shared/debug-trace';

// ─── Settings Section Registry ──────────────────────────────────────────────

export interface SettingsSectionDef {
  /** Unique section id (used as activeSection value) */
  id: string;
  /** Display label in sidebar */
  label: string;
  /** Icon component — receives className prop */
  icon: FC<{ className?: string; size?: number }>;
  /** Category group in sidebar (e.g. 'General', 'Insights', 'CREATORS') */
  category: string;
  /** The section content component — receives { websiteId } */
  component: FC<{ websiteId: string }>;
  /** Sort order within category (lower = higher). Default 0 */
  order?: number;
}

const _settingsSections: SettingsSectionDef[] = [];

export function registerSettingsSection(section: SettingsSectionDef): void {
  // Prevent duplicate registrations
  if (_settingsSections.some(s => s.id === section.id)) return;
  _settingsSections.push(section);
  trace.action('plugin-registry:register-settings-section', { id: section.id, category: section.category });
}

/**
 * Get sections grouped by category, in registration order.
 * Returns array of { title, items } matching the SettingsOverlay sidebar shape.
 */
export function getSettingsCategories(): Array<{ title: string; items: SettingsSectionDef[] }> {
  const categoryMap = new Map<string, SettingsSectionDef[]>();

  for (const section of _settingsSections) {
    if (!categoryMap.has(section.category)) {
      categoryMap.set(section.category, []);
    }
    categoryMap.get(section.category)!.push(section);
  }

  // Sort items within each category by order
  const result: Array<{ title: string; items: SettingsSectionDef[] }> = [];
  for (const [title, items] of categoryMap) {
    items.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    result.push({ title, items });
  }

  return result;
}
