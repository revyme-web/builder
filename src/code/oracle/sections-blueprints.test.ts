// sections-blueprints.test.ts — CI gate for the Sections library.
//
// Every blueprint must be a clean page-dialect citizen: it wraps into the
// standard page scaffold, parses with the real parser, and produces ZERO
// oracle violations. A blueprint that fails here would insert content the
// panels can't edit — the exact drift the oracle exists to prevent, so the
// library holds itself to the same bar as AI-written files.

import { describe, it, expect } from 'vitest';
import { checkFile } from './check-file';
import { parseJSXToNodes } from '@/code/parsing/parser';
import { SECTION_BLUEPRINTS, wrapBlueprintInPage } from '@/shared/sections-library';

describe('sections library blueprints', () => {
  it('has the launch set: 2 headers + 2 heroes with unique ids', () => {
    const ids = SECTION_BLUEPRINTS.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(SECTION_BLUEPRINTS.filter((b) => b.category === 'header').length).toBeGreaterThanOrEqual(2);
    expect(SECTION_BLUEPRINTS.filter((b) => b.category === 'hero').length).toBeGreaterThanOrEqual(2);
  });

  for (const blueprint of SECTION_BLUEPRINTS) {
    describe(blueprint.id, () => {
      const page = wrapBlueprintInPage(blueprint.source);

      it('passes the oracle with zero violations', () => {
        const violations = checkFile(page, { kind: 'page' });
        expect(violations.map((v) => `${v.code}: ${v.message}`)).toEqual([]);
      });

      it('parses to a single section root with unique data-ids', () => {
        const nodes = parseJSXToNodes(page);
        const root = nodes.get('root');
        expect(root).toBeTruthy();
        expect(root!.children).toHaveLength(1);

        const sectionRootId = root!.children[0];
        expect(sectionRootId.startsWith('section-')).toBe(true);

        // Every node reachable from the section root exists exactly once and
        // every child reference resolves — the flat clipboard conversion in
        // section-insert relies on this.
        const seen = new Set<string>();
        const walk = (id: string) => {
          expect(seen.has(id)).toBe(false);
          seen.add(id);
          const node = nodes.get(id);
          expect(node, `missing node ${id}`).toBeTruthy();
          for (const childId of node!.children) walk(childId);
        };
        walk(sectionRootId);
        expect(seen.size).toBeGreaterThan(3);
      });

      it('declares only loadable font families', () => {
        for (const family of blueprint.fonts) {
          expect(family).not.toMatch(/,/);
          expect(family.trim().length).toBeGreaterThan(0);
        }
      });
    });
  }
});
