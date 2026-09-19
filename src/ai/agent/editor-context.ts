// editor-context.ts — what the model is told about the project, per turn.
//
// The turn loop runs in the ai-generator service and has no access to the
// editor, so this tab has to SAY where it is: the file being edited, the
// breakpoint, the selection, the page tree, the design tokens and the
// components available to reuse. Sent as one block with each turn.
//
// The block is dynamic on purpose: the service's system prompt stays byte
// identical across turns so providers can cache it, and everything that
// changes lives here instead.

import { getDefaultStore } from 'jotai';
import { projectNodeTree, formatDesignTokens } from './tools/read';
import { buildComponentRegistry } from '@/code/components/component-registry';
import { activeFilePathAtom } from '@/code/project/active-file-store';
import { projectFS, projectVersionAtom } from '@/code/project/project-fs';
import { getPresetTokens } from '@/code/project/preset-ops';
import { getNodesSnapshot, selectedIdsAtom } from '@/code/stores/store';
import { interactingViewportWidthAtom } from '@/code/stores/viewport-store';
import { DEFAULT_VIEWPORT_WIDTH } from '@/shared/constants';
import { trace } from '@/shared/debug-trace';

/** The tree is the biggest part of the block — cap it and say so, rather than
 *  spending the whole context window on a page the model can query per node. */
const PAGE_TREE_CAP = 6000;
const TOKENS_CAP = 40;
const COMPONENTS_CAP = 30;
const TRUNCATED_TREE_SUFFIX = '\n...(truncated, call get_node for details)';

/**
 * The Revyme dialect card — the rules a written file must satisfy to pass the
 * oracle, stated in the terms the oracle reports them. Derived from the most
 * frequent violation codes rather than written per feature: these are the ones
 * a model actually trips over, and each line is phrased as the fix, not the
 * complaint. Kept short and OUT of the system prompt so the static prompt
 * stays cacheable.
 */
const DIALECT_CARD =
  '## Revyme dialect — must-pass\n' +
  "FLEX_CHILD_MISSING_ORDER: every flex/grid child needs quoted order '0','1'… • " +
  'NODE_MISSING_POSITION: every node needs position (relative/absolute/fixed) • ' +
  'MINMAX_SIZE_UNIT: min/max only px or % • ' +
  'IMAGE_USE_BACKGROUND_FRAME: images are div+backgroundImage, not <img> • ' +
  "FLEX_CHILD_SHRINKS: flex children need flex:'0 0 auto' (no shrink) • " +
  "PIN_VALUE_NOT_PX: pins must be 'Npx' strings";

/** Build the per-turn context block. Never throws: a missing piece is simply
 *  omitted — an agent with partial context still works, one that crashed the
 *  turn assembling context does not. */
export function buildAgentContextBlock(): string {
  const store = getDefaultStore();
  const sections: string[] = [];

  try {
    const lines = ['## Current editor context'];
    lines.push(`Editing: ${store.get(activeFilePathAtom) ?? 'unknown'}`);

    const vpWidth = store.get(interactingViewportWidthAtom) || DEFAULT_VIEWPORT_WIDTH;
    lines.push(`Active viewport width: ${vpWidth}px`);
    if (vpWidth !== DEFAULT_VIEWPORT_WIDTH) {
      lines.push("(editing a non-desktop breakpoint — pass this px value as 'viewport' to set_styles for responsive overrides)");
    }

    const selected = store.get(selectedIdsAtom);
    lines.push(selected.length > 0 ? `Selected elements: ${selected.join(', ')}` : 'No element selected.');
    sections.push(lines.join('\n'));
  } catch (err) {
    trace.error('agent-context:header-failed', err);
  }

  try {
    const tree = projectNodeTree(getNodesSnapshot());
    if (tree.length > 0) {
      const content = tree.length > PAGE_TREE_CAP ? tree.slice(0, PAGE_TREE_CAP) + TRUNCATED_TREE_SUFFIX : tree;
      sections.push(
        '## Current page tree (compact: id [type] name {abbreviated styles} "text"; children indented; ' +
        "defaults omitted; '…' = truncated — get_node for full detail)\n" + content,
      );
    }
  } catch (err) {
    trace.error('agent-context:tree-failed', err);
  }

  sections.push(DIALECT_CARD);

  try {
    const tokens = getPresetTokens();
    if (tokens.length > 0) sections.push(formatDesignTokens(tokens, TOKENS_CAP));
  } catch (err) {
    trace.error('agent-context:tokens-failed', err);
  }

  try {
    const registry = buildComponentRegistry(projectFS, store.get(projectVersionAtom));
    if (registry.size > 0) {
      const names = Array.from(registry.values())
        .map((c) => `${c.name} (${c.props.length} prop${c.props.length === 1 ? '' : 's'})`)
        .slice(0, COMPONENTS_CAP);
      sections.push(`## Reusable components\n${names.join(', ')}`);
    }
  } catch (err) {
    trace.error('agent-context:components-failed', err);
  }

  const block = sections.join('\n\n');
  trace.fn('agent-context:built', { chars: block.length, sections: sections.length });
  return block;
}
