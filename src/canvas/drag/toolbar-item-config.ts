// toolbar-item-config.ts — Maps insert panel item IDs to concrete JSX element configs for toolbar drag.
// Covers: Basic, Typography, Cards, Layouts, Shapes. Code components/Creative are V2.

import { trace } from '@/shared/debug-trace';
import { generateNodeId } from '@/shared/id-utils';
import { ellipsePathD } from '@/shared/svg-geometry';
import { getCollectionSchema } from '@/code/project/cms-ops';
import type { NewNodeDescriptor } from '@/shared/types';

export interface ToolbarItem {
  /** Insert panel item ID (e.g. 'frame', 'image') */
  id: string;
  /** JSX tag name (e.g. 'div', 'img', 'button') */
  elementType: string;
  /** Human-readable name for the dropped element. Writes
   *  `data-name="..."` on the JSX so the Layers panel shows
   *  "Pricing Card" / "Hero Section" instead of generic "div".
   *  Optional — when missing, the layers panel falls back to the tag
   *  name (the legacy behaviour). */
  name?: string;
  /** Default inline styles for the new element */
  defaultStyles: Record<string, string>;
  /** Default HTML attributes (e.g. src, alt, controls) */
  defaultAttrs?: Record<string, string>;
  /** Text content inside the element (e.g. 'Button', 'Heading') */
  textContent?: string;
  /** Child elements to create inside this element */
  children?: () => NewNodeDescriptor[];
  /** Ghost overlay dimensions during drag (px) */
  ghostSize: { width: number; height: number };
  /** When set, this drag inserts a CDN-linked component. The strategy
   *  ensures the URL `import` line exists on the active page on drop
   *  so the inserted JSX tag (`elementType` is the slug / component
   *  name) resolves at runtime via the canvas's URL-import path. */
  cdnUrl?: string;
}

// ─── Child factories ────────────────────────────────────────────────────────
//
// Every descriptor sets `name` so the Layers panel reads "Frame" / "Heading"
// / "Text" / "Button" instead of the bare tag (`div`, `h3`, `p`, …).
// Tag → friendly-name map used throughout:
//   div         → "Frame"
//   h1-h6       → "Heading"
//   p / span    → "Text"
//   button      → "Button"

function makeFlexChildren(count: number): NewNodeDescriptor[] {
  return Array.from({ length: count }, () => ({
    tag: 'div', id: generateNodeId('frame'), name: 'Frame',
    styles: { flex: '1', backgroundColor: '#ffffff', borderRadius: '4px' },
  }));
}

function makeGridChildren(count: number): NewNodeDescriptor[] {
  return Array.from({ length: count }, () => ({
    tag: 'div', id: generateNodeId('frame'), name: 'Frame',
    styles: { backgroundColor: '#ffffff', borderRadius: '4px' },
  }));
}

function makeCardBasicChildren(): NewNodeDescriptor[] {
  return [
    { tag: 'div', id: generateNodeId('frame'), name: 'Frame', styles: { width: '100%', height: '140px', backgroundColor: '#e5e7eb', borderRadius: '8px 8px 0 0' } },
    { tag: 'div', id: generateNodeId('frame'), name: 'Frame', styles: { display: 'flex', flexDirection: 'column', gap: '8px', padding: '16px' }, children: [
      { tag: 'h3', id: generateNodeId('heading'), name: 'Heading', styles: { fontSize: '18px', fontWeight: '700', color: '#111' }, textContent: 'Card Title' },
      { tag: 'p', id: generateNodeId('text'), name: 'Text', styles: { fontSize: '14px', color: '#666', lineHeight: '1.5' }, textContent: 'Card description text goes here.' },
    ] },
  ];
}

function makeCardHorizontalChildren(): NewNodeDescriptor[] {
  return [
    { tag: 'div', id: generateNodeId('frame'), name: 'Frame', styles: { width: '120px', backgroundColor: '#e5e7eb', borderRadius: '8px 0 0 8px', flexShrink: '0' } },
    { tag: 'div', id: generateNodeId('frame'), name: 'Frame', styles: { display: 'flex', flexDirection: 'column', gap: '8px', padding: '16px', flex: '1' }, children: [
      { tag: 'h3', id: generateNodeId('heading'), name: 'Heading', styles: { fontSize: '16px', fontWeight: '700', color: '#111' }, textContent: 'Title' },
      { tag: 'p', id: generateNodeId('text'), name: 'Text', styles: { fontSize: '13px', color: '#666', lineHeight: '1.5' }, textContent: 'Description text.' },
    ] },
  ];
}

function makeCardProfileChildren(): NewNodeDescriptor[] {
  return [
    // 9999px, not '50%': spacing/radius is PX-ONLY (SPACING_UNIT_NOT_PX) —
    // an over-large px radius clamps to a perfect circle identically.
    { tag: 'div', id: generateNodeId('frame'), name: 'Avatar', styles: { width: '64px', height: '64px', borderRadius: '9999px', backgroundColor: '#d1d5db', flexShrink: '0' } },
    { tag: 'h3', id: generateNodeId('heading'), name: 'Heading', styles: { fontSize: '16px', fontWeight: '700', color: '#111' }, textContent: 'Name' },
    { tag: 'p', id: generateNodeId('text'), name: 'Text', styles: { fontSize: '13px', color: '#888' }, textContent: 'Role / Description' },
  ];
}

function makeCardPricingChildren(): NewNodeDescriptor[] {
  return [
    { tag: 'h3', id: generateNodeId('heading'), name: 'Heading', styles: { fontSize: '18px', fontWeight: '700', color: '#111' }, textContent: 'Pro Plan' },
    { tag: 'p', id: generateNodeId('text'), name: 'Text', styles: { fontSize: '32px', fontWeight: '800', color: '#111' }, textContent: '$29' },
    { tag: 'p', id: generateNodeId('text'), name: 'Text', styles: { fontSize: '13px', color: '#888' }, textContent: 'per month' },
    { tag: 'button', id: generateNodeId('button'), name: 'Button', styles: { padding: '10px 20px', borderRadius: '8px', backgroundColor: '#3b82f6', border: 'none', cursor: 'pointer', display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }, children: [
      { tag: 'p', id: generateNodeId('text'), name: 'Text', styles: { color: '#ffffff', fontSize: '14px', fontWeight: '600', margin: '0px' }, textContent: 'Get Started' },
    ] },
  ];
}

function makeCardProductChildren(): NewNodeDescriptor[] {
  // Text elements get horizontal padding so they don't sit flush against
  // the card's left edge. The image stays full-bleed (no padding) — that
  // edge-to-edge look is the typical product-card recipe and matches the
  // card's `overflow: hidden` + top corner-radius on the image itself.
  return [
    { tag: 'div', id: generateNodeId('frame'), name: 'Frame', styles: { width: '100%', height: '160px', backgroundColor: '#e5e7eb', borderRadius: '8px 8px 0 0' } },
    { tag: 'h3', id: generateNodeId('heading'), name: 'Heading', styles: { fontSize: '16px', fontWeight: '700', color: '#111', paddingLeft: '16px', paddingRight: '16px' }, textContent: 'Product Name' },
    { tag: 'p', id: generateNodeId('text'), name: 'Text', styles: { fontSize: '18px', fontWeight: '700', color: '#111', paddingLeft: '16px', paddingRight: '16px' }, textContent: '$49.99' },
  ];
}

// ─── Shape descriptors ──────────────────────────────────────────────────────
//
// Every shape drops as a real `<svg viewBox="0 0 100 100" preserveAspectRatio="none">`
// wrapper with a primitive child (rect / ellipse / polygon). This matches
// what the bottom-toolbar ShapeCreator builds when the user draws a shape
// by hand — same render path on canvas, same Stroke + Fill controls in
// the inspector, same SVG semantics on the live site.
//
// The previous div + clip-path approach was a hack: it rendered fine but
// the inspector couldn't expose proper SVG controls (fill/stroke/etc.),
// the live HTML carried CSS-only geometry that doesn't compose with most
// SVG-aware tooling, and resizing relied on clip-path % math instead of
// the more robust viewBox-stretch model.
//
// Default fill: matches `DEFAULT_SHAPE_FILL` in ShapeCreator.ts (blue
// `#3b82f6`) so panel-dropped and toolbar-drawn shapes look identical
// out of the box. Stroke is preset to black width-0 so the Stroke Width
// input does something on first scrub (SVG ignores stroke-width without
// an explicit stroke attr — see ShapeCreator's same trick).
const SVG_SHAPE_ATTRS = {
  viewBox: '0 0 100 100',
  preserveAspectRatio: 'none',
  xmlns: 'http://www.w3.org/2000/svg',
} as const;
const SVG_SHAPE_STYLES = { width: '100px', height: '100px', display: 'block', overflow: 'visible' };
const SHAPE_FILL = '#3b82f6';
const COMMON_INNER_ATTRS = { fill: SHAPE_FILL, stroke: '#000000', strokeWidth: '0' };

function makeShapeChildren(innerTag: string, geometryAttrs: Record<string, string>): () => NewNodeDescriptor[] {
  return () => [{
    tag: innerTag,
    id: generateNodeId(innerTag),
    name: innerTag.charAt(0).toUpperCase() + innerTag.slice(1),
    styles: {},
    attrs: { ...geometryAttrs, ...COMMON_INNER_ATTRS },
  }];
}

// ─── Items ──────────────────────────────────────────────────────────────────

const TOOLBAR_ITEMS: Record<string, ToolbarItem> = {
  // ─── Basic ──────────────────────────────────────────────────────────
  frame: {
    id: 'frame', elementType: 'div',
    defaultStyles: { width: '200px', height: '200px', backgroundColor: '#ffffff' },
    ghostSize: { width: 200, height: 200 },
  },
  column: {
    id: 'column', elementType: 'div',
    defaultStyles: { display: 'flex', flexDirection: 'column', gap: '8px', width: '100px', height: '250px', padding: '16px', backgroundColor: '#d5d5d5' },
    children: () => makeFlexChildren(2),
    ghostSize: { width: 100, height: 250 },
  },
  row: {
    id: 'row', elementType: 'div',
    defaultStyles: { display: 'flex', flexDirection: 'row', gap: '8px', width: '250px', height: '100px', padding: '16px', backgroundColor: '#d5d5d5' },
    children: () => makeFlexChildren(2),
    ghostSize: { width: 250, height: 100 },
  },
  image: {
    id: 'image', elementType: 'img',
    defaultStyles: { display: 'block', width: '200px', height: '150px', maxWidth: 'none', objectFit: 'cover', backgroundColor: '#e5e7eb' },
    defaultAttrs: { src: 'https://images.unsplash.com/photo-1573655349936-de6bed86f839?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w2MjE1NjZ8MHwxfHNlYXJjaHwxNXx8dGV4dHVyZXxlbnwwfHx8fDE3NzUzMzI3Njd8MA&ixlib=rb-4.1.0&q=80&w=1080', alt: '' },
    ghostSize: { width: 200, height: 150 },
  },
  video: {
    id: 'video', elementType: 'video',
    defaultStyles: { display: 'block', width: '320px', height: '240px', maxWidth: 'none', backgroundColor: '#1f2937' },
    defaultAttrs: { controls: '' },
    ghostSize: { width: 320, height: 240 },
  },
  audio: {
    id: 'audio', elementType: 'audio',
    defaultStyles: { display: 'block', width: '300px', maxWidth: 'none' },
    defaultAttrs: { controls: 'true' },
    ghostSize: { width: 300, height: 40 },
  },
  button: {
    id: 'button', elementType: 'button',
    // A LAYOUT frame with a real <p> child — not intrinsic bare text. Bare
    // text inside <button> renders but shows NO Text node in the layers
    // (the label is invisible in the tree and only editable via
    // double-click), and a padded element must declare a layout for the
    // Padding control to exist. The p child is a normal text node: visible
    // in layers, styleable, and the button itself stays a flex container.
    defaultStyles: { padding: '12px 24px', borderRadius: '8px', backgroundColor: '#3b82f6', border: 'none', cursor: 'pointer', display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
    children: () => [
      { tag: 'p', id: generateNodeId('text'), name: 'Text', styles: { color: '#ffffff', fontSize: '15px', fontWeight: '500', margin: '0px' }, textContent: 'Button' },
    ],
    ghostSize: { width: 120, height: 44 },
  },

  // ─── Typography ─────────────────────────────────────────────────────
  heading: {
    id: 'heading', elementType: 'h1',
    defaultStyles: { fontSize: '36px', fontWeight: '700', color: '#111111' },
    textContent: 'Heading',
    ghostSize: { width: 200, height: 50 },
  },
  paragraph: {
    id: 'paragraph', elementType: 'p',
    // Fixed width so the dropped paragraph wraps at a readable measure
    // immediately, instead of stretching to its absolute-positioned
    // parent (which would put it on one giant line) or shrinking to fit
    // content (a single narrow column). Height is intentionally NOT set
    // so the box grows / shrinks naturally with the user's edits — no
    // clipped text, no awkward fixed-height frame.
    defaultStyles: { fontSize: '16px', lineHeight: '1.6', color: '#333333', width: '480px' },
    textContent: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.',
    ghostSize: { width: 480, height: 100 },
  },
  'text-link': {
    id: 'text-link', elementType: 'a',
    defaultStyles: { fontSize: '16px', color: '#3b82f6', cursor: 'pointer', textDecorationLine: 'underline', textDecorationStyle: 'solid', textDecorationThickness: '1px', textUnderlineOffset: '0px' },
    defaultAttrs: { href: '#' },
    textContent: 'Link text',
    ghostSize: { width: 120, height: 30 },
  },
  quote: {
    id: 'quote', elementType: 'blockquote',
    defaultStyles: { fontSize: '18px', fontStyle: 'italic', color: '#555555', borderLeft: '4px solid #d1d5db', paddingLeft: '16px', margin: '0' },
    textContent: '"A great quote goes here."',
    ghostSize: { width: 250, height: 60 },
  },

  // ─── Cards ──────────────────────────────────────────────────────────
  // Panel labels are short ("Basic", "Horizontal", …) because they live
  // under a "Cards" section header — `name` overrides write the full
  // "Basic Card" / "Horizontal Card" string to `data-name` so the
  // Layers panel reads clearly without the section context.
  'card-basic': {
    id: 'card-basic', elementType: 'div', name: 'Basic Card',
    defaultStyles: { display: 'flex', flexDirection: 'column', gap: '12px', width: '280px', backgroundColor: '#ffffff', borderRadius: '12px', overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' },
    children: makeCardBasicChildren,
    ghostSize: { width: 280, height: 260 },
  },
  'card-horizontal': {
    id: 'card-horizontal', elementType: 'div', name: 'Horizontal Card',
    defaultStyles: { display: 'flex', flexDirection: 'row', width: '400px', backgroundColor: '#ffffff', borderRadius: '12px', overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' },
    children: makeCardHorizontalChildren,
    ghostSize: { width: 400, height: 120 },
  },
  'card-profile': {
    id: 'card-profile', elementType: 'div', name: 'Profile Card',
    defaultStyles: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', width: '200px', padding: '24px', backgroundColor: '#ffffff', borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', textAlign: 'center' },
    children: makeCardProfileChildren,
    ghostSize: { width: 200, height: 180 },
  },
  'card-pricing': {
    id: 'card-pricing', elementType: 'div', name: 'Pricing Card',
    defaultStyles: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', width: '240px', padding: '32px 24px', backgroundColor: '#ffffff', borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', textAlign: 'center' },
    children: makeCardPricingChildren,
    ghostSize: { width: 240, height: 280 },
  },
  'card-product': {
    id: 'card-product', elementType: 'div', name: 'Product Card',
    defaultStyles: { display: 'flex', flexDirection: 'column', gap: '10px', width: '240px', backgroundColor: '#ffffff', borderRadius: '12px', overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', paddingBottom: '16px' },
    children: makeCardProductChildren,
    ghostSize: { width: 240, height: 260 },
  },

  // ─── Layouts ────────────────────────────────────────────────────────
  // Top-level container is INVISIBLE — no padding, no background. The
  // layout primitive is purely structural: a flex/grid container with
  // gap between visible child cells. Matches the legacy "layout creator"
  // affordance where dropping a layout gave you 2/3/grid empty frames
  // arranged with a small gap, without a wrapping panel of its own
  // (a wrapping panel would force the user to immediately strip
  // padding + bg before they can do anything useful).
  'layout-2row': {
    id: 'layout-2row', elementType: 'div', name: '2 Row Layout',
    defaultStyles: { display: 'flex', flexDirection: 'column', gap: '8px', width: '300px', height: '200px' },
    children: () => makeFlexChildren(2),
    ghostSize: { width: 300, height: 200 },
  },
  'layout-3row': {
    id: 'layout-3row', elementType: 'div', name: '3 Row Layout',
    defaultStyles: { display: 'flex', flexDirection: 'column', gap: '8px', width: '300px', height: '250px' },
    children: () => makeFlexChildren(3),
    ghostSize: { width: 300, height: 250 },
  },
  'layout-2col': {
    id: 'layout-2col', elementType: 'div', name: '2 Col Layout',
    defaultStyles: { display: 'flex', flexDirection: 'row', gap: '8px', width: '300px', height: '150px' },
    children: () => makeFlexChildren(2),
    ghostSize: { width: 300, height: 150 },
  },
  'layout-3col': {
    id: 'layout-3col', elementType: 'div', name: '3 Col Layout',
    defaultStyles: { display: 'flex', flexDirection: 'row', gap: '8px', width: '400px', height: '150px' },
    children: () => makeFlexChildren(3),
    ghostSize: { width: 400, height: 150 },
  },
  'layout-grid': {
    id: 'layout-grid', elementType: 'div', name: 'Grid Layout',
    defaultStyles: { display: 'grid', gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr 1fr', gap: '8px', width: '300px', height: '300px' },
    children: () => makeGridChildren(4),
    ghostSize: { width: 300, height: 300 },
  },
  'layout-sidebar': {
    id: 'layout-sidebar', elementType: 'div', name: 'Sidebar Layout',
    defaultStyles: { display: 'flex', flexDirection: 'row', gap: '8px', width: '400px', height: '300px' },
    children: (): NewNodeDescriptor[] => [
      { tag: 'div', id: generateNodeId('frame'), name: 'Sidebar', styles: { width: '120px', flexShrink: '0', backgroundColor: '#ffffff', borderRadius: '4px' } },
      { tag: 'div', id: generateNodeId('frame'), name: 'Content', styles: { flex: '1', backgroundColor: '#ffffff', borderRadius: '4px' } },
    ],
    ghostSize: { width: 400, height: 300 },
  },
  'layout-header': {
    id: 'layout-header', elementType: 'div', name: 'Header Layout',
    defaultStyles: { display: 'flex', flexDirection: 'column', gap: '8px', width: '300px', height: '250px' },
    children: (): NewNodeDescriptor[] => [
      { tag: 'div', id: generateNodeId('frame'), name: 'Header', styles: { height: '60px', flexShrink: '0', backgroundColor: '#ffffff', borderRadius: '4px' } },
      { tag: 'div', id: generateNodeId('frame'), name: 'Content', styles: { flex: '1', backgroundColor: '#ffffff', borderRadius: '4px' } },
    ],
    ghostSize: { width: 300, height: 250 },
  },

  // ─── Shapes ─────────────────────────────────────────────────────────
  'shape-square': {
    id: 'shape-square', elementType: 'svg', name: 'Square',
    defaultStyles: SVG_SHAPE_STYLES,
    defaultAttrs: SVG_SHAPE_ATTRS,
    children: makeShapeChildren('rect', { width: '100%', height: '100%' }),
    ghostSize: { width: 100, height: 100 },
  },
  'shape-circle': {
    id: 'shape-circle', elementType: 'svg', name: 'Circle',
    defaultStyles: SVG_SHAPE_STYLES,
    defaultAttrs: SVG_SHAPE_ATTRS,
    // Bézier `<path>` (absolute coords), like the reference — NOT `<ellipse rx="50%">`.
    // A %-based ellipse has no absolute coordinates, so every geometry op (bbox,
    // vertices, scale, rotate-transform bake, group refit, selection bounds)
    // mis-handled it (collapse on resize, loose rotated bounds). A path scales
    // with the box via scalePathD and works everywhere the polygon does.
    children: makeShapeChildren('path', { d: ellipsePathD(100, 100) }),
    ghostSize: { width: 100, height: 100 },
  },
  'shape-triangle': {
    id: 'shape-triangle', elementType: 'svg', name: 'Triangle',
    defaultStyles: SVG_SHAPE_STYLES,
    defaultAttrs: SVG_SHAPE_ATTRS,
    children: makeShapeChildren('polygon', { points: '50,0 100,100 0,100' }),
    ghostSize: { width: 100, height: 100 },
  },
  'shape-star': {
    id: 'shape-star', elementType: 'svg', name: 'Star',
    defaultStyles: SVG_SHAPE_STYLES,
    defaultAttrs: SVG_SHAPE_ATTRS,
    children: makeShapeChildren('polygon', { points: '50,5 61,35 95,35 68,57 79,91 50,70 21,91 32,57 5,35 39,35' }),
    ghostSize: { width: 100, height: 100 },
  },
  'shape-hexagon': {
    id: 'shape-hexagon', elementType: 'svg', name: 'Hexagon',
    defaultStyles: SVG_SHAPE_STYLES,
    defaultAttrs: SVG_SHAPE_ATTRS,
    children: makeShapeChildren('polygon', { points: '50,3 93,25 93,75 50,97 7,75 7,25' }),
    ghostSize: { width: 100, height: 100 },
  },
  'shape-pentagon': {
    id: 'shape-pentagon', elementType: 'svg', name: 'Pentagon',
    defaultStyles: SVG_SHAPE_STYLES,
    defaultAttrs: SVG_SHAPE_ATTRS,
    children: makeShapeChildren('polygon', { points: '50,5 95,38 80,92 20,92 5,38' }),
    ghostSize: { width: 100, height: 100 },
  },

  // ─── Form Widgets ───────────────────────────────────────────────────
  input: {
    id: 'input', elementType: 'input',
    defaultStyles: { width: '250px', height: '40px', padding: '8px 12px', fontSize: '14px', border: '1px solid #d1d5db', borderRadius: '6px', backgroundColor: '#ffffff', color: '#111' },
    defaultAttrs: { type: 'text', placeholder: 'Enter text...' },
    ghostSize: { width: 250, height: 40 },
  },
  textarea: {
    id: 'textarea', elementType: 'textarea',
    defaultStyles: { width: '250px', height: '100px', padding: '8px 12px', fontSize: '14px', border: '1px solid #d1d5db', borderRadius: '6px', backgroundColor: '#ffffff', color: '#111', resize: 'vertical' },
    defaultAttrs: { placeholder: 'Enter text...' },
    ghostSize: { width: 250, height: 100 },
  },
  select: {
    id: 'select', elementType: 'select',
    defaultStyles: { width: '250px', height: '40px', padding: '8px 12px', fontSize: '14px', border: '1px solid #d1d5db', borderRadius: '6px', backgroundColor: '#ffffff', color: '#111' },
    ghostSize: { width: 250, height: 40 },
  },
  checkbox: {
    id: 'checkbox', elementType: 'input',
    defaultStyles: { width: '18px', height: '18px' },
    defaultAttrs: { type: 'checkbox' },
    ghostSize: { width: 18, height: 18 },
  },
  radio: {
    id: 'radio', elementType: 'input',
    defaultStyles: { width: '18px', height: '18px' },
    defaultAttrs: { type: 'radio' },
    ghostSize: { width: 18, height: 18 },
  },
  form: {
    id: 'form', elementType: 'form',
    defaultStyles: { display: 'flex', flexDirection: 'column', gap: '12px', width: '300px', padding: '24px', backgroundColor: '#ffffff', borderRadius: '12px' },
    children: (): NewNodeDescriptor[] => [
      { tag: 'input', id: generateNodeId('input'), styles: { width: '100%', height: '40px', padding: '8px 12px', fontSize: '14px', border: '1px solid #d1d5db', borderRadius: '6px' }, attrs: { type: 'text', name: 'name', placeholder: 'Name' } },
      { tag: 'input', id: generateNodeId('input'), styles: { width: '100%', height: '40px', padding: '8px 12px', fontSize: '14px', border: '1px solid #d1d5db', borderRadius: '6px' }, attrs: { type: 'email', name: 'email', placeholder: 'Email' } },
      { tag: 'button', id: generateNodeId('button'), styles: { padding: '10px 20px', borderRadius: '8px', backgroundColor: '#3b82f6', color: '#fff', border: 'none', cursor: 'pointer', fontSize: '14px', fontWeight: '600' }, textContent: 'Submit' },
    ],
    ghostSize: { width: 300, height: 200 },
  },
  // ─── Full / 3rd-party form integrations ──────────────────────────────
  // CustomForm: fully-styled multi-field contact form (name + email + textarea + button)
  'custom-form': {
    id: 'custom-form', elementType: 'form',
    defaultStyles: {
      display: 'flex', flexDirection: 'column', gap: '12px',
      width: '400px', padding: '24px', backgroundColor: '#ffffff',
      borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
    },
    children: (): NewNodeDescriptor[] => [
      { tag: 'h3', id: generateNodeId('heading'), styles: { fontSize: '18px', fontWeight: '600', color: '#111827', marginBottom: '4px' }, textContent: 'Get in touch' },
      { tag: 'input', id: generateNodeId('input'), styles: { width: '100%', height: '40px', padding: '10px 12px', fontSize: '14px', border: '1px solid #d1d5db', borderRadius: '6px', outline: 'none' }, attrs: { type: 'text', name: 'name', placeholder: 'Name' } },
      { tag: 'input', id: generateNodeId('input'), styles: { width: '100%', height: '40px', padding: '10px 12px', fontSize: '14px', border: '1px solid #d1d5db', borderRadius: '6px', outline: 'none' }, attrs: { type: 'email', name: 'email', placeholder: 'Email' } },
      { tag: 'textarea', id: generateNodeId('textarea'), styles: { width: '100%', minHeight: '100px', padding: '10px 12px', fontSize: '14px', border: '1px solid #d1d5db', borderRadius: '6px', outline: 'none', resize: 'vertical', fontFamily: 'inherit' }, attrs: { name: 'message', placeholder: 'Message', rows: '4' } },
      { tag: 'button', id: generateNodeId('button'), styles: { padding: '10px 16px', borderRadius: '6px', backgroundColor: '#3b82f6', color: '#fff', border: 'none', cursor: 'pointer', fontSize: '14px', fontWeight: '500' }, attrs: { type: 'submit' }, textContent: 'Send' },
    ],
    ghostSize: { width: 400, height: 360 },
  },
  // ─── Embed / Social Code components ────────────────────────────────────────────
  // Each drops a component instance (`<YouTubeEmbed/>` etc.). The Code component file
  // is shipped as a built-in in components/ — see project-fs.ts BUILT_IN_COMPONENTS.
  youtube: {
    id: 'youtube', elementType: 'YouTubeEmbed',
    defaultStyles: { width: '640px', height: '360px', overflow: 'hidden' },
    ghostSize: { width: 640, height: 360 },
  },
  vimeo: {
    id: 'vimeo', elementType: 'VimeoEmbed',
    defaultStyles: { width: '640px', height: '360px', overflow: 'hidden' },
    ghostSize: { width: 640, height: 360 },
  },
  soundcloud: {
    id: 'soundcloud', elementType: 'SoundCloudEmbed',
    defaultStyles: { width: '640px', height: '300px', overflow: 'hidden' },
    ghostSize: { width: 640, height: 300 },
  },
  spotify: {
    id: 'spotify', elementType: 'SpotifyEmbed',
    defaultStyles: { width: '460px', height: '152px', overflow: 'hidden' },
    ghostSize: { width: 460, height: 152 },
  },
  'google-maps': {
    id: 'google-maps', elementType: 'GoogleMapsEmbed',
    defaultStyles: { width: '600px', height: '450px', overflow: 'hidden' },
    ghostSize: { width: 600, height: 450 },
  },
  facebook: {
    id: 'facebook', elementType: 'FacebookEmbed',
    defaultStyles: { width: '500px', height: '600px', overflow: 'hidden' },
    ghostSize: { width: 500, height: 600 },
  },
  x: {
    id: 'x', elementType: 'TwitterEmbed',
    defaultStyles: { width: '550px', height: '500px', overflow: 'hidden' },
    ghostSize: { width: 550, height: 500 },
  },
  instagram: {
    id: 'instagram', elementType: 'InstagramEmbed',
    defaultStyles: { width: '480px', height: '720px', overflow: 'hidden' },
    ghostSize: { width: 480, height: 720 },
  },
  linkedin: {
    id: 'linkedin', elementType: 'LinkedInEmbed',
    defaultStyles: { width: '550px', height: '600px', overflow: 'hidden' },
    ghostSize: { width: 550, height: 600 },
  },
  pinterest: {
    id: 'pinterest', elementType: 'PinterestEmbed',
    defaultStyles: { width: '345px', height: '500px', overflow: 'hidden' },
    ghostSize: { width: 345, height: 500 },
  },
  tiktok: {
    id: 'tiktok', elementType: 'TikTokEmbed',
    defaultStyles: { width: '380px', height: '720px', overflow: 'hidden' },
    ghostSize: { width: 380, height: 720 },
  },
  // Form integrations — drop as Code component instances (CalendlyEmbed/TypeformEmbed/GoogleFormEmbed
  // live in default-code-components/). The Code component renders a placeholder card when the URL/ID
  // is unset, then switches to a real iframe once the user fills the @controls field.
  calendly: {
    id: 'calendly', elementType: 'CalendlyEmbed',
    defaultStyles: { width: '640px', height: '700px', overflow: 'hidden' },
    ghostSize: { width: 640, height: 700 },
  },
  typeform: {
    id: 'typeform', elementType: 'TypeformEmbed',
    defaultStyles: { width: '640px', height: '500px', overflow: 'hidden' },
    ghostSize: { width: 640, height: 500 },
  },
  'google-forms': {
    id: 'google-forms', elementType: 'GoogleFormEmbed',
    defaultStyles: { width: '640px', height: '600px', overflow: 'hidden' },
    ghostSize: { width: 640, height: 600 },
  },
};

// Also add form-related attrs to parser
// (placeholder, type already in htmlAttrs list)

/** Default placeholder template for a CMS-bound list item. Mirrors the
 *  the reference "Article Item" — image on the left, title text on the right.
 *  After drop, the first child (this whole `<div>`) gets wrapped in a
 *  `.map()` over the chosen collection (see Canvas's add-handler). */
function makeCmsPlaceholderItem(): NewNodeDescriptor {
  return {
    tag: 'div',
    id: generateNodeId('item'),
    styles: {
      display: 'flex',
      flexDirection: 'row',
      alignItems: 'center',
      gap: '12px',
      padding: '8px',
      width: '100%',
    },
    children: [
      {
        tag: 'div',
        id: generateNodeId('image'),
        styles: {
          width: '60px',
          height: '60px',
          borderRadius: '8px',
          backgroundColor: '#d1d5db',
          flexShrink: '0',
        },
      },
      {
        tag: 'h3',
        id: generateNodeId('heading'),
        styles: { fontSize: '18px', fontWeight: '700', color: '#111' },
        textContent: 'Item Title',
      },
    ],
  };
}

/** Insert-panel `cs-*` IDs that resolve to a code-component code component file in
 *  ProjectFS. Drag drops them as `<TagName />` JSX, the code component file is loaded
 *  by the Renderer and the @controls block drives the Properties panel. */
const CODE_SNIPPET_TOOLBAR_ITEMS: Record<string, { tag: string; width: number; height: number }> = {
  // Noises (Canvas 2D effects)
  'cs-filmGrain':       { tag: 'FilmGrain',       width: 600, height: 400 },
  'cs-staticNoise':     { tag: 'StaticTV',        width: 600, height: 400 },
  'cs-perlinNoise':     { tag: 'PerlinNoise',     width: 600, height: 400 },
  'cs-halftone':        { tag: 'Halftone',        width: 600, height: 400 },
  'cs-scanlines':       { tag: 'Scanlines',       width: 600, height: 400 },
  'cs-chromaticNoise':  { tag: 'ChromaticNoise',  width: 600, height: 400 },
  // Interactive utility — small inline buttons.
  'cs-themeToggle':     { tag: 'ThemeToggle',     width: 44,  height: 44 },
  'cs-localeSwitcher':  { tag: 'LocaleSwitcher',  width: 100, height: 36 },
  'cs-copyButton':      { tag: 'CopyButton',      width: 160, height: 48 },
  // Creative — text effects (port batch 1). Defaults sized big enough
  // for the rendered animation to be visible on first drop without the
  // user needing to resize. SpinningText is square because the chars
  // sit on a circle; HangingCurved is wider because the curve spans
  // the viewBox horizontally.
  'cs-morphingText':    { tag: 'MorphingText',    width: 400, height: 100 },
  'cs-wordRotate':      { tag: 'WordRotate',      width: 400, height: 80 },
  'cs-spinningText':    { tag: 'SpinningText',    width: 400, height: 400 },
  'cs-hangingCurved':   { tag: 'HangingCurved',   width: 800, height: 200 },
  'cs-magneticText':    { tag: 'MagneticText',    width: 600, height: 120 },
  'cs-textPressure':    { tag: 'TextPressure',    width: 600, height: 160 },
  // Port batch 2 — typing-cycle, 3D cylinder, video-masked text,
  // count-up number. `cs-counter` reuses the existing AnimatedCounter
  // code component (no separate Counter file — the single code component covers the
  // count-up axis with prefix/suffix already; differences from the
  // old builder's `from`/`to` shape are absorbed into the React
  // controls schema so the user gets the same affordance).
  'cs-typingText':      { tag: 'TypingText',      width: 400, height: 80 },
  'cs-rotatingText':    { tag: 'RotatingText3D',  width: 600, height: 600 },
  'cs-videoText':       { tag: 'VideoText',       width: 600, height: 200 },
  'cs-counter':         { tag: 'AnimatedCounter', width: 200, height: 80 },
  'cs-glitchText':      { tag: 'GlitchText',      width: 400, height: 100 },
  // Containers — slot-based code components. Drop empty; the user connects
  // canvas nodes into the slot (rendered as real JSX children).
  'cs-lensBox':         { tag: 'LensBox',         width: 400, height: 300 },
  'cs-magnetBox':       { tag: 'MagnetBox',       width: 400, height: 300 },
  // Effects — multi-slot containers; connected canvas nodes become children.
  'cs-carousel':        { tag: 'Carousel',         width: 600, height: 400 },
  'cs-marquee':         { tag: 'Marquee',          width: 800, height: 160 },
  'cs-ribbonMarquee':   { tag: 'RibbonMarquee',    width: 700, height: 320 },
  'cs-threeDMarquee':   { tag: 'Marquee3D',        width: 720, height: 520 },
  'cs-imageTrail':      { tag: 'MotionTrail',      width: 640, height: 420 },
  'cs-horizontalScroll':{ tag: 'HorizontalScroll', width: 800, height: 340 },
  // Cursors — region hotspots, no slot. The bounding box defines the
  // cursor zone; default 600×400 is large enough to be a meaningful
  // hover area without dominating the page on first drop.
  'cs-designCursor':    { tag: 'DesignCursor',    width: 600, height: 400 },
  'cs-blobCursor':      { tag: 'BlobCursor',      width: 600, height: 400 },
  'cs-ribbonCursor':    { tag: 'RibbonCursor',    width: 600, height: 400 },
  'cs-splashCursor':    { tag: 'SplashCursor',    width: 600, height: 400 },
};

function makeCodeSnippetToolbarItem(itemId: string): ToolbarItem | null {
  const cfg = CODE_SNIPPET_TOOLBAR_ITEMS[itemId];
  if (!cfg) return null;
  return {
    id: itemId,
    elementType: cfg.tag,
    defaultStyles: { width: cfg.width + 'px', height: cfg.height + 'px' },
    ghostSize: { width: cfg.width, height: cfg.height },
  };
}

/** Insert-panel divider IDs. Each drops a plain `<div>` with a CSS clip-path
 *  carved into a recognisable section-break shape (line / wave / angled /
 *  curved / zigzag / wavy-line / arrow / steps). Pure CSS, no code component needed —
 *  the user can change `backgroundColor` from the panel like any other
 *  element. Polygons use percentages so they scale with width/height. */
const DIVIDER_TOOLBAR_ITEMS: Record<string, { width: number; height: number; styles: Record<string, string> }> = {
  // Plain horizontal line — no clip-path, just a 2px tall white div.
  'cs-lineDivider': {
    width: 600, height: 2,
    styles: { backgroundColor: '#ffffff' },
  },
  // Smooth wavy bottom edge — single W-shaped wave (3 lobes).
  'cs-waveDivider': {
    width: 1200, height: 80,
    styles: {
      backgroundColor: '#ffffff',
      clipPath: 'polygon(0 0, 100% 0, 100% 70%, 75% 100%, 50% 70%, 25% 100%, 0 70%)',
    },
  },
  // Diagonal slope across the top edge.
  'cs-angledDivider': {
    width: 1200, height: 80,
    styles: {
      backgroundColor: '#ffffff',
      clipPath: 'polygon(0 40%, 100% 0, 100% 100%, 0 100%)',
    },
  },
  // Dome / arc — half-ellipse anchored at bottom-centre.
  'cs-curvedDivider': {
    width: 1200, height: 80,
    styles: {
      backgroundColor: '#ffffff',
      clipPath: 'ellipse(50% 100% at 50% 100%)',
    },
  },
  // Eight-tooth zigzag at the top.
  'cs-zigzagDivider': {
    width: 1200, height: 60,
    styles: {
      backgroundColor: '#ffffff',
      clipPath: 'polygon(0 80%, 6.25% 0, 12.5% 80%, 18.75% 0, 25% 80%, 31.25% 0, 37.5% 80%, 43.75% 0, 50% 80%, 56.25% 0, 62.5% 80%, 68.75% 0, 75% 80%, 81.25% 0, 87.5% 80%, 93.75% 0, 100% 80%, 100% 100%, 0 100%)',
    },
  },
  // Wavy thin band — two parallel sine curves making a serpentine line.
  'cs-wavyLineDivider': {
    width: 1200, height: 40,
    styles: {
      backgroundColor: '#ffffff',
      clipPath: 'polygon(0 35%, 12% 50%, 25% 35%, 38% 20%, 50% 35%, 62% 50%, 75% 35%, 88% 20%, 100% 35%, 100% 50%, 88% 35%, 75% 50%, 62% 65%, 50% 50%, 38% 35%, 25% 50%, 12% 65%, 0 50%)',
    },
  },
  // Down-chevron / V cut into the top.
  'cs-arrowDivider': {
    width: 1200, height: 80,
    styles: {
      backgroundColor: '#ffffff',
      clipPath: 'polygon(0 0, 50% 50%, 100% 0, 100% 100%, 0 100%)',
    },
  },
  // Five-step staircase climbing left → right along the top.
  'cs-stepsDivider': {
    width: 1200, height: 80,
    styles: {
      backgroundColor: '#ffffff',
      clipPath: 'polygon(0 80%, 20% 80%, 20% 60%, 40% 60%, 40% 40%, 60% 40%, 60% 20%, 80% 20%, 80% 0, 100% 0, 100% 100%, 0 100%)',
    },
  },
};

function makeDividerToolbarItem(itemId: string): ToolbarItem | null {
  const cfg = DIVIDER_TOOLBAR_ITEMS[itemId];
  if (!cfg) return null;
  return {
    id: itemId,
    elementType: 'div',
    defaultStyles: { width: cfg.width + 'px', height: cfg.height + 'px', ...cfg.styles },
    ghostSize: { width: cfg.width, height: cfg.height },
  };
}

// ─── Patterns (Pattern Code component with `kind` select) ──────────────────────────
//
// All seven pattern flavours drop the SAME `<Pattern>` Code component, just with a
// different default `kind` attribute. The Code component's `@controls` exposes a
// `kind` select control + shared color / opacity / size controls so the
// user can swap pattern type AFTER the drop without re-dragging from the
// panel. One code component file, one set of controls, seven entry points.
const PATTERN_KINDS: Record<string, string> = {
  'cs-gridPattern': 'grid',
  'cs-dotPattern': 'dots',
  'cs-crossPattern': 'crosses',
  'cs-diagonalPattern': 'diagonal',
  'cs-gridMaskPattern': 'gridMask',
  'cs-honeycombPattern': 'honeycomb',
  'cs-checkerboardPattern': 'checkerboard',
};

function makePatternToolbarItem(itemId: string): ToolbarItem | null {
  const kind = PATTERN_KINDS[itemId];
  if (!kind) return null;
  return {
    id: itemId,
    elementType: 'Pattern',
    defaultStyles: { width: '600px', height: '400px' },
    defaultAttrs: { kind },
    ghostSize: { width: 600, height: 400 },
  };
}

// ─── Shaders (canvas-2D animated effects) ─────────────────────────────────
//
// Each entry drops a Code component instance — the actual visual is rendered by
// the live React component (e.g. <WaveLines kind=… />). The Code component file
// ships in ProjectFS via BUILT_IN_COMPONENTS so syncImports auto-injects
// `import WaveLines from '@/components/WaveLines'` after the drop, and
// the @controls metadata wires the tag's props to the Properties panel.
//
// (Replaces the legacy GRADIENT_TOOLBAR_ITEMS list of plain `<div>`s with
// CSS gradients — those couldn't be edited beyond a single `background`
// string and gave no rich panel controls.)
const SHADER_TOOLBAR_ITEMS: Record<string, { tag: string; width: number; height: number }> = {
  'cs-shaderWaveLines':       { tag: 'WaveLines',        width: 600, height: 400 },
  'cs-shaderWaveGradient':    { tag: 'WaveGradient',     width: 600, height: 400 },
  'cs-shaderMeshGradient':    { tag: 'MeshGradient',     width: 600, height: 400 },
  'cs-shaderPlasma':          { tag: 'PlasmaShader',     width: 600, height: 400 },
  'cs-shaderLiquidMetal':     { tag: 'LiquidMetal',      width: 600, height: 400 },
  'cs-shaderCaustics':        { tag: 'CausticsLight',    width: 600, height: 400 },
  'cs-shaderAurora':          { tag: 'AuroraBackground', width: 600, height: 400 },
  'cs-shaderMatrixRain':      { tag: 'MatrixRain',       width: 600, height: 400 },
  'cs-shaderWaveDistortion':  { tag: 'WaveDistortion',   width: 600, height: 400 },
  'cs-neonParticleField':     { tag: 'NeonParticleField', width: 600, height: 400 },
};

function makeShaderToolbarItem(itemId: string): ToolbarItem | null {
  const cfg = SHADER_TOOLBAR_ITEMS[itemId];
  if (!cfg) return null;
  return {
    id: itemId,
    elementType: cfg.tag,
    defaultStyles: { width: cfg.width + 'px', height: cfg.height + 'px' },
    ghostSize: { width: cfg.width, height: cfg.height },
  };
}

/** Build a synthetic ToolbarItem on demand for `cms:<slug>` insert IDs.
 *  The wrapper is a vertical Stack — the reference renders the same shape and
 *  it gives the user a visual home for ghost copies once binding lands. */
function makeCmsCollectionToolbarItem(slug: string): ToolbarItem {
  return {
    id: `cms:${slug}`,
    elementType: 'div',
    defaultStyles: {
      display: 'flex',
      flexDirection: 'column',
      gap: '12px',
      width: '320px',
      padding: '12px',
      backgroundColor: '#ffffff',
      borderRadius: '8px',
    },
    children: () => [makeCmsPlaceholderItem()],
    ghostSize: { width: 320, height: 280 },
  };
}

/** Build a synthetic ToolbarItem for `cmsField:<slug>:<fieldId>` insert IDs.
 *
 *  Looks up the field's TYPE from the collection schema and picks an
 *  appropriate element + binding target so the drop is immediately
 *  usable (image fields drop as `<img>`, link fields as `<a>`, color
 *  fields as a swatch `<div>`, everything else as `<p>` text).
 *
 *  Two attributes carry the binding intent through to the post-drop
 *  rewrite pass:
 *    - `data-cms-field="<slug>:<fieldId>"` — which collection/field
 *    - `data-cms-bind-target="text"|"src"|"href"|"style:<prop>"` — what
 *      slot of the JSX should be rewritten to `{iter.<fieldId>}`
 *
 *  When the drop lands inside a `.map(…)` ancestor, `bindCmsFieldOnDropInCode`
 *  rewrites that slot in the same flush. Outside a map the element
 *  stays as a usable placeholder (visible text / placeholder image /
 *  swatch color) and the binding lies dormant until the user wraps a
 *  parent in a collection list. */
/** Build a ToolbarItem for a `cmsFieldNav:<slug>:<prev|next>` insert id —
 *  a CMS detail-page navigation link. Drops as a native `<a>` (so the drag
 *  strategy doesn't treat it as a project component) carrying the hint
 *  attrs `data-cms-nav` + `data-cms-collection`; the post-drop pass
 *  (`bindCmsNavLinkOnDropInCode`) rewrites it to a Next.js `<Link>` with
 *  the resolved `href`. syncImports then adds the `next/link` import. */
function makeCmsNavLinkToolbarItem(itemId: string): ToolbarItem | null {
  const rest = itemId.slice('cmsFieldNav:'.length);
  const sepIdx = rest.indexOf(':');
  if (sepIdx === -1) return null;
  const slug = rest.slice(0, sepIdx);
  const direction = rest.slice(sepIdx + 1);
  if (!slug || (direction !== 'prev' && direction !== 'next')) return null;

  return {
    id: itemId,
    elementType: 'a',
    defaultStyles: {
      fontSize: '15px',
      fontWeight: '600',
      color: '#3b82f6',
      textDecorationLine: 'none',
      cursor: 'pointer',
    },
    defaultAttrs: {
      'data-cms-nav': direction,
      'data-cms-collection': slug,
      href: '#',
    },
    textContent: direction === 'prev' ? '← Previous' : 'Next →',
    ghostSize: { width: 130, height: 26 },
  };
}

function makeCmsFieldToolbarItem(itemId: string): ToolbarItem | null {
  const rest = itemId.slice('cmsField:'.length);
  const sepIdx = rest.indexOf(':');
  if (sepIdx === -1) return null;
  const slug = rest.slice(0, sepIdx);
  const fieldId = rest.slice(sepIdx + 1);
  if (!slug || !fieldId) return null;

  // Look up the field's type from the schema. Schemas live in
  // `cms/<slug>.schema.json` and may not exist (deleted collection,
  // typo) — fall back to plain text in that case.
  const schema = getCollectionSchema(slug);
  const field = schema?.fields?.find(f => f.id === fieldId);
  const fieldType = field?.type ?? 'text';
  const baseAttrs: Record<string, string> = { 'data-cms-field': `${slug}:${fieldId}` };

  switch (fieldType) {
    case 'image': {
      // 240×160 placeholder with cover crop — same shape as the regular
      // <Image>/`<img>` drop. The `src` placeholder will be replaced
      // with `{iter.<fieldId>}` if dropped inside a map.
      return {
        id: itemId,
        elementType: 'img',
        defaultStyles: {
          display: 'block',
          width: '240px',
          height: '160px',
          objectFit: 'cover',
          backgroundColor: '#e5e7eb',
        },
        defaultAttrs: { ...baseAttrs, 'data-cms-bind-target': 'src', src: '', alt: '' },
        ghostSize: { width: 240, height: 160 },
      };
    }
    case 'link':
    case 'url': {
      return {
        id: itemId,
        elementType: 'a',
        defaultStyles: {
          fontSize: '16px',
          color: '#3b82f6',
          textDecorationLine: 'underline',
          cursor: 'pointer',
        },
        defaultAttrs: { ...baseAttrs, 'data-cms-bind-target': 'href', href: '#' },
        textContent: field?.name ?? fieldId,
        ghostSize: { width: 160, height: 24 },
      };
    }
    case 'color': {
      // Swatch — small square that the user can resize. Style binding
      // rewrites `backgroundColor: '...'` to `backgroundColor: iter.x`.
      return {
        id: itemId,
        elementType: 'div',
        defaultStyles: {
          width: '48px',
          height: '48px',
          borderRadius: '8px',
          backgroundColor: '#cccccc',
        },
        defaultAttrs: { ...baseAttrs, 'data-cms-bind-target': 'style:backgroundColor' },
        ghostSize: { width: 48, height: 48 },
      };
    }
    case 'file': {
      return {
        id: itemId,
        elementType: 'a',
        defaultStyles: {
          fontSize: '14px',
          color: '#3b82f6',
          textDecorationLine: 'underline',
          cursor: 'pointer',
        },
        defaultAttrs: { ...baseAttrs, 'data-cms-bind-target': 'href', href: '#', target: '_blank' },
        textContent: field?.name ?? fieldId,
        ghostSize: { width: 140, height: 24 },
      };
    }
    default: {
      // text / textarea / richtext / number / boolean / date / enum /
      // tags / slug / reference / multi-reference — all paragraph text.
      // The user can change the tag (h1, span, …) later via the layers
      // panel; the binding survives the tag change.
      return {
        id: itemId,
        elementType: 'p',
        defaultStyles: {
          fontSize: '16px',
          lineHeight: '1.5',
          color: '#111111',
          margin: '0',
        },
        defaultAttrs: { ...baseAttrs, 'data-cms-bind-target': 'text' },
        textContent: field?.name ?? fieldId,
        ghostSize: { width: 200, height: 24 },
      };
    }
  }
}

/**
 * Look up the toolbar item config for an insert panel item ID.
 * Returns null for items not yet supported (code components, creative, embeds, social).
 *
 * `cms:<slug>` IDs are resolved dynamically — they describe a CMS-bound
 * collection list (a stack with a placeholder Item template). The actual
 * binding mutation fires after the add lands; see Canvas.tsx's add path.
 */
export function getToolbarItemConfig(itemId: string): ToolbarItem | null {
  if (itemId.startsWith('cmsFieldNav:')) {
    const item = makeCmsNavLinkToolbarItem(itemId);
    trace.fn('getToolbarItemConfig:cmsFieldNav', { itemId, found: !!item });
    return item;
  }
  if (itemId.startsWith('cmsField:')) {
    const item = makeCmsFieldToolbarItem(itemId);
    trace.fn('getToolbarItemConfig:cmsField', { itemId, found: !!item });
    return item;
  }
  if (itemId.startsWith('cms:')) {
    const slug = itemId.slice('cms:'.length);
    if (!slug) return null;
    const item = makeCmsCollectionToolbarItem(slug);
    trace.fn('getToolbarItemConfig:cms', { slug });
    return item;
  }
  if (itemId.startsWith('cs-')) {
    // Dividers, patterns, gradients (plain <div>s with CSS) take priority
    // over code components because all four share the `cs-` prefix in element-data.
    // Code component fallback handles the noise pack and any future code-component-backed
    // entries (anything that needs JS to render correctly).
    const divider = makeDividerToolbarItem(itemId);
    if (divider) {
      trace.fn('getToolbarItemConfig:divider', { itemId });
      return divider;
    }
    const pattern = makePatternToolbarItem(itemId);
    if (pattern) {
      trace.fn('getToolbarItemConfig:pattern', { itemId });
      return pattern;
    }
    const shader = makeShaderToolbarItem(itemId);
    if (shader) {
      trace.fn('getToolbarItemConfig:shader', { itemId });
      return shader;
    }
    const item = makeCodeSnippetToolbarItem(itemId);
    trace.fn('getToolbarItemConfig:cs', { itemId, found: !!item });
    return item;
  }
  const item = TOOLBAR_ITEMS[itemId] ?? null;
  trace.fn('getToolbarItemConfig', { itemId, found: !!item });
  return item;
}
