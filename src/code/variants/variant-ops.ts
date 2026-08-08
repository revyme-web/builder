// variant-ops.ts — Add, remove, rename variants in component files.
// Each variant = a key in the framer-motion `variants` objects on motion.* elements.
// Adding a variant: adds to variantConfig + copies default values to all variant objects.

import { modifyProjectFile } from '../project/modify-file';
import { ensureRootPerfIsolation } from './variant-perf';
import { parseVariantConfig, serializeVariantConfig, hasInteractionState, type VariantConfig } from './variant-config';
import { addConnection, removeConnectionEntry, removeConnectionsForVariantInCode, type ConnectionTrigger } from './connection-config';
import { projectFS } from '../project/project-fs';
import { parseJSXToNodes } from '../parsing/parser';
import { setVariantVisibilityInCode } from '../generation/variant-visibility-gen';
import { removeObjectEntryBalanced } from '../generation/generator-utils';
import { parseJSX } from '../parsing/ast-utils';
import { trace } from '@/shared/debug-trace';

const VARIANT_GAP = 200; // px gap between variant blocks on canvas
const HP_STATE_GAP = 200; // px gap between a variant and its hover/pressed states

/**
 * Add a new variant to a component file.
 * 1. Adds entry to variantConfig
 * 2. For every `variants` object in the file, copies the 'default' key as the new variant
 *
 * Optional `interaction` marks the new entry as a hover/pressed state
 * cascading from `interaction.parent`. The runtime treats it like any
 * other variant; the metadata only drives the canvas UI (button
 * placement, dedup, "selected interaction state → source variant"
 * resolution when wiring further connections).
 */
export function addVariant(
  filePath: string,
  name: string,
  position?: { x: number; y: number },
  label?: string,
  sourceVariant?: string,
  interaction?: { type: 'hover' | 'pressed'; parent: string },
): VariantConfig[] | null {
  try {
    let configs: VariantConfig[] | null = null;

    modifyProjectFile(filePath, (code) => {
      configs = parseVariantConfig(code);

      // Use provided position, or fall back to below last variant
      let x: number, y: number;
      if (position) {
        x = position.x;
        y = position.y;
      } else {
        let maxBottom = 0;
        for (const v of configs) {
          maxBottom = Math.max(maxBottom, v.y + 400);
        }
        x = 0;
        y = maxBottom + VARIANT_GAP;
      }

      const newConfig: VariantConfig = {
        name,
        label: label || name,
        x,
        y,
        isPrimary: false,
      };
      if (interaction) {
        newConfig.interactionType = interaction.type;
        newConfig.parentVariant = interaction.parent;
      }
      configs.push(newConfig);

      // 1. Replace variantConfig in code
      let updated = replaceVariantConfigInCode(code, configs);

      // 1b. CLEAN any STALE footprint for this NAME first (variant-object entries +
      //     conditional ternary branches). A make-component extraction can leave
      //     entries for the SOURCE component's variants — e.g. the Logo Mark carried
      //     `'variant-6'/'7'/'8'` from the Header — so a newly-created `variant-6`
      //     COLLIDES with that leftover and inherits the stale value (a black dot)
      //     instead of the source variant's (a green dot). Wipe the name, then the
      //     add + cascade below re-seed it purely from the source.
      updated = removeVariantKeyFromAllObjects(updated, name);
      updated = removeVariantBranchFromConditionalTernaries(updated, name);

      // 2. Add the new variant key to all `variants` objects (copy from source variant).
      //    Interaction states (hover/pressed) REPLACE the variant via setVariant so
      //    they seed the source's RESOLVED value (incl. default); a regular new
      //    variant INHERITS via animate={['default', variant]} and stays sparse.
      updated = addVariantKeyToAllObjects(updated, name, sourceVariant, !!interaction);

      // 3. Cascade JSX-level conditional patterns so the new variant
      //    matches the source variant's behavior:
      //      - AnimatePresence visibility (`{variant === 'X' && <e/>}`)
      //      - Conditional style ternaries (`order: variant === 'X' ? 1 : 0`)
      //    Without this, "Add Variant" from variant-1 produced a copy
      //    that inherited variant-1's `variants` object overrides but
      //    NOT the JSX conditionals — so e.g. an AnimatePresence-only
      //    child visible on variant-1 was missing on the new variant.
      const effectiveSource = sourceVariant ?? 'default';
      const allVariantNames = configs.map(v => v.name);
      updated = cascadeVisibilityForNewVariant(updated, name, effectiveSource, allVariantNames);
      updated = cascadeConditionalTernariesForNewVariant(updated, name, effectiveSource);
      return updated;
    });

    trace.action('variant-ops:add', { filePath, name, interaction });
    return configs;
  } catch (err) {
    trace.error('variant-ops:addVariant-failed', { filePath, name, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/**
 * Add an interaction state (hover or pressed) cascading from `parentVariant`.
 *
 * Mirrors the old builder's `handleAddInteractionState` semantics, but
 * implemented over the JSX source-of-truth model:
 *
 *  1. Skip if the state already exists for that source.
 *  2. Add a variant entry named `${parentVariant}-${type}`, marked with
 *     `interactionType` + `parentVariant`. Position defaults to below
 *     the source (or to the right when a sibling is already there);
 *     callers (the Add Variant UI) can override with a precise position
 *     via `positionOverride`.
 *  3. Auto-wire connections following the chain rule:
 *     - Hover only: source mouseEnter → hover, hover mouseLeave → source.
 *     - Pressed only: source clickStart → pressed, pressed click → source.
 *     - Both states exist (creating the second one) — chain instead of
 *       parallel pairs:
 *         · Adding pressed while hover exists: hover gets clickStart →
 *           pressed; pressed click → hover (NOT source).
 *         · Adding hover while pressed exists: hover mouseLeave → source
 *           + clickStart → pressed; the existing pressed click → source
 *           is rewritten to pressed click → hover.
 *
 * Returns the updated variant config on success, null on failure (source
 * not found, state already exists, etc.).
 */
export function addInteractionState(
  filePath: string,
  parentVariant: string,
  type: 'hover' | 'pressed',
  positionOverride?: { x: number; y: number },
): VariantConfig[] | null {
  try {
    const code = projectFS.readFile(filePath);
    if (!code) {
      trace.error('variant-ops:addInteractionState-no-code', { filePath });
      return null;
    }

    const configs = parseVariantConfig(code);
    const source = configs.find(v => v.name === parentVariant);
    if (!source) {
      trace.error('variant-ops:addInteractionState-no-source', { filePath, parentVariant });
      return null;
    }
    if (hasInteractionState(configs, parentVariant, type)) {
      trace.action('variant-ops:addInteractionState-skip-duplicate', { filePath, parentVariant, type });
      return null;
    }

    const newName = `${parentVariant}-${type}`;
    const stateLabel = type === 'hover' ? 'Hover' : 'Pressed';
    const newLabel = `${source.label} - ${stateLabel}`;

    // The "sibling" state is the OTHER half of {hover, pressed} for
    // this same source variant — used both for default positioning
    // (tuck next to the sibling) AND for the chain-connection rewrite
    // when adding the second state.
    const sibling = configs.find(v => v.parentVariant === parentVariant && v.interactionType !== type && !!v.interactionType);

    // Position: caller override wins. Otherwise place the new state
    // BELOW the source by default. If a sibling state already exists,
    // tuck the new one to the right of the sibling so they sit next
    // to each other below the source — mirrors the builder's "find a
    // free slot" feel without doing overlap detection here (the UI
    // handles precise screen placement).
    let position: { x: number; y: number };
    if (positionOverride) {
      position = positionOverride;
    } else if (sibling) {
      position = { x: sibling.x + 600, y: sibling.y };
    } else {
      position = { x: source.x, y: source.y + 400 + HP_STATE_GAP };
    }

    const updated = addVariant(filePath, newName, position, newLabel, parentVariant, { type, parent: parentVariant });
    if (!updated) return null;

    const forwardTrigger: ConnectionTrigger = type === 'hover' ? 'mouseEnter' : 'clickStart';
    const reverseTrigger: ConnectionTrigger = type === 'hover' ? 'mouseLeave' : 'click';

    if (!sibling) {
      // Single state — simple bidirectional pair.
      addConnection(filePath, parentVariant, newName, forwardTrigger);
      addConnection(filePath, newName, parentVariant, reverseTrigger);
    } else if (type === 'pressed') {
      // Pressed added with hover already present → chain through hover.
      // Source stays connected to hover (mouseEnter ↔ mouseLeave); we
      // add hover clickStart → pressed and pressed click → hover.
      addConnection(filePath, sibling.name, newName, 'clickStart');
      addConnection(filePath, newName, sibling.name, 'click');
    } else {
      // Hover added with pressed already present. Pressed previously
      // had `click → source`; rewrite to `click → hover` so the chain
      // routes through hover instead of jumping straight to source.
      removeConnectionEntry(filePath, sibling.name, parentVariant, 'click');
      addConnection(filePath, parentVariant, newName, 'mouseEnter');
      addConnection(filePath, newName, parentVariant, 'mouseLeave');
      addConnection(filePath, newName, sibling.name, 'clickStart');
      addConnection(filePath, sibling.name, newName, 'click');
    }

    // Re-parse the final state for the caller.
    const finalCode = projectFS.readFile(filePath);
    const finalConfigs = finalCode ? parseVariantConfig(finalCode) : null;
    trace.action('variant-ops:add-interaction-state', { filePath, parentVariant, type, name: newName });
    return finalConfigs;
  } catch (err) {
    trace.error('variant-ops:addInteractionState-failed', { filePath, parentVariant, type, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}


/**
 * Remove a variant from a component file.
 * Cannot remove the primary variant.
 */
export function removeVariant(filePath: string, variantName: string): VariantConfig[] | null {
  try {
    let result: VariantConfig[] | null = null;

    modifyProjectFile(filePath, (code) => {
      const configs = parseVariantConfig(code);
      const target = configs.find(v => v.name === variantName);
      if (!target || target.isPrimary) return code; // no change

      result = configs.filter(v => v.name !== variantName);
      let updated = replaceVariantConfigInCode(code, result);

      // Remove the variant key from all variant objects
      updated = removeVariantKeyFromAllObjects(updated, variantName);

      // Tear down any connection wired to the deleted variant (and the now-
      // orphaned event handlers — generateConnectionCode strips+regenerates).
      // Without this, deleting e.g. a `default-hover` variant left the
      // `mouseEnter`/`mouseLeave` connection entries AND the onHoverStart/
      // onHoverEnd handlers referencing the dead variant.
      updated = removeConnectionsForVariantInCode(updated, variantName);

      // Drop the deleted variant's branch from every inline conditional ternary
      // (`prop: (variant|initialVariant) === 'X' ? a : b`, style OR content) so the
      // value collapses to what it'd be without X. Otherwise the stale `=== 'X'`
      // lingers in the source and re-adding X resurrects the old conditional value
      // (the reported bug: an `order: … === 'variant-1' ? 2 : 0` survived a delete).
      // Runs AFTER the connection teardown so the regenerated setVariant toggles —
      // which intentionally keep a `variant` identifier fallback and so are skipped
      // here anyway — are already free of the dead variant.
      updated = removeVariantBranchFromConditionalTernaries(updated, variantName);

      // Re-emit every AnimatePresence visibility gate against the REMAINING
      // variants. The ternary sweep above only reaches inline style/content
      // ternaries, so a gate kept naming the dead variant —
      // `{initialVariant !== "variant-1" && <svg/>}` survived deleting
      // variant-1 (found replaying the user's own file). Always true now, so
      // nothing looked wrong, but the dead reference is exactly what makes
      // re-adding a variant of the same name resurrect the old visibility.
      // Runs AFTER the connection teardown so the gates it reads are already
      // in their post-teardown (`initialVariant`) form. The delete-path mirror
      // of cascadeVisibilityForNewVariant.
      updated = cascadeVisibilityForRemovedVariant(updated, result!.map(v => v.name));

      // Removing this variant may have dropped the LAST heavy animated prop —
      // sweep the root perf isolation in the SAME write (see variant-perf.ts).
      updated = ensureRootPerfIsolation(updated);

      // NEVER LAND UNPARSEABLE SOURCE. This op runs five string transforms over
      // the whole file; if any of them mis-cuts, the parser returns an EMPTY
      // node map and the canvas goes blank — indistinguishable from "the delete
      // destroyed my component", and the user's work is only recoverable via
      // undo. Refusing the write instead makes the worst case "the variant
      // didn't get deleted", and the traced error is how the real defect
      // surfaces. (Both known mis-cuts are fixed above; this is the backstop.)
      if (!parseJSX(updated)) {
        trace.error('variant-ops:removeVariant-would-corrupt', { filePath, variantName });
        result = null;
        return code;
      }
      return updated;
    });

    if (result === null) return null;
    trace.action('variant-ops:remove', { filePath, variantName });
    return result;
  } catch (err) {
    trace.error('variant-ops:removeVariant-failed', { filePath, variantName, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/**
 * Rename a variant — updates the user-facing `label` only. The internal
 * `name` (e.g. 'default', 'variant-1') is the stable key referenced from
 * `variants` objects, motion props, and connection configs everywhere in
 * the file, so we never touch it. The `label` is what the layers panel
 * shows for the variant header row.
 */
export function renameVariant(filePath: string, variantName: string, newLabel: string): VariantConfig[] | null {
  try {
    let result: VariantConfig[] | null = null;

    modifyProjectFile(filePath, (code) => {
      const configs = parseVariantConfig(code);
      const target = configs.find(v => v.name === variantName);
      if (!target) return code;

      const trimmed = newLabel.trim();
      if (!trimmed || trimmed === target.label) return code;

      target.label = trimmed;
      result = configs;
      return replaceVariantConfigInCode(code, configs);
    });

    trace.action('variant-ops:rename', { filePath, variantName, newLabel });
    return result;
  } catch (err) {
    trace.error('variant-ops:renameVariant-failed', { filePath, variantName, newLabel, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/**
 * Update variant position (after dragging on canvas).
 */
export function updateVariantPosition(filePath: string, variantName: string, x: number, y: number): void {
  try {
    modifyProjectFile(filePath, (code) => {
      const configs = parseVariantConfig(code);
      const target = configs.find(v => v.name === variantName);
      if (!target) return code; // no change

      target.x = x;
      target.y = y;

      return replaceVariantConfigInCode(code, configs);
    });

    trace.action('variant-ops:update-position', { filePath, variantName, x, y });
  } catch (err) {
    trace.error('variant-ops:updateVariantPosition-failed', { filePath, variantName, x, y, error: err instanceof Error ? err.message : String(err) });
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function replaceVariantConfigInCode(code: string, configs: VariantConfig[]): string {
  const serialized = serializeVariantConfig(configs);
  const match = code.match(/const\s+variantConfig\s*=\s*\[[\s\S]*?\];/);

  if (match) {
    return code.replace(match[0], serialized);
  }

  // No existing config — insert before the first export/import
  const insertIdx = code.search(/^(import|export)/m);
  if (insertIdx !== -1) {
    return code.slice(0, insertIdx) + serialized + '\n\n' + code.slice(insertIdx);
  }
  return serialized + '\n\n' + code;
}

/**
 * Add a new key to all framer-motion variant objects in the code.
 * Copies values from the SOURCE variant (or 'default' if no source specified).
 *
 * Finds patterns like:
 *   const navVariants = { default: { ... }, open: { ... } };
 * And adds:
 *   newName: { ...copy of source values }
 */
/** Transform channels motion holds at their last value across a variant switch
 *  (paint props instead fall back to the default entry). Mirrors the oracle's
 *  TRANSFORM_KEYS in oracle/checks/variant-dialect.ts. */
const TRANSFORM_KEYS = ['rotate', 'rotateX', 'rotateY', 'rotateZ', 'scale', 'scaleX', 'scaleY', 'skewX', 'skewY', 'x', 'y', 'z'];
const TRANSFORM_NEUTRAL: Record<string, string> = { scale: '1', scaleX: '1', scaleY: '1' };

/**
 * For a variants object that animates transforms, the entry a NEW variant needs
 * so motion has a target instead of holding the previous variant's transform.
 * Returns null for a paint-only object (which correctly stays sparse).
 *
 * Values come from the object's OWN `default` entry where it states one — that is
 * what an entry-less variant renders today, so seeding it changes nothing
 * visually. Anything the default doesn't state falls back to the CSS neutral.
 */
function transformRestEntry(objContent: string): string | null {
  const used = TRANSFORM_KEYS.filter((k) => new RegExp(`(?:^|[{,\\s])${k}\\s*:`).test(objContent));
  if (used.length === 0) return null;
  const def = objContent.match(/default\s*:\s*\{([^}]*)\}/)?.[1] ?? '';
  const parts = used.map((k) => {
    const own = def.match(new RegExp(`(?:^|[{,\\s])${k}\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`))?.[1];
    return `${k}: ${own ?? TRANSFORM_NEUTRAL[k] ?? '0'}`;
  });
  return `{ ${parts.join(', ')} }`;
}

function addVariantKeyToAllObjects(code: string, newName: string, sourceVariant?: string, seedResolvedDefault: boolean = false): string {
  // Find all: const xxxVariants = { ... };
  const variantObjRegex = /const\s+(\w+Variants)\s*=\s*\{([\s\S]*?)\};/g;
  let result = code;

  let match;
  while ((match = variantObjRegex.exec(code)) !== null) {
    const fullMatch = match[0];
    const objContent = match[2];

    // Copy the SOURCE variant's explicit override (if any) into the new variant.
    let sourceContent: string | null = null;
    if (sourceVariant && sourceVariant !== 'default') {
      const sourceMatch = objContent.match(new RegExp(`'${sourceVariant}'\\s*:\\s*(\\{[^}]*\\})`));
      if (sourceMatch) sourceContent = sourceMatch[1];
    }
    // The source variant has NO explicit entry here → it INHERITS the default.
    // A regular NEW VARIANT must inherit too (sparse model — animate={['default',
    // variant]}), so add NO entry: seeding the default in is a spurious override
    // (the purple "overridden" pill on a value that merely equals the default —
    // e.g. the logo dots' fill). An INTERACTION state (hover/pressed) instead
    // REPLACES the variant via setVariant, so it DOES need the resolved default
    // seeded or hover/press snaps to the base — addVariant passes
    // seedResolvedDefault=true for those.
    if (!sourceContent) {
      // TRANSFORMS BREAK THE SPARSE MODEL. Paint props inherit fine — with
      // `animate={['default', variant]}` an entry-less variant just shows
      // default's value. But framer-motion HOLDS an animated transform at its
      // last value when it switches to a variant with no entry, so the element
      // arrives stuck mid-state: add a variant while a burger is an X and the
      // new variant's burger is a permanent X (user report 2026-08-01; the same
      // class the oracle's VARIANT_OBJECT_MISSING_ENTRY rule describes as "the
      // hamburger-frozen-as-X bug").
      //
      // So a variants object that animates transforms ALWAYS gets an explicit
      // entry, seeded with the REST values this variant already renders (the
      // default entry's own values), not a blind neutral — the point is to give
      // motion a target, not to change the design. Paint-only objects keep the
      // sparse behaviour below, where an entry would show as a spurious
      // "overridden" pill on a value that merely equals the default.
      //
      // generator-styles has an equivalent guard (ensureTransformNeutralOnAllVariants)
      // but it only runs on a STYLE WRITE that touches a transform prop. Adding a
      // variant is not a style write, so nothing closed this hole until here.
      const transformRest = transformRestEntry(objContent);
      if (transformRest) {
        sourceContent = transformRest;
      } else {
        if (!seedResolvedDefault) continue;
        const defaultMatch = objContent.match(/default\s*:\s*(\{[^}]*\})/);
        if (!defaultMatch) continue;
        sourceContent = defaultMatch[1];
      }
    }

    const defaultContent = sourceContent;

    // Check if new variant already exists (handles both quoted and unquoted keys)
    if (objContent.includes(`${newName}:`) || objContent.includes(`'${newName}':`) || objContent.includes(`"${newName}":`)) continue;

    // Add new variant before the closing }
    // Ensure the previous entry has a trailing comma
    const lastBrace = fullMatch.lastIndexOf('}');
    let beforeBrace = fullMatch.slice(0, lastBrace).trimEnd();
    if (beforeBrace.length > 0 && !beforeBrace.endsWith(',') && !beforeBrace.endsWith('{')) {
      beforeBrace += ',';
    }
    const insertion = `\n  '${newName}': ${defaultContent},\n`;
    const updated = beforeBrace + insertion + fullMatch.slice(lastBrace);
    result = result.replace(fullMatch, updated);
  }

  return result;
}

/**
 * For every node with an AnimatePresence visibility wrapper, ensure the
 * new variant inherits the SOURCE variant's visibility.
 *
 * Approach: parse the file's current `hiddenOnVariants` per node. If the
 * source variant is in the hidden set, add the new variant to the hidden
 * set (new variant also hidden). Otherwise the new variant inherits the
 * visible state (don't add). Then re-emit the wrapper via
 * `setVariantVisibilityInCode` with the updated allVariants list.
 *
 * Pre-existing `false && <element/>` ("hidden everywhere") wrappers expand
 * to include the new variant in the hidden set, matching their semantics.
 * Pre-existing `true && <element/>` (visible everywhere) likewise stays
 * visible on the new variant.
 */
function cascadeVisibilityForNewVariant(
  code: string,
  newName: string,
  sourceVariant: string,
  allVariants: string[],
): string {
  let result = code;
  let nodes: ReturnType<typeof parseJSXToNodes>;
  try {
    nodes = parseJSXToNodes(result);
  } catch {
    return result;
  }
  for (const [nodeId, node] of nodes) {
    const hidden = node.hiddenOnVariants;
    if (!hidden || hidden.size === 0) continue;
    // Parser may have included `newName` in `hidden` already — a positive
    // `variant === 'X'` chain hides every OTHER variant, so the just-
    // added new variant looks hidden by default until we decide. Compute
    // the source's effective visibility ignoring `newName`, then add or
    // omit `newName` accordingly.
    const sourceHidden = hidden.has(sourceVariant);
    const newHidden = new Set(hidden);
    if (sourceHidden) {
      newHidden.add(newName);
    } else {
      // Source visible → new variant also visible → ensure not in hidden.
      newHidden.delete(newName);
    }
    try {
      result = setVariantVisibilityInCode(result, nodeId, Array.from(newHidden), allVariants);
    } catch (e) {
      trace.error('variant-ops:cascade-visibility-failed', { nodeId, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return result;
}

/**
 * Delete-path mirror of `cascadeVisibilityForNewVariant`: re-emit every
 * AnimatePresence visibility gate with the removed variant dropped from its
 * hidden set and the remaining variant list as the new universe.
 *
 * Two shapes resolve on their own from that:
 *  · hidden ONLY on the removed variant → the set empties → the generator
 *    unwraps the gate entirely (the element is simply visible again);
 *  · visible ONLY on the removed variant → its hidden set already covers every
 *    survivor, so it re-emits as hidden everywhere. Kept rather than deleted —
 *    a hidden element is recoverable from the Layers panel, a deleted one is
 *    only recoverable by undo.
 *
 * Every gated node is re-emitted, not just the ones naming the removed variant:
 * a positive gate (`variant === 'X'`) records its hidden set as "all the
 * others", so the removed name isn't in it and a narrower filter would leave
 * the dead `=== 'X'` test in the source.
 */
function cascadeVisibilityForRemovedVariant(code: string, remainingVariants: string[]): string {
  let result = code;
  let nodes: ReturnType<typeof parseJSXToNodes>;
  try {
    nodes = parseJSXToNodes(result);
  } catch {
    return result;
  }
  for (const [nodeId, node] of nodes) {
    const hidden = node.hiddenOnVariants;
    if (!hidden || hidden.size === 0) continue;
    const next = [...hidden].filter(v => remainingVariants.includes(v));
    try {
      result = setVariantVisibilityInCode(result, nodeId, next, remainingVariants);
    } catch (e) {
      trace.error('variant-ops:cascade-visibility-remove-failed', { nodeId, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return result;
}

/**
 * For every JSX inline style ternary of shape
 *   `propName: variant === 'X' ? V1 : variant === 'Y' ? V2 : <fallback>`
 * extend the chain so the new variant maps to the SAME resolved value as
 * the source variant. Without this, `order: variant === 'variant-1' ? 1
 * : 0` on a new variant created from variant-1 would default to `0` (the
 * fallback) instead of `1`.
 *
 * The original chain is preserved verbatim; we just prepend a new
 * `variant === 'newName' ? <sourceValue>` branch at the front. The
 * resolved value is computed by walking the chain against `sourceVariant`.
 */
/**
 * Is this ternary a connection HANDLER's state transition rather than a
 * per-variant style/content binding?
 *
 * Both ternary walkers below rewrite `X === 'name' ? value : …` chains, and a
 * handler's `setVariant` decision has the SAME SHAPE as a style binding — so
 * the walkers have to tell them apart or they rewrite the component's state
 * machine. They used to test one signature: a bare `variant` fallback, from the
 * legacy `setVariant(variant === 'a' ? 'b' : variant)` form. The generator has
 * since moved to
 *
 *     const _n = variant === 'default' ? 'default-hover' : null;
 *     if (_n) setVariant(_n);
 *
 * whose fallback is `null` — so handlers stopped being recognised, and Add
 * Variant cascaded a branch INTO the hover handler: adding a `mobile` variant
 * wrote `variant === 'variant-3' ? 'default-hover'`, giving mobile a hover
 * transition that appears nowhere in `connections` and that the Interactions
 * panel therefore can't show or remove (user report 2026-08-08 — hovering the
 * mobile Services link ran the desktop hover state).
 *
 * Tested by DIALECT, not by position, so all three forms are covered and a
 * future one degrades to "don't cascade" rather than "corrupt the machine".
 */
function isVariantTransitionChain(code: string, start: number, fallback: string): boolean {
  if (fallback === 'null') return true;                                  // current `const _n = … : null`
  if (fallback === 'variant' || fallback === 'initialVariant') return true; // legacy `setVariant(… : variant)`
  // Belt and braces: whatever the chain resolves to, is it being handed to the
  // variant setter?
  const before = code.slice(Math.max(0, start - 48), start).replace(/\s+$/, '');
  return /(?:const\s+_n\s*=|\bsetVariant\s*\()$/.test(before);
}

function cascadeConditionalTernariesForNewVariant(
  code: string,
  newName: string,
  sourceVariant: string,
): string {
  // Match `propName: variant === '<X>' ? <val> : <rest until , or })`
  // Whole-style scope is unrealistic; instead we scan for any
  // `variant === '...'` occurrence and walk forward to consume the full
  // ternary chain. Conservative: only modify chains that start cleanly
  // with `variant === '...' ?`.
  // Accept BOTH condition forms AND both quote styles:
  //  • `variant === '…'`  (after a connection) and `initialVariant === '…'` (the
  //    make-time convention — e.g. the per-variant ORDER ternary the Styles tool /
  //    Layers reorder writes). A `variant`-only pattern skipped every `initialVariant`
  //    chain, so a new variant created from a source with a custom ORDER inherited
  //    nothing (the reported bug — order stayed the default fallback).
  //  • single-quoted (STYLE ternaries `'390px'`) and double-quoted (CONTENT/text
  //    ternaries `"Blog"`).
  // The setVariant toggle is still rejected below because its fallback is the
  // `variant` identifier, not a literal.
  const startRegex = /\b(?:variant|initialVariant)\s*===\s*['"][^'"]+['"]\s*\?/g;
  // We do replacement RIGHT-to-LEFT so earlier indices stay valid.
  const matches: { start: number; end: number; replacement: string }[] = [];
  // A multi-branch chain (`variant === 'a' ? va : variant === 'b' ? vb : fb`) contains MULTIPLE
  // `variant === '...' ?` starts. We must walk only the OUTERMOST start (the whole chain); the inner
  // starts are sub-chains whose ranges OVERLAP the outer one — emitting matches for them would corrupt
  // the right-to-left splice. So skip any start that falls inside the last chain we already walked.
  let lastProcessedEnd = -1;
  let m: RegExpExecArray | null;
  while ((m = startRegex.exec(code)) !== null) {
    const start = m.index;
    if (start < lastProcessedEnd) continue;
    // Walk the cascading ternary: variant === 'A' ? va : variant === 'B' ? vb : ... : fallback
    let pos = start;
    const branches: Array<{ prefix: string; quote: string; name: string; value: string }> = [];
    let fallback: string | null = null;
    let ok = true;
    while (pos < code.length) {
      const tail = code.slice(pos);
      const branchMatch = tail.match(/^(variant|initialVariant)\s*===\s*(['"])([^'"]+)\2\s*\?\s*/);
      if (!branchMatch) { ok = false; break; }
      pos += branchMatch[0].length;
      // Read value — a NUMBER, a quoted string, OR a bare IDENTIFIER. The
      // identifier form is a per-variant VARIABLE binding, e.g. a text node's
      // `{variant === 'variant-1' ? content : "Description"}` (the `content`
      // prop) or a style var `color: variant === 'x' ? colorVar : '#000'`.
      // Without it the whole chain was skipped, so a new variant created from a
      // replica that carried a STANDALONE per-variant variable lost that
      // binding (fell back to the literal default). `variant`/`initialVariant`
      // as a "value" is the setVariant TOGGLE (`… ? 'v1' : variant`), NOT a
      // binding — reject it so the toggle stays out of the cascade.
      const valMatch = code.slice(pos).match(/^(-?\d+(?:\.\d+)?|'[^']*'|"[^"]*"|[A-Za-z_$][\w$]*)\s*/);
      if (!valMatch || valMatch[1] === 'variant' || valMatch[1] === 'initialVariant') { ok = false; break; }
      branches.push({ prefix: branchMatch[1], quote: branchMatch[2], name: branchMatch[3], value: valMatch[1] });
      pos += valMatch[0].length;
      if (code[pos] !== ':') { ok = false; break; }
      pos++;
      // Skip whitespace
      while (pos < code.length && /\s/.test(code[pos])) pos++;
      // Either another `variant === ...` (continuation) or a fallback literal. The window MUST be wide
      // enough to contain `variant === ` (11 chars with one space) — a 10-char slice cut the third `=`,
      // so the regex missed the continuation and every MULTI-branch ternary (e.g. a per-variant width
      // chain) broke after its first branch → the new variant never inherited the source's size.
      if (code.slice(pos, pos + 24).match(/^(?:variant|initialVariant)\s*===/)) {
        continue;
      }
      // Fallback: same value forms. A bare `variant`/`initialVariant` fallback
      // means this is the setVariant toggle (`… ? 'v1' : variant`) — reject the
      // whole chain (it's a connection handler, not a per-variant binding).
      const fbMatch = code.slice(pos).match(/^(-?\d+(?:\.\d+)?|'[^']*'|"[^"]*"|[A-Za-z_$][\w$]*)\s*/);
      if (!fbMatch || fbMatch[1] === 'variant' || fbMatch[1] === 'initialVariant') { ok = false; break; }
      fallback = fbMatch[1];
      pos += fbMatch[0].length;
      break;
    }
    if (!ok || fallback === null) continue;
    // Claim this chain's whole extent so the inner `variant === '...'` starts are skipped (above) —
    // even when no branch is added below, the sub-chains belong to THIS chain and must not be re-walked.
    lastProcessedEnd = pos;
    // A connection handler's transition — the state machine belongs to
    // `connections`, never to this cascade.
    if (isVariantTransitionChain(code, start, fallback)) continue;
    // Resolve the source variant's value
    const sourceBranch = branches.find(b => b.name === sourceVariant);
    const sourceValue = sourceBranch ? sourceBranch.value : fallback;
    // If the new variant already exists in the chain, skip (idempotent)
    if (branches.some(b => b.name === newName)) continue;
    // If sourceValue equals the fallback AND the new variant isn't going
    // to differ from the fallback, no need to add a redundant branch.
    if (sourceValue === fallback) continue;
    // Build the new chain: `<prefix> === <q>newName<q> ? sourceValue : <original>`,
    // PRESERVING the chain's condition form (variant vs initialVariant) + quote so
    // an `initialVariant`-keyed ORDER ternary stays consistent (not mixed).
    const cp = branches[0].prefix, cq = branches[0].quote;
    const original = code.slice(start, pos);
    const replacement = `${cp} === ${cq}${newName}${cq} ? ${sourceValue} : ${original}`;
    matches.push({ start, end: pos, replacement });
  }
  // Apply replacements right-to-left
  let result = code;
  for (let i = matches.length - 1; i >= 0; i--) {
    const { start, end, replacement } = matches[i];
    result = result.slice(0, start) + replacement + result.slice(end);
  }
  return result;
}

/**
 * Drop a deleted variant's branch from every inline conditional ternary in the
 * file — the INVERSE of `cascadeConditionalTernariesForNewVariant`. Handles both
 * the make-time `initialVariant === 'X'` form and the post-connection `variant ===
 * 'X'` form, single OR double quoted (style ternaries are single-quoted, content/
 * text ternaries double-quoted). Walks each chain into branches + fallback (same
 * walker shape as the cascade), removes the branch whose name === `variantName`,
 * and rebuilds:
 *   `prop: COND==='X' ? a : b`                       → `prop: b`            (collapse)
 *   `prop: COND==='A' ? a : COND==='X' ? x : b`      → `prop: COND==='A' ? a : b`
 * The setVariant toggle (`setVariant(variant === 'X' ? 'y' : variant)`) is left
 * untouched because its fallback is the `variant` IDENTIFIER, not a literal — the
 * walker requires a literal fallback, so it's skipped (the connection teardown owns
 * those). Right-to-left splice + a `lastProcessedEnd` guard so a multi-branch
 * chain's inner `=== ` starts (which overlap the outer one) aren't re-walked.
 */
function removeVariantBranchFromConditionalTernaries(code: string, variantName: string): string {
  const startRegex = /\b(?:variant|initialVariant)\s*===\s*['"][^'"]+['"]\s*\?/g;
  const matches: { start: number; end: number; replacement: string }[] = [];
  let lastProcessedEnd = -1;
  let m: RegExpExecArray | null;
  while ((m = startRegex.exec(code)) !== null) {
    const start = m.index;
    if (start < lastProcessedEnd) continue;
    let pos = start;
    const branches: Array<{ prefix: string; quote: string; name: string; value: string }> = [];
    let fallback: string | null = null;
    let ok = true;
    while (pos < code.length) {
      const branchMatch = code.slice(pos).match(/^(variant|initialVariant)\s*===\s*(['"])([^'"]+)\2\s*\?\s*/);
      if (!branchMatch) { ok = false; break; }
      pos += branchMatch[0].length;
      // Same value forms as the add-variant cascade — a NUMBER, quoted string,
      // OR a bare IDENTIFIER (per-variant variable binding, e.g. text `content`)
      // so removing a variant that carried a standalone variable binding drops
      // its branch cleanly instead of leaving a dangling reference. Reject the
      // setVariant toggle's `variant`/`initialVariant` "value".
      const valMatch = code.slice(pos).match(/^(-?\d+(?:\.\d+)?|'[^']*'|"[^"]*"|[A-Za-z_$][\w$]*)\s*/);
      if (!valMatch || valMatch[1] === 'variant' || valMatch[1] === 'initialVariant') { ok = false; break; }
      branches.push({ prefix: branchMatch[1], quote: branchMatch[2], name: branchMatch[3], value: valMatch[1] });
      pos += valMatch[0].length;
      if (code[pos] !== ':') { ok = false; break; }
      pos++;
      while (pos < code.length && /\s/.test(code[pos])) pos++;
      // Continuation (another branch) vs the fallback literal. Window must fit
      // `initialVariant ===` (~17 chars) — too small a slice would miss it.
      if (code.slice(pos, pos + 24).match(/^(?:variant|initialVariant)\s*===/)) continue;
      const fbMatch = code.slice(pos).match(/^(-?\d+(?:\.\d+)?|'[^']*'|"[^"]*"|[A-Za-z_$][\w$]*)\s*/);
      if (!fbMatch || fbMatch[1] === 'variant' || fbMatch[1] === 'initialVariant') { ok = false; break; }
      fallback = fbMatch[1];
      pos += fbMatch[0].length;
      break;
    }
    if (!ok || fallback === null) continue;
    lastProcessedEnd = pos;
    // Handlers are the connection teardown's to rebuild (it strips and
    // regenerates the whole set from `connections`) — same guard as the add
    // cascade, so the two paths can't disagree about what a handler is.
    if (isVariantTransitionChain(code, start, fallback)) continue;
    if (!branches.some(b => b.name === variantName)) continue; // chain doesn't mention X
    const kept = branches.filter(b => b.name !== variantName);
    const rebuilt = kept.length === 0
      ? fallback
      : kept.map(b => `${b.prefix} === ${b.quote}${b.name}${b.quote} ? ${b.value}`).join(' : ') + ` : ${fallback}`;
    matches.push({ start, end: pos, replacement: rebuilt });
  }
  let result = code;
  for (let i = matches.length - 1; i >= 0; i--) {
    const { start, end, replacement } = matches[i];
    result = result.slice(0, start) + replacement + result.slice(end);
  }
  if (matches.length > 0) trace.fn('variant-ops.removeVariantBranchFromConditionalTernaries', { variantName, count: matches.length });
  return result;
}

/**
 * Remove a variant key from all variant objects in the code.
 */
function removeVariantKeyFromAllObjects(code: string, variantName: string): string {
  // Remove entries like:  variantName: { ... },   OR   'variantName': { ... }
  // from every `const xxxVariants = { ... }` object.
  //
  // Quoted keys, the entry delimiter, and NESTED brace values are all handled
  // by the shared balanced remover. The third of those is what a `\{[^}]*\}`
  // regex could never do: a per-variant transition —
  //
  //     'variant-1': { transition: { duration: 0.5 } }
  //
  // — ends at the SECOND `}`, so the regex consumed the inner object and left
  // the entry's own closing brace stranded in the variants object. The file
  // stopped parsing and the canvas rendered nothing, which read as "deleting
  // a variant deleted my whole component" (user report 2026-08-08).
  return removeObjectEntryBalanced(code, variantName);
}
