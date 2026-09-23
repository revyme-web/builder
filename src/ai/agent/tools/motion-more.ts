// src/ai/agent/tools/motion-more.ts
//
// The Animation panel beyond its four seeds (audit §8). `set_motion_preset`
// gave the agent a fixed appear, a scale-only hover / tap and a rotate-only
// loop; everything the panel's popups edit — any hover/tap target, an appear
// with direction, duration, delay and a spring, parallax speed, a scroll
// transform (from → to as you scroll), a scroll-direction animation — had no
// tool, and nothing could READ the motion already on a node. The whole panel
// writes ONE carrier, the node's `ScrollFxSpec` (`data-scroll-fx`): these
// tools merge into it exactly as the panel's `writeScrollFx` does, so an
// agent edit and a hand edit are the same edit.

import { z } from 'zod';
import type { AgentTool, AgentToolResult, ToolContext } from '@/ai/agent';
import { queueToolMutation, flushTool, getToolNodes, getToolCode } from '@/ai/agent/workspace';
import { getScrollFx, type ScrollFxSpec } from '@/code/generation/generator-motion-scroll-fx';
import { TEXT_ANIM_PRESETS, type TextAnimConfig } from '@/editor/tools/AnimationTool/motion/text-anim-presets';
import { trace } from '@/shared/debug-trace';

function ok(data: unknown): AgentToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}
function fail(message: string): AgentToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

const EASES = ['easeOut', 'easeIn', 'easeInOut', 'linear', 'backOut', 'backIn', 'circOut', 'circIn', 'anticipate'] as const;

/** Motion targets: numbers / strings keyed by motion prop (x, y, scale,
 *  rotate, opacity, backgroundColor, …). Numbers become the strings the spec
 *  carries. */
const targetsSchema = z.record(z.string(), z.union([z.number(), z.string()]))
  .describe('motion props → values, e.g. {"y": -8, "scale": 1.03, "opacity": 0.9, "backgroundColor": "#111111"}');

const transitionSchema = z.object({
  duration: z.number().optional().describe('seconds'),
  delay: z.number().optional().describe('seconds before it starts'),
  ease: z.enum(EASES).optional(),
  type: z.enum(['tween', 'spring']).optional(),
  stiffness: z.number().optional().describe('spring'),
  damping: z.number().optional().describe('spring'),
  mass: z.number().optional().describe('spring'),
  bounce: z.number().optional().describe('spring, 0-1'),
}).optional().describe('timing; a spring is {type:"spring", stiffness, damping}');

const strings = (o: Record<string, unknown> | undefined): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o ?? {})) if (v !== undefined && v !== null) out[k] = String(v);
  return out;
};

function currentSpec(ctx: ToolContext, nodeId: string): ScrollFxSpec {
  return { ...(getScrollFx(getToolCode(ctx), nodeId) ?? {}) };
}

function isEmpty(spec: ScrollFxSpec): boolean {
  return !spec.hover && !spec.tap && !spec.appear && !spec.loop && !spec.animation && !spec.transform && (spec.speed == null || spec.speed === 100);
}

function commit(ctx: ToolContext, nodeId: string, next: ScrollFxSpec): void {
  if (isEmpty(next)) queueToolMutation(ctx, { type: 'removeScrollFx', nodeId });
  else queueToolMutation(ctx, { type: 'updateScrollFx', nodeId, spec: next });
  flushTool(ctx);
}

/** A node the effects can live on: a plain element (an INSTANCE routes to its master — see set_motion_preset). */
function targetNode(ctx: ToolContext, nodeId: string): { error: string } | null {
  const node = getToolNodes(ctx).get(nodeId);
  if (!node) return { error: `No node "${nodeId}" in the active file.` };
  if (/^[A-Z]/.test(node.type) && !node.type.startsWith('motion.') && node.type !== 'MotionLink') {
    return { error: `"${nodeId}" is a component instance — an instance cannot carry motion. Animate the master's root instead: set_page to its master, or use set_motion_preset which routes there.` };
  }
  return null;
}

export const setMotionTool: AgentTool = {
  name: 'set_motion',
  description:
    'Add or change an effect on an element with FULL control — the Animation panel\'s popups. One call sets one effect; effects on a node stack (an appear and a hover together). ' +
    'effect "hover" / "tap": `targets` while hovered / pressed ({y:-8, scale:1.03, backgroundColor:"#111"}). ' +
    '"appear": enter when scrolled into view — `from` is the hidden start ({opacity:0, y:40} slides up, {x:-60} slides in from the left), it animates to the resting state; `once` (default true); `transition` for duration / delay / ease / spring — a `delay` per element is how you stagger cards. ' +
    '"loop": `targets` cycled forever ({rotate:360} spin, {y:-6} float) with `transition` {duration, ease, repeatType:"mirror"?}. ' +
    '"speed": parallax — `speed` 100 = normal, 50 = half speed (lags), 150 = faster. ' +
    '"transform": scrub `from` → `to` with scroll; `trigger` "layerInView" (this element passes through), "sectionInView" (another element does — `section_id`) or "onScroll" (the page). ' +
    '"animation": on scroll DIRECTION — `direction` "down" | "up" animates to `targets` ({y:-100, opacity:0} hides a header when scrolling down), `replay` to undo on the way back. ' +
    'Component instances: use set_motion_preset (routes to the master).',
  inputSchema: {
    node_id: z.string(),
    effect: z.enum(['hover', 'tap', 'appear', 'loop', 'speed', 'transform', 'animation']),
    targets: targetsSchema.optional(),
    from: targetsSchema.optional().describe('appear / transform: the start state'),
    to: targetsSchema.optional().describe('transform: the end state'),
    once: z.boolean().optional().describe('appear: play once (default) or every time'),
    transition: transitionSchema,
    speed: z.number().optional().describe('effect "speed": 100 = normal'),
    trigger: z.enum(['layerInView', 'sectionInView', 'onScroll']).optional().describe('transform: what drives the scrub (default layerInView)'),
    section_id: z.string().optional().describe('transform with sectionInView: the data-id of the driving section'),
    direction: z.enum(['down', 'up']).optional().describe('animation: the scroll direction that triggers it'),
    replay: z.boolean().optional().describe('animation: undo when scrolling the other way'),
  },
  category: 'semantic',
  async execute(args, ctx) {
    const nodeId = String(args.node_id);
    const bad = targetNode(ctx, nodeId);
    if (bad) return fail(bad.error);
    const effect = String(args.effect);
    const targets = strings(args.targets as Record<string, unknown> | undefined);
    const from = strings(args.from as Record<string, unknown> | undefined);
    const to = strings(args.to as Record<string, unknown> | undefined);
    const transition = strings(args.transition as Record<string, unknown> | undefined);
    const spec = currentSpec(ctx, nodeId);

    if (effect === 'hover' || effect === 'tap') {
      if (!Object.keys(targets).length) return fail(`${effect} needs \`targets\`, e.g. {"scale": 1.05}.`);
      spec[effect] = { ...(spec[effect] ?? { props: {} }), props: targets };
    } else if (effect === 'appear') {
      const initial = Object.keys(from).length ? from : { opacity: '0', y: '30' };
      spec.appear = { ...(spec.appear ?? {}), initial, once: args.once !== false, ...(Object.keys(transition).length ? { transition } : {}) };
    } else if (effect === 'loop') {
      if (!Object.keys(targets).length) return fail('loop needs `targets`, e.g. {"rotate": 360}.');
      spec.loop = { props: targets, transition: { duration: transition.duration ?? '2', ease: transition.ease ?? 'linear', repeat: 'Infinity', ...transition } };
    } else if (effect === 'speed') {
      if (typeof args.speed !== 'number') return fail('speed needs `speed` (100 = normal).');
      spec.speed = Number(args.speed);
    } else if (effect === 'transform') {
      if (!Object.keys(from).length || !Object.keys(to).length) return fail('transform needs `from` and `to`, e.g. from {opacity:1} to {opacity:0}.');
      const trigger = String(args.trigger ?? 'layerInView');
      if (trigger === 'sectionInView' && !args.section_id) return fail('sectionInView needs `section_id`.');
      spec.transform = { trigger: trigger === 'sectionInView' ? `sectionInView:${args.section_id}` : trigger, from, to, ...(Object.keys(transition).length ? { transition } : {}) };
    } else {
      if (!Object.keys(targets).length || !args.direction) return fail('animation needs `direction` ("down" | "up") and `targets`.');
      spec.animation = { direction: args.direction as 'down' | 'up', replay: !!args.replay, toProps: targets, ...(Object.keys(transition).length ? { transition } : {}) };
    }
    ctx.ensureCheckpoint();
    commit(ctx, nodeId, spec);
    trace.action('agent-tool:set_motion', { nodeId, effect });
    return ok({ node_id: nodeId, effect, motion: describeSpec(spec) });
  },
};

export const removeMotionTool: AgentTool = {
  name: 'remove_motion',
  description: 'Remove one effect from an element (hover | tap | appear | loop | speed | transform | animation), or `all`.',
  inputSchema: { node_id: z.string(), effect: z.enum(['hover', 'tap', 'appear', 'loop', 'speed', 'transform', 'animation', 'all']) },
  category: 'semantic',
  async execute(args, ctx) {
    const nodeId = String(args.node_id);
    if (!getToolNodes(ctx).has(nodeId)) return fail(`No node "${nodeId}" in the active file.`);
    const effect = String(args.effect);
    const spec = currentSpec(ctx, nodeId);
    ctx.ensureCheckpoint();
    if (effect === 'all') { queueToolMutation(ctx, { type: 'removeScrollFx', nodeId }); flushTool(ctx); return ok({ node_id: nodeId, removed: 'all' }); }
    if (effect === 'speed') delete spec.speed; else delete (spec as Record<string, unknown>)[effect];
    commit(ctx, nodeId, spec);
    return ok({ node_id: nodeId, removed: effect, motion: describeSpec(spec) });
  },
};

const PRESET_NAMES = TEXT_ANIM_PRESETS.map((p) => p.name).filter((n) => n !== 'None');

export const setTextEffectTool: AgentTool = {
  name: 'set_text_effect',
  description:
    `Animate TEXT by unit — split by character, word or line, each unit entering after the previous (the Text Effect popup). preset is one of: ${PRESET_NAMES.join(', ')}; or describe it: split, from ({opacity:0, y:20}), stagger (seconds between units), transition. ` +
    'mask: true reveals each unit from behind a clip (the "cut-off" look) — pair with y "100%". trigger "appear" (on mount) or "layerInView" (when scrolled to). Pass preset "none" to remove.',
  inputSchema: {
    node_id: z.string(),
    preset: z.string().optional().describe(`${PRESET_NAMES.join(' | ')} | none`),
    split: z.enum(['character', 'word', 'line', 'full']).optional(),
    from: targetsSchema.optional().describe('start state per unit: opacity, y, x, scale, blur, rotateX/Y/Z'),
    stagger: z.number().optional().describe('seconds between units (default 0.05)'),
    mask: z.boolean().optional(),
    trigger: z.enum(['appear', 'layerInView']).optional(),
    transition: transitionSchema,
  },
  category: 'semantic',
  async execute(args, ctx) {
    const nodeId = String(args.node_id);
    const node = getToolNodes(ctx).get(nodeId);
    if (!node) return fail(`No node "${nodeId}" in the active file.`);
    if (String(args.preset ?? '').toLowerCase() === 'none') {
      ctx.ensureCheckpoint();
      queueToolMutation(ctx, { type: 'removeTextAnim', nodeId });
      flushTool(ctx);
      return ok({ node_id: nodeId, text_effect: null });
    }
    let config: TextAnimConfig;
    if (args.preset) {
      const p = TEXT_ANIM_PRESETS.find((x) => x.name.toLowerCase() === String(args.preset).toLowerCase());
      if (!p) return fail(`No text effect preset "${args.preset}". Presets: ${PRESET_NAMES.join(', ')}.`);
      config = { ...p.config };
    } else {
      config = { animationType: 'character', delay: 0.05, opacity: 0 };
    }
    if (args.split) config.animationType = args.split as TextAnimConfig['animationType'];
    if (typeof args.stagger === 'number') config.delay = Number(args.stagger);
    if (args.mask !== undefined) config.mask = !!args.mask;
    if (args.trigger) config.trigger = args.trigger as TextAnimConfig['trigger'];
    const from = (args.from as Record<string, unknown> | undefined) ?? {};
    for (const key of ['opacity', 'scale', 'blur', 'rotateX', 'rotateY', 'rotateZ', 'skewX', 'skewY'] as const) {
      if (from[key] !== undefined) (config as unknown as Record<string, unknown>)[key] = Number(from[key]);
    }
    for (const key of ['x', 'y'] as const) {
      if (from[key] !== undefined) config[key] = typeof from[key] === 'number' ? Number(from[key]) : String(from[key]);
    }
    if (args.transition) config.transition = { ...(config.transition ?? {}), ...(args.transition as TextAnimConfig['transition']) };
    ctx.ensureCheckpoint();
    queueToolMutation(ctx, { type: 'updateTextAnim', nodeId, config });
    flushTool(ctx);
    trace.action('agent-tool:set_text_effect', { nodeId, preset: args.preset ?? null, split: config.animationType });
    return ok({ node_id: nodeId, text_effect: { split: config.animationType, stagger: config.delay, mask: !!config.mask, trigger: config.trigger ?? 'appear' } });
  },
};

/** The motion on a node, in words. */
export function describeSpec(spec: ScrollFxSpec | null): Record<string, unknown> | null {
  if (!spec || isEmpty(spec)) return null;
  const out: Record<string, unknown> = {};
  if (spec.appear) out.appear = { from: spec.appear.initial, once: spec.appear.once, ...(spec.appear.transition ? { transition: spec.appear.transition } : {}) };
  if (spec.hover) out.hover = spec.hover.props;
  if (spec.tap) out.tap = spec.tap.props;
  if (spec.loop) out.loop = { targets: spec.loop.props, transition: spec.loop.transition };
  if (spec.speed != null && spec.speed !== 100) out.speed = spec.speed;
  if (spec.transform) out.transform = { trigger: spec.transform.trigger, from: spec.transform.from, to: spec.transform.to };
  if (spec.animation) out.animation = { direction: spec.animation.direction, targets: spec.animation.toProps, replay: spec.animation.replay };
  return out;
}

export const getMotionTool: AgentTool = {
  name: 'get_motion',
  description: 'Read the motion on an element — every effect (appear, hover, tap, loop, parallax speed, scroll transform, scroll animation) with its values, plus any text effect. Call it before changing motion that is already there.',
  inputSchema: { node_id: z.string() },
  category: 'read',
  async execute(args, ctx) {
    const nodeId = String(args.node_id);
    const node = getToolNodes(ctx).get(nodeId);
    if (!node) return fail(`No node "${nodeId}" in the active file.`);
    const code = getToolCode(ctx);
    const motion = describeSpec(getScrollFx(code, nodeId));
    const tagStart = code.indexOf(`data-id="${nodeId}"`);
    const tag = tagStart >= 0 ? code.slice(code.lastIndexOf('<', tagStart), tagStart + 600) : '';
    const textAnim = tag.match(/data-text-anim='([^']*)'/)?.[1];
    return ok({ node_id: nodeId, motion, text_effect: textAnim ? JSON.parse(textAnim) : null, is_motion_element: /^<motion\./.test(tag) });
  },
};

export const MOTION_MORE_TOOLS: AgentTool[] = [setMotionTool, removeMotionTool, setTextEffectTool, getMotionTool];
