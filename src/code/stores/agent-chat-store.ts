// agent-chat-store.ts — conversation state for the agent panel.
//
// The TURN runs in the ai-generator service; this store only holds what the
// panel renders. Deliberately NOT a mirror of the run: the service owns the
// loop, the tab owns the tools, and this owns the transcript.
//
// Provider keys are BYOK and live in localStorage, sent per request and never
// stored server-side.

import { atom } from 'jotai';
import { atomWithStorage } from 'jotai/utils';
import type { ChangePart } from '@/code/project/change-parts';

export type AgentStatus = 'idle' | 'running' | 'error';

export interface AgentToolEntry {
  id: string;
  name: string;
  ok: boolean | null;      // null = still running
  detail?: string;
  /** data-URL of a screenshot the tool returned. Shown inline so you can see
   *  what the agent saw at that point in the run. */
  image?: string;
  /** How many things this call touched — a batch of 15 adds is 15 layers, not
   *  one "batch". Derived from the arguments at call time; the arguments
   *  themselves are never kept, so persisting a turn stays small. */
  count?: number;
  /** Wall time of this call, summed into its activity line's duration. */
  ms?: number;
  /** The reasoning streamed just before this call — the WHY behind it, shown
   *  when its sub-step is expanded. */
  note?: string;
}

/** One run of text, one stretch of the model's thinking, or one group of
 *  tool calls — in the order they happened. */
export type AgentBlock =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'tools'; tools: AgentToolEntry[] };

/** Files the last finished run changed, with their per-file id diffs — drives
 *  the Changes card's layer counts. */
export interface AgentChangedFile {
  path: string;
  addedIds?: string[];
  removedIds?: string[];
  changedIds?: string[];
  /** Non-layer changes (styles, collection items/fields, strings) — see
   *  code/project/change-parts.ts. */
  parts?: ChangePart[];
}

/** One image the user pasted into a message. */
export interface AgentTurnImage {
  /** Small JPEG for the transcript — the only encoding that is PERSISTED. */
  thumb: string;
  /** What the model receives. In memory for this session only: absent on a
   *  turn restored from disk, which then shows the picture but no longer
   *  re-sends it (see editor/agent/attachments.ts). */
  full?: string;
  width?: number;
  height?: number;
}

export interface AgentTurn {
  role: 'user' | 'assistant';
  text: string;
  /** Images pasted with a USER turn, in paste order. */
  images?: AgentTurnImage[];
  /** Chronological blocks. A turn interleaves talking and acting — "I'll check
   *  the conventions" → tools → "done, here's what changed" — and rendering
   *  all the text above all the tools puts the closing summary ABOVE the work
   *  it describes. Assistant turns render from this; `text` remains the whole
   *  reply, which is what the next request sends back as history. */
  blocks?: AgentBlock[];
  tools?: AgentToolEntry[];
  /** The model's own deliberation. Kept SEPARATE from `text` and collapsed by
   *  default — it is context for a curious user, not part of the answer. */
  reasoning?: string;
  /** What this turn changed. Lives on the TURN, not in one panel-level atom,
   *  so every turn keeps its own Changes card in place in the transcript
   *  instead of a single card at the bottom that only describes the last run. */
  changes?: AgentChangedFile[];
  /** The MCP client that carried this request ("Claude Code") when the work
   *  was asked for outside the builder — see ai/agent/external-run.ts. */
  via?: string;
  /** Project skills this message invoked with /name (skills-config.ts). */
  skills?: string[];
  /** The error this run ENDED on (the service's message, verbatim). Kept on
   *  the turn and saved with the chat — it used to live only in a live atom
   *  that the next load or send wiped, so a failed run left nothing to debug
   *  from (2026-09-23). */
  error?: string;
}

export interface AgentProviderConfig {
  /** `revyme` runs on REVYME CREDITS — the service's own key, billed to the
   *  workspace; the only engine on Revyme cloud (ai-generator
   *  agent/engine-policy.ts). `claude-cli` runs the turn on the local Claude
   *  Code SUBSCRIPTION via the `claude` binary — no key, no per-token cost.
   *  Every other provider is BYOK: the key is sent with the request and never
   *  stored server-side. Those two are for self-hosted / local installs. */
  provider: 'revyme' | 'claude-cli' | 'anthropic' | 'openai' | 'google' | 'openrouter';
  model: string;
  apiKey: string;
}

export const agentStatusAtom = atom<AgentStatus>('idle');
export const agentErrorAtom = atom<string | null>(null);
/** Committed transcript. The in-flight assistant reply lives in the stream atoms. */
export const agentConversationAtom = atom<AgentTurn[]>([]);
/** Text streaming in for the CURRENT reply, rendered as its own bubble. */
export const agentStreamAtom = atom<string>('');
/** Tool calls of the current reply, in call order. */
export const agentToolsAtom = atom<AgentToolEntry[]>([]);
/** The current reply in CHRONOLOGICAL blocks — talking and acting in the order
 *  they happen. The live view renders these exactly as a finished turn renders
 *  its `blocks`; the stream/tools atoms above stay for the closing summary and
 *  the tool count. (Before this the live view showed ONE bubble of all the
 *  text above ALL the tools — the sentences between the work only appeared
 *  once the turn was over, 2026-09-22.) */
export const agentBlocksAtom = atom<AgentBlock[]>([]);
/** Reasoning streaming in for the CURRENT reply. */
export const agentReasoningAtom = atom<string>('');
export const agentChangedFilesAtom = atom<AgentChangedFile[]>([]);

/**
 * A request for the agent from OUTSIDE the chat — Settings → Skills →
 * "Generate from my project". The open chat sends it once (AgentChat);
 * `nonce` makes the same text asked twice two requests.
 */
export const agentQueuedRequestAtom = atom<{ text: string; nonce: number } | null>(null);

export const DEFAULT_MODELS: Record<AgentProviderConfig['provider'], string> = {
  // A catalog id (ai-generator providers/model-catalog.ts) — the server clamps
  // anything else to its default, so credits can never run an arbitrary model.
  revyme: 'anthropic/claude-sonnet-5',
  'claude-cli': '',                 // whatever the CLI is configured to use
  anthropic: 'claude-sonnet-5',
  openai: 'gpt-5',
  google: 'gemini-2.5-pro',
  openrouter: 'anthropic/claude-sonnet-5',
};

/** Engine config. Per user, not per project — a key is an account credential. */
export const agentConfigAtom = atomWithStorage<AgentProviderConfig>('revyme.agent.config', {
  // The chat runs on Revyme credits (effectiveAgentConfig).
  provider: 'revyme',
  model: DEFAULT_MODELS.revyme,
  apiKey: '',
});

/**
 * The engines the CONNECTED AI SERVICE runs the agent on (GET
 * /api/agent/engines — ai-generator agent/engine-policy.ts): credits only on
 * Revyme cloud; credits (when keyed), the local CLI and pasted keys on a local
 * service; NOTHING when no service is reachable — the open-source builder
 * ships without one, so it has no agent to configure. Asked, not derived from
 * this build's flags: only the service knows what it will run.
 * `null` = not asked yet.
 */
export const agentEnginesAtom = atom<AgentProviderConfig['provider'][] | null>(null);

/** Could the AI service be reached at the last ask? `null` = not asked yet.
 *  While `false` the chat cannot run and keeps asking (AgentChat). */
export const agentServiceReachableAtom = atom<boolean | null>(null);

/**
 * The config a turn actually runs with: ALWAYS Revyme credits. The chat's
 * model select lists the credit models and nothing else — no local CLI, no
 * pasted keys, no settings behind it (owner, 2026-09-23); bringing your own
 * AI is the MCP connector, driven from the user's own client. A choice
 * stored before that (the old default was the local CLI) runs as credits on
 * the default model rather than on an engine nothing on screen names.
 */
export function effectiveAgentConfig(c: AgentProviderConfig): AgentProviderConfig {
  if (c.provider === 'revyme') return c;
  return { provider: 'revyme', model: DEFAULT_MODELS.revyme, apiKey: '' };
}

export const effectiveAgentConfigAtom = atom((get) => effectiveAgentConfig(get(agentConfigAtom)));

/**
 * How hard the model thinks before it answers — chosen PER MODEL in the
 * composer's model select (ModelSelector.tsx), stored per user like the rest
 * of the engine config. Every OpenRouter model THINKS — there is no "off":
 * the level goes out as the turn's `reasoning` and reaches OpenRouter as
 * `reasoning.effort`, Low being the least (owner, 2026-09-23). Thinking is
 * billed as output, so a higher effort costs more on credits.
 * `off` / `auto` are no longer offered; a choice stored before that falls
 * back to the model's default level (effortFor).
 */
export type AgentEffort = 'off' | 'auto' | 'low' | 'medium' | 'high';

export const EFFORT_LABELS: Record<AgentEffort, string> = { off: 'Off', auto: 'Auto', low: 'Low', medium: 'Medium', high: 'High' };

/** model id → its chosen effort. */
export const agentEffortAtom = atomWithStorage<Record<string, AgentEffort>>('revyme.agent.effort', {});

/**
 * The efforts a model takes, and the one it runs at until you pick. Only the
 * OpenRouter engines (credits, a pasted OpenRouter key) — the slug says the
 * vendor, and OpenRouter maps effort per vendor. Always a level, never off:
 *   · Claude only thinks when asked, so it is always asked — Low by default
 *     (the cheapest thinking; an effort sets its thinking budget);
 *   · GPT — Medium by default, OpenAI's own level;
 *   · Gemini — High by default, its own level; it takes low / high only.
 *     (It also sends its thinking only when a level is asked for.)
 * `null`: no effort control (Claude Code, the native key providers).
 */
export function effortOptionsFor(provider: AgentProviderConfig['provider'], model: string): { options: AgentEffort[]; fallback: AgentEffort } | null {
  if (provider !== 'revyme' && provider !== 'openrouter') return null;
  if (model.startsWith('anthropic/')) return { options: ['low', 'medium', 'high'], fallback: 'low' };
  if (model.startsWith('openai/')) return { options: ['low', 'medium', 'high'], fallback: 'medium' };
  if (model.startsWith('google/')) return { options: ['low', 'high'], fallback: 'high' };
  return null;
}

/** The effort a model runs at — the stored pick when the model takes it. */
export function effortFor(efforts: Record<string, AgentEffort>, provider: AgentProviderConfig['provider'], model: string): AgentEffort | null {
  const opts = effortOptionsFor(provider, model);
  if (!opts) return null;
  const picked = efforts[model];
  return picked && opts.options.includes(picked) ? picked : opts.fallback;
}

/** What a turn sends as `reasoning`: a level, or nothing. */
export function effortWire(effort: AgentEffort | null): 'low' | 'medium' | 'high' | undefined {
  return effort === 'low' || effort === 'medium' || effort === 'high' ? effort : undefined;
}

/** Providers that need no API key — credits use the platform's, the local
 *  CLI supplies its own auth. */
export function providerNeedsKey(p: AgentProviderConfig['provider']): boolean {
  return p !== 'claude-cli' && p !== 'revyme';
}

export const isAgentConfiguredAtom = atom((get) => {
  // The service is down / not there: nothing can run until it answers.
  if (get(agentServiceReachableAtom) === false) return false;
  // The service answered and does not run credits (none at all in the
  // open-source build; a local one without an OpenRouter key): the chat,
  // which runs on credits only, has nothing to run on.
  const offered = get(agentEnginesAtom);
  return !offered || offered.includes('revyme');
});
