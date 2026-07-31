// entry-detector.ts — Unified grace-period entry detection for drag strategies.
//
// Replaces duplicated entry state machines in:
//   - CanvasDragStrategy (single-select fields + NodeEntryState map)
//   - AbsoluteInFrameStrategy (sibling entry fields)
//
// Each node tracks a candidate parent. After N consecutive frames with the same
// candidate, entry is "confirmed". The strategy decides what to do after confirmation
// (reparent, strategy switch, show drop line, etc.).

import { trace } from '@/shared/debug-trace';

export interface EntryCandidate {
  id: string;
  el: HTMLElement;
}

export interface EntryState {
  /** Current candidate being evaluated */
  candidateId: string | null;
  candidateEl: HTMLElement | null;
  /** Consecutive frames with the same candidate */
  graceFrames: number;
  /** True once grace threshold is met */
  confirmed: boolean;
  /** The confirmed target (set once on confirmation) */
  confirmedId: string | null;
  confirmedEl: HTMLElement | null;
}

function createDefaultState(): EntryState {
  return {
    candidateId: null, candidateEl: null,
    graceFrames: 0, confirmed: false,
    confirmedId: null, confirmedEl: null,
  };
}

/**
 * Tracks entry detection for one or more nodes using a grace-period hysteresis.
 * Call `update()` each frame with the best candidate for each node.
 * Returns true when entry is NEWLY confirmed (only on the confirmation frame).
 */
export class EntryDetector {
  private states: Map<string, EntryState> = new Map();
  private threshold: number;

  constructor(nodeIds: string[], threshold: number) {
    this.threshold = threshold;
    for (const id of nodeIds) {
      this.states.set(id, createDefaultState());
    }
  }

  /**
   * Update entry detection for a node.
   * @returns true if entry was NEWLY confirmed this frame (false on subsequent frames)
   */
  update(nodeId: string, candidate: EntryCandidate | null): boolean {
    const state = this.states.get(nodeId);
    if (!state) return false;

    const candidateId = candidate?.id ?? null;

    if (candidateId !== state.candidateId) {
      // New candidate (or cleared) — reset grace counter
      state.candidateId = candidateId;
      state.candidateEl = candidate?.el ?? null;
      state.graceFrames = candidateId ? 1 : 0;
    } else if (candidateId) {
      state.graceFrames++;
    }

    // Check threshold (works on BOTH first detection and subsequent frames)
    if (candidateId && state.graceFrames > 0) {
      if (!state.confirmed && state.graceFrames >= this.threshold) {
        state.confirmed = true;
        state.confirmedId = candidateId;
        state.confirmedEl = candidate?.el ?? null;
        trace.action('entry-detector:confirmed', {
          nodeId, candidateId, graceFrames: state.graceFrames, threshold: this.threshold,
        });
        return true; // newly confirmed this frame
      }
    }

    return false;
  }

  /** Get the current state for a node */
  getState(nodeId: string): EntryState | undefined {
    return this.states.get(nodeId);
  }

  /** Check if any node has confirmed entry */
  hasConfirmed(): boolean {
    for (const state of this.states.values()) {
      if (state.confirmed) return true;
    }
    return false;
  }

  /** Clear confirmation for a specific node (e.g., element exited the parent) */
  clearNode(nodeId: string): void {
    const state = this.states.get(nodeId);
    if (state) Object.assign(state, createDefaultState());
  }

  /** Reset all nodes */
  reset(): void {
    for (const [id] of this.states) {
      this.states.set(id, createDefaultState());
    }
  }
}
