// AnimationTool/popups/seeds.ts — Appear/Scroll mechanism seed writers, lifted verbatim
// from AnimationTool/index.tsx (Phase 7 god-file split, item 7.6).

import { queueMutation } from '@/code/mutation/mutation-queue';
import { getActiveAnimationScope } from '../animation-scope-source';
import { findEnclosingAnchorId } from '../enclosing-section';
import type { SerScope } from '@/code/generation/generator-motion';

// Default Motion scroll seed (the reference On Scroll: resting → To, default Fade Out).
const SCROLL_SEED = (nodeId: string, trigger: import('@/code/generation/generator-motion').ScrollAnimConfig['trigger'] = 'layerInView'): import('@/code/generation/generator-motion').ScrollAnimConfig => ({
  nodeId, trigger,
  stops: [
    { progress: 0, props: { opacity: '1' } },   // resting
    { progress: 1, props: { opacity: '0' } },   // To (Fade Out)
  ],
  transition: { type: 'spring', duration: '0.5', bounce: '0.25' },
  direction: 'down', replay: true,
});

export const seedAppear = (nodeId: string, fromTrigger?: import('@/code/generation/generator-motion').ScrollAnimConfig['trigger']) => {
  // Convert ONLY the Scroll Animation being edited into an Appear. In the
  // stackable model Transform / Speed are SEPARATE effects on the same node, so
  // we must NOT blanket-removeScrollAnim — that generator is shared with a
  // standalone Scroll Transform and would wipe it. Remove the mechanism this
  // animation actually uses: sectionInView = scrubbed (removeScrollAnim),
  // otherwise direction-triggered (removeScrollDirection). Default to the
  // direction removal (the Animation's "On Scroll" is layerInView).
  if (fromTrigger === 'sectionInView') queueMutation({ type: 'removeScrollAnim', nodeId });
  else queueMutation({ type: 'removeScrollDirection', nodeId });
  queueMutation({ type: 'updateMotionProp', nodeId, propName: 'initial', props: { opacity: '0', y: '30' }, scope: getActiveAnimationScope() });
  queueMutation({ type: 'updateMotionProp', nodeId, propName: 'whileInView', props: { opacity: '1', y: '0' } });
  queueMutation({ type: 'updateMotionProp', nodeId, propName: 'viewport', props: { once: 'true' } });
};
export const seedScroll = (nodeId: string, trigger: import('@/code/generation/generator-motion').ScrollAnimConfig['trigger']) => {
  queueMutation({ type: 'removeMotionProp', nodeId, propName: 'whileInView' });
  queueMutation({ type: 'removeMotionProp', nodeId, propName: 'initial' });
  queueMutation({ type: 'removeMotionProp', nodeId, propName: 'viewport' });
  if (trigger === 'sectionInView') {
    // Default the target to the node's ENCLOSING anchored section — that's
    // what "Section in View" means. '' stays valid (self-targeted scrub)
    // when no ancestor carries an anchor id.
    const cfg = SCROLL_SEED(nodeId, 'sectionInView');
    cfg.sectionId = findEnclosingAnchorId(nodeId);
    queueMutation({ type: 'updateScrollAnim', config: cfg });
  } else {
    // "On Scroll" = direction-TRIGGERED (the reference): fades out when scrolling down,
    // returns on scroll up (replay). Fade Out default. Adding on a replica scopes it to
    // that tile (no direction animation off-scope).
    const dscope = getActiveAnimationScope() as SerScope | null;
    queueMutation({ type: 'updateScrollDirection', config: { nodeId, toProps: { opacity: '0' }, direction: 'down', replay: true, transition: { type: 'spring', duration: '0.5', bounce: '0.25' }, ...(dscope ? { scope: [dscope] } : {}) } });
  }
};
