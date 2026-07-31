// builder-conformance.test.ts — THE BUILDER MUST SATISFY ITS OWN ORACLE.
//
// The oracle gates AI submits; the builder writes freely. They drifted. A live
// page that had ONLY ever been edited in the builder failed the builder's own
// submit gate with 155 violations — `transparent` fills from the wrap commands,
// zero left/top on relative nodes, column flips with no flex re-base, `inset` +
// a missing data-id from the background-video feature, and 29 flex violations
// from the Insert catalogue's own children (user report 2026-07-26). Nothing was
// broken at runtime; what broke was AI-EDITABILITY — the submit gate judges the
// WHOLE file, so the more a user edited by hand, the less an AI could touch the
// page.
//
// Every one of those was found REACTIVELY: submit a page, read violations, trace
// the producer. That neither scales nor holds — the next feature that emits a
// new shape re-opens the gap silently until someone submits.
//
// This file states the invariant instead: run the builder's OWN output through
// `checkFile` and require it to be clean. It is a RATCHET, not a snapshot —
// `KNOWN_DIVERGENCES` lists what is still wrong, and the test fails BOTH when a
// new divergence appears AND when a listed one is fixed but left in the list. So
// the list can only shrink, and it can never silently grow.
//
// SCOPE: the pure, importable producers. Canvas-layer producers (creators, wrap
// commands) need a live bridge + DOM; the shared helpers they now call are
// covered by their own unit tests (`normalizeTransparent`, `healInertOffsets`).

import { describe, it, expect } from 'vitest';
import { checkFile } from './check-file';
import { getToolbarItemConfig } from '@/canvas/drag/toolbar-item-config';
import { normalizeLayoutDescriptor } from '@/canvas/drag/layout-normalize';
import { addNodeInCode, type AddNodeDef } from '@/code/generation/generator-crud';
import { CATEGORIES, CREATIVE_CATEGORIES } from '@/shared/insert-items/element-data';
import type { NewNodeDescriptor } from '@/shared/types';

/** A minimal, oracle-CLEAN page — so anything reported is attributable to the
 *  node just inserted, never to the fixture. */
const BLANK_PAGE = `'use client';
/** @canvas { "viewports": [{ "id": "desktop", "label": "Desktop", "width": 1440, "isPrimary": true, "order": 0 }], "positions": { "desktop": { "x": 0, "y": 0 } } } */
import React from 'react';

export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%', display: 'flex', flexDirection: 'column' }}>
    </div>
  );
}
`;

/**
 * Rules an item is still allowed to trip, with the reason. Two kinds live here
 * and they are NOT the same thing:
 *
 *   • HARNESS — the real drop path does more than this test can (it adds the
 *     component import, wires the form handler). Not a builder bug; the test
 *     simply can't see the whole path from here.
 *   • DIVERGENCE — a genuine builder-vs-oracle disagreement, still open.
 *
 * Shrinking this list is the point. Adding to it should feel like a decision.
 */
const KNOWN_DIVERGENCES: Record<string, { codes: string[]; why: string }> = {
  // ── HARNESS ──
  // Embeds / code components drop an INSTANCE tag (`<Calendly/>`) whose import
  // the real path adds alongside the node (component creation + syncImports).
  // Inserting the tag alone into a bare fixture is always an undefined
  // identifier — an artifact of testing one step of a two-step drop.
  __embedsAndCodeComponents: { codes: ['WOULD_CRASH'], why: 'harness: instance import added by the drop path, not by addNodeInCode' },
  'text-link': { codes: ['PAGE_LINK_NOT_NEXTLINK', 'NEXTLINK_IMPORT_MISSING'], why: 'harness: the drop path adds the next/link import via syncImports' },
  'custom-form': { codes: ['FORM_MISSING_ONSUBMIT', 'FORM_NO_DESTINATION'], why: 'harness: the form drop wires onSubmit/endpoint in a follow-up mutation' },

  // ── DIVERGENCE (open) ──
  // The shape items insert native <rect>/<polygon>; the oracle wants geometry on
  // a <path> so per-variant morphing and the shape editor can drive one `d`.
  'shape-square': { codes: ['SHAPE_GEOMETRY_NOT_PATH'], why: 'open: native primitives vs path geometry' },
  'shape-triangle': { codes: ['SHAPE_GEOMETRY_NOT_PATH'], why: 'open: native primitives vs path geometry' },
  'shape-star': { codes: ['SHAPE_GEOMETRY_NOT_PATH'], why: 'open: native primitives vs path geometry' },
  'shape-hexagon': { codes: ['SHAPE_GEOMETRY_NOT_PATH'], why: 'open: native primitives vs path geometry' },
  'shape-pentagon': { codes: ['SHAPE_GEOMETRY_NOT_PATH'], why: 'open: native primitives vs path geometry' },
  // `maxWidth: 'none'` has no slot in the Size panel; <img> should be a
  // background-image frame per the dialect.
  image: { codes: ['IMAGE_USE_BACKGROUND_FRAME', 'MINMAX_SIZE_UNIT'], why: 'open: <img> + maxWidth:none' },
  video: { codes: ['MINMAX_SIZE_UNIT'], why: "open: maxWidth: 'none'" },
  audio: { codes: ['MINMAX_SIZE_UNIT'], why: "open: maxWidth: 'none'" },
};

/** Items whose only failure is the embed/code-component import artifact. */
const isImportArtifact = (codes: string[]) => codes.length === 1 && codes[0] === 'WOULD_CRASH';

function allInsertItemIds(): string[] {
  const ids: string[] = [];
  for (const cat of [...CATEGORIES, ...CREATIVE_CATEGORIES]) {
    for (const section of cat.sections ?? []) for (const item of section.items ?? []) ids.push(item.id);
  }
  return [...new Set(ids)];
}

let seq = 0;
function toAddNodeDef(tag: string, styles: Record<string, string>, attrs?: Record<string, string>,
  text?: string, kids?: NewNodeDescriptor[]): AddNodeDef {
  return {
    id: `${tag.replace(/[^a-z]/gi, '') || 'node'}-conf-${++seq}`,
    type: tag,
    styles: { ...styles },
    attrs: attrs ? { ...attrs } : undefined,
    textContent: text,
    children: kids?.map(k => toAddNodeDef(k.tag, k.styles, k.attrs, k.textContent, k.children)),
  };
}

/** Mirror of the real drop: descriptor → `normalizeLayoutDescriptor` (which
 *  ToolbarDragStrategy now applies to built-ins, not just plugin trees) →
 *  `addNodeInCode`. */
function dropItem(id: string): string[] | null {
  const cfg = getToolbarItemConfig(id);
  if (!cfg) return null;
  const n = normalizeLayoutDescriptor({
    tag: cfg.elementType, styles: { ...cfg.defaultStyles }, children: cfg.children?.(),
    attrs: cfg.defaultAttrs, textContent: cfg.textContent,
  } as NewNodeDescriptor);
  const code = addNodeInCode(BLANK_PAGE, 'root', toAddNodeDef(n.tag, n.styles, n.attrs, n.textContent, n.children));
  return [...new Set(checkFile(code, { kind: 'page' }).map(v => v.code))];
}

describe('builder conformance — the Insert catalogue', () => {
  const ids = allInsertItemIds().filter(id => !!getToolbarItemConfig(id));

  it('the sweep covers the catalogue (guards against silently checking nothing)', () => {
    expect(ids.length).toBeGreaterThan(50);
  });

  it('the blank fixture is itself oracle-clean', () => {
    expect(checkFile(BLANK_PAGE, { kind: 'page' })).toEqual([]);
  });

  for (const id of ids) {
    it(`dropping "${id}" produces oracle-clean code`, () => {
      const codes = dropItem(id)!;
      if (codes.length === 0) return;
      const allowed = KNOWN_DIVERGENCES[id]?.codes
        ?? (isImportArtifact(codes) ? KNOWN_DIVERGENCES.__embedsAndCodeComponents.codes : []);
      // Anything not on this item's allow-list is a NEW divergence: the builder
      // started emitting a shape its own oracle rejects.
      expect(codes.filter(c => !allowed.includes(c))).toEqual([]);
    });
  }

  it('the allow-list has no STALE entries (fixed divergences must be removed)', () => {
    // Without this the list would quietly become a permanent excuse: fix the
    // producer, and the entry must go, or the next regression hides behind it.
    const stale: string[] = [];
    for (const [id, { codes }] of Object.entries(KNOWN_DIVERGENCES)) {
      if (id.startsWith('__')) continue;
      const actual = dropItem(id);
      if (!actual) { stale.push(`${id} (no longer in the catalogue)`); continue; }
      const unused = codes.filter(c => !actual.includes(c));
      if (unused.length) stale.push(`${id}: ${unused.join(', ')} no longer fires`);
    }
    expect(stale).toEqual([]);
  });
});

describe('builder conformance — the plugin/insert descriptor normaliser', () => {
  // `normalizeLayoutDescriptor` is the module that makes any supplied tree
  // oracle-compliant. Its contract, as a test rather than a comment.
  const naive: NewNodeDescriptor = {
    tag: 'div',
    styles: {
      background: 'transparent',   // TRANSPARENT_COLOR
      alignItems: 'stretch',       // FORBIDDEN_ALIGN_VALUE
      left: '0px', top: '0px',     // POSITION_OFFSET_REQUIRES_ABSOLUTE
      padding: '20px',             // PADDING_NEEDS_LAYOUT
    },
    children: [
      { tag: 'p', styles: { flex: '1' }, textContent: 'a' },   // MISSING_ORDER + SHRINKS
      { tag: 'p', styles: {}, textContent: 'b' },
    ],
  };

  it('turns a naive tree into oracle-clean code', () => {
    const n = normalizeLayoutDescriptor(structuredClone(naive));
    const code = addNodeInCode(BLANK_PAGE, 'root', toAddNodeDef(n.tag, n.styles, n.attrs, n.textContent, n.children));
    expect(checkFile(code, { kind: 'page' }).map(v => v.code)).toEqual([]);
  });

  it('normalises every rule it claims to own', () => {
    const n = normalizeLayoutDescriptor(structuredClone(naive));
    expect(n.styles.background).not.toBe('transparent');
    expect(n.styles.alignItems).toBeUndefined();
    expect(n.styles.left).toBeUndefined();
    expect(n.styles.top).toBeUndefined();
    expect(n.styles.display).toBe('flex');
    (n.children ?? []).forEach((kid, i) => {
      expect(kid.styles.order).toBe(String(i));
      expect(kid.styles.flex).not.toBe('1');          // grow 1 + shrink 1 collapses
      expect(kid.styles.flex).toMatch(/ 0 /);         // shrink is always 0
    });
  });
});
