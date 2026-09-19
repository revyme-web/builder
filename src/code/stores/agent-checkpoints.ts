// agent-checkpoints.ts — sealed turn checkpoints, leaf module.
//
// `agentCheckpointsAtom` (runKey → sealed TurnCheckpoint + per-file id
// deltas) lived in agent-store.ts, but the read tools need it too
// (`turn_diff`, P7) and agent-store → tools/index → read is a hard cycle
// (checkpoint-seal.ts documents why the edge must stay one-way). This leaf
// owns the atom + its type; agent-store re-exports both, so every existing
// importer (store, checkpoint-seal, ChangesCard, MessageList) keeps working
// unchanged. Only jotai + type-only imports here — never a runtime edge.

import { atom } from 'jotai';
import type { TurnFileChange } from '@/ai/agent';

/** Full-file snapshots sealed by one run's TurnCheckpoint — the revert/redo
 *  payload for `agentCheckpointsAtom`. `changes` carries the per-file id
 *  deltas of the same run, so the UI can summarise what the agent touched
 *  without re-diffing the snapshots.
 *  `runId` (`conversationEpoch-seq`, D-T1) identifies the run across
 *  conversations (the `run-N` key resets per conversation). `aborted` marks a
 *  PARTIAL seal (abort/timeout, D-T2) — the UI must say so. `branchId` is
 *  RESERVED for Porte 8 (garde-fou §Ib-7): set nowhere in phase 1; a future
 *  writer that changes it must refuse instead of silently rebinding. */
export interface AgentCheckpoint {
  before: Map<string, string>;
  after: Map<string, string>;
  changes: TurnFileChange[];
  runId?: string;
  aborted?: boolean;
  branchId?: string;
}

export const agentCheckpointsAtom = atom<Map<string, AgentCheckpoint>>(new Map());
