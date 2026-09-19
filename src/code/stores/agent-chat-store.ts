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

/** One run of text or one group of tool calls, in the order they happened. */
export type AgentBlock =
  | { kind: 'text'; text: string }
  | { kind: 'tools'; tools: AgentToolEntry[] };

/** Files the last finished run changed, with their per-file id diffs — drives
 *  the Changes card's layer counts. */
export interface AgentChangedFile {
  path: string;
  addedIds?: string[];
  removedIds?: string[];
  changedIds?: string[];
}

export interface AgentTurn {
  role: 'user' | 'assistant';
  text: string;
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
}

export interface AgentProviderConfig {
  /** `claude-cli` runs the turn on the local Claude Code SUBSCRIPTION via the
   *  `claude` binary — no key, no per-token cost. Every other provider is
   *  BYOK: the key is sent with the request and never stored server-side. */
  provider: 'claude-cli' | 'anthropic' | 'openai' | 'google' | 'openrouter';
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
/** Reasoning streaming in for the CURRENT reply. */
export const agentReasoningAtom = atom<string>('');
export const agentChangedFilesAtom = atom<AgentChangedFile[]>([]);

export const DEFAULT_MODELS: Record<AgentProviderConfig['provider'], string> = {
  'claude-cli': '',                 // whatever the CLI is configured to use
  anthropic: 'claude-sonnet-5',
  openai: 'gpt-5',
  google: 'gemini-2.5-pro',
  openrouter: 'anthropic/claude-sonnet-5',
};

/** BYOK config. Per user, not per project — a key is an account credential. */
export const agentConfigAtom = atomWithStorage<AgentProviderConfig>('revyme.agent.config', {
  // Default to the local subscription: it works with no setup at all, where
  // every other provider needs a key pasted in first.
  provider: 'claude-cli',
  model: '',
  apiKey: '',
});

/** Providers that need no API key — the local CLI supplies its own auth. */
export function providerNeedsKey(p: AgentProviderConfig['provider']): boolean {
  return p !== 'claude-cli';
}

export const isAgentConfiguredAtom = atom((get) => {
  const c = get(agentConfigAtom);
  return !providerNeedsKey(c.provider) || c.apiKey.trim().length > 0;
});
