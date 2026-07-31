// types.ts — Unified control system types.

import type { CanvasNode } from '@/code/parsing/parser';
import type { ReactNode } from 'react';

/** Control modes determine value routing */
export type ControlMode =
  | 'direct'           // inline style on selected node
  | 'htmlAttr'         // HTML attribute on selected node (src, controls, poster, etc.)
  | 'scrollStop'       // scroll animation From/To stop
  | 'motionVariant'    // Motion animate/whileHover/initial
  | 'cssKeyframe'      // CSS @keyframes stop
  | 'variableDefault'  // component prop default value
  | 'preset'           // preset value editor
  | 'override'         // container query responsive override
  | 'locale'           // locale-conditional value
  | 'fetch'            // external API binding
  | 'motionPathWaypoint'; // motion path waypoint properties

/** Binding info — is this property controlled by something else? */
export interface ControlBinding {
  bound: boolean;
  boundBy: string | null;         // 'Scroll Transform' | 'Keyframe: glow' | etc.
  onNavigate: (() => void) | null;
  /** When value is var(--name), this holds the token name. Controls show a preset pill. */
  presetRef?: string;
}

/** Context value exposed to ToolAtoms via useControlContext() */
export interface UnifiedControlContextValue {
  // Core value flow
  value: string;
  onChange: (value: string) => void;
  /** Update multiple properties at once (for shorthand like border, padding) */
  onChangeMultiple: (styles: Record<string, string>) => void;
  /** Live preview only — DOM patch via bridge, no code write. Use during
   *  continuous input (slider drag, color picker swatch); follow with
   *  `onChange` to commit the final value. Only meaningful in `direct`
   *  mode; other modes (animation/scroll/htmlAttr) fall back to onChange. */
  onChangeLive: (value: string) => void;
  /** Live preview for MULTIPLE properties at once (e.g. shadow = boxShadow +
   *  filter). DOM-only patch per key via the same routing as `onChangeLive`;
   *  follow with `onChangeMultiple` to commit. Falls back to a commit in
   *  non-direct modes. */
  onChangeMultipleLive: (styles: Record<string, string>) => void;

  // Identity
  property: string;
  mode: ControlMode;

  /** When true, atoms must NOT render their own ControlLabel. Used by the Variable modal's Default
   *  row, where the surrounding FieldRow already labels it "Default" — the atom's internal
   *  "Background"/"Border" label would be redundant. ControlLabel short-circuits to null. */
  hideLabel?: boolean;

  // Binding detection (computed in 'direct' mode)
  binding: ControlBinding;

  // Node context (available in 'direct' mode)
  nodeId: string | null;
  node: CanvasNode | null;

  /** All properties for the current context (node.styles in direct, stopProps in scrollStop) */
  allProps: Record<string, string>;

  // Responsive overrides
  hasOverride: boolean;
  getOverrides: () => { maxWidth: number; value: string }[];

  // Variable operations (stubs until variable system is built)
  hasVariable: boolean;
  variableRef: string | null;
  createVariable: (propName: string) => void;
  removeVariable: (propName: string, defaultValue: string) => void;
}

/** Props accepted by every ToolAtom's exported component */
export interface AtomProps {
  mode?: ControlMode;
  // For scrollStop / motionVariant / cssKeyframe modes:
  stopProps?: Record<string, string>;
  onStopChange?: (props: Record<string, string>) => void;
  // For variableDefault / preset / locale / fetch modes:
  externalValue?: string;
  externalOnChange?: (value: string) => void;
  /** Continuous live-drag callback for non-direct modes (e.g. a component-tool variable: route to
   *  `previewProp` so the canvas updates per frame). When absent, `onChangeLive` falls back to
   *  `onChange` (commit). Direct mode ignores this — it uses the outer `updateStyleLive`. */
  externalOnChangeLive?: (value: string) => void;
  /** Suppress the atom's own ControlLabel (see UnifiedControlContextValue.hideLabel). */
  hideLabel?: boolean;
}

/** Props for the UnifiedControlProvider wrapper */
export interface UnifiedControlProviderProps extends AtomProps {
  property: string;
  defaultValue?: string;
  children: ReactNode;
}
