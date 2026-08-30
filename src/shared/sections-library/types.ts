// types.ts — the Sections library data model.
//
// A SectionBlueprint is a page-dialect JSX fragment (one root element, real
// data-ids, inline styles only) stored as source. Insert parses it with the
// REAL parser and routes it through the paste engine (see
// src/canvas/section-insert.ts), so a blueprint behaves exactly like a copied
// section: ids are regenerated, placement follows the paste rules, and every
// node is immediately editable by the panels.
//
// Blueprints double as the AI exemplar gallery — each one is a worked example
// of the page dialect at the marketplace quality bar, which is why `source`
// stays human-readable JSX rather than a serialized node tree.

export type SectionCategory =
  | 'header'
  | 'hero'
  | 'features'
  | 'cta'
  | 'pricing'
  | 'testimonials'
  | 'footer';

export interface SectionBlueprint {
  /** Stable library id (kebab-case). Also the insert-panel item suffix. */
  id: string;
  /** Display name in the Insert panel. */
  name: string;
  category: SectionCategory;
  /** One-line art-direction caption (panel tooltip + exemplar caption). */
  description: string;
  /** Google-font families the section references. Loaded on insert via
   *  loadGoogleFont + ensureGoogleFontImport so the face paints without a
   *  page switch (font-preload only scans on load/page-switch). */
  fonts: string[];
  /** Page-dialect JSX for ONE root element (`<div data-id="section-…">`).
   *  Must pass the oracle when wrapped in a page scaffold — enforced by
   *  src/code/oracle/sections-blueprints.test.ts. */
  source: string;
  /** Materialised px size for free-canvas placement (the paste engine uses
   *  it when nothing is selected and the section lands as a canvas node,
   *  where the root's `width: 100%` has no parent to resolve against). */
  canvasSize: { width: string; height: string };
}
