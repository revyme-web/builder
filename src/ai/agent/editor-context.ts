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
import { describeSurface, type AgentSurface } from './surface';
import { readAgentSurface, readCodeComponentFacts, readCmsFacts, readPluginFacts, readIconSetFacts } from './surface-state';
import { listProjectSkills } from '@/code/stores/project-skills-store';
import type { ProjectSkill } from '@/code/project/skills-config';

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
/** What the skills may take of one turn's context, together. A skill is
 *  capped at SKILL_CONTENT_MAX on its own; this bounds several at once. */
export const SKILLS_CONTEXT_CAP = 20_000;

/**
 * The skills section: always-apply ones, then the invoked ones, in full,
 * until the budget runs out — a skill that does not fit is NAMED, so the
 * model can `read_skill` it rather than never knowing it was asked for.
 */
export function formatProjectSkills(skills: readonly ProjectSkill[], invoked: readonly string[]): string {
  const picked = [
    ...skills.filter((s) => s.alwaysApply),
    ...invoked.map((n) => skills.find((s) => s.name === n && !s.alwaysApply)).filter((s): s is ProjectSkill => !!s),
  ];
  if (picked.length === 0) return '';
  const parts = ["## Project skills — the user's own rules for this project; follow them"];
  const left: string[] = [];
  let used = 0;
  for (const s of picked) {
    const why = s.alwaysApply ? 'always apply' : 'invoked for this request';
    const block = `## Project skill: /${s.name} (${why})${s.description ? ` — ${s.description}` : ''}\n${s.content}`;
    if (used + block.length > SKILLS_CONTEXT_CAP) { left.push(`/${s.name}`); continue; }
    parts.push(block);
    used += block.length;
  }
  if (left.length) parts.push(`(Also in effect but over this turn's budget — read them with read_skill: ${left.join(', ')})`);
  return parts.join('\n\n');
}

export function buildAgentContextBlock(surface: AgentSurface = readAgentSurface(), invokedSkills: readonly string[] = []): string {
  const store = getDefaultStore();
  const sections: string[] = [];
  // The page underneath an overlay is not what the user is looking at. Its
  // tree, its selection and the page dialect are ~6 KB that would pull the
  // model toward the canvas on every turn — the opposite of focus — so they
  // are sent on the canvas surface only. The agent can still ask for them
  // (get_node_tree, get_selection) the moment a request leaves the overlay.
  // An icon set is edited ON the canvas: its tree and selection are the icons.
  const onCanvas = surface.kind === 'canvas' || surface.kind === 'icon-set';

  try {
    sections.push(describeSurface(surface, {
      codeComponent: surface.kind === 'code-component' ? readCodeComponentFacts(surface.filePath) : null,
      cms: surface.kind === 'cms' ? readCmsFacts(surface) : null,
      plugin: surface.kind === 'plugin' ? readPluginFacts(surface.filePath) : null,
      iconSet: surface.kind === 'icon-set' ? readIconSetFacts(surface.filePath) : null,
    }));
  } catch (err) {
    trace.error('agent-context:surface-failed', err);
  }

  try {
    const lines = ['## Current editor context'];
    lines.push(onCanvas
      ? `Editing: ${store.get(activeFilePathAtom) ?? 'unknown'}`
      : `Page underneath (NOT what the user is looking at): ${store.get(activeFilePathAtom) ?? 'unknown'}`);

    const vpWidth = store.get(interactingViewportWidthAtom) || DEFAULT_VIEWPORT_WIDTH;
    lines.push(`Active viewport width: ${vpWidth}px`);
    if (vpWidth !== DEFAULT_VIEWPORT_WIDTH) {
      lines.push("(editing a non-desktop breakpoint — pass this px value as 'viewport' to set_styles for responsive overrides)");
    }

    if (onCanvas) {
      const selected = store.get(selectedIdsAtom);
      lines.push(selected.length > 0 ? `Selected elements: ${selected.join(', ')}` : 'No element selected.');
    }
    // WHICH BRANCH — the one fact the branch rules in the prompt turn on:
    // on main a big piece of work is offered a branch; on a branch the work
    // simply continues there.
    const branch = projectFS.getActiveBranchId();
    const others = projectFS.listBranches().filter((b) => b.id !== branch && b.id !== 'main').map((b) => b.id);
    lines.push(branch === 'main'
      ? `Branch: main (the version that publishes)${others.length ? ` — other branches: ${others.join(', ')}` : ''}`
      : `Branch: ${branch} (a copy of the project; main is untouched until the user applies it)${others.length ? ` — other branches: ${others.join(', ')}` : ''}`);
    sections.push(lines.join('\n'));
  } catch (err) {
    trace.error('agent-context:header-failed', err);
  }

  // The user's own rules for this project: every "always apply" skill, and
  // the ones this message invoked with /name (skills-config.ts). Near the top
  // — they outrank the page detail below.
  try {
    const skills = formatProjectSkills(listProjectSkills(), invokedSkills);
    if (skills) sections.push(skills);
  } catch (err) {
    trace.error('agent-context:skills-failed', err);
  }

  try {
    const tree = onCanvas ? projectNodeTree(getNodesSnapshot()) : '';
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

  if (onCanvas) sections.push(DIALECT_CARD);

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
  trace.fn('agent-context:built', { surface: surface.kind, chars: block.length, sections: sections.length });
  return block;
}
