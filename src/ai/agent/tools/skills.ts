// src/ai/agent/tools/skills.ts
//
// The KNOWLEDGE tools — `load_manual` (the manual for a kind of work),
// `component_example` (a reference design-component master) and `get_dialect`
// (the whole-file dialect card). Their answers are the SERVICE's private
// knowledge, so the service answers them itself (ai-generator
// agent/service-tools.ts), for its own agent loop and for the MCP: the text
// never reaches this tab. They are declared here only so they sit in the
// manifest — the names, descriptions and schemas the model sees are the
// builder's, like every other tool.
//
// Executed in the tab, they say so and fail honestly: this editor holds no
// manuals (they used to be fetched from public routes — anyone could read
// them, 2026-09-23).

import { z } from 'zod';
import type { AgentTool } from '@/ai/agent';
import { trace } from '@/shared/debug-trace';

/** The honest answer when a knowledge tool runs in the tab instead of the service. */
function answeredByService(tool: string) {
  trace.action('agent-knowledge-tool:tab-refused', { tool });
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: `Could not load it here — ${tool} is answered by the Revyme AI service, and this editor holds no manuals.` }) }],
    isError: true,
  };
}

export const SKILL_NAMES = ['code-component', 'cms', 'plugin'] as const;

export const loadSkillTool: AgentTool = {
  name: 'load_manual',
  description:
    'Load the detailed manual for a kind of work BEFORE doing it, when the context does not already carry it ("# Manual: …"). ' +
    '`code-component`: writing or editing a code component file — required annotations, the two render modes, controls, what may be imported. ' +
    '`cms`: building or filling a CMS collection — field types, content rules, translations. ' +
    '`plugin`: writing an editor plugin (plugins/<Name>.tsx) — the plugin SDK surface, the authoring shape, idioms. ' +
    'One call, a few KB; it saves a rejected write.',
  inputSchema: { name: z.enum(SKILL_NAMES) },
  category: 'meta',
  async execute() {
    return answeredByService('load_manual');
  },
};

/**
 * `component_example` — a REAL design-component master as reference before
 * hand-writing one with `apply_file_edit`. The examples are the service's
 * (they describe the dialect, not the project), like the manuals above. The
 * system prompt named this tool from the day the MCP server had it; the
 * in-app agent did not (audit: phantom tool).
 */
export const componentExampleTool: AgentTool = {
  name: 'component_example',
  description:
    'Show a REAL design-component master as reference before writing or restructuring a components/*.tsx file by hand (apply_file_edit). ' +
    'The shape cannot be guessed — variantConfig, initialVariant in the signature, a variant root, connections, AnimatePresence. ' +
    "Patterns: 'two-state-toggle', 'hover-state', 'animate-presence', 'declared-props', 'motion-variants', 'many-variants', 'minimal'. Omit to list them. " +
    'Read the shape, then write your own — never copy the content. Prefer create_component / extract_component when a declaration is enough.',
  inputSchema: { pattern: z.string().optional() },
  category: 'meta',
  async execute() {
    return answeredByService('component_example');
  },
};

/**
 * `get_dialect` — the whole-file DIALECT card for a kind of file: what a
 * page / design component / code component must look like for the builder
 * to resolve it (the same card the MCP `revyme_get_dialect` returns). For
 * `apply_file_edit` / `create_component` work; the semantic tools never
 * need it.
 */
export const getDialectTool: AgentTool = {
  name: 'get_dialect',
  description:
    'The builder\'s whole-file DIALECT for a kind of file — page | component | code-component: the exact source shape the editor resolves (data-ids, style objects, variant plumbing, annotations, allowed imports). ' +
    'Read it BEFORE writing a whole file with apply_file_edit; the semantic tools write the dialect for you and never need it.',
  inputSchema: { kind: z.enum(['page', 'component', 'code-component']) },
  category: 'meta',
  async execute() {
    return answeredByService('get_dialect');
  },
};
