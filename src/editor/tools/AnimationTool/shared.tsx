// shared.tsx — Shared UI components for the AnimationTool system.

import React from 'react';
import { ToolInput, ToolSlider, ControlLabel, ControlActionRow } from '../../controls';
import {
  HoverIcon, TapIcon, AppearIcon, AnimationIcon, ScrollIcon, TransitionIcon,
  TextDecorationIcon, LoopIcon,
} from '@/design-system/PropertyIcons';

/** Slider row: label + slider + input.
 *  `onChange` fires per drag tick (live); optional `onCommit` fires once on
 *  release. Pass `onCommit` when `onChange` should only update local UI state
 *  and the expensive write (code edit / backend PUT) must run once on release —
 *  otherwise a slider drag writes code 60×/sec and tanks FPS. The stepper input
 *  commits directly (a typed/chevron change is already discrete). */
export function SliderRow({ label, value, min, max, step, onChange, onCommit, suffix }: {
  label: string; value: number; min: number; max: number; step: number;
  onChange: (v: number) => void; onCommit?: (v: number) => void; suffix?: string;
}) {
  return (
    <div className="flex items-center justify-between w-full">
      <ControlLabel label={label} property="" plain />
      <div className="flex items-center gap-2 w-full">
        <ToolSlider value={value} min={min} max={max} step={step} onChange={onChange} onCommit={onCommit} />
        {/* Unit goes through chevronLabel (NOT baked into the value) — a value like
            "0.5s" reads as non-numeric, which makes ToolInput hide the stepper
            chevrons entirely. Clean number + chevronLabel = chevrons + "s" suffix,
            matching the Delay row and the Width field. */}
        <ToolInput value={String(value)}
          onChange={(v) => (onCommit ?? onChange)(parseFloat(v) || 0)} step={step} chevronLabel={suffix} />
      </div>
    </div>
  );
}

/** Section divider with centered label */
export function SectionLabel({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 mt-1">
      <div className="h-px flex-1 bg-[var(--border-light)]" />
      <span className="text-[10px] font-semibold text-[var(--text-disabled)] shrink-0">{label}</span>
      <div className="h-px flex-1 bg-[var(--border-light)]" />
    </div>
  );
}

/** Small pill badge for "Open Editor" actions */
export function OpenEditorBadge() {
  return (
    <span className="text-[10px] font-medium text-[var(--text-secondary)] bg-white/10 px-1.5 py-0.5 rounded">
      Open Editor
    </span>
  );
}

/** Button-style row that opens a sliding panel */
export function PanelRow({ label, summary, onClick }: { label: string; summary: string; onClick: () => void }) {
  return (
    <div className="flex items-center justify-between w-full">
      <ControlLabel label={label} property="" plain />
      <ControlActionRow onClick={onClick}>
        <span className="truncate flex-1">{summary}</span>
      </ControlActionRow>
    </div>
  );
}


/** Animation entry type */
export type AnimEntryType = 'hover' | 'tap' | 'appear' | 'glide' | 'loop' | 'scrollTransform' | 'scrollSpeed' | 'scrollVariant' | 'textEffect' | 'transition' | 'keyframe' | 'cssHover' | 'sketchDraw';

/** Entry metadata */
export const ENTRY_META: Record<AnimEntryType, { label: string; Icon: React.FC<React.SVGProps<SVGSVGElement>> }> = {
  hover: { label: 'Hover', Icon: HoverIcon },
  tap: { label: 'Tap', Icon: TapIcon },
  appear: { label: 'Appear', Icon: AppearIcon },
  glide: { label: 'Glide', Icon: AnimationIcon },
  loop: { label: 'Loop', Icon: LoopIcon },
  scrollTransform: { label: 'Scroll Transform', Icon: ScrollIcon },
  scrollSpeed: { label: 'Scroll Speed', Icon: ScrollIcon },
  scrollVariant: { label: 'Scroll Variant', Icon: ScrollIcon },
  textEffect: { label: 'Text', Icon: TextDecorationIcon },
  transition: { label: 'Transition', Icon: TransitionIcon },
  keyframe: { label: 'Keyframe', Icon: AnimationIcon },
  cssHover: { label: 'CSS Hover', Icon: HoverIcon },
  sketchDraw: { label: 'Draw', Icon: AnimationIcon },
};

/** Detected animation entry */
export interface DetectedEntry {
  type: AnimEntryType;
  summary: string;
  key: string;
  data?: any;
}
