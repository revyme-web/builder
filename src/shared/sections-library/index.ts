// Sections library — registry of source-level section blueprints for the
// Insert panel. See types.ts for the model and src/canvas/section-insert.ts
// for the insert path. Every blueprint is oracle-validated in CI
// (src/code/oracle/sections-blueprints.test.ts).

import type { SectionBlueprint } from './types';
import { headerEditorial } from './blueprints/header-editorial';
import { headerGlass } from './blueprints/header-glass';
import { heroEditorial } from './blueprints/hero-editorial';
import { heroTypewall } from './blueprints/hero-typewall';

export type { SectionBlueprint, SectionCategory } from './types';

export const SECTION_BLUEPRINTS: SectionBlueprint[] = [
  headerEditorial,
  headerGlass,
  heroEditorial,
  heroTypewall,
];

const BY_ID = new Map(SECTION_BLUEPRINTS.map((b) => [b.id, b]));

export function getSectionBlueprint(id: string): SectionBlueprint | null {
  return BY_ID.get(id) ?? null;
}

/** Insert-panel item ids are prefixed so they can't collide with toolbar
 *  element ids. `sectionItemId('hero-typewall')` → `'section-bp-hero-typewall'`. */
export const SECTION_ITEM_PREFIX = 'section-bp-';
export function sectionItemId(blueprintId: string): string {
  return SECTION_ITEM_PREFIX + blueprintId;
}
export function blueprintIdFromItemId(itemId: string): string | null {
  return itemId.startsWith(SECTION_ITEM_PREFIX)
    ? itemId.slice(SECTION_ITEM_PREFIX.length)
    : null;
}

/**
 * Wrap a blueprint fragment in the minimal page scaffold the parser and the
 * oracle expect — same shape the MCP builder emits for a fresh page. The
 * fragment becomes the root's only section child.
 */
export function wrapBlueprintInPage(source: string): string {
  return `'use client';

/** @canvas {
  "viewports": [
    { "id": "desktop", "label": "Desktop", "width": 1440, "height": "auto", "isPrimary": true, "order": 0 }
  ],
  "positions": {
    "desktop": { "x": 0, "y": 0 }
  }
} */

import React from 'react';

export default function Page() {
  return (
<div data-id="root" data-name="Page" style={{
  position: 'relative', width: '100%', height: 'auto', minHeight: '100px',
  backgroundColor: '#ffffff',
  display: 'flex', flexDirection: 'column', justifyContent: 'flex-start'
}}>
${source}
</div>
  );
}
`;
}
