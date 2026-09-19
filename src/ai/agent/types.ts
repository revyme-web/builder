// src/ai/agent/types.ts
//
// Frozen contracts for the conversational agent module (`src/ai/agent/`).
// Every implementation (providers, tools, runtime) conforms to these types.
// These are the integration boundary — changing them requires Tech Lead approval.
//
// reasoningEffort added 2026-08-12 (tech lead approved).
// reasoning_delta + reasoningWire added 2026-08-13 (tech lead approved).
//
// Design refs: artifacts/tech-plan (§ Interfaces), artifacts/epic-0-spike (§ S1/S2/S3).
// Conceptual reference: Ycode agent (lib/agent/) — adapted, never copied.

import type { ZodRawShape } from 'zod';

/* ─────────────────────────── Provider layer ─────────────────────────── */

export type AgentProviderId = 'anthropic' | 'openai' | 'google' | 'openrouter' | 'custom';

/**
 * A user-defined OpenAI-compatible provider (the "custom" family — z.ai,
 * opengo, openrouter-custom, …). `id` is a store-generated string and is NOT
 * an AgentProviderId member; the instance created at resolution time carries
 * the generic id 'custom' (identity lives in this config, not on the
 * provider). Variables are stored separately per provider id (store-level),
 * so this config intentionally carries none.
 */
export interface CustomProvider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
}

export interface AgentUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export type ProviderEvent =
  | { type: 'text_delta'; text: string }
  /** Réflexion interne d'un modèle de raisonnement (champ `reasoning_content`
   *  des streams OpenAI-compatibles). Streamée SÉPARÉMENT du contenu
   *  (reasoning_delta), jamais comme text_delta : le runtime la relaie en
   *  event `reasoning` dédié et ne la persiste pas dans l'historique. */
  | { type: 'reasoning_delta'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'message_stop'; stopReason: string | null; usage?: AgentUsage };

/** Tool descriptor already converted to a provider-ready JSON Schema. */
export interface ProviderTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ThinkingConfig {
  enabled: boolean;
  budgetTokens?: number;
}

export interface ProviderStreamOptions {
  model: string;
  system: string;
  messages: AgentMessage[];
  tools?: ProviderTool[];
  signal: AbortSignal;
  thinking?: ThinkingConfig;
  /** Persisted reasoning effort for the model ('' or 'none' = off). */
  reasoningEffort?: string;
  /** Payload RÉEL du body de requête pour la VARIANTE de raisonnement choisie
   *  (`reasoningEffort`), résolu par le provider bridge depuis les variants du
   *  CLI (ex. `{ reasoningEffort: 'high' }`, `{ thinkingConfig: … }`,
   *  `{ thinking: { type: 'adaptive' } }`). Quand il est présent, les
   *  providers openai-compatible le répandent VERBATIM dans le body à la
   *  place du champ générique `reasoning_effort` — le dialecte wire d'un
   *  modèle ne se devine pas depuis la seule clé de variante. */
  reasoningWire?: Record<string, unknown>;
}

export interface AgentProvider {
  readonly id: AgentProviderId;
  streamMessage(options: ProviderStreamOptions): AsyncIterable<ProviderEvent>;
}

/* ─────────────────────── Conversation messages ──────────────────────── */

export type AgentRole = 'user' | 'assistant';

export type AgentContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean }
  /** Pasted/uploaded image attachment, as a base64 data URL from the Composer
   *  (ex. 'data:image/png;base64,...'). User-role messages only. */
  | { type: 'image'; dataUrl: string };

export interface AgentMessage {
  role: AgentRole;
  content: AgentContentBlock[];
}

/* ──────────────────────────── Tool layer ────────────────────────────── */

export type ToolCategory = 'read' | 'semantic' | 'wholefile' | 'meta' | 'cms';

export interface AgentToolResult {
  content: ({ type: 'text'; text: string } | { type: 'image'; dataUrl: string; alt?: string })[];
  isError?: boolean;
}

/**
 * Per-turn execution context handed to every tool.
 * `ensureCheckpoint()` is idempotent within a turn: the first mutating tool
 * snapshots ProjectFS + arms history coalescing; later calls are no-ops.
 * (See artifacts/epic-0-spike § S2.)
 */
export interface ToolContext {
  ensureCheckpoint(): void;
  /** Active viewport width in px (desktop/tablet/mobile resolved) for responsive tools. */
  vpWidth: number;
  signal: AbortSignal;
  /**
   * P8 workspace binding (mutable, shared across the turn's calls).
   * Absent = human active context (legacy: every helper below degrades to
   * the exact pre-P8 global reads). Present = the run works on
   * (branchId, filePath): file/node/queue reads route there, the canvas
   * (human truth) is untouched, and set_page mutates this binding instead
   * of the global atoms (virtualized navigation).
   */
  workspace?: { branchId: string; filePath: string };
}

export interface AgentTool {
  name: string;
  description: string;
  /** Zod raw shape; validated at execution time against the full schema. */
  inputSchema: ZodRawShape;
  category: ToolCategory;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<AgentToolResult>;
}

/* ──────────────────────────── Runtime ───────────────────────────────── */

export interface TurnFileChange {
  path: string;
  addedIds: string[];
  removedIds: string[];
  changedIds: string[];
}

/**
 * Turn-scoped ProjectFS checkpoint. The first mutating tool of a run calls
 * `begin()` (via toolCtx.ensureCheckpoint); the runtime calls `end()` when
 * the turn finishes and gets per-file id diffs for the run. One run = one
 * editor undo entry.
 */
export interface TurnCheckpointHandle {
  begin(): void;
  end(): TurnFileChange[];
}

export type RuntimeEvent =
  | { type: 'text'; text: string }
  /** Réflexion interne streamée (reasoning_delta du provider). Relaissée pour
   *  l'UI (atom séparé), jamais fusionnée au texte de l'assistant ni à
   *  l'historique renvoyé au modèle. */
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: Record<string, unknown>; label: string }
  | { type: 'tool_result'; id: string; ok: boolean; content: string }
  | { type: 'usage'; usage: AgentUsage }
  | { type: 'turn_changes'; changes: TurnFileChange[] }
  | { type: 'done' }
  | { type: 'error'; message: string };

export interface AgentReference {
  kind: 'page' | 'component' | 'node' | 'collection';
  id: string;
  label: string;
}

export interface AgentEditorContext {
  activeFilePath: string | null;
  selectedNodeIds: string[];
  activeViewportWidth: number;
  mentions: AgentReference[];
  /** Pasted/uploaded image attachments as base64 data URLs. */
  images: string[];
  /**
   * P8 (vi): branch the run works on. Absent = human active context
   * (legacy). When bound, the prompt shows this file (not the human's),
   * selection defaults to empty (never the human's), and tools route
   * through ToolContext.workspace.
   */
  branch?: { branchId: string; filePath?: string };
}

export interface RunAgentOptions {
  provider: AgentProvider;
  model: string;
  system: string;
  messages: AgentMessage[];
  tools: AgentTool[];
  /** Active viewport width in px for responsive tools. */
  vpWidth: number;
  signal: AbortSignal;
  checkpoint?: TurnCheckpointHandle;
  /** Persisted reasoning effort for the model ('' or 'none' = off). */
  reasoningEffort?: string;
  /**
   * P2 — wall-clock budget for the whole run (tool loop included), in ms.
   * 0/undefined = no deadline (legacy behavior for tests/callers that manage
   * their own timing). When set, the run aborts cleanly on expiry: the
   * provider stream is cancelled via a derived AbortController, a clear
   * `error` event is yielded (never a fake `done`), and the checkpoint is
   * always flushed — the caller's gate release runs in ITS finally (nothing
   * here can leak a run). No zombie: every exit path still yields a
   * terminal event after the deadline.
   */
  timeoutMs?: number;
}
