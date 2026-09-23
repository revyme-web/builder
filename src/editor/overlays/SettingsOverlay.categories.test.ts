// The settings sidebar's groups: Website first in General, the registered
// categories in order, AI last, and A/B test pages kept beside Insights.
import { describe, it, expect } from 'vitest';
import { buildMenuCategories } from './SettingsOverlay';
import type { SettingsSectionDef } from '@/plugins/plugin-registry';

const Icon = () => null;
const sec = (id: string, category: string): SettingsSectionDef => ({ id, label: id, icon: Icon, category, component: Icon as never });
const registered = [
  { title: 'General', items: [sec('pages', 'General'), sec('domain', 'General')] },
  { title: 'Insights', items: [sec('analytics', 'Insights'), sec('ab-tests', 'Insights')] },
  { title: 'AI', items: [sec('connect-ai', 'AI'), sec('skills', 'AI')] },
];

describe('settings sidebar categories', () => {
  it('General (Website first), Insights, then AI with Connect AI and Skills', () => {
    const cats = buildMenuCategories(registered, []);
    expect(cats.map((c) => c.title)).toEqual(['General', 'Insights', 'AI']);
    expect(cats[0].items[0].id).toBe('website');
    expect(cats[2].items.map((i) => i.id)).toEqual(['connect-ai', 'skills']);
  });

  it('A/B test pages sit right after Insights, AI stays last', () => {
    const cats = buildMenuCategories(registered, ['page', 'about']);
    expect(cats.map((c) => c.title)).toEqual(['General', 'Insights', 'A/B Tests', 'AI']);
  });
});
