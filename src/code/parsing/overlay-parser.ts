// overlay-parser.ts — Parse overlay and overlay-trigger attributes from JSX code.
// Returns linked pairs of trigger→overlay for the OverlayTool.

import type { OverlayConfig, OverlayTriggerConfig } from '@/shared/types';
import { trace } from '@/shared/debug-trace';

/** True if a parsed node is a relative/fixed overlay (carries `data-overlay`).
 *  Used to EXCLUDE overlays from snap targets — a node being dragged must never
 *  snap to an overlay (the overlay is portal-rendered and follows its own
 *  trigger, so snapping to it glitches). */
export function isOverlayNode(node: { attrs?: Record<string, string> } | undefined | null): boolean {
  return !!node?.attrs?.['data-overlay'];
}

/**
 * Resolve an overlay's EFFECTIVE config for a given viewport/variant.
 *
 * Unified entry point: a design-component VARIANT override (`responsiveVariant`,
 * keyed by variant id/name) takes precedence; otherwise fall to the width-keyed
 * page-replica resolution. The default variant (`vpId === 'desktop'`) and pages
 * with no variant overrides flow straight to the width path. Used by the
 * Renderer/follow/drag so a component variant card shows its OWN override.
 */
export function resolveOverlayConfig(config: OverlayConfig, vpId: string, vpWidth: number): OverlayConfig {
  const rv = config.responsiveVariant;
  if (rv && rv[vpId]) return { ...config, ...rv[vpId] };
  return resolveOverlayConfigForWidth(config, vpWidth);
}

/**
 * Resolve an overlay's EFFECTIVE config for a given viewport width.
 *
 * The base fields are the primary (desktop) config; `config.responsive` holds
 * per-breakpoint overrides keyed by viewport width. Replicas are INDEPENDENT —
 * there is NO cascade between them. We resolve the OWNING viewport for `width`
 * (the smallest viewport breakpoint `>= width`, from `config.responsiveBp`) and
 * use ONLY that viewport's override — or BASE if it has none. So a mobile (375)
 * tile with no 375 override stays on the desktop base even when the tablet
 * (768) has one; editing the tablet never leaks into mobile.
 *
 * When `responsiveBp` is absent (e.g. the canvas passing an exact tile width),
 * we exact-match `responsive[width]` — the tile IS its own viewport, so exact
 * and owning resolution coincide.
 *
 * Pure — used by the canvas Renderer (per viewport tile) and the tests; the
 * generated runtime re-implements the same owning-viewport pick inline.
 */
export function resolveOverlayConfigForWidth(config: OverlayConfig, width: number): OverlayConfig {
  const ov = config.responsive;
  if (!ov) return config;
  const bps = config.responsiveBp;
  // Owning viewport = smallest breakpoint that still covers `width`. With a
  // known breakpoint list this correctly returns BASE for a viewport that has
  // no override (its own key is absent), instead of borrowing a larger one.
  const owning = (bps && bps.length)
    ? bps.filter(b => Number.isFinite(b) && width <= b).sort((a, b) => a - b)[0]
    : width; // no list → exact (canvas passes the tile's own width)
  if (owning === undefined) return config; // width above all breakpoints → base
  const o = ov[String(owning)];
  return o ? { ...config, ...o } : config;
}

export interface OverlayCall {
  overlayId: string;
  config: OverlayConfig;
  codeStart: number;
  codeEnd: number;
}

export interface OverlayTriggerCall {
  triggerId: string;
  config: OverlayTriggerConfig;
}

export interface OverlayPair {
  trigger: OverlayTriggerCall;
  overlay: OverlayCall;
}

// Last-code memo. These parsers full-scan the source (regex over ~470KB on a
// big page) and get called from SEVERAL places per commit — the derived atoms
// AND direct component-render calls (OverlayTool, Canvas, PropertiesPanel).
// Same code string ⇒ same result, so a 1-entry memo collapses the 6-scans-per-
// commit pattern to one. Keyed on string identity (fast — same reference for
// every caller within a commit).
let _ovCallsCode: string | null = null;
let _ovCallsResult: OverlayCall[] = [];
let _ovTrigCode: string | null = null;
let _ovTrigResult: OverlayTriggerCall[] = [];

/**
 * Parse all overlay declarations from code.
 * Scans for data-overlay='...' attributes.
 */
export function parseOverlayCalls(code: string): OverlayCall[] {
  if (code === _ovCallsCode) return _ovCallsResult;
  const results: OverlayCall[] = [];
  const regex = /data-overlay='([^']+)'/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(code)) !== null) {
    const jsonStr = match[1];
    let config: OverlayConfig | null = null;
    try { config = JSON.parse(jsonStr); } catch (err) {
      trace.error('overlay-parser:invalid-json', { content: jsonStr, error: String(err) });
      continue;
    }

    // Find the data-id on this element — search backwards from the attribute
    const searchStart = Math.max(0, match.index - 1000);
    const beforeAttr = code.slice(searchStart, match.index);
    const idMatch = beforeAttr.match(/data-id="([^"]+)"/g);
    if (!idMatch || idMatch.length === 0) continue;
    // Take the LAST data-id found (closest to the data-overlay attr)
    const lastId = idMatch[idMatch.length - 1].match(/data-id="([^"]+)"/);
    if (!lastId) continue;

    const overlayId = lastId[1];

    // Find the element's extent (approximate — from tag start to closing tag)
    const tagStart = code.lastIndexOf('<', match.index);
    // Find the closing tag for this overlay div
    const tagNameMatch = code.slice(tagStart).match(/^<(\w+)/);
    const tagName = tagNameMatch ? tagNameMatch[1] : 'div';
    const closingTag = `</${tagName}>`;
    // Search for closing tag after the attribute
    const closeIdx = code.indexOf(closingTag, match.index);
    const codeEnd = closeIdx >= 0 ? closeIdx + closingTag.length : match.index + match[0].length;

    if (config) results.push({ overlayId, config, codeStart: tagStart, codeEnd });
  }

  trace.fn('overlay-parser:parseOverlays', { count: results.length });
  _ovCallsCode = code;
  _ovCallsResult = results;
  return results;
}

/**
 * Parse all overlay trigger declarations from code.
 * Scans for data-overlay-trigger='...' attributes.
 */
export function parseOverlayTriggerCalls(code: string): OverlayTriggerCall[] {
  if (code === _ovTrigCode) return _ovTrigResult;
  const results: OverlayTriggerCall[] = [];
  const regex = /data-overlay-trigger='([^']+)'/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(code)) !== null) {
    const jsonStr = match[1];
    let config: OverlayTriggerConfig | null = null;
    try { config = JSON.parse(jsonStr); } catch (err) {
      trace.error('overlay-parser:trigger-invalid-json', { content: jsonStr, error: String(err) });
      continue;
    }

    // Find the data-id on this element — search backwards
    const tSearchStart = Math.max(0, match.index - 1000);
    const tBeforeAttr = code.slice(tSearchStart, match.index);
    const tIdMatches = tBeforeAttr.match(/data-id="([^"]+)"/g);
    if (!tIdMatches || tIdMatches.length === 0) continue;
    const tLastId = tIdMatches[tIdMatches.length - 1].match(/data-id="([^"]+)"/);
    if (!tLastId) continue;

    if (config) results.push({ triggerId: tLastId[1], config });
  }

  trace.fn('overlay-parser:parseTriggers', { count: results.length });
  _ovTrigCode = code;
  _ovTrigResult = results;
  return results;
}

/**
 * Link triggers to their overlays, return pairs.
 */
export function getOverlayPairs(code: string): OverlayPair[] {
  const overlays = parseOverlayCalls(code);
  const triggers = parseOverlayTriggerCalls(code);
  const pairs: OverlayPair[] = [];

  for (const trigger of triggers) {
    const overlay = overlays.find(o => o.overlayId === trigger.config.targetId);
    if (overlay) pairs.push({ trigger, overlay });
  }

  trace.fn('overlay-parser:getPairs', { pairCount: pairs.length });
  return pairs;
}

/** Get the overlay config for a specific node (if it's an overlay) */
export function getOverlayForNode(overlays: OverlayCall[], nodeId: string): OverlayCall | null {
  return overlays.find(o => o.overlayId === nodeId) ?? null;
}

/** Get the trigger config for a specific node (if it's a trigger) */
export function getTriggerForNode(triggers: OverlayTriggerCall[], nodeId: string): OverlayTriggerCall | null {
  return triggers.find(t => t.triggerId === nodeId) ?? null;
}
