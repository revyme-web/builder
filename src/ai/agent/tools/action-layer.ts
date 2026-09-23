// src/ai/agent/tools/action-layer.ts
//
// Layout / size / position / typography primitives (action layer, M12).
// Thin wrappers over the SAME write path the UI panels use: every field maps
// to an `updateStyles` (or `updateHtmlAttrs`) mutation, nothing else.
// Schemas MIRROR the editor's own option sets (css-property-options.ts,
// LayoutTool / SizeTool / PositionTool / TextStyleTool) — the parity test
// (action-layer.test.ts) asserts schema ≡ UI. No imports from src/editor:
// the values are duplicated here on purpose.
//
// Values are the CSS strings the UI writes verbatim (px strings for
// dimensions, flex keywords for alignment). Passing "" for a style REMOVES
// the property (invariant 3).

import { z } from 'zod';
import { queueToolMutation, flushTool } from '@/ai/agent/workspace';
import type { AgentTool, AgentToolResult } from '@/ai/agent';

function ok(data: unknown): AgentToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function fail(message: string): AgentToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

const NODE_ID_DESCRIBE = 'data-id of the target node';

/** Px STRINGS only — the exact dialect the UI panels write and the pin/size
 *  detectors read ('0px', '24.5px'). Anything else (%, em, bare numbers) is
 *  rejected at schema level. */
export const PX_VALUE_RE = /^-?\d+(\.\d+)?px$/;
const pxField = (label: string) =>
  z.string().regex(PX_VALUE_RE, `${label} must be a px string like '24px' or '0px' — no %, em, vw or bare numbers`);

/** Hex color as the color controls write it: #rrggbb. */
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

// ─── Enum mirrors of the editor's option sets ─────────────────────────────
// Parity sources (src/editor/controls/css-property-options.ts):
//   getAlignOptions()   → ['flex-start', 'center', 'flex-end']
//   getJustifyOptions() → ['flex-start', 'center', 'flex-end', 'space-between', 'space-around', 'space-evenly']
// `stretch` / `baseline` are NOT in the Align control (they read as unset in
// the panel) — excluded here too (anti-permissivity).

export const LAYOUT_DISPLAY_VALUES = ['flex', 'block', 'grid', 'none'] as const;
export const LAYOUT_DIRECTION_VALUES = ['row', 'row-reverse', 'column', 'column-reverse'] as const;
export const LAYOUT_ALIGN_VALUES = ['flex-start', 'center', 'flex-end'] as const;
export const LAYOUT_JUSTIFY_VALUES = [
  'flex-start',
  'center',
  'flex-end',
  'space-between',
  'space-around',
  'space-evenly',
] as const;
export const LAYOUT_WRAP_VALUES = ['nowrap', 'wrap'] as const;

export const POSITION_MODE_VALUES = ['relative', 'absolute', 'fixed', 'sticky'] as const;

export const TEXT_ALIGN_VALUES = ['left', 'center', 'right', 'justify'] as const;

export const TYPOGRAPHY_WEIGHT_VALUES = ['normal', 'bold'] as const;

// ─── set_layout ───────────────────────────────────────────────────────────

export const setLayoutTool: AgentTool = {
  name: 'set_layout',
  description:
    "Set layout properties (display, flexDirection, alignItems, justifyContent, flexWrap, gap) on a node. Only the fields you pass are written; alignment values are exactly the editor's Align/Justify options. gap must be a px string ('24px'); pass '' to REMOVE a property.",
  inputSchema: {
    node_id: z.string().describe(NODE_ID_DESCRIBE),
    display: z.enum(LAYOUT_DISPLAY_VALUES).optional().describe("display: 'flex' | 'block' | 'grid' | 'none'"),
    flexDirection: z
      .enum(LAYOUT_DIRECTION_VALUES)
      .optional()
      .describe("flex direction: 'row' | 'row-reverse' | 'column' | 'column-reverse'"),
    alignItems: z
      .enum(LAYOUT_ALIGN_VALUES)
      .optional()
      .describe("cross-axis alignment (editor Align options): 'flex-start' | 'center' | 'flex-end'"),
    justifyContent: z
      .enum(LAYOUT_JUSTIFY_VALUES)
      .optional()
      .describe("main-axis distribution (editor Justify options): 'flex-start' | 'center' | 'flex-end' | 'space-between' | 'space-around' | 'space-evenly'"),
    flexWrap: z.enum(LAYOUT_WRAP_VALUES).optional().describe("flex wrap: 'nowrap' | 'wrap'"),
    gap: pxField('gap').optional().describe("gap as a px string, e.g. '24px'; '' removes it"),
  },
  category: 'semantic',
  async execute(args, ctx) {
    const nodeId = args.node_id as string;
    const fields = [
      ['display', args.display],
      ['flexDirection', args.flexDirection],
      ['alignItems', args.alignItems],
      ['justifyContent', args.justifyContent],
      ['flexWrap', args.flexWrap],
      ['gap', args.gap],
    ] as const;
    const provided = fields.filter(([, v]) => v !== undefined);
    if (provided.length === 0) return fail('set_layout needs at least one field (display, flexDirection, alignItems, justifyContent, flexWrap or gap).');
    ctx.ensureCheckpoint();
    // One updateStyles mutation per provided field (M12 contract) — each
    // field is an independent CSS property write.
    for (const [key, value] of provided) {
      queueToolMutation(ctx, { type: 'updateStyles', nodeId, styles: { [key]: value as string } });
    }
    flushTool(ctx);
    return ok({ node_id: nodeId, applied: provided.length });
  },
};

// ─── set_size ─────────────────────────────────────────────────────────────

const SIZE_FIELDS = ['width', 'height', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight'] as const;

export const setSizeTool: AgentTool = {
  name: 'set_size',
  description:
    "Set size properties (width, height, minWidth, minHeight, maxWidth, maxHeight) on a node — px strings only, the Size panel's dialect. Pass '' to REMOVE a property (e.g. width: '' clears it).",
  inputSchema: {
    node_id: z.string().describe(NODE_ID_DESCRIBE),
    width: pxField('width').optional().describe("width as a px string, e.g. '640px'; '' removes it"),
    height: pxField('height').optional().describe("height as a px string, e.g. '480px'; '' removes it"),
    minWidth: pxField('minWidth').optional().describe("min-width as a px string; '' removes it"),
    minHeight: pxField('minHeight').optional().describe("min-height as a px string; '' removes it"),
    maxWidth: pxField('maxWidth').optional().describe("max-width as a px string; '' removes it"),
    maxHeight: pxField('maxHeight').optional().describe("max-height as a px string; '' removes it"),
  },
  category: 'semantic',
  async execute(args, ctx) {
    const nodeId = args.node_id as string;
    const styles: Record<string, string> = {};
    for (const key of SIZE_FIELDS) {
      if (args[key] !== undefined) styles[key] = args[key] as string;
    }
    if (Object.keys(styles).length === 0) return fail('set_size needs at least one of width, height, minWidth, minHeight, maxWidth, maxHeight.');
    ctx.ensureCheckpoint();
    queueToolMutation(ctx, { type: 'updateStyles', nodeId, styles });
    flushTool(ctx);
    return ok({ node_id: nodeId, applied: Object.keys(styles).length });
  },
};

// ─── set_position ─────────────────────────────────────────────────────────

const INSET_FIELDS = ['left', 'top', 'right', 'bottom'] as const;

export const setPositionTool: AgentTool = {
  name: 'set_position',
  description:
    "Set position (mode + insets) on a node. mode is the Position panel's type; left/top/right/bottom are px strings ('24px'), exactly what the pin detector reads — % is rejected. pinned: true marks the node data-pinned (the Position panel's lock, so drag stops auto-picking pins); pinned: false clears it. Pass '' as an inset value to REMOVE that pin.",
  inputSchema: {
    node_id: z.string().describe(NODE_ID_DESCRIBE),
    mode: z.enum(POSITION_MODE_VALUES).optional().describe("position mode: 'relative' | 'absolute' | 'fixed' | 'sticky'"),
    left: pxField('left').optional().describe("left inset as a px string; '' removes it"),
    top: pxField('top').optional().describe("top inset as a px string; '' removes it"),
    right: pxField('right').optional().describe("right inset as a px string; '' removes it"),
    bottom: pxField('bottom').optional().describe("bottom inset as a px string; '' removes it"),
    pinned: z
      .boolean()
      .optional()
      .describe("true writes data-pinned='true' (drag lock), false removes it; omit to leave the lock untouched"),
  },
  category: 'semantic',
  async execute(args, ctx) {
    const nodeId = args.node_id as string;
    const styles: Record<string, string> = {};
    if (args.mode !== undefined) styles.position = args.mode as string;
    for (const key of INSET_FIELDS) {
      if (args[key] !== undefined) styles[key] = args[key] as string;
    }
    const pinned = args.pinned;
    if (Object.keys(styles).length === 0 && pinned === undefined) {
      return fail('set_position needs at least one of mode, left, top, right, bottom or pinned.');
    }
    ctx.ensureCheckpoint();
    if (Object.keys(styles).length > 0) {
      queueToolMutation(ctx, { type: 'updateStyles', nodeId, styles });
    }
    if (pinned !== undefined) {
      // Same channel as the Position panel's pin lock (PinControl.lockNodePinning):
      // data-pinned attribute; '' removes it (cleared on any reparent anyway).
      queueToolMutation(ctx, { type: 'updateHtmlAttrs', nodeId, attrs: { 'data-pinned': pinned ? 'true' : '' } });
    }
    flushTool(ctx);
    return ok({ node_id: nodeId, applied: Object.keys(styles).length + (pinned !== undefined ? 1 : 0) });
  },
};

// ─── set_typography ───────────────────────────────────────────────────────

// lineHeight is the editor's UNITLESS ratio dialect ('1.5') or 'normal' —
// exactly what the oracle's LINE_HEIGHT_FORMAT accepts. This used to allow px
// too, so the tool's own description taught the one value the oracle exists to
// reject, and a model that followed the description got a bounce (audit V3;
// proven by the capability suite, 2026-09-21).
const LINE_HEIGHT_RE = /^(normal|\d+(\.\d+)?)$/;

export const setTypographyTool: AgentTool = {
  name: 'set_typography',
  description:
    "Set typography (fontSize, fontWeight, lineHeight, letterSpacing, fontFamily, textAlign, color) on a node. fontSize/letterSpacing are px strings ('32px'); lineHeight is a UNITLESS ratio ('1.5') or 'normal' — never px, the oracle rejects it; fontWeight is a number ('700'), 'normal' or 'bold'; fontFamily is a font name or a token reference ('var(--typo-* )'); color is hex '#rrggbb'. Pass '' to REMOVE a property.",
  inputSchema: {
    node_id: z.string().describe(NODE_ID_DESCRIBE),
    fontSize: pxField('fontSize').optional().describe("font size as a px string, e.g. '32px'; '' removes it"),
    fontWeight: z
      .union([z.number(), z.enum(TYPOGRAPHY_WEIGHT_VALUES)])
      .optional()
      .describe("font weight: a number ('700'), 'normal' or 'bold'"),
    lineHeight: z
      .string()
      .regex(LINE_HEIGHT_RE, "lineHeight must be a unitless ratio ('1.5') or 'normal' — never px (a px leading freezes when the font size changes)")
      .optional()
      .describe("line height as a unitless ratio, e.g. '1.5', or 'normal'; '' removes it"),
    letterSpacing: pxField('letterSpacing').optional().describe("letter spacing as a px string, e.g. '0.5px'; '' removes it"),
    fontFamily: z.string().optional().describe("font family name or token ref 'var(--typo-* )'; '' removes it"),
    textAlign: z.enum(TEXT_ALIGN_VALUES).optional().describe("text align: 'left' | 'center' | 'right' | 'justify'"),
    color: z
      .string()
      .regex(HEX_COLOR_RE, "color must be a hex string like '#6366f1'")
      .optional()
      .describe("text color as hex '#rrggbb'"),
  },
  category: 'semantic',
  async execute(args, ctx) {
    const nodeId = args.node_id as string;
    const styles: Record<string, string> = {};
    if (args.fontSize !== undefined) styles.fontSize = args.fontSize as string;
    if (args.fontWeight !== undefined) styles.fontWeight = String(args.fontWeight);
    if (args.lineHeight !== undefined) styles.lineHeight = args.lineHeight as string;
    if (args.letterSpacing !== undefined) styles.letterSpacing = args.letterSpacing as string;
    if (args.fontFamily !== undefined) styles.fontFamily = args.fontFamily as string;
    if (args.textAlign !== undefined) styles.textAlign = args.textAlign as string;
    if (args.color !== undefined) styles.color = args.color as string;
    if (Object.keys(styles).length === 0) {
      return fail('set_typography needs at least one of fontSize, fontWeight, lineHeight, letterSpacing, fontFamily, textAlign or color.');
    }
    ctx.ensureCheckpoint();
    queueToolMutation(ctx, { type: 'updateStyles', nodeId, styles });
    flushTool(ctx);
    return ok({ node_id: nodeId, applied: Object.keys(styles).length });
  },
};

export const ACTION_TOOLS: AgentTool[] = [
  setLayoutTool,
  setSizeTool,
  setPositionTool,
  setTypographyTool,
];
