// component-var-detach-gen.ts — Detach / rehydrate COMPONENT-VARIABLE bindings
// when a node is dragged OUT of a design-component's render onto the module-scope
// `canvasNodes` fragment, or BACK INTO the component render.
//
// Why this exists (source = deploy reality):
//   Inside a component function a node can bind props to its text content
//   (`<p>{bio}</p>`), its inline style (`backgroundImage: image`), or an attribute
//   (`href={emailHref}`). `canvasNodes` lives OUTSIDE that function (module scope),
//   so once a node is dragged there those identifiers are undefined → the oracle
//   blocks the move ("References undefined identifier: bio — would crash at
//   runtime"). On EXIT we swap each ref for the prop's DEFAULT value (paints fine,
//   no crash) and stash the binding in
//   `data-var-orphan="content:bio,style.backgroundImage:image,attr.href:emailHref"`.
//   The parser reads it back and shows the SAME purple variable pill. On ENTRY back
//   into the component render we restore each live binding.
//
// This is the component-variable analogue of cms-detach-gen.ts (which does the
// same round-trip for `prop={item.field}` CMS bindings across a `.map()` boundary).

import * as t from '@babel/types';
import { parseJSX, findFirstElementByDataId } from '../parsing/ast-utils';
import { extractComponentPropDefaults, type CanvasNode } from '../parsing/parser';
import { generate } from './generator-utils';
import { readTransitionVarRef } from './generator-motion';
import { trace } from '@/shared/debug-trace';

const VAR_ORPHAN_ATTR = 'data-var-orphan';

/**
 * True when `nodeId` lives in the module-scope `const canvasNodes = <>…</>`
 * fragment (which always sits AFTER `export default`), where component props are
 * out of scope. Used to route variable SET/REMOVE on a canvas node through the
 * orphan form (dormantize / clearVarOrphan) instead of writing a live `{prop}`
 * ref that would crash at module load. A node's id is unique, so "appears after
 * the `const canvasNodes` declaration" ⇔ "is a canvas node".
 */
export function isCanvasNode(code: string, nodeId: string): boolean {
  const cnIdx = code.search(/\bconst\s+canvasNodes\b/);
  if (cnIdx === -1) return false;
  const idIdx = code.indexOf(`data-id="${nodeId}"`);
  return idIdx !== -1 && idIdx > cnIdx;
}

/** A remembered binding. `content` has no target; `style`/`attr` target a CSS
 *  property (camelCase or `--custom`) / attribute name respectively. */
export type VarOrphanEntry =
  | { kind: 'content'; prop: string }
  | { kind: 'style'; target: string; prop: string }
  | { kind: 'attr'; target: string; prop: string }
  // A framer-motion `transition` VARIABLE (the prop the node's `transition={…}` resolved to for the variant it
  // was dragged from). Stashed like `content` (no target) so a per-variant transition variable on a dragged-out
  // node survives + the Styles Transition control still shows its pill; restored on re-entry.
  | { kind: 'transition'; prop: string };

/** `"content:bio,style.backgroundImage:image"` → entries. Tolerant of junk. */
export function parseVarOrphanBindings(value: string): VarOrphanEntry[] {
  const out: VarOrphanEntry[] = [];
  for (const raw of value.split(',')) {
    const pair = raw.trim();
    if (!pair) continue;
    const ci = pair.indexOf(':');
    if (ci === -1) continue;
    const key = pair.slice(0, ci);
    const prop = pair.slice(ci + 1);
    if (!prop) continue;
    const di = key.indexOf('.');
    if (di === -1) {
      if (key === 'content') out.push({ kind: 'content', prop });
      else if (key === 'transition') out.push({ kind: 'transition', prop });
      continue;
    }
    const kind = key.slice(0, di);
    const target = key.slice(di + 1);
    if (!target) continue;
    if (kind === 'style') out.push({ kind: 'style', target, prop });
    else if (kind === 'attr') out.push({ kind: 'attr', target, prop });
  }
  return out;
}

export function serializeVarOrphanBindings(entries: VarOrphanEntry[]): string {
  return entries
    .map((e) => (e.kind === 'content' || e.kind === 'transition' ? `${e.kind}:${e.prop}` : `${e.kind}.${e.target}:${e.prop}`))
    .join(',');
}

/** Identity of a binding SLOT (one per content / per style-prop / per attr / the transition). */
function entryKey(e: VarOrphanEntry): string {
  return e.kind === 'content' || e.kind === 'transition' ? e.kind : `${e.kind}.${e.target}`;
}

/** Read the variant a replica node was solo'd to (`data-replica-solo="variant-1"`), used to pick the right
 *  branch of a per-variant `transition={variant === 'v' ? tN : …}` ternary. null = base/primary. */
function replicaSoloVariant(el: t.JSXElement): string | null {
  const a = el.openingElement.attributes.find(
    (x): x is t.JSXAttribute => x.type === 'JSXAttribute' && x.name.type === 'JSXIdentifier' && x.name.name === 'data-replica-solo',
  );
  return a?.value?.type === 'StringLiteral' ? a.value.value : null;
}

/** The transition VARIABLE the node's `transition={…}` resolves to for `variant` (null = base): walks an
 *  `Identifier` (base var) or a `variant === 'v' ? tN : …` ternary chain, returning the prop name (a transition
 *  prop — its `{}` default keeps it OUT of `propDefaults`, so the codegen shape is the contract, not a lookup).
 *  Returns null for a literal `{{…}}` / `undefined` branch (no variable to stash). */
function transitionVarForVariant(expr: t.Expression | t.JSXEmptyExpression, variant: string | null): string | null {
  const ident = (e: t.Node): string | null => (e.type === 'Identifier' && e.name !== 'undefined' ? e.name : null);
  if (expr.type === 'Identifier') return ident(expr);
  if (expr.type === 'ConditionalExpression') {
    const test = expr.test;
    if (
      test.type === 'BinaryExpression' && test.left.type === 'Identifier' &&
      (test.left.name === 'variant' || test.left.name === 'initialVariant') && test.right.type === 'StringLiteral'
    ) {
      if (variant && test.right.value === variant) return ident(expr.consequent);
      return transitionVarForVariant(expr.alternate, variant);
    }
  }
  return null;
}

/**
 * Resolve the EFFECTIVE component-variable bindings a node shows on `variantKey`
 * (the variant/replica a clone-detach is sourced from) as orphan entries —
 * following the per-variant truth, mirroring `ControlProvider.getValueSource`:
 *   • content: a per-variant variable branch wins; a per-variant LITERAL override
 *     means "removed here" (no var); else the ternary fallback / global
 *     `textVariable` (inherited).
 *   • style (per prop): same precedence over `conditionalStyleVariables` /
 *     `conditionalStyles` / `styleVariables`.
 * `variantKey` is undefined for a page-replica / primary exit → falls to the global
 * binding. So a clone-detached replica keeps exactly the variable it inherited or
 * overrode: inherited → attach, removed-only-here → no attach, only-here → attach.
 *
 * The CLONE-PATH counterpart of `dormantizeComponentVarBindings` (which reads JSX on
 * the move path); this reads the PARSED node metadata, which the clone builds from.
 */
export function resolveVarOrphansForVariant(node: CanvasNode, variantKey: string | undefined, code?: string): VarOrphanEntry[] {
  const out: VarOrphanEntry[] = [];

  // TRANSITION variable — the node model doesn't parse the per-variant transition, so read it from the live JSX
  // for the source variant (the node's OWN element ternary; a node that merely inherits the MotionConfig returns
  // null → no stash → Default, per "follow the actual node"). Needs `code` (clone strategies pass it).
  if (code) {
    const txVar = readTransitionVarRef(code, node.id, variantKey ? 'variantEntry' : 'elementProp', variantKey ?? null, false);
    if (txVar) out.push({ kind: 'transition', prop: txVar });
  }

  // CONTENT. Precedence: this variant's own variable branch → this variant's
  // LITERAL override (removed here) → ternary fallback variable → global binding.
  const ctv = node.conditionalTextVariable;
  const contentLiteralHere = !!(variantKey && node.conditionalText && variantKey in node.conditionalText);
  let contentVar: string | undefined;
  if (variantKey && ctv?.[variantKey]) contentVar = ctv[variantKey];
  else if (contentLiteralHere) contentVar = undefined;
  else contentVar = ctv?.['default'] ?? node.textVariable;
  if (contentVar) out.push({ kind: 'content', prop: contentVar });

  // STYLE (per prop) — union of globally- and per-variant-bound props, same precedence.
  const styleProps = new Set<string>([
    ...Object.keys(node.styleVariables ?? {}),
    ...Object.keys(node.conditionalStyleVariables ?? {}),
  ]);
  for (const prop of styleProps) {
    const csv = node.conditionalStyleVariables?.[prop];
    const literalHere = !!(variantKey && node.conditionalStyles?.[prop] && variantKey in node.conditionalStyles[prop]);
    let styleVar: string | undefined;
    if (variantKey && csv?.[variantKey]) styleVar = csv[variantKey];
    else if (literalHere) styleVar = undefined; // shadowed by a per-variant literal
    else styleVar = csv?.['default'] ?? node.styleVariables?.[prop];
    if (styleVar) out.push({ kind: 'style', target: prop, prop: styleVar });
  }

  return out;
}

function styleKeyName(key: t.ObjectProperty['key']): string | null {
  if (key.type === 'Identifier') return key.name;
  if (key.type === 'StringLiteral') return key.value;
  return null;
}

function getElement(ast: ReturnType<typeof parseJSX>, nodeId: string): t.JSXElement | null {
  if (!ast) return null;
  let found: t.JSXElement | null = null;
  findFirstElementByDataId(ast, nodeId, (_path, el) => { found = el as unknown as t.JSXElement; });
  return found;
}

function findOrphanAttr(el: t.JSXElement): t.JSXAttribute | undefined {
  return el.openingElement.attributes.find(
    (a): a is t.JSXAttribute =>
      a.type === 'JSXAttribute' && a.name.type === 'JSXIdentifier' && a.name.name === VAR_ORPHAN_ATTR,
  );
}

/** Collect a JSXElement and ALL its descendant JSXElements (depth-first). Drag-out
 *  moves a whole subtree, so bound descendants must be processed too. */
function collectElements(root: t.JSXElement, out: t.JSXElement[]): void {
  out.push(root);
  const walk = (children: readonly t.Node[]) => {
    for (const child of children) {
      if (child.type === 'JSXElement') collectElements(child, out);
      else if (child.type === 'JSXFragment') walk(child.children);
    }
  };
  walk(root.children);
}

/** Orphan ONE element's prop refs (content/style/attr) → defaults + `data-var-orphan`.
 *  Mutates `el`; returns true if anything changed. */
function dormantizeElement(el: t.JSXElement, propDefaults: Record<string, string>): boolean {
  const found: VarOrphanEntry[] = [];

  // 1) Text content: a `{Identifier}` child whose name is a component prop.
  for (let i = 0; i < el.children.length; i++) {
    const child = el.children[i];
    if (
      child.type === 'JSXExpressionContainer' &&
      child.expression.type === 'Identifier' &&
      child.expression.name in propDefaults
    ) {
      const prop = child.expression.name;
      found.push({ kind: 'content', prop });
      // `{"default"}` (a string-literal expression) is read back as textContent by
      // the parser AND is safe for any `<`/`{` chars, unlike raw JSX text.
      el.children[i] = t.jsxExpressionContainer(t.stringLiteral(propDefaults[prop]));
    }
  }

  // 2) Style values + plain attributes on the opening tag.
  for (const attr of el.openingElement.attributes) {
    if (attr.type !== 'JSXAttribute' || attr.name.type !== 'JSXIdentifier') continue;
    const attrName = attr.name.name;
    if (
      attrName === 'style' &&
      attr.value?.type === 'JSXExpressionContainer' &&
      attr.value.expression.type === 'ObjectExpression'
    ) {
      for (const p of attr.value.expression.properties) {
        if (p.type !== 'ObjectProperty') continue;
        if (p.value.type === 'Identifier' && p.value.name in propDefaults) {
          const target = styleKeyName(p.key);
          if (!target) continue;
          found.push({ kind: 'style', target, prop: p.value.name });
          p.value = t.stringLiteral(propDefaults[p.value.name]);
        }
      }
    } else if (
      attrName !== 'style' &&
      attr.value?.type === 'JSXExpressionContainer' &&
      attr.value.expression.type === 'Identifier' &&
      attr.value.expression.name in propDefaults
    ) {
      const prop = attr.value.expression.name;
      found.push({ kind: 'attr', target: attrName, prop });
      attr.value = t.stringLiteral(propDefaults[prop]);
    }
  }

  // 3) framer-motion `transition` VARIABLE — `transition={variant === 'v' ? tN : …}` (per-variant) or
  //    `transition={tN}` (base). Stash the var the node resolves to for ITS solo variant + DROP the attr (the ref
  //    is undefined at module scope). A literal `transition={{…}}` (no var) is left for the canvas stripper to keep.
  const transAttr = el.openingElement.attributes.find(
    (a): a is t.JSXAttribute => a.type === 'JSXAttribute' && a.name.type === 'JSXIdentifier' && a.name.name === 'transition',
  );
  if (transAttr && transAttr.value?.type === 'JSXExpressionContainer') {
    const tVar = transitionVarForVariant(transAttr.value.expression, replicaSoloVariant(el));
    if (tVar) {
      found.push({ kind: 'transition', prop: tVar });
      el.openingElement.attributes = el.openingElement.attributes.filter((a) => a !== transAttr);
    }
  }

  if (found.length === 0) return false;

  // Merge into any existing stash on this element (last write per slot).
  const existing = findOrphanAttr(el);
  const merged: VarOrphanEntry[] =
    existing && existing.value?.type === 'StringLiteral' ? parseVarOrphanBindings(existing.value.value) : [];
  for (const f of found) {
    const k = entryKey(f);
    const idx = merged.findIndex((m) => entryKey(m) === k);
    if (idx >= 0) merged[idx] = f;
    else merged.push(f);
  }
  const serialized = serializeVarOrphanBindings(merged);
  if (existing) existing.value = t.stringLiteral(serialized);
  else el.openingElement.attributes.push(t.jsxAttribute(t.jsxIdentifier(VAR_ORPHAN_ATTR), t.stringLiteral(serialized)));
  return true;
}

/** Restore ONE element's orphaned bindings from `data-var-orphan`, dropping the
 *  stash. Skips props that no longer exist. Mutates `el`; returns true if it had a
 *  stash to act on. */
function rehydrateElement(el: t.JSXElement, propDefaults: Record<string, string>): boolean {
  const orphanAttr = findOrphanAttr(el);
  if (!orphanAttr || orphanAttr.value?.type !== 'StringLiteral') return false;
  for (const e of parseVarOrphanBindings(orphanAttr.value.value)) {
    // A transition var has an OBJECT default so it's not in propDefaults — restore it regardless (it's a stable
    // function param). Other kinds: skip if the prop was removed (keep the baked default, never re-add undefined).
    if (e.kind !== 'transition' && !(e.prop in propDefaults)) continue;
    if (e.kind === 'content') el.children = [t.jsxExpressionContainer(t.identifier(e.prop))];
    else if (e.kind === 'style') setStyleProp(el, e.target, t.identifier(e.prop));
    else if (e.kind === 'transition') setAttr(el, 'transition', t.jsxExpressionContainer(t.identifier(e.prop)));
    else setAttr(el, e.target, t.jsxExpressionContainer(t.identifier(e.prop)));
  }
  el.openingElement.attributes = el.openingElement.attributes.filter((a) => a !== orphanAttr);
  return true;
}

/**
 * EXIT: a node (and its whole subtree) is leaving the component render for module-
 * scope `canvasNodes`. Orphan every component-prop reference on the root AND every
 * descendant (text content `{prop}`, style value `key: prop`, attribute `x={prop}`)
 * — swap each for the prop's literal DEFAULT and stash in `data-var-orphan`. Must
 * run BEFORE the move bakes style refs to flat literals. No-op on a non-component
 * file (no prop defaults) or a subtree that references no props.
 */
export function dormantizeComponentVarBindings(code: string, nodeId: string): string {
  if (!code.includes(`data-id="${nodeId}"`)) return code;
  const ast = parseJSX(code);
  if (!ast) return code;
  const propDefaults = extractComponentPropDefaults(ast);
  if (Object.keys(propDefaults).length === 0) return code;
  const root = getElement(ast, nodeId);
  if (!root) return code;

  const elements: t.JSXElement[] = [];
  collectElements(root, elements);
  let changed = 0;
  for (const el of elements) if (dormantizeElement(el, propDefaults)) changed++;
  if (changed === 0) return code;

  try {
    const out = generate(ast).code;
    trace.action('var-detach:dormantize', { nodeId, nodes: changed });
    return out;
  } catch (err) {
    trace.error('var-detach:dormantize-failed', { nodeId, error: err instanceof Error ? err.message : String(err) });
    return code;
  }
}

/** The transition VARIABLE stashed in a node's `data-var-orphan` (its prop name, e.g. `transition5`), or null.
 *  Lets the Styles Transition control show the pill for a dragged-out CANVAS NODE whose per-variant transition
 *  was dormantized — the live `transition={tN}` ref can't exist at module scope, so the pill reads the stash. */
export function readTransitionOrphanVar(code: string, nodeId: string): string | null {
  if (!code.includes(VAR_ORPHAN_ATTR)) return null;
  const ast = parseJSX(code);
  const el = getElement(ast, nodeId);
  if (!el) return null;
  const orphan = findOrphanAttr(el);
  if (!orphan || orphan.value?.type !== 'StringLiteral') return null;
  const tx = parseVarOrphanBindings(orphan.value.value).find((e) => e.kind === 'transition');
  return tx ? tx.prop : null;
}

/**
 * ENTRY: a node (and its subtree) is back inside the component render. Restore each
 * remembered binding on the root AND every descendant, then drop the stashes. Only
 * restores props that still exist (a removed/renamed prop stays at its default —
 * never re-introduces an undefined identifier). No-op when nothing carries a stash.
 */
export function rehydrateComponentVarBindings(code: string, nodeId: string): string {
  if (!code.includes(VAR_ORPHAN_ATTR)) return code;
  const ast = parseJSX(code);
  if (!ast) return code;
  const root = getElement(ast, nodeId);
  if (!root) return code;
  const propDefaults = extractComponentPropDefaults(ast);

  const elements: t.JSXElement[] = [];
  collectElements(root, elements);
  let changed = 0;
  for (const el of elements) if (rehydrateElement(el, propDefaults)) changed++;
  if (changed === 0) return code;

  try {
    const out = generate(ast).code;
    trace.action('var-detach:rehydrate', { nodeId, nodes: changed });
    return out;
  } catch (err) {
    trace.error('var-detach:rehydrate-failed', { nodeId, error: err instanceof Error ? err.message : String(err) });
    return code;
  }
}

/**
 * Clear ONE orphaned binding (the pill's ×) → that slot stays at the prop's
 * default and won't re-bind on a later re-entry. `target` is the slot id:
 * `'content'`, `'style.backgroundImage'`, or `'attr.href'`. Drops the whole attr
 * once empty.
 */
export function clearVarOrphanInCode(code: string, nodeId: string, target: string): string {
  if (!code.includes(VAR_ORPHAN_ATTR)) return code;
  const ast = parseJSX(code);
  if (!ast) return code;
  const el = getElement(ast, nodeId);
  if (!el) return code;
  const orphanAttr = findOrphanAttr(el);
  if (!orphanAttr || orphanAttr.value?.type !== 'StringLiteral') return code;

  const remaining = parseVarOrphanBindings(orphanAttr.value.value).filter((e) => entryKey(e) !== target);
  if (remaining.length) {
    orphanAttr.value = t.stringLiteral(serializeVarOrphanBindings(remaining));
  } else {
    el.openingElement.attributes = el.openingElement.attributes.filter((a) => a !== orphanAttr);
  }

  // Clearing the CONTENT slot: the dormant default lives as a `{"literal"}`
  // expression child (chosen so it round-trips any chars). Once it's no longer a
  // variable it must become a PLAIN text node — otherwise the text editor appends
  // the next edit beside the expression instead of replacing it (duplicate text).
  // Collapse ALL children to one JSXText of the literal value (safe chars only;
  // a value with `<`/`{`/`}` keeps the expression form). Also heals a node already
  // showing duplicate text from this bug.
  if (target === 'content') normalizeLiteralContentToText(el);

  try {
    const out = generate(ast).code;
    trace.action('var-detach:clear-orphan', { nodeId, target, remaining: remaining.length });
    return out;
  } catch (err) {
    trace.error('var-detach:clear-orphan-failed', { nodeId, error: err instanceof Error ? err.message : String(err) });
    return code;
  }
}

/**
 * Collapse a node's children to a single plain `JSXText` of its `{"literal"}`
 * content child, so an unbound text node edits normally (no duplicate text). Heals
 * a node that already accumulated extra text children. No-op if there's no string-
 * literal expression child, or its value has JSX-unsafe chars (`<`/`{`/`}`) — those
 * keep the expression form (still valid, just edits via the Content field).
 */
function normalizeLiteralContentToText(el: t.JSXElement): void {
  const literalChild = el.children.find(
    (c): c is t.JSXExpressionContainer => c.type === 'JSXExpressionContainer' && c.expression.type === 'StringLiteral',
  );
  if (!literalChild || literalChild.expression.type !== 'StringLiteral') return;
  const value = literalChild.expression.value;
  if (/[<{}]/.test(value)) return; // unsafe as raw JSX text — leave the expression
  el.children = [t.jsxText(value)];
}

/** Set an inline-style property value, adding the property if it was removed. */
function setStyleProp(el: t.JSXElement, target: string, value: t.Expression): void {
  const styleAttr = el.openingElement.attributes.find(
    (a): a is t.JSXAttribute =>
      a.type === 'JSXAttribute' && a.name.type === 'JSXIdentifier' && a.name.name === 'style',
  );
  if (!styleAttr || styleAttr.value?.type !== 'JSXExpressionContainer' || styleAttr.value.expression.type !== 'ObjectExpression') return;
  const obj = styleAttr.value.expression;
  for (const p of obj.properties) {
    if (p.type === 'ObjectProperty' && styleKeyName(p.key) === target) {
      p.value = value;
      return;
    }
  }
  const key = /^[A-Za-z_$][\w$]*$/.test(target) ? t.identifier(target) : t.stringLiteral(target);
  obj.properties.push(t.objectProperty(key, value));
}

/** Set an attribute value, adding the attribute if it was removed. */
function setAttr(el: t.JSXElement, target: string, value: t.JSXExpressionContainer): void {
  const attr = el.openingElement.attributes.find(
    (a): a is t.JSXAttribute =>
      a.type === 'JSXAttribute' && a.name.type === 'JSXIdentifier' && a.name.name === target,
  );
  if (attr) { attr.value = value; return; }
  el.openingElement.attributes.push(t.jsxAttribute(t.jsxIdentifier(target), value));
}
