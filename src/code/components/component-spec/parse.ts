// component-spec/parse.ts — reverse of compile (for EDITING).
//
// Reads an existing component file back into a ComponentSpec so the AI can edit a
// real component instead of only greenfield. Depth-1: the entry component fully,
// its direct child instances as instance refs (not recursed). The spec is the AI's
// transient working copy — never written to disk.
//
// Lossy by design: `kind` (interactive/responsive/option) isn't stored in the file,
// so it defaults to 'interactive'; auto-wired hover/pressed connections are dropped
// (the compiler re-derives them from interaction-state variants).

import { trace } from '@/shared/debug-trace';
import { parseJSXToNodes, type CanvasNode } from '@/code/parsing/parser';
import { parseVariantConfig } from '@/code/variants/variant-config';
import { parseConnections } from '@/code/variants/connection-config';
import { parseComponentName } from '@/code/components/component-ops';
import { CONDITIONAL_LAYOUT_PROPS } from '@/shared/constants';
import type {
  ComponentSpec,
  SpecVariant,
  SpecElement,
  SpecConnection,
  PaintStyles,
  LayoutStyles,
  VariantOverride,
} from './types';

const MOTION_NUM = new Set(['rotate', 'scale', 'x', 'y', 'skewX', 'skewY', 'opacity']);

/** Parse one component file's code into a ComponentSpec. `specName` is the handle
 *  to give it (usually its registry name). */
export function parseComponentSpec(code: string, specName: string): ComponentSpec {
  trace.fn('component-spec.parseComponentSpec', { specName });

  const nodes = parseJSXToNodes(code);
  const variantConfig = parseVariantConfig(code);
  const variantNames = variantConfig.map((v) => v.name);
  const allVariants = variantNames.length > 0 ? variantNames : ['default'];
  const interactionNames = new Set(variantConfig.filter((v) => v.interactionType).map((v) => v.name));

  const variants: SpecVariant[] = variantConfig.map((v): SpecVariant => {
    const out: SpecVariant = { name: v.name, label: v.label, kind: 'interactive' };
    if (v.interactionType && v.parentVariant) {
      out.interaction = { type: v.interactionType === 'pressed' ? 'pressed' : 'hover', of: v.parentVariant };
    }
    return out;
  });

  // root = node with no parent (parser unwraps LayoutGroup/MotionConfig already)
  let rootId = '';
  const elements: SpecElement[] = [];
  for (const node of nodes.values()) {
    if (node.parentId == null) rootId = node.id;
    elements.push(nodeToElement(node, allVariants));
  }
  // fallback: first element
  if (!rootId && elements.length > 0) rootId = elements[0].id;

  const connections: SpecConnection[] = parseConnections(code)
    // drop auto-wired hover/pressed — compiler regenerates them from interaction states
    .filter((c) => !interactionNames.has(c.from) && !interactionNames.has(c.to))
    .map((c) => {
      const out: SpecConnection = { from: c.from, to: c.to, trigger: c.trigger };
      if (c.delay != null) out.delay = c.delay;
      if (c.sourceNode) out.sourceElement = c.sourceNode;
      return out;
    });

  return {
    name: specName,
    displayName: parseComponentName(code) || specName,
    isNew: false,
    variants,
    rootId,
    elements,
    connections,
  };
}

function nodeToElement(node: CanvasNode, allVariants: string[]): SpecElement {
  const visibleIn = allVariants.filter((v) => !node.hiddenOnVariants?.has(v));
  const base = { id: node.id, name: node.name || undefined, visibleIn, children: node.children.length ? [...node.children] : undefined };

  // nested component instance — flagged by project expansion, or (standalone
  // parse) recognizable by a PascalCase tag name.
  if (node.isComponentInstance || node.componentFile || /^[A-Z]/.test(node.type)) {
    const component = node.componentFile ? basename(node.componentFile) : node.type;
    const inner = node.attrConditional?.initialVariant;
    const innerVariantByParent = inner
      ? Object.entries(inner).filter(([p]) => p !== 'default').map(([parent, child]) => ({ parent, child }))
      : undefined;
    const styleOverrides = pickWrapperOnly(node.styles);
    return {
      kind: 'instance',
      ...base,
      component,
      ...(innerVariantByParent && innerVariantByParent.length ? { innerVariantByParent } : {}),
      ...(inner?.default ? { defaultInnerVariant: inner.default } : node.attrs?.initialVariant ? { defaultInnerVariant: stripQuotes(node.attrs.initialVariant) } : {}),
      ...(styleOverrides ? { styleOverrides } : {}),
    } as SpecElement;
  }

  // plain element — split styles into base paint/layout, deltas into variantStyles
  const basePaint: PaintStyles = {};
  const baseLayout: LayoutStyles = {};
  for (const [k, val] of Object.entries(node.styles)) {
    if (k === 'order' || k.startsWith('--')) continue;
    if (CONDITIONAL_LAYOUT_PROPS.has(k)) (baseLayout as Record<string, unknown>)[k] = val;
    else (basePaint as Record<string, unknown>)[k] = coerce(k, val);
  }
  // motionVariants default → base paint
  for (const [k, val] of Object.entries(node.motionVariants?.default ?? {})) {
    (basePaint as Record<string, unknown>)[k] = coerce(k, val);
  }
  // conditionalStyles default branch → base layout
  for (const [prop, byVariant] of Object.entries(node.conditionalStyles ?? {})) {
    if (prop === 'order') continue;
    if (byVariant.default !== undefined && CONDITIONAL_LAYOUT_PROPS.has(prop)) (baseLayout as Record<string, unknown>)[prop] = byVariant.default;
  }

  // per-variant deltas
  const variantStyles: VariantOverride[] = [];
  for (const variant of allVariants) {
    if (variant === 'default') continue;
    const paint: PaintStyles = {};
    const layout: LayoutStyles = {};
    for (const [k, val] of Object.entries(node.motionVariants?.[variant] ?? {})) (paint as Record<string, unknown>)[k] = coerce(k, val);
    for (const [prop, byVariant] of Object.entries(node.conditionalStyles ?? {})) {
      if (prop === 'order') continue;
      if (byVariant[variant] !== undefined && CONDITIONAL_LAYOUT_PROPS.has(prop)) (layout as Record<string, unknown>)[prop] = byVariant[variant];
    }
    if (Object.keys(paint).length || Object.keys(layout).length) {
      variantStyles.push({ variant, ...(Object.keys(paint).length ? { paint } : {}), ...(Object.keys(layout).length ? { layout } : {}) });
    }
  }

  // order ternary
  const orderMap = node.conditionalStyles?.order;
  const order = orderMap
    ? allVariants.filter((v) => orderMap[v] !== undefined).map((v) => ({ variant: v, order: Number(orderMap[v]) }))
    : undefined;

  return {
    kind: 'element',
    ...base,
    tag: node.type as SpecElement extends { tag: infer T } ? T : never,
    ...(node.textContent && node.children.length === 0 ? { text: node.textContent } : {}),
    base: { paint: basePaint, layout: baseLayout },
    ...(variantStyles.length ? { variantStyles } : {}),
    ...(order && order.length ? { order } : {}),
  } as SpecElement;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function coerce(k: string, v: string): string | number {
  if (MOTION_NUM.has(k) && /^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

const WRAPPER_KEYS = new Set(['position', 'left', 'top', 'right', 'bottom', 'transform', 'margin', 'alignSelf', 'order']);
function pickWrapperOnly(styles: Record<string, string>): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(styles)) {
    if (WRAPPER_KEYS.has(k)) out[k] = k === 'order' ? Number(v) : v;
  }
  return Object.keys(out).length ? out : null;
}

function basename(path: string): string {
  const f = path.split('/').pop() ?? path;
  return f.replace(/\.tsx?$/, '');
}

function stripQuotes(s: string): string {
  return s.replace(/^['"]|['"]$/g, '');
}
