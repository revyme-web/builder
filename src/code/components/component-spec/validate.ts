// component-spec/validate.ts — the semantic net (gate 2 of 3).
//
// The structured-output schema (gate 1, server-side) guarantees the bundle is
// SHAPE-valid. This pass catches the SEMANTIC rules a schema can't express, BEFORE
// compile, so violations bounce back to the model with a precise reason. The real
// parser+resolver (gate 3, resolve-check) is the final ground-truth check.
//
// Pure function — no DOM, no generators, fully unit-testable.

import { trace } from '@/shared/debug-trace';
import type {
  ComponentBundle,
  ComponentSpec,
  SpecElement,
  Violation,
} from './types';
import { isInstanceElement, isPlainElement } from './types';

/** Validate a bundle. `existingComponents` = names already on disk (registry),
 *  so an instance can reference a component that isn't (re)defined in this bundle.
 *  Returns [] when the bundle is sound. */
export function validateBundle(
  bundle: ComponentBundle,
  existingComponents: ReadonlySet<string> = new Set(),
): Violation[] {
  const v: Violation[] = [];
  trace.fn('component-spec.validateBundle', {
    entry: bundle.entry,
    components: bundle.components.length,
    existing: existingComponents.size,
  });

  const bundleNames = new Set(bundle.components.map((c) => c.name));

  // R9 — entry resolves
  if (!bundleNames.has(bundle.entry)) {
    v.push({ code: 'BAD_ENTRY', message: `entry "${bundle.entry}" is not one of the bundle's components.` });
  }

  // duplicate component names
  if (bundleNames.size !== bundle.components.length) {
    v.push({ code: 'DUP_COMPONENT', message: 'two components share a name.' });
  }

  // a component instance may reference a bundle component OR an existing one
  const knownComponents = new Set<string>([...bundleNames, ...existingComponents]);

  for (const spec of bundle.components) {
    validateSpec(spec, knownComponents, v);
  }

  if (v.length > 0) trace.action('component-spec:validate-violations', { count: v.length, codes: v.map((x) => x.code) });
  return v;
}

function validateSpec(spec: ComponentSpec, knownComponents: ReadonlySet<string>, v: Violation[]): void {
  const tag = (extra: Partial<Violation>): Violation => ({ component: spec.name, ...extra } as Violation);

  // ── variants ──────────────────────────────────────────────────────────────
  const variantNames = new Set<string>();
  for (const vr of spec.variants) {
    if (variantNames.has(vr.name)) v.push(tag({ code: 'DUP_VARIANT', variant: vr.name, message: `duplicate variant "${vr.name}".` }));
    variantNames.add(vr.name);
  }
  if (spec.variants.length === 0) {
    v.push(tag({ code: 'NO_VARIANTS', message: 'a component needs at least one variant.' }));
    return; // nothing else is checkable
  }
  // primary = first variant by convention (compiler marks isPrimary on [0])
  const primaryName = spec.variants[0].name;

  // interaction states reference a real `of`
  for (const vr of spec.variants) {
    if (vr.interaction && !variantNames.has(vr.interaction.of)) {
      v.push(tag({ code: 'BAD_INTERACTION_OF', variant: vr.name, message: `interaction state "${vr.name}" references unknown source variant "${vr.interaction.of}".` }));
    }
  }

  // ── elements: kind bridge + ids + visibility + tree ─────────────────────────
  const elementIds = new Set<string>();
  const byId = new Map<string, SpecElement>();
  for (const el of spec.elements) {
    if (elementIds.has(el.id)) v.push(tag({ code: 'DUP_ELEMENT_ID', elementId: el.id, message: `duplicate element id "${el.id}".` }));
    elementIds.add(el.id);
    byId.set(el.id, el);

    // R0 — kind/field bridge (schema is flat; enforce the conditional requireds)
    if (isPlainElement(el)) {
      if (!el.tag) v.push(tag({ code: 'MISSING_TAG', elementId: el.id, message: `element "${el.id}" (kind=element) needs a tag.` }));
      if (!el.base) v.push(tag({ code: 'MISSING_BASE', elementId: el.id, message: `element "${el.id}" (kind=element) needs base styles.` }));
    } else if (isInstanceElement(el)) {
      if (!el.component) {
        v.push(tag({ code: 'MISSING_COMPONENT', elementId: el.id, message: `instance "${el.id}" needs a component.` }));
      } else if (!knownComponents.has(el.component)) {
        v.push(tag({ code: 'UNKNOWN_COMPONENT', elementId: el.id, message: `instance "${el.id}" references unknown component "${el.component}".` }));
      }
    }

    // R1 — no dead element (schema enforces minItems:1, but verify + real names)
    if (!el.visibleIn || el.visibleIn.length === 0) {
      v.push(tag({ code: 'DEAD_ELEMENT', elementId: el.id, message: `element "${el.id}" is visible in no variant.` }));
    }
    for (const name of el.visibleIn ?? []) {
      if (!variantNames.has(name)) v.push(tag({ code: 'BAD_VARIANT_REF', elementId: el.id, variant: name, message: `element "${el.id}" visibleIn references unknown variant "${name}".` }));
    }

    // NOTE: offsets (left/top/right/bottom) without a position are NOT a
    // violation — they're CSS-inert, and the compiler's normalizeSpec strips
    // them, so bouncing would burn a retry on something rendering identically.
    // The prompt still teaches "offsets require position" up front.

    // per-variant refs
    if (isPlainElement(el)) {
      for (const ov of el.variantStyles ?? []) {
        if (!variantNames.has(ov.variant)) v.push(tag({ code: 'BAD_VARIANT_REF', elementId: el.id, variant: ov.variant, message: `element "${el.id}" variantStyles references unknown variant "${ov.variant}".` }));
      }
      for (const ob of el.order ?? []) {
        if (!variantNames.has(ob.variant)) v.push(tag({ code: 'BAD_VARIANT_REF', elementId: el.id, variant: ob.variant, message: `element "${el.id}" order references unknown variant "${ob.variant}".` }));
      }
    } else {
      for (const ivp of el.innerVariantByParent ?? []) {
        if (!variantNames.has(ivp.parent)) v.push(tag({ code: 'BAD_VARIANT_REF', elementId: el.id, variant: ivp.parent, message: `instance "${el.id}" innerVariantByParent references unknown PARENT variant "${ivp.parent}".` }));
        // child variant is the OTHER component's — not checkable here; resolve-check covers it
      }
    }
  }

  // R6 — root exists + tree is sound (connected, no cycles, no orphans)
  if (!elementIds.has(spec.rootId)) {
    v.push(tag({ code: 'BAD_ROOT', message: `rootId "${spec.rootId}" is not an element.` }));
  } else {
    validateTree(spec, byId, v, tag);
  }

  // ── connections ─────────────────────────────────────────────────────────────
  for (const c of spec.connections) {
    if (!variantNames.has(c.from)) v.push(tag({ code: 'BAD_CONNECTION_VARIANT', variant: c.from, message: `connection.from "${c.from}" is not a variant.` }));
    if (!variantNames.has(c.to)) v.push(tag({ code: 'BAD_CONNECTION_VARIANT', variant: c.to, message: `connection.to "${c.to}" is not a variant.` }));
    if (c.sourceElement && !elementIds.has(c.sourceElement)) v.push(tag({ code: 'BAD_SOURCE_ELEMENT', elementId: c.sourceElement, message: `connection.sourceElement "${c.sourceElement}" is not an element.` }));
    if (c.trigger !== 'inView' && c.delay != null) v.push(tag({ code: 'DELAY_ON_NON_INVIEW', message: `delay is only valid on inView connections (trigger="${c.trigger}").` }));
    // hover/pressed must be auto-wired, not hand-written
    const toV = spec.variants.find((x) => x.name === c.to);
    const fromV = spec.variants.find((x) => x.name === c.from);
    if (toV?.interaction || fromV?.interaction) {
      v.push(tag({ code: 'MANUAL_INTERACTION_CONNECTION', message: `connection ${c.from}→${c.to} touches an interaction-state variant; hover/pressed are auto-wired — remove the manual connection.` }));
    }
  }

  // R3 — interactive variants must be reachable
  const reached = new Set<string>(spec.connections.map((c) => c.to));
  // interaction targets are reachable via their auto-wired connections
  for (const vr of spec.variants) if (vr.interaction) reached.add(vr.name);
  for (const vr of spec.variants) {
    if (vr.kind === 'interactive' && vr.name !== primaryName && !vr.interaction && !reached.has(vr.name)) {
      v.push(tag({ code: 'UNREACHABLE_VARIANT', variant: vr.name, message: `interactive variant "${vr.name}" has no connection leading to it — it is unreachable.` }));
    }
  }
}

/** Verify children edges are valid, acyclic, and every element is reachable from root. */
function validateTree(
  spec: ComponentSpec,
  byId: Map<string, SpecElement>,
  v: Violation[],
  tag: (extra: Partial<Violation>) => Violation,
): void {
  // edges valid
  for (const el of spec.elements) {
    for (const cid of el.children ?? []) {
      if (!byId.has(cid)) v.push(tag({ code: 'BAD_CHILD_REF', elementId: el.id, message: `element "${el.id}" lists unknown child "${cid}".` }));
    }
  }
  // reachable from root + cycle detection (DFS)
  const seen = new Set<string>();
  const stack = new Set<string>();
  let cyclic = false;
  const visit = (id: string): void => {
    if (stack.has(id)) { cyclic = true; return; }
    if (seen.has(id)) return;
    seen.add(id); stack.add(id);
    for (const cid of byId.get(id)?.children ?? []) if (byId.has(cid)) visit(cid);
    stack.delete(id);
  };
  visit(spec.rootId);
  if (cyclic) v.push(tag({ code: 'CYCLIC_TREE', message: 'element tree has a cycle.' }));

  const orphans = spec.elements.filter((el) => !seen.has(el.id));
  // The model's most common failure is a FLAT element list — no `children` arrays
  // at all, so EVERYTHING but the root is an orphan. Twenty per-element messages
  // don't tell it HOW to fix that; one targeted instruction does. Only fires when
  // the list is genuinely flat (zero tree edges anywhere) — a partially wired tree
  // gets precise per-element orphan messages instead.
  const anyEdges = spec.elements.some((el) => (el.children?.length ?? 0) > 0);
  if (orphans.length > 0 && !anyEdges) {
    v.push(tag({
      code: 'TREE_NOT_WIRED',
      message: `elements[] is a flat list — no element lists any children, so nothing is reachable from root "${spec.rootId}". Build the TREE: give every container a children array of its child ids (e.g. root.children = ["header-inner"], header-inner.children = ["logo","nav",…]) and [] for leaves. Every element except the root must appear in exactly ONE parent's children.`,
    }));
    return;
  }
  for (const el of orphans) {
    v.push(tag({ code: 'ORPHAN_ELEMENT', elementId: el.id, message: `element "${el.id}" is not reachable from root "${spec.rootId}" — add "${el.id}" to its parent's children array.` }));
  }
}
