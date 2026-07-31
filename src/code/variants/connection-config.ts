// connection-config.ts — Parse/serialize variant connections from component files.
//
// Connections define state transitions between variants:
//   { from: 'default', to: 'open', trigger: 'click' }
//
// Stored as `const connections = [...]` in the component file.
// Each connection generates framer-motion event handlers in the code.

import { modifyProjectFile } from '@/code/project/modify-file';
import { projectFS } from '@/code/project/project-fs';
import { isIndexInsideSlotConst } from '@/code/generation/slot-ops';
import { ensureVariantListWiring } from '@/code/generation/generator-styles';
import { extractImports, resolveImportPath } from '@/code/components/import-resolver';
import { forwardEventPropsToComponentRoot } from './event-prop-forwarding';
import { trace } from '@/shared/debug-trace';

// ─── Types ──────────────────────────────────────────────────────────────────

export type ConnectionTrigger = 'click' | 'clickStart' | 'mouseEnter' | 'mouseLeave' | 'inView' | 'afterDelay';

export interface Connection {
  from: string;           // source variant name
  to: string;             // target variant name
  trigger: ConnectionTrigger;
  delay?: number;         // seconds (0-2)
  // data-id of the JSX element where the trigger handler is attached.
  // When undefined, the handler lands on the root motion element
  // (legacy behavior — clicking anywhere on the variant cycles state).
  // When set, codegen places the handler on THAT element's JSX tag, so
  // only clicks on that specific child trigger the variant switch.
  sourceNode?: string;
}

// ─── Parser ─────────────────────────────────────────────────────────────────

/**
 * Parse connections from a component file.
 * Looks for: const connections = [...];
 */
export function parseConnections(code: string): Connection[] {
  const match = code.match(/const\s+connections\s*=\s*(\[[\s\S]*?\]);/);
  if (!match) return [];

  try {
    const jsonStr = match[1]
      .replace(/'/g, '"')
      .replace(/(\w+)\s*:/g, '"$1":')
      .replace(/,\s*([}\]])/g, '$1');

    return JSON.parse(jsonStr) as Connection[];
  } catch (e) {
    trace.error('connection-config:parse-failed', { error: String(e) });
    return [];
  }
}

/**
 * Serialize connections back to code.
 */
export function serializeConnections(connections: Connection[]): string {
  if (connections.length === 0) return '';

  const entries = connections.map(c => {
    const parts = [
      `from: '${c.from}'`,
      `to: '${c.to}'`,
      `trigger: '${c.trigger}'`,
    ];
    if (c.delay) parts.push(`delay: ${c.delay}`);
    if (c.sourceNode) parts.push(`sourceNode: '${c.sourceNode}'`);
    return `  { ${parts.join(', ')} }`;
  });
  return `const connections = [\n${entries.join(',\n')},\n];`;
}

// ─── Operations ─────────────────────────────────────────────────────────────

/**
 * Add a connection between two variants.
 *
 * `sourceNode` (optional) — data-id of the JSX element where the
 * trigger handler should land. When undefined, the handler lands on
 * the root motion element (legacy behavior: clicking anywhere on the
 * variant cycles state). When set, the codegen places the handler on
 * THAT element's tag so only clicks on that specific child trigger
 * the switch. Two connections that differ ONLY by `sourceNode` are
 * NOT duplicates — different elements can drive the same transition.
 */
export function addConnection(
  filePath: string,
  from: string,
  to: string,
  trigger: ConnectionTrigger,
  delay?: number,
  sourceNode?: string,
): Connection[] {
  let connections: Connection[] = [];

  modifyProjectFile(filePath, (code) => {
    connections = parseConnections(code);

    // Duplicate check — sourceNode is part of the identity (same
    // (from, to, trigger) on different elements is allowed).
    if (connections.some(c =>
      c.from === from && c.to === to && c.trigger === trigger
      && (c.sourceNode ?? null) === (sourceNode ?? null)
    )) {
      return code; // no change
    }

    const newConnection: Connection = { from, to, trigger };
    if (delay) newConnection.delay = delay;
    if (sourceNode) newConnection.sourceNode = sourceNode;
    connections.push(newConnection);

    const serialized = serializeConnections(connections);
    let updated = replaceConnectionsInCode(code, serialized);

    // Also generate useState + event handlers in the component code
    updated = generateConnectionCode(updated, connections);
    return updated;
  });

  // If the connection's source is a NESTED component instance, ensure that
  // child component forwards parent event props (`...rest`) onto its root
  // motion element — otherwise the `onTap` we just wrote on the instance tag
  // is swallowed and the click does nothing.
  ensureChildComponentsForward(filePath, connections);

  trace.action('connection-config:add', { filePath, from, to, trigger, sourceNode });
  return connections;
}

/**
 * For every connection whose `sourceNode` resolves to an Uppercase component
 * instance tag in `masterFilePath`, patch that child component file to forward
 * parent event props to its root. Idempotent and silent when the source is a
 * plain element or the child file can't be resolved.
 */
function ensureChildComponentsForward(masterFilePath: string, connections: Connection[]): void {
  // The master was just flushed by the modifyProjectFile above, so a direct
  // read returns fresh content (read-only — no flush needed).
  const masterCode = (() => {
    try { return projectFS.readFile(masterFilePath); } catch { return null; }
  })();
  if (!masterCode) return;

  const imports = extractImports(masterCode);
  const patched = new Set<string>();
  for (const c of connections) {
    if (!c.sourceNode) continue;
    const tagName = componentTagNameForDataId(masterCode, c.sourceNode);
    if (!tagName || patched.has(tagName)) continue;
    const spec = imports.get(tagName);
    if (!spec) continue;
    const childPath = resolveImportPath(spec, masterFilePath);
    if (!childPath) continue;
    patched.add(tagName);
    modifyProjectFile(childPath, (childCode) => forwardEventPropsToComponentRoot(childCode));
    trace.action('connection-config:forward-child', { masterFilePath, tagName, childPath });
  }
}

/** If `dataId` belongs to an Uppercase component-instance tag, return the
 *  component name; otherwise null (plain element / motion tag). */
function componentTagNameForDataId(code: string, dataId: string): string | null {
  const idx = code.indexOf(`data-id="${dataId}"`);
  if (idx === -1) return null;
  const tagStart = code.lastIndexOf('<', idx);
  if (tagStart === -1) return null;
  const m = code.slice(tagStart, idx).match(/^<([A-Z][A-Za-z0-9]*)\b/);
  return m ? m[1] : null;
}

/**
 * Remove a connection.
 */
export function removeConnection(
  filePath: string,
  from: string,
  to: string,
  match?: { trigger?: ConnectionTrigger; sourceNode?: string | null },
): Connection[] {
  let connections: Connection[] = [];

  // A (from, to) pair is NOT a connection's identity — the same variant pair
  // legitimately carries several connections from different source nodes /
  // triggers (a next-arrow click AND a root inView both targeting t2). When
  // `match` gives the trigger/sourceNode, remove ONLY that exact connection
  // (sourceNode null = explicitly the root connection). Pair-wide removal
  // (no `match`) remains for legacy callers that mean "disconnect these
  // variants entirely".
  const matches = (c: Connection): boolean => {
    if (c.from !== from || c.to !== to) return false;
    if (!match) return true;
    if (match.trigger !== undefined && c.trigger !== match.trigger) return false;
    if (match.sourceNode !== undefined && (c.sourceNode ?? null) !== match.sourceNode) return false;
    return true;
  };

  modifyProjectFile(filePath, (code) => {
    connections = parseConnections(code).filter(c => !matches(c));
    return rebuildConnections(code, connections);
  });

  trace.action('connection-config:remove', { filePath, from, to, trigger: match?.trigger, sourceNode: match?.sourceNode });
  return connections;
}

/**
 * Pure code transform shared by every connection-removal path: write the
 * remaining `connections` array and regenerate handlers — or, when none
 * remain, strip ALL connection scaffolding (handlers, useState/useEffect,
 * `animate={variant}` → `animate={initialVariant}`, and `variant ===` →
 * `initialVariant ===`). Factored out of `removeConnection` so the
 * node-delete path can reuse it without `modifyProjectFile`.
 */
function rebuildConnections(code: string, connections: Connection[]): string {
  const serialized = serializeConnections(connections);
  let updated = replaceConnectionsInCode(code, serialized);

  if (connections.length > 0) {
    updated = generateConnectionCode(updated, connections);
  } else {
    // Remove stale handlers
    updated = updated.replace(/\s*onTap=\{[^}]*\}/g, '');
    updated = updated.replace(/\s*onTapStart=\{[^}]*\}/g, '');
    updated = updated.replace(/\s*onHoverStart=\{[^}]*\}/g, '');
    updated = updated.replace(/\s*onHoverEnd=\{[^}]*\}/g, '');
    updated = updated.replace(/\s*onViewportEnter=\{[^}]*\}/g, '');
    // Remove useState + useEffect chain
    updated = updated.replace(/\s*const \[variant, setVariant\] = useState\([^)]*\);\n?/g, '');
    updated = updated.replace(/\s*const \[isInView, setIsInView\] = useState\(false\);\n?/g, '');
    updated = updated.replace(/\s*useEffect\(\(\) => \{[\s\S]*?\}, \[variant, isInView\]\);\n?/g, '');
    // The SYNC effect the add-path pairs with the useState
    // (`useEffect(() => { setVariant(initialVariant); }, [initialVariant]);`)
    // has deps `[initialVariant]`, so the inView-anchored regex above never
    // matched it — deleting the last connected variant stripped the useState
    // but LEFT this effect, and its dangling `setVariant` crashed the
    // component at runtime and blocked every later mutation on the file
    // ("References undefined identifier: setVariant"). Whitespace-FLEXIBLE +
    // global (babel reformats; other hooks may share the line — the pagination
    // regex lesson), keyed on the setVariant(initialVariant) call.
    updated = updated.replace(/\s*useEffect\(\(\)\s*=>\s*\{\s*setVariant\(initialVariant\);?\s*\},\s*\[initialVariant\]\);?\n?/g, '');
    // Restore the static form since connections are gone — variant-list
    // wiring (current dialect) plus the legacy scalar form. Restored TO the
    // list form: `['default', initialVariant]` merges the default entry under
    // the variant at runtime (sparse-entry inheritance).
    updated = updated.replace(/animate=\{\['default',\s*variant\]\}/g, "animate={['default', initialVariant]}");
    if (updated.includes('animate={variant}')) {
      updated = updated.replace(/animate=\{variant\}/g, "animate={['default', initialVariant]}");
    }
    // Restore per-variant comparison tests (`variant === '…'` AND
    // `variant !== '…'` — visibility conditions use the negative form) back to
    // `initialVariant`. Leaving a `variant !==` behind after the useState above
    // is stripped would be a ReferenceError that kills the whole component.
    updated = updated.replace(/\bvariant(\s*[!=]==\s*)/g, `initialVariant$1`);
    // Restore the Collection List config's variant arg to `initialVariant` (mirror
    // of the add-path 2d rewrite). `variant` would be a ReferenceError once the
    // useState above is stripped. Anchored on the `const … =` assignment so the
    // hook DEFINITION's `variant` param stays intact.
    updated = updated.replace(/(const\s+\w+\s*=\s*useResponsiveListConfig\([^;]*?,\s*)variant(\s*,\s*\{)/g, '$1initialVariant$2');
  }
  return updated;
}

/**
 * Drop every connection whose `sourceNode` element is no longer present in the
 * code, then regenerate handlers. When a node that triggers a connection is
 * deleted, its onTap handler vanishes with the element, but the
 * `const connections = [...]` entry would linger as dead data (and a stale
 * arrow). Checking presence (rather than a single deleted id) also covers
 * deleting a PARENT whose descendant was the trigger, and self-heals any
 * pre-existing orphaned connections in the file.
 *
 * Pure string transform — called by the removeNode mutation AFTER the element
 * strip (so the deleted subtree is already gone from `code`). Connections with
 * no `sourceNode` (variant-level) are always kept. No-op when nothing changed.
 */
export function removeDanglingConnectionsInCode(code: string): string {
  const all = parseConnections(code);
  if (all.length === 0) return code;
  const remaining = all.filter(c => !c.sourceNode || code.includes(`data-id="${c.sourceNode}"`));
  if (remaining.length === all.length) return code; // every sourceNode still present
  trace.action('connection-config:remove-dangling', { removed: all.length - remaining.length });
  return rebuildConnections(code, remaining);
}

/**
 * Drop every connection that references a removed VARIANT (as `from` OR `to`),
 * then regenerate handlers. Called by `removeVariant`: deleting a variant must
 * also tear down any state transition wired to it — e.g. deleting a
 * `default-hover` variant removes the `default → default-hover` (mouseEnter)
 * and `default-hover → default` (mouseLeave) edges. Because `rebuildConnections`
 * → `generateConnectionCode` STRIPS all event handlers and regenerates only the
 * ones the remaining connections need, the now-orphaned `onHoverStart` /
 * `onHoverEnd` handlers fall away automatically (and if NO connections remain,
 * the full scaffolding — useState/useEffect/animate — is torn down too).
 *
 * Pure string transform — no `modifyProjectFile`, so callers can compose it
 * inside their own write. No-op when nothing references the variant.
 */
export function removeConnectionsForVariantInCode(code: string, variantName: string): string {
  const all = parseConnections(code);
  if (all.length === 0) return code;
  const remaining = all.filter(c => c.from !== variantName && c.to !== variantName);
  if (remaining.length === all.length) return code; // variant wired to nothing
  trace.action('connection-config:remove-for-variant', { variantName, removed: all.length - remaining.length });
  return rebuildConnections(code, remaining);
}

/**
 * Surgical connection removal — drop ONE specific (from, to, trigger)
 * triple from `const connections = [...]` without touching the JSX
 * event handlers. Intended for the chain-rewrite case in
 * `addInteractionState` where we re-route a single existing connection
 * (e.g. `pressed click → source` becomes `pressed click → hover`)
 * before adding the replacement entry.
 *
 * `removeConnection` (above) is too coarse for this: it matches by
 * (from, to) only AND regenerates every handler from the remaining
 * connections, which would clobber the onTap ternary we want to keep
 * around to land the rewrite cleanly.
 */
export function removeConnectionEntry(
  filePath: string,
  from: string,
  to: string,
  trigger: ConnectionTrigger,
): void {
  modifyProjectFile(filePath, (code) => {
    const conns = parseConnections(code);
    const filtered = conns.filter(c => !(c.from === from && c.to === to && c.trigger === trigger));
    if (filtered.length === conns.length) return code;
    const serialized = serializeConnections(filtered);
    const match = code.match(/const\s+connections\s*=\s*\[[\s\S]*?\];/);
    if (match) return code.replace(match[0], serialized);
    return code;
  });
  trace.action('connection-config:remove-entry', { filePath, from, to, trigger });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

export function replaceConnectionsInCode(code: string, serialized: string): string {
  const match = code.match(/const\s+connections\s*=\s*\[[\s\S]*?\];/);

  if (match) {
    if (serialized) {
      return code.replace(match[0], serialized);
    } else {
      // Remove empty connections block + surrounding whitespace
      return code.replace(match[0] + '\n', '');
    }
  }

  if (!serialized) return code;

  // No existing connections — insert before the component function
  let exportIdx = code.indexOf('export default function');
  if (exportIdx === -1) {
    const funcMatch = code.match(/^function\s+\w+\s*\(/m);
    exportIdx = funcMatch ? code.indexOf(funcMatch[0]) : -1;
  }
  if (exportIdx !== -1) {
    return code.slice(0, exportIdx) + serialized + '\n\n' + code.slice(exportIdx);
  }
  return code;
}

/**
 * Generate useState + event handler code from connections.
 *
 * Adds/updates:
 *   - import { useState } from 'react'
 *   - const [variant, setVariant] = useState('default')
 *   - animate={variant} on the root motion element
 *   - Event handlers: onTap, onHoverStart, onHoverEnd, whileInView
 */
export function generateConnectionCode(code: string, connections: Connection[]): string {
  if (connections.length === 0) return code;

  // Upgrade any legacy scalar wiring to the variant-list dialect first so the
  // passes below see one form (see ensureVariantListWiring for why lists).
  let result = ensureVariantListWiring(code);

  // Locale-CSS carrier: a static component exposes `data-variant={initialVariant}`
  // on its root (ensureRootDataVariantAttr); once connections add variant STATE,
  // the attr must track the live variant or variant-scoped :lang rules freeze
  // on the initial variant.
  result = result.replace(/data-variant=\{initialVariant\}/, 'data-variant={variant}');

  // 1. Add useState import if not present
  if (!result.includes("useState")) {
    // Named import: import { X } from 'react' → import { X, useState } from 'react'
    if (/import\s*\{[^}]*\}\s*from\s*'react'/.test(result)) {
      result = result.replace(
        /import\s*\{([^}]*)\}\s*from\s*'react'/,
        (_, imports) => `import { ${imports.trim()}, useState } from 'react'`
      );
    // Default import: import React from 'react' → import React, { useState } from 'react'
    } else if (/import\s+\w+\s+from\s*'react'/.test(result)) {
      result = result.replace(
        /import\s+(\w+)\s+from\s*'react'/,
        `import $1, { useState } from 'react'`
      );
    } else if (result.includes("from 'framer-motion'")) {
      result = result.replace(
        /import.*from 'framer-motion'/,
        `import { useState } from 'react';\n$&`
      );
    }
  }

  // 1b. Add useEffect import (needed for responsive variant sync + inView chains)
  if (!result.includes('useEffect')) {
    if (/import\s*\{([^}]*)\}\s*from\s*'react'/.test(result)) {
      result = result.replace(
        /import\s*\{([^}]*)\}\s*from\s*'react'/,
        (_, imports) => `import { ${imports.trim()}, useEffect } from 'react'`
      );
    } else if (/import\s+(\w+),\s*\{([^}]*)\}\s*from\s*'react'/.test(result)) {
      result = result.replace(
        /import\s+(\w+),\s*\{([^}]*)\}\s*from\s*'react'/,
        (_, def, imports) => `import ${def}, { ${imports.trim()}, useEffect } from 'react'`
      );
    }
  }

  // 2. Add useState(initialVariant) inside the COMPONENT function body if not
  // present. The component uses `function Name() {} + export default
  // withResponsiveProps(Name)` (or `export default Name`), so there's usually
  // no `export default function`. We must target the EXPORTED component by
  // name — NOT the first `function` in the file, which may be a module-level
  // helper declared above the component (e.g. `__applyInstanceSize` from the
  // instance-size-override). Injecting the hooks into that helper produced
  // `ReferenceError: initialVariant is not defined` and broke the component.
  // Find the EXPORTED component's body-open brace ROBUSTLY via a balanced-paren scan. A naive
  // `\([^)]*\)` regex breaks on a param default that itself contains parens — e.g. a componentCursor
  // prop's `jljkjh = () => null` — so it failed to locate the body and the useState hook was never
  // injected, leaving `variant`/`setVariant` referenced but undefined ("variant is not defined").
  const findBodyBraceIdx = (): number => {
    const exportName = result.match(/export default function (\w+)/)?.[1]
      ?? result.match(/export default \w+\((\w+)\)\s*;/)?.[1] // withResponsiveProps(Name)
      ?? result.match(/export default (\w+)\s*;/)?.[1];        // bare Name
    const startRe = exportName
      ? new RegExp(`function ${exportName}\\s*\\(`)
      : /export default function\s*\w*\s*\(/;
    const m = startRe.exec(result);
    if (!m) return -1;
    let i = m.index + m[0].length - 1; // at the opening '(' of the param list
    let depth = 0;
    for (; i < result.length; i++) {
      const c = result[i];
      if (c === '(') depth++;
      else if (c === ')') { depth--; if (depth === 0) { i++; break; } }
    }
    while (i < result.length && result[i] !== '{') i++; // skip the optional return-type to the body '{'
    return i < result.length ? i + 1 : -1;
  };
  const bodyBraceIdx = findBodyBraceIdx();
  const stateWasJustAdded = bodyBraceIdx >= 0 && !result.includes('const [variant, setVariant]');
  if (stateWasJustAdded) {
    const insertIdx = bodyBraceIdx;
    result = result.slice(0, insertIdx) +
      "\n  const [variant, setVariant] = useState(initialVariant);" +
      "\n  useEffect(() => { setVariant(initialVariant); }, [initialVariant]);\n" +
      result.slice(insertIdx);

    // NOTE: migration of pre-existing AnimatePresence wrapper conditions
    // (`initialVariant !== 'X'` → `variant !== 'X'`) is handled by the
    // unconditional comparison rewrite further down (step 2c), which covers
    // BOTH `===` and `!==`. The previous per-block regex
    // (`<AnimatePresence…>…</AnimatePresence>` with lazy `[\s\S]*?`) closed at
    // the FIRST `</AnimatePresence>`, so conditions of wrappers NESTED inside
    // another wrapper were silently skipped — those elements stayed frozen on
    // the initial variant forever (hamburger line stuck on click-toggle).
  }

  // 2b. (Re)build the inView chain effect from the current connection list.
  //
  // Strip the existing block UNCONDITIONALLY first, then re-add if there are
  // any inView connections. The previous version guarded the insertion with
  // `!result.includes('isInView')`, which meant the chain map was frozen at
  // the first inView connection and never refreshed — adding a reverse
  // `variant-1 → default` inView edge updated `const connections = [...]`
  // but never made it into the runtime `chain` map, so the cycle stopped
  // at variant-1. Mirrors the strip+regenerate pattern used for event
  // handlers below.
  result = result.replace(/\s*const \[isInView, setIsInView\] = useState\(false\);\n?/g, '');
  result = result.replace(/\s*useEffect\(\(\) => \{[\s\S]*?\}, \[variant, isInView\]\);\n?/g, '');

  result = result.replace(/\s*useEffect\(\(\) => \{[\s\S]*?\}, \[variant\]\);\n?/g, (m) =>
    m.includes('__afterDelayChain') ? '' : m);
  const afterDelayConns = connections.filter(c => c.trigger === 'afterDelay');
  if (afterDelayConns.length > 0) {
    const anchor = result.match(/const \[variant, setVariant\] = useState\(initialVariant\);/);
    if (anchor) {
      const at = result.indexOf(anchor[0]) + anchor[0].length;
      const entries = afterDelayConns.map(c =>
        `    '${c.from}': { to: '${c.to}', delay: ${(c.delay ?? 0) * 1000} }`).join(',\n');
      result = result.slice(0, at) + `
  useEffect(() => {
    const __afterDelayChain: Record<string, { to: string; delay: number }> = {\n${entries}\n    };
    const next = __afterDelayChain[variant];
    if (!next) return;
    const timer = setTimeout(() => setVariant(next.to), next.delay);
    return () => clearTimeout(timer);
  }, [variant]);
` + result.slice(at);
    }
  }

  const inViewConns = connections.filter(c => c.trigger === 'inView');
  if (inViewConns.length > 0) {
    // Find function body to insert after useState
    const funcMatch2 = result.match(/const \[variant, setVariant\] = useState\(initialVariant\);/);
    if (funcMatch2) {
      const afterState = result.indexOf(funcMatch2[0]) + funcMatch2[0].length;
      // Build the inView chain map: { 'default': { to: 'variant-1', delay: 1.3 }, ... }
      const chainEntries = inViewConns.map(c =>
        `    '${c.from}': { to: '${c.to}', delay: ${(c.delay ?? 0) * 1000} }`
      ).join(',\n');
      const chainCode = `
  const [isInView, setIsInView] = useState(false);
  useEffect(() => {
    if (!isInView) return;
    const chain: Record<string, { to: string; delay: number }> = {\n${chainEntries}\n    };
    const next = chain[variant];
    if (!next) return;
    const timer = setTimeout(() => setVariant(next.to), next.delay);
    return () => clearTimeout(timer);
  }, [variant, isInView]);
`;
      result = result.slice(0, afterState) + chainCode + result.slice(afterState);
    }
  }

  // 2c. Rewrite per-variant comparison tests from `initialVariant === '…'` /
  // `initialVariant !== '…'` to the live `variant`. Without this, inline style
  // ternaries (e.g. on a nested component instance:
  // `left: initialVariant === 'variant-1' ? …`) and AnimatePresence visibility
  // conditions (`initialVariant !== 'open' && …`) continue to read the FROZEN
  // initial prop instead of the live useState value — clicks toggle `variant`
  // but the condition never re-evaluates, and the canvas freezes at the initial
  // state. Only the comparison-operator form is matched, so prop NAMES like
  // `initialVariant=` and the bare `: initialVariant` else-branch stay intact.
  result = result.replace(/\binitialVariant(\s*[!=]==\s*)/g, `variant$1`);

  // 2d. Re-point the responsive Collection List config's variant ARGUMENT to the
  // live `variant` state too. `const cfg = useResponsiveListConfig(base, vp, bps,
  // initialVariant, variants)` re-filters/re-sorts the list for the active variant;
  // the 4th positional arg is the discriminator. The comparison-only rewrite (2c)
  // leaves it on the FROZEN `initialVariant`, so the list never switches as the
  // component animates between variants (e.g. a variant filtered to zero rows still
  // shows the prior variant's rows during an animate preview). Anchored on the
  // `const … =` assignment so the hook DEFINITION's `variant` param is untouched.
  result = result.replace(/(const\s+\w+\s*=\s*useResponsiveListConfig\([^;]*?,\s*)initialVariant(\s*,\s*\{)/g, '$1variant$2');

  // 3. Ensure animate={variant} lands on EVERY motion element that has
  // `variants={…}`, not just the root. Why per-element instead of relying
  // on framer-motion's parent→child variant propagation:
  //
  //   - The root may have NO `variants` of its own (the user only created
  //     variant styles on a nested element). A bare `animate={variant}`
  //     on the root in that case has nothing to resolve against, AND
  //     propagation behavior is unreliable when the parent context has
  //     no variants to anchor the label.
  //   - The codebase's working components (PricingCard, FeatureCard, …)
  //     duplicate `animate={…}` onto every variants-bearing element. New
  //     codegen output must match that convention or live-preview taps
  //     produce the "frozen at initial variant" bug the user hit.
  //
  // Remove animate={initialVariant} (static, from non-connection path)
  // first so the per-element pass is a clean insert. Both the variant-list
  // dialect and the legacy scalar form.
  result = result.replace(/\s*animate=\{\['default',\s*initialVariant\]\}/g, '');
  result = result.replace(/\s*animate=\{initialVariant\}/g, '');

  // For every `<motion.* ...>` tag, if it has `variants={…}` AND no
  // `animate=`, inject `animate={variant}` next to the variants prop.
  // Also ensure the ROOT has `animate={variant}` even if it has no
  // variants — the existing codegen contract (line below) relies on
  // its presence to position `initial={initialVariant}`.
  //
  // We can't use a simple regex like `<motion\.\w+\s[^>]*?>` to extract
  // tags: it stops at the first `>` it sees, which would include the
  // `>` inside `=>` arrow functions (`onTap={() => ...}`) or `>`
  // comparison operators inside JSX expressions. The previous version
  // truncated tags at `() =` and on the second-connection pass garbled
  // the `onTap` handler, leaving stray fragments like `> setVariant(…)}`
  // floating in the JSX. Walk the source manually with brace + string
  // state instead.
  const tagInserts: Array<{ tagStart: number; tagEnd: number; newTag: string }> = [];
  let isFirstTag = true;
  let scan = 0;
  while (scan < result.length) {
    // Scan for the next animate-capable tag: `<motion.*` OR `<MotionLink`
    // (motion.create(Link) — a MotionLink ROOT was previously invisible to
    // this loop, so `isFirstTag` mis-identified a descendant motion.* as the
    // root and a variants-carrying MotionLink never got `animate` wired).
    const motionIdx = result.indexOf('<motion.', scan);
    const linkIdx = result.indexOf('<MotionLink', scan);
    const tagStartIdx = motionIdx === -1 ? linkIdx : linkIdx === -1 ? motionIdx : Math.min(motionIdx, linkIdx);
    if (tagStartIdx === -1) break;
    const isMotionLink = tagStartIdx === linkIdx;
    const nameStart = tagStartIdx + (isMotionLink ? '<MotionLink'.length : '<motion.'.length);
    // Validate the token boundary: after `<motion.` a tag-name char must
    // follow (don't false-match `<motion.div.foo`); after `<MotionLink` a
    // NON-name char must follow (don't match `<MotionLinkFoo`).
    if (!isMotionLink && !/[A-Za-z]/.test(result[nameStart] ?? '')) { scan = nameStart; continue; }
    if (isMotionLink && /[A-Za-z0-9]/.test(result[nameStart] ?? '')) { scan = nameStart; continue; }
    // Find the end of the OPENING tag, respecting string + brace depth
    // so a `>` inside an attribute expression is ignored.
    let i = nameStart;
    let braceDepth = 0;
    let stringChar: string | null = null;
    let tagEndIdx = -1;
    let isSelfClose = false;
    while (i < result.length) {
      const ch = result[i];
      if (stringChar) {
        if (ch === '\\') { i += 2; continue; }
        if (ch === stringChar) stringChar = null;
        i++;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') { stringChar = ch; i++; continue; }
      if (ch === '{') { braceDepth++; i++; continue; }
      if (ch === '}') { braceDepth--; i++; continue; }
      if (braceDepth === 0 && ch === '>') {
        tagEndIdx = i;
        isSelfClose = result[i - 1] === '/';
        break;
      }
      i++;
    }
    if (tagEndIdx === -1) break;
    scan = tagEndIdx + 1;

    const tagText = result.slice(tagStartIdx, tagEndIdx + 1);
    const hasVariants = /\svariants=\{/.test(tagText);
    const hasAnimate = /\sanimate=\{/.test(tagText);
    if (hasAnimate) { isFirstTag = false; continue; }
    // Slot-hoisted const decls live at MODULE scope where `variant`
    // (function-scoped useState) is undefined. Injecting `animate={variant}`
    // there would crash module load with `ReferenceError: variant is not
    // defined`. Skip them entirely — framer-motion's parent→child variant
    // propagation handles slot-rendered children at runtime when there's
    // a containing motion context.
    if (isIndexInsideSlotConst(result, tagStartIdx)) { isFirstTag = false; continue; }
    if (!hasVariants && !isFirstTag) continue;
    isFirstTag = false;
    const closeLen = isSelfClose ? 2 : 1;
    const newTag = tagText.slice(0, tagText.length - closeLen).trimEnd() + " animate={['default', variant]}" + (isSelfClose ? ' />' : '>');
    tagInserts.push({ tagStart: tagStartIdx, tagEnd: tagEndIdx + 1, newTag });
  }
  // Apply inserts back-to-front so earlier offsets stay valid.
  for (let i = tagInserts.length - 1; i >= 0; i--) {
    const { tagStart, tagEnd, newTag } = tagInserts[i];
    result = result.slice(0, tagStart) + newTag + result.slice(tagEnd);
  }
  // Ensure initial on root (prevents mount animation) — list form; tolerate
  // legacy scalar wiring already present.
  if (!result.includes("initial={['default', initialVariant]}") && !result.includes('initial={initialVariant}')) {
    const animateIdx = result.indexOf("animate={['default', variant]}");
    if (animateIdx !== -1) {
      // Root already carrying an OBJECT-form initial (an Appear effect's
      // from-state)? Adding the variant-array initial would emit a DUPLICATE
      // JSX attribute: React takes the LAST (killing the appear) while the
      // parser reads the FIRST (missing the variant wiring) — editor and
      // runtime diverge (live find 2026-07-03, hover-variant + cursor master).
      // Skip it: motion animates from the object initial INTO the animate
      // variant labels on mount — exactly the appear semantic.
      const tagStart = result.lastIndexOf('<', animateIdx);
      const tagText = tagStart >= 0 ? result.slice(tagStart, animateIdx) : '';
      if (!/initial=\{\{/.test(tagText)) {
        result = result.slice(0, animateIdx) + "initial={['default', initialVariant]} " + result.slice(animateIdx);
      } else {
        trace.action('connection-config:skip-initial-array-appear-root', {});
      }
    }
  }

  // 4. Generate event handlers from connections.
  //
  // Strategy: strip ALL existing event handlers from every motion tag,
  // then regenerate. Connections are grouped by (sourceNode, trigger):
  // each group lands on a SPECIFIC element (the root for unset
  // sourceNode, the matching `data-id` element otherwise). Strip+
  // regenerate keeps things consistent across edits — adding/removing
  // a single connection produces a clean handler set every time, no
  // accumulating leftovers from earlier codegen runs.
  result = stripAllEventHandlers(result);

  // Group by (sourceNode, trigger). The "(no sourceNode)" bucket goes
  // on the root motion tag.
  const ROOT_KEY = '__ROOT__';
  const groups = new Map<string, Connection[]>();
  for (const c of connections) {
    const key = `${c.sourceNode ?? ROOT_KEY}|${c.trigger}`;
    let bucket = groups.get(key);
    if (!bucket) { bucket = []; groups.set(key, bucket); }
    bucket.push(c);
  }

  for (const [key, conns] of groups) {
    const [sourceKey, trigger] = key.split('|') as [string, ConnectionTrigger];
    const propName = triggerToPropName(trigger);
    if (!propName) continue;
    const handler = buildTriggerHandler(trigger, conns);
    if (sourceKey === ROOT_KEY) {
      result = insertPropOnRootMotion(result, propName, handler);
    } else {
      result = insertPropOnMotionWithDataId(result, sourceKey, propName, handler);
    }
  }

  trace.action('connection-config:generate-code', { connectionCount: connections.length });
  return result;
}

// ─── Codegen helpers ────────────────────────────────────────────────────────

/** Map a connection trigger to its framer-motion event prop name.
 *  `inView` is special: the actual transition is driven by a useEffect
 *  chain, but `onViewportEnter` flips the `isInView` flag. */
function triggerToPropName(trigger: ConnectionTrigger): string {
  switch (trigger) {
    case 'click': return 'onTap';
    case 'clickStart': return 'onTapStart';
    case 'mouseEnter': return 'onHoverStart';
    case 'mouseLeave': return 'onHoverEnd';
    case 'inView': return 'onViewportEnter';
    // afterDelay is TIME-driven, not an event: the auto-advance lives in the
    // chain useEffect below, so there is no prop to hang on the element.
    case 'afterDelay': return '';
  }
}

/** Build the JS handler body for a group of connections that share
 *  (sourceNode, trigger). Single connection → direct setVariant. Multi
 *  → ternary keyed on the current `variant` so the right transition
 *  fires for the right starting state. inView always just flips the
 *  isInView flag — the chain useEffect handles delays / targets. */
function buildTriggerHandler(trigger: ConnectionTrigger, conns: Connection[]): string {
  if (trigger === 'inView') return '() => setIsInView(true)';
  // Gate EVERY connection by its `from` variant — a connection is per-variant
  // ("when in `from`, this trigger → `to`"). A single connection was
  // previously UNGATED (`() => setVariant(to)`), so a source element shown
  // across variants fired the same transition in EVERY variant, not just the
  // one it was configured on. The chained ternary (with a `: variant`
  // fall-through that keeps the current variant) gates single AND multi
  // identically.
  const cases = conns.map(c => `variant === '${c.from}' ? '${c.to}'`).join(' : ');
  const delayed = conns.filter(c => (c.delay ?? 0) > 0);
  if (delayed.length === 0) return `() => setVariant(${cases} : variant)`;
  const delayCases = conns.map(c => `variant === '${c.from}' ? ${Math.round((c.delay ?? 0) * 1000)}`).join(' : ');
  return `() => { const _d = ${delayCases} : 0; setTimeout(() => setVariant(${cases} : variant), _d); }`;
}

/** Strip every framer-motion event handler from every `<motion.*>` tag
 *  in the source. Brace + string aware so handlers with nested arrow
 *  functions / comparison operators don't get half-stripped. Targets
 *  the five props framer-motion exposes for variant transitions. */
function stripAllEventHandlers(code: string): string {
  const PROPS = ['onTap', 'onTapStart', 'onHoverStart', 'onHoverEnd', 'onViewportEnter'];
  let result = code;
  for (const prop of PROPS) {
    result = stripPropFromAllTags(result, prop);
  }
  return result;
}

/** Regex matching the start of an opening tag we may carry a connection
 *  handler on: a `<motion.*>` element OR an Uppercase component instance
 *  (`<JiPoZa ...>`). Component instances forward the handler to their root
 *  motion element via `...rest` (see event-prop-forwarding). */
const HANDLER_TAG_OPEN = /<(motion\.\w+|[A-Z][A-Za-z0-9]*)/;
const HANDLER_TAG_OPEN_G = /<(motion\.\w+|[A-Z][A-Za-z0-9]*)/g;

/** Remove every `<prop>={...}` occurrence from every motion tag AND component
 *  instance tag in the source. Walks each tag manually with brace + string
 *  state so a `>` or `}` inside a nested expression doesn't terminate the prop
 *  value prematurely (the same family of bugs that broke the per-tag animate
 *  scan with a naive regex). Component instances are included so a connection
 *  on a nested instance is cleanly re-generated, not duplicated. */
function stripPropFromAllTags(code: string, prop: string): string {
  let out = code;
  let scan = 0;
  while (true) {
    HANDLER_TAG_OPEN_G.lastIndex = scan;
    const tm = HANDLER_TAG_OPEN_G.exec(out);
    if (!tm) break;
    const tagStart = tm.index;
    const tagEnd = findTagEnd(out, tagStart);
    if (tagEnd === -1) { scan = tagStart + tm[0].length; continue; }
    const tagText = out.slice(tagStart, tagEnd + 1);
    // Locate ` <prop>=` on a token boundary so `onTap=` doesn't match
    // `customOnTap=`.
    const propPattern = new RegExp(`\\s+${prop}=\\{`);
    const propMatch = tagText.match(propPattern);
    if (!propMatch) { scan = tagEnd + 1; continue; }
    const propStartInTag = propMatch.index!;
    // Find the matching closing brace of the prop value.
    const valueStart = propStartInTag + propMatch[0].length;
    let depth = 1;
    let stringChar: string | null = null;
    let valueEnd = -1;
    for (let i = valueStart; i < tagText.length; i++) {
      const ch = tagText[i];
      if (stringChar) {
        if (ch === '\\') { i++; continue; }
        if (ch === stringChar) stringChar = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') { stringChar = ch; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { valueEnd = i; break; } }
    }
    if (valueEnd === -1) { scan = tagEnd + 1; continue; }
    const newTagText = tagText.slice(0, propStartInTag) + tagText.slice(valueEnd + 1);
    out = out.slice(0, tagStart) + newTagText + out.slice(tagEnd + 1);
    // RE-SCAN THE SAME TAG — a tag can carry the prop MORE THAN ONCE (the
    // 14×-duplicated onViewportEnter find: two codegen groups landed on one
    // tag, and this single-removal-then-skip let the extras accumulate on
    // every regeneration). Restart at the tag so every copy is removed.
    scan = tagStart;
  }
  return out;
}

/** Insert a JSX prop into the ROOT element's opening tag — the first
 *  handler-capable tag that isn't a TRANSPARENT WRAPPER (LayoutGroup /
 *  MotionConfig / AnimatePresence). Used for connections without a
 *  sourceNode — hovering/clicking anywhere on the root cycles the variant.
 *
 *  Previously matched only `'<motion.'`: a `MotionLink` root
 *  (motion.create(Link), the next/link escape hatch) was silently skipped —
 *  the hover variant's connections were WRITTEN but onHoverStart/onHoverEnd
 *  never landed, so the variant never fired (live find 2026-07-14, "Explore
 *  CTA" master). In a mixed tree it also mis-targeted the first descendant
 *  motion.* as "the root". */
function insertPropOnRootMotion(code: string, propName: string, handler: string): string {
  const WRAPPER_TAGS = new Set(['LayoutGroup', 'MotionConfig', 'AnimatePresence']);
  HANDLER_TAG_OPEN_G.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HANDLER_TAG_OPEN_G.exec(code)) !== null) {
    // Skip generic type params (`useRef<HTMLDivElement>`): a real JSX `<` is
    // never preceded by an identifier character.
    const prev = m.index > 0 ? code[m.index - 1] : ' ';
    if (/[A-Za-z0-9_$]/.test(prev)) continue;
    if (WRAPPER_TAGS.has(m[1])) continue;
    return insertPropAtTag(code, m.index, propName, handler);
  }
  return code;
}

/** Insert a JSX prop into the `<motion.*>` tag whose `data-id` matches
 *  `dataId`. Used for per-child connections — the handler lands on
 *  THAT specific element so only clicks on that child fire the
 *  transition. Falls back to no-op if the element isn't in the JSX
 *  (deleted node, stale connection, etc.). */
function insertPropOnMotionWithDataId(code: string, dataId: string, propName: string, handler: string): string {
  const dataIdAttr = `data-id="${dataId}"`;
  const dataIdIdx = code.indexOf(dataIdAttr);
  if (dataIdIdx === -1) return code;
  // Walk backward from the data-id attr to find the opening tag for THIS
  // element — a `<motion.*>` OR an Uppercase component instance
  // (`<JiPoZa ...>`). Component instances forward the handler to their root
  // motion element via `...rest` (event-prop-forwarding), so connections on
  // nested component instances work the same as on motion elements.
  const tagStart = code.lastIndexOf('<', dataIdIdx);
  if (tagStart === -1) return code;
  const nameMatch = code.slice(tagStart).match(HANDLER_TAG_OPEN);
  if (!nameMatch || nameMatch.index !== 0) return code;
  // Make sure the tag we found actually contains this data-id (no
  // intervening `>` between tagStart and dataIdIdx — otherwise the
  // data-id belongs to a different tag).
  const tagEnd = findTagEnd(code, tagStart);
  if (tagEnd === -1 || tagEnd < dataIdIdx) return code;
  return insertPropAtTag(code, tagStart, propName, handler);
}

/** Insert `\n      <propName>={<handler>}` immediately after the tag's
 *  name token (`<motion.div`, `<MotionLink`, `<JiPoZa`, …). Same shape as
 *  the legacy single-handler insertion the codegen used to do. */
function insertPropAtTag(code: string, tagStart: number, propName: string, handler: string): string {
  const nameMatch = code.slice(tagStart).match(HANDLER_TAG_OPEN);
  if (!nameMatch || nameMatch.index !== 0) return code;
  // DUPLICATE GUARD — two codegen groups can resolve to the SAME element (a
  // no-sourceNode "root" connection + a sourceNode pointing at the root's
  // data-id). Writing both emits a duplicate JSX attribute: React keeps the
  // LAST while the parser reads the FIRST, and every later mutation bounces.
  // First writer wins; the collision is traced.
  const tagEnd = findTagEnd(code, tagStart);
  if (tagEnd !== -1) {
    const tagText = code.slice(tagStart, tagEnd + 1);
    if (new RegExp(`\\s${propName}=\\{`).test(tagText)) {
      trace.action('connection-config:skip-duplicate-handler', { propName });
      return code;
    }
  }
  const nameEnd = tagStart + nameMatch[0].length;
  return code.slice(0, nameEnd) + `\n      ${propName}={${handler}}` + code.slice(nameEnd);
}

/** Find the index of the closing `>` of a `<motion.*>` opening tag,
 *  starting at `tagStart`. Brace + string aware — same scanner used
 *  by the per-tag `animate={variant}` insertion above so `>` inside
 *  attribute expressions (arrow functions, comparison ops) doesn't
 *  prematurely terminate the tag. Returns -1 on failure. */
function findMotionTagEnd(code: string, tagStart: number): number {
  const i = tagStart + '<motion.'.length;
  if (!/[A-Za-z]/.test(code[i] ?? '')) return -1;
  return scanTagEnd(code, i);
}

/** Find the closing `>` of any opening tag (motion element OR component
 *  instance) starting at `tagStart`. Brace + string aware. Returns -1 on
 *  failure. */
function findTagEnd(code: string, tagStart: number): number {
  const m = code.slice(tagStart).match(HANDLER_TAG_OPEN);
  if (!m || m.index !== 0) return -1;
  return scanTagEnd(code, tagStart + m[0].length);
}

/** Shared brace/string-aware scanner: from index `i` (just past the tag
 *  name), return the index of the tag's closing `>`. */
function scanTagEnd(code: string, i: number): number {
  let braceDepth = 0;
  let stringChar: string | null = null;
  while (i < code.length) {
    const ch = code[i];
    if (stringChar) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === stringChar) stringChar = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { stringChar = ch; i++; continue; }
    if (ch === '{') { braceDepth++; i++; continue; }
    if (ch === '}') { braceDepth--; i++; continue; }
    if (braceDepth === 0 && ch === '>') return i;
    i++;
  }
  return -1;
}
