// slot-ops.ts — Code generation for code-component SLOTS (reference model).
//
// A connection is REAL JSX composition. The connected canvas node is
// hoisted to a `const cn_<id> = (<div data-canvas-node …/>)` and every
// component it's connected to references it as a `{cn_<id>}` child:
//
//   const cn_frame_1 = (<div data-id="frame-1" data-canvas-node="true" …/>);
//   …
//   <LensBox>{cn_frame_1}</LensBox>
//   <LensBox2>{cn_frame_1}</LensBox2>
//
// So ONE canvas node can feed MANY slots, every reference renders it
// natively on the live site (zero transformation), and editing the node
// updates every slot (one definition). An UNCONNECTED canvas node stays
// inline in `const canvasNodes` exactly as before — extraction happens on
// connect, and the node inlines back on full disconnect.

import * as t from '@babel/types';
import { trace } from '@/shared/debug-trace';
import { parseJSX, findFirstElementByDataId, traverse } from '@/code/parsing/ast-utils';
import { generate } from './generator-utils';

/** The `const` name a connected canvas node is hoisted to. */
export function slotConstName(dataId: string): string {
  return 'cn_' + dataId.replace(/[^a-zA-Z0-9]/g, '_');
}

// isIndexInsideSlotConst moved to generator-utils (shared with the hook-emitting
// effect generators via isModuleScopeJsx); re-exported here for existing importers.
export { isIndexInsideSlotConst } from './generator-utils';

/** Read a JSX element's `data-id` string attribute. */
function getDataId(el: t.JSXElement): string | null {
  for (const attr of el.openingElement.attributes) {
    if (attr.type === 'JSXAttribute' && attr.name.type === 'JSXIdentifier'
        && attr.name.name === 'data-id'
        && attr.value?.type === 'StringLiteral') {
      return attr.value.value;
    }
  }
  return null;
}

/** Ensure the element carries `data-canvas-node="true"` — component-
 *  instance canvas nodes may not, since fragment membership was their
 *  signal before they were hoisted to a `const`. */
function ensureCanvasNodeAttr(el: t.JSXElement): void {
  const has = el.openingElement.attributes.some(a =>
    a.type === 'JSXAttribute' && a.name.type === 'JSXIdentifier' && a.name.name === 'data-canvas-node');
  if (!has) {
    el.openingElement.attributes.push(
      t.jsxAttribute(t.jsxIdentifier('data-canvas-node'), t.stringLiteral('true')),
    );
  }
}

/** Unwrap `(<jsx/>)` → `<jsx/>`. */
function unwrapJSX(expr: t.Expression): t.JSXElement | t.JSXFragment | null {
  let e: t.Node = expr;
  if (e.type === 'ParenthesizedExpression') e = e.expression;
  if (e.type === 'JSXElement' || e.type === 'JSXFragment') return e;
  return null;
}

/** True if `cn_<...>` references this name appear anywhere in the AST. */
function countConstRefs(ast: t.File, constName: string): number {
  let n = 0;
  traverse(ast, {
    JSXExpressionContainer(path) {
      const e = path.node.expression;
      if (e.type === 'Identifier' && e.name === constName) n++;
    },
  });
  return n;
}

/** Whether a `const <constName> = …` declaration exists in the program. */
function findConstDecl(ast: t.File, constName: string): t.VariableDeclarator | null {
  for (const stmt of ast.program.body) {
    if (stmt.type !== 'VariableDeclaration') continue;
    for (const d of stmt.declarations) {
      if (d.id.type === 'Identifier' && d.id.name === constName) return d;
    }
  }
  return null;
}

/**
 * Topologically sort `const cn_…` declarations so each one is declared
 * AFTER every `cn_…` it references in its own JSX.
 *
 * Why this matters: a slot-bearing canvas node (e.g. a Marquee that lives
 * on the canvas as a `data-canvas-node`) can itself have slot connections.
 * Connecting that Marquee into another Marquee's slot creates a chain:
 *
 *   const cn_marquee_inner = <Marquee data-canvas-node="true">{cn_leaf}</Marquee>;
 *   const cn_leaf          = <div data-canvas-node="true">…</div>;
 *
 * `cn_marquee_inner`'s JSX evaluates `{cn_leaf}` at module-load. With this
 * order, `cn_leaf` is still in its temporal dead zone → ReferenceError
 * (visible symptom: on the LIVE site the outer Marquee renders empty —
 * "Connect Content" placeholder — even though the wiring is correct).
 *
 * The editor's `CodeComponentHost` resolves slots through the connections
 * graph instead of evaluating the JSX, so the bug only surfaces in
 * production. Fix: reorder the decls so any cn_X that references cn_Y
 * comes after cn_Y.
 *
 * Cycles (cn_A → cn_B → cn_A) can't be expressed correctly in
 * source-order; we leave the original order in that case and trace an
 * error — it'd also be an infinite-render bug at runtime.
 */
function topoSortSlotConsts(ast: t.File): void {
  const cnDecls: { decl: t.VariableDeclaration; name: string; refs: Set<string> }[] = [];
  // Track each cn_ declaration's index in the program body so we can
  // splice them back in topological order without disturbing non-cn_
  // statements.
  const indices: number[] = [];
  ast.program.body.forEach((stmt, i) => {
    if (stmt.type !== 'VariableDeclaration') return;
    const d = stmt.declarations[0];
    if (!d || d.id.type !== 'Identifier' || !d.id.name.startsWith('cn_')) return;
    // Collect every `cn_…` identifier referenced by this decl's JSX init.
    const refs = new Set<string>();
    if (d.init) {
      const collect = (node: t.Node) => {
        if (node.type === 'JSXExpressionContainer'
            && node.expression.type === 'Identifier'
            && node.expression.name.startsWith('cn_')
            && node.expression.name !== (d.id as t.Identifier).name) {
          refs.add(node.expression.name);
        }
        // Recurse — JSX inits can nest arbitrarily deep.
        for (const key in node) {
          const v = (node as any)[key];
          if (v && typeof v === 'object') {
            if (Array.isArray(v)) for (const item of v) { if (item && typeof item === 'object') collect(item); }
            else if (v.type) collect(v);
          }
        }
      };
      collect(d.init as t.Node);
    }
    cnDecls.push({ decl: stmt, name: d.id.name, refs });
    indices.push(i);
  });
  if (cnDecls.length <= 1) return;

  // Kahn's algorithm: nodes with no remaining deps first. `inDegree` here
  // is the count of cn_ deps this decl still needs — it drops to 0 when
  // all its referenced cn_s have been emitted.
  const byName = new Map(cnDecls.map(c => [c.name, c]));
  const inDegree = new Map<string, number>();
  for (const c of cnDecls) {
    // Only count refs that are actually cn_ decls in this file (a
    // dangling ref to a deleted cn_ shouldn't block ordering).
    let deg = 0;
    for (const r of c.refs) if (byName.has(r)) deg++;
    inDegree.set(c.name, deg);
  }
  const sorted: typeof cnDecls = [];
  const queue: string[] = cnDecls.filter(c => inDegree.get(c.name) === 0).map(c => c.name);
  while (queue.length) {
    const name = queue.shift()!;
    const c = byName.get(name)!;
    sorted.push(c);
    // Decrement every decl that referenced `name`.
    for (const other of cnDecls) {
      if (other.refs.has(name)) {
        const d = (inDegree.get(other.name) ?? 0) - 1;
        inDegree.set(other.name, d);
        if (d === 0) queue.push(other.name);
      }
    }
  }
  // Cycle — bail out (sorted is missing some decls). Keep original order.
  if (sorted.length !== cnDecls.length) {
    trace.error('slot-ops:topo-cycle', { cnNames: cnDecls.map(c => c.name) });
    return;
  }

  // Reinsert at the same slot positions, in topo order. Non-cn_ statements
  // stay where they were (we only touch positions in `indices`).
  for (let k = 0; k < indices.length; k++) {
    ast.program.body[indices[k]] = sorted[k].decl;
  }
}

/**
 * Connect a canvas node into a code component's slot. Hoists the node to a
 * `const cn_<id>` (once) and adds a `{cn_<id>}` reference to the component.
 */
export function connectSlotInCode(code: string, componentId: string, canvasNodeId: string): string {
  trace.fn('slot-ops:connectSlotInCode', { componentId, canvasNodeId });
  const ast = parseJSX(code);
  if (!ast) return code;
  let constName = slotConstName(canvasNodeId);

  // Hoist the canvas node to `const cn_<id>` if it isn't already hoisted.
  if (!findConstDecl(ast, constName)) {
    let extracted: t.JSXElement | null = null;
    let existingConst: string | null = null;
    findFirstElementByDataId(ast, canvasNodeId, (path, el) => {
      // A canvas node can feed MANY slots. If it's ALREADY the initializer of a
      // const — possibly authored under a different name than slotConstName()
      // returns (e.g. `const tl_tool_6 = …` instead of `cn_tl_tool_6`) — reuse
      // that const BY NAME and do NOT extract it. Pulling the element out would
      // leave `const tl_tool_6;` (no initializer) and break every other slot
      // already referencing it.
      const parent = path.parentPath;
      if (parent && parent.isVariableDeclarator() && t.isIdentifier(parent.node.id)) {
        existingConst = parent.node.id.name;
        return;
      }
      extracted = el;
      path.remove(); // pull it out of the canvasNodes fragment
    });
    if (existingConst) {
      constName = existingConst;
    } else if (extracted) {
      ensureCanvasNodeAttr(extracted);
      const decl = t.variableDeclaration('const', [
        t.variableDeclarator(t.identifier(constName), extracted),
      ]);
      const exportIdx = ast.program.body.findIndex(s => s.type === 'ExportDefaultDeclaration');
      ast.program.body.splice(exportIdx >= 0 ? exportIdx + 1 : ast.program.body.length, 0, decl);
    } else {
      trace.error('slot-ops:connect-node-not-found', { canvasNodeId });
      return code;
    }
  }

  // Add a `{cn_<id>}` reference child to the component (idempotent).
  findFirstElementByDataId(ast, componentId, (_path, comp) => {
    const already = comp.children.some(c =>
      c.type === 'JSXExpressionContainer'
      && c.expression.type === 'Identifier'
      && c.expression.name === constName);
    if (!already) {
      comp.children.push(t.jsxExpressionContainer(t.identifier(constName)));
    }
  });

  // Order matters at runtime — see topoSortSlotConsts for why.
  topoSortSlotConsts(ast);

  trace.action('slot-ops:connected', { componentId, canvasNodeId, constName });
  return generate(ast).code;
}

/**
 * Disconnect a canvas node from one component's slot. Removes that
 * component's `{cn_<id>}` reference. If no component references the node
 * anymore, it's inlined back into the `canvasNodes` fragment.
 */
export function disconnectSlotInCode(code: string, componentId: string, canvasNodeId: string): string {
  trace.fn('slot-ops:disconnectSlotInCode', { componentId, canvasNodeId });
  const ast = parseJSX(code);
  if (!ast) return code;
  const constName = slotConstName(canvasNodeId);

  // Drop the reference from this component.
  findFirstElementByDataId(ast, componentId, (_path, comp) => {
    comp.children = comp.children.filter(c =>
      !(c.type === 'JSXExpressionContainer'
        && c.expression.type === 'Identifier'
        && c.expression.name === constName));
  });

  // Still referenced elsewhere → leave the hoisted const in place.
  if (countConstRefs(ast, constName) > 0) {
    trace.action('slot-ops:disconnected-still-referenced', { componentId, canvasNodeId });
    return generate(ast).code;
  }

  // Last connection gone — un-hoist: drop the const, inline the node back
  // into the canvasNodes fragment.
  let jsx: t.JSXElement | null = null;
  ast.program.body = ast.program.body.filter(stmt => {
    if (stmt.type !== 'VariableDeclaration') return true;
    const d = stmt.declarations[0];
    if (d?.id.type === 'Identifier' && d.id.name === constName && d.init) {
      const inner = unwrapJSX(d.init as t.Expression);
      if (inner?.type === 'JSXElement') jsx = inner;
      return false;
    }
    return true;
  });
  if (jsx) {
    const canvasDecl = findConstDecl(ast, 'canvasNodes');
    const frag = canvasDecl?.init ? unwrapJSX(canvasDecl.init as t.Expression) : null;
    if (frag && frag.type === 'JSXFragment') {
      frag.children.push(jsx);
    } else {
      // No canvasNodes fragment — create one after the export default.
      const newFrag = t.jsxFragment(t.jsxOpeningFragment(), t.jsxClosingFragment(), [jsx]);
      const decl = t.variableDeclaration('const', [
        t.variableDeclarator(t.identifier('canvasNodes'), newFrag),
      ]);
      ast.program.body.push(decl);
    }
  }

  // Removing a cn_ decl can change the dependency graph for the remaining
  // ones (e.g. a chain of nested slot-bearing canvas nodes); resort.
  topoSortSlotConsts(ast);

  trace.action('slot-ops:disconnected-inlined', { componentId, canvasNodeId });
  return generate(ast).code;
}

/**
 * Reorder a component's slot connections — moves the `{cn_<id>}` reference
 * at `fromIndex` to `toIndex` among the component's slot-reference children.
 */
export function reorderSlotInCode(
  code: string,
  componentId: string,
  fromIndex: number,
  toIndex: number,
): string {
  trace.fn('slot-ops:reorderSlotInCode', { componentId, fromIndex, toIndex });
  const ast = parseJSX(code);
  if (!ast) return code;
  findFirstElementByDataId(ast, componentId, (_path, comp) => {
    // Indices of the `{cn_…}` reference children within comp.children.
    const slots: number[] = [];
    comp.children.forEach((c, i) => {
      if (c.type === 'JSXExpressionContainer'
          && c.expression.type === 'Identifier'
          && c.expression.name.startsWith('cn_')) {
        slots.push(i);
      }
    });
    if (fromIndex < 0 || fromIndex >= slots.length || toIndex < 0 || toIndex >= slots.length) return;
    const refs = slots.map(i => comp.children[i]);
    const [moved] = refs.splice(fromIndex, 1);
    refs.splice(toIndex, 0, moved);
    slots.forEach((slotIdx, k) => { comp.children[slotIdx] = refs[k]; });
  });
  return generate(ast).code;
}

/** Map every `const cn_… = (<jsx data-id=…/>)` declaration → its data-id. */
function buildConstToIdMap(ast: t.File): Map<string, string> {
  const m = new Map<string, string>();
  for (const stmt of ast.program.body) {
    if (stmt.type !== 'VariableDeclaration') continue;
    for (const d of stmt.declarations) {
      if (d.id.type !== 'Identifier' || !d.init) continue;
      const jsx = unwrapJSX(d.init as t.Expression);
      if (jsx?.type === 'JSXElement') {
        const did = getDataId(jsx);
        if (did) m.set(d.id.name, did);
      }
    }
  }
  return m;
}

/** The canvas-node ids referenced as `{cn_<id>}` children of `el`. */
function readSlotRefs(el: t.JSXElement, constToId: Map<string, string>): string[] {
  const refs: string[] = [];
  for (const c of el.children) {
    if (c.type === 'JSXExpressionContainer' && c.expression.type === 'Identifier') {
      const did = constToId.get(c.expression.name);
      if (did) refs.push(did);
    }
  }
  return refs;
}

/**
 * List the canvas-node ids connected into a component's slot — i.e. the
 * `data-id`s behind its `{cn_<id>}` reference children, in order.
 */
export function getSlotConnections(code: string, componentId: string): string[] {
  // Route through the code-keyed `getAllSlotConnections` cache instead of a fresh `parseJSX(code)`.
  // SlotConnectionHandle re-renders this from its selection-overlay useMemo EVERY drag frame, and on a
  // TEMPLATE the page is ~50KB → a full ~15ms babel parse PER FRAME (single-digit FPS), while a normal page
  // (smaller file, and the handle only mounts for components) stays smooth. `getAllSlotConnections(code)` is
  // the same traversal, memoised by exact code → a pure cache hit while the code is stable mid-drag. The
  // per-componentId result is identical: a component with no slot refs isn't in the map → `?? []`.
  const out = getAllSlotConnections(code).get(componentId) ?? [];
  trace.fn('slot-ops:getSlotConnections', { componentId, count: out.length });
  return out;
}

/**
 * Mirror a component's slot connections onto its DUPLICATE — both end up
 * referencing the SAME hoisted canvas nodes.
 *
 * A `{cn_<id>}` reference is a JSX expression child, not a node in the
 * parsed tree, so the paste engine (which rebuilds the pasted JSX from
 * CLIPBOARD nodes — `parentId`-linked children only) drops it: duplicate a
 * section holding a wired `<Marquee>{cn_a}{cn_b}</Marquee>` and the copy
 * comes out as a bare `<Marquee />` showing the empty-slot placeholder.
 *
 * Sharing — not cloning — is the whole point of the reference model this
 * file implements (see the header: one canvas node, many `{cn_}` refs, each
 * rendering it natively). So the copy points at the EXISTING consts and the
 * source is left completely untouched.
 *
 * `pairs` are `{ fromId (source element), toId (its pasted copy) }`; ids
 * with no slot refs are skipped. Idempotent — a ref already present on the
 * target isn't added twice — and returns `code` unchanged (no babel
 * reprint) when there's nothing to mirror.
 */
export function copySlotConnectionsInCode(
  code: string,
  pairs: Array<{ fromId: string; toId: string }>,
): string {
  if (pairs.length === 0) return code;

  // Cheap gate FIRST: this runs on every paste, and a full babel parse of a
  // page is ~15ms. `getAllSlotConnections` is memoised by exact code, and the
  // render path (CodeComponentHost) already called it for this very string —
  // so a paste on a page with no wired components costs a Map lookup.
  const conns = getAllSlotConnections(code);
  const todo = pairs.filter(p => p.fromId !== p.toId && (conns.get(p.fromId)?.length ?? 0) > 0);
  if (todo.length === 0) return code;

  const ast = parseJSX(code);
  if (!ast) {
    trace.error('slot-ops:copy-connections-parse-failed', { pairs: pairs.length });
    return code;
  }
  // Reverse `constName → canvasNodeId` so a connection (which is stored by
  // node id) can be written back as the identifier the source referenced.
  // First declaration wins — a hand-authored const may sit under a name that
  // isn't `slotConstName()`'s (connectSlotInCode reuses those by name).
  const idToConst = new Map<string, string>();
  for (const [name, did] of buildConstToIdMap(ast)) {
    if (!idToConst.has(did)) idToConst.set(did, name);
  }

  const wanted = new Map<string, string[]>(); // toId → const names, in source order
  for (const { fromId, toId } of todo) {
    const names = (conns.get(fromId) ?? [])
      .map(id => idToConst.get(id))
      .filter((n): n is string => !!n);
    if (names.length > 0) wanted.set(toId, names);
  }
  if (wanted.size === 0) return code;

  let added = 0;
  const wired: string[] = [];
  for (const [toId, names] of wanted) {
    findFirstElementByDataId(ast, toId, (_path, comp) => {
      const have = new Set<string>();
      for (const c of comp.children) {
        if (c.type === 'JSXExpressionContainer' && c.expression.type === 'Identifier') {
          have.add(c.expression.name);
        }
      }
      let pushed = 0;
      for (const n of names) {
        if (have.has(n)) continue;
        comp.children.push(t.jsxExpressionContainer(t.identifier(n)));
        pushed++;
      }
      if (pushed === 0) return;
      // A pasted component with no children prints self-closing
      // (`<Marquee … />`); babel ignores `children` on such a node, so the
      // refs would silently vanish. Give it a real closing tag.
      if (comp.openingElement.selfClosing) {
        comp.openingElement.selfClosing = false;
        comp.closingElement = t.jsxClosingElement(comp.openingElement.name);
      }
      added += pushed;
      wired.push(toId);
    });
  }
  if (added === 0) return code;

  trace.action('slot-ops:copied-connections', { pairs: pairs.length, targets: wired, refs: added });
  return generate(ast).code;
}

/**
 * Remove a SLOT-HOISTED canvas-node entirely — its `const cn_<id>`
 * declaration AND every `{cn_<id>}` reference across the file. Used when
 * the user deletes a canvas node that was hoisted as a slot connection;
 * the regular `removeNodeInCode` string-strip would null the const's
 * JSX init and leave `const cn_<id> = ;` (parse error).
 *
 * No-op if no `const cn_<sanitized>` declaration exists for this node —
 * caller should fall through to the regular removal path in that case.
 */
export function removeSlotHoistedCanvasNodeInCode(code: string, canvasNodeId: string): string {
  // Cheap pre-check BEFORE the ~15ms full-page babel parse: slot-hoisted nodes
  // live in `const <slotConstName> = …`. If that identifier isn't even present in
  // the source, there's nothing to unwire — bail immediately. Most nodes aren't
  // slot-hoisted, and on a multi-delete this was parsing the entire 125KB page
  // once PER deleted node (the dominant cost of the multi-second delete freeze).
  const constName = slotConstName(canvasNodeId);
  if (!code.includes(constName)) return code;
  trace.fn('slot-ops:removeSlotHoistedCanvasNodeInCode', { canvasNodeId });
  const ast = parseJSX(code);
  if (!ast) return code;
  if (!findConstDecl(ast, constName)) return code;

  // Strip every `{cn_<id>}` reference (so no component is left wired to
  // the now-deleted node).
  traverse(ast, {
    JSXExpressionContainer(path) {
      const e = path.node.expression;
      if (e.type === 'Identifier' && e.name === constName) path.remove();
    },
  });

  // Drop the hoist declaration itself.
  ast.program.body = ast.program.body.filter(stmt => {
    if (stmt.type !== 'VariableDeclaration') return true;
    return !stmt.declarations.some(
      d => d.id.type === 'Identifier' && d.id.name === constName,
    );
  });

  // Removing a cn_ decl can change dependency ordering for the rest.
  topoSortSlotConsts(ast);

  trace.action('slot-ops:slot-hoisted-canvas-node-removed', { canvasNodeId, constName });
  return generate(ast).code;
}

/**
 * All slot connections in a file: `componentId → connected canvas-node ids`.
 * One parse — used by the slot UI (connectors, control, host) so they don't
 * re-parse per component.
 */
// Memoise by exact code. This babel-parses the WHOLE page, and it's called
// multiple times per render (SlotConnectors + CodeComponentHost) on every
// selection — even for a plain frame that touches no slots — so the same 125KB
// page was parsed 2-3× per selection in the render path. Caching the result by
// code collapses those redundant ~15ms parses to one, and re-selecting without a
// code edit becomes a pure cache hit. Returns a deep clone so callers that mutate
// the Map / its arrays can't corrupt the cached copy. Bounded FIFO (the page code
// churns on every edit, so a few entries suffice for the within-render dupes).
const _slotConnCache = new Map<string, Map<string, string[]>>();
const SLOT_CONN_CACHE_MAX = 6;
function cloneSlotConns(m: Map<string, string[]>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [k, v] of m) out.set(k, v.slice());
  return out;
}

export function getAllSlotConnections(code: string): Map<string, string[]> {
  const cached = _slotConnCache.get(code);
  if (cached) return cloneSlotConns(cached);

  const result = new Map<string, string[]>();
  const ast = parseJSX(code);
  if (!ast) return result; // parse failure — don't cache (transient)
  const constToId = buildConstToIdMap(ast);
  if (constToId.size > 0) {
    traverse(ast, {
      JSXElement(path) {
        const id = getDataId(path.node);
        if (!id) return;
        const refs = readSlotRefs(path.node, constToId);
        if (refs.length > 0) result.set(id, refs);
      },
    });
  }
  _slotConnCache.set(code, result);
  if (_slotConnCache.size > SLOT_CONN_CACHE_MAX) {
    const oldest = _slotConnCache.keys().next().value;
    if (oldest !== undefined) _slotConnCache.delete(oldest);
  }
  trace.fn('slot-ops:getAllSlotConnections', { componentCount: result.size });
  return cloneSlotConns(result);
}
