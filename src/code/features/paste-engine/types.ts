// types.ts — shared types for the paste engine
//
// This is a port of the builder's paste system, adapted for Revyme:
// - Single source JSX (no per-viewport syncId / replica node IDs)
// - Mutation-queue based creation (no direct DOM)
// - No cross-website hydration

import type { CanvasNode } from '@/code/parsing/parser';
import type { Transform } from '@/shared/types';

// ─── Clipboard data ───────────────────────────────────────────────────────────

/** A node in the clipboard. Mirrors the relevant parts of CanvasNode. */
export interface ClipboardNode {
  id: string;
  type: string;
  parentId: string | null;
  children: string[];
  order: number;
  styles: Record<string, string>;
  attrs?: Record<string, string>;
  name?: string;
  textContent?: string;
  hasMixedContent?: boolean;
  isCanvasNode?: boolean;
  componentFile?: string | null;
  componentInstanceId?: string | null;

  /**
   * Captured at copy-time for ROOT nodes when w/h is auto/%/fill or inset-sized.
   * Used by canvas paste to materialise concrete px so the node doesn't
   * collapse / unwrap when its parent context disappears.
   */
  computedDimensions?: { width?: string; height?: string };

  /**
   * Parsed from attrs.data-overlay-trigger — the targetId here points at
   * another clipboard node. Paste remaps it after creation.
   */
  overlayTriggerTargetId?: string;

  /**
   * motion tag props (initial/whileInView/viewport/transition/
   * whileHover/whileTap/animate/exit) parsed off the copied element.
   * The AddNodeDef the executor emits carries only styles/attrs, so
   * without this capture every pasted node loses its Appear/Hover/Tap/
   * declarative-Loop animation. Paste re-injects the transferable BASE
   * values via `updateMotionProp` (see paste/motion-reinject.ts).
   */
  motionProps?: CanvasNode['motionProps'];

  /**
   * `::after` border-overlay rule BODY captured from the source page's
   * `<style>` block (`[data-id="<id>"]::after { <body> }`). The border
   * tool's overlay mode lives entirely in that per-id CSS rule, not in
   * the node's inline styles, so without this capture every pasted copy
   * lost its border. Paste re-injects it under the NEW id via the
   * `updateBorderOverlay` mutation (see paste/border-reinject.ts).
   */
  borderAfterCSS?: string;

  /**
   * `::placeholder` rule styles (the Input tool's Placeholder Color) —
   * same style-block-keyed-by-data-id failure mode as the border overlay.
   * Paste re-injects under the NEW id via `updatePseudoStyle`.
   */
  placeholderStyles?: Record<string, string>;
}

/**
 * A component MASTER captured at copy time — the full source of every file
 * the component needs (root + transitive `@/components/*` / `@/icons/*`
 * deps, via the share pipeline's bundle walker). Captured so a paste into
 * ANOTHER project can either share the bundle to the CDN and link the
 * instance (standard, cloud) or materialize the files locally
 * (standalone fallback). Capturing at COPY is what makes share-at-PASTE
 * possible: by paste time the source project's files are no longer in
 * projectFS.
 */
export interface ClipboardComponentMaster {
  /** JSX tag / internal component name the instances use (e.g. `NuSuBi`). */
  tagName: string;
  /** Master file's projectFS path (e.g. `components/NuSuBi.tsx`). */
  masterPath: string;
  kind: 'design' | 'code' | 'vector';
  /** Root file FIRST, then transitive deps — walkBundle order. */
  files: { path: string; content: string }[];
  /** Imports the walker couldn't resolve in the source project (share
   *  would fail server-side; local materialization still writes what we have). */
  missingDeps?: string[];
}

export interface ClipboardData {
  version: 1;
  timestamp: number;
  nodes: ClipboardNode[];

  /**
   * Which project the copy happened in (`'local'` in standalone). Paste
   * compares against its own project id — a mismatch routes component
   * instances through the cross-project link path instead of emitting
   * bare tags whose masters don't exist in the target.
   */
  sourceProjectId?: string | null;

  /**
   * Masters for every component instance in `nodes` (deduped by path).
   * Absent when the copied subtree contains no component instances.
   */
  components?: ClipboardComponentMaster[];
  /**
   * Function-scope code (refs, useState, useEffect, useScroll /
   * useTransform / useSpring hooks and their consts) attached to ANY node in the copied
   * subtree. Re-injected at the top of the destination file's
   * default-exported function body on paste, with the copied-node IDs
   * remapped to their newly-allocated paste IDs.
   *
   * Cross-references to nodes NOT in the copy set stay verbatim — the
   * effect runs as a no-op on the destination if those targets don't
   * exist there (per user spec: "we don't copy the other nodes").
   *
   * Captured for the FULL subtree (parent → grandchild) and for every
   * root in a multi-select copy, not just the user-clicked roots.
   *
   * `null` when no function-scope code mentions any of the copied
   * nodes (the common case for plain JSX copy).
   */
  effects?: EffectsBundle | null;

  /**
   * Verbatim CMS Collection List snapshots (one per copied `.map()` container).
   * The plain node tree can't express the `.map()` repeater / CMS bindings /
   * pagination, so each list's exact source JSX + pagination hooks + imports are
   * captured here and re-inserted (id-renamed) by a paste post-step
   * (`rebuildPastedCollectionInCode`). Absent for non-collection copies.
   */
  collections?: import('@/code/generation/cms-paste-gen').CollectionPaste[];
}

/**
 * Re-exported from `copy/effects-extractor` so external callers can
 * import the type without reaching across folders.
 */
export interface EffectsBundle {
  sourceSlices: string[];
  ownedNodeIds: string[];
}

// ─── Paste context ────────────────────────────────────────────────────────────

/**
 * Everything the engine needs to decide and execute a paste. Built once per
 * paste call, passed to every condition/rule/executor.
 */
export interface PasteContext {
  selectedIds: string[];
  clipboardNodes: ClipboardNode[];

  // Canvas geometry — used by 'visible-center' and smart positioning.
  transform?: Transform;
  containerWidth?: number;
  containerHeight?: number;

  // Drop overrides — set by template/toolbar drops to bypass position calc.
  forceInsertIndex?: number;
  forcePosition?: { x: number; y: number };
  forceNoLayoutPosition?: { x: number; y: number };

  /**
   * The viewport/variant the user is currently interacting with. When this
   * is a non-primary viewport, the paste cascade emits `display: none` rules
   * for all OTHER viewports (so the pasted node only shows up where the user
   * dropped/pasted it). Mirrors the drag system's `getReplicaContext` flow.
   */
  interactingVpId?: string;

  /** Map of viewport/variant IDs → widths. Required when interactingVpId is set. */
  viewportWidths?: Record<string, number>;

  /**
   * Active file path — needed to decide whether the paste is happening in a
   * component file (replica = variant entry) vs page file (replica = @container).
   */
  activeFilePath?: string;

  // Live nodes map — passed in by the call-site.
  nodes: Map<string, CanvasNode>;
}

// ─── Paste config (target + positioning + style transform) ────────────────────

export type TargetMode =
  | 'canvas'                  // root-level free-floating canvas node
  | 'canvas-frame-children'   // child of a selected canvas frame
  | 'viewport-children'       // inside the viewport root (data-id="root")
  | 'sibling'                 // sibling of selected
  | 'frame-children';         // child of selected frame

export type PositioningMode =
  | 'smart-right'             // canvas: try right→bottom→left→top, collision-checked
  | 'after-selected'          // sibling: insert after selected in parent.children
  | 'last-child'              // append at end of parent.children
  | 'at-origin'               // (0,0) — used for text-into-absolute-frame
  | 'preserve'                // keep clipboard node's original position
  | 'visible-center'          // center of visible canvas area (uses transform)
  | 'at-selected-position'    // copy left/top from selected (abs-in-frame siblings)
  | 'center-in-parent';       // center inside selected canvas frame

export type StyleTransform =
  | 'none'                    // leave styles alone (createNode applies layout-aware fixes)
  | 'strip-absolute'          // → relative, drop left/top/right/bottom/insets
  | 'force-relative'          // → relative UNLESS isAbsoluteInFrame is true
  | 'to-canvas'               // → absolute (for canvas paste)
  | 'preserve'                // do NOT modify position — used for ALL nested children
  | 'to-absolute-in-frame';   // → absolute + isAbsoluteInFrame:true, default 0,0

export interface PasteConfig {
  targetMode: TargetMode;
  positioning: PositioningMode;
  styleTransform: StyleTransform;
  /** Force-insert offset from defaults */
  gap?: number;
  defaultPosition?: { x: number; y: number };
  forcePosition?: { x: number; y: number };
}

export interface PasteRule {
  id: string;
  name: string;
  description?: string;
  /** Lower number = higher priority. */
  priority: number;
  conditions: string[];
  config: PasteConfig;
}

// ─── Targets (output of target-resolver) ──────────────────────────────────────

export interface PasteTarget {
  parentId: string | null;
  insertIndex?: number;
  /** Used by visibility cascade; for Revyme this is informational only. */
  isPrimary: boolean;
}

// ─── Result ───────────────────────────────────────────────────────────────────

export interface PasteResult {
  success: boolean;
  createdIds: string[];
  message?: string;
}

export interface CopyResult {
  success: boolean;
  nodeCount: number;
  message?: string;
}

// ─── Condition checker ────────────────────────────────────────────────────────

export type ConditionChecker = (ctx: PasteContext) => boolean;
export type ConditionCheckers = Record<string, ConditionChecker>;
