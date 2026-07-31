// id-mapper.ts — Centralized ID tracking during a single paste operation.
//
// Canvas-poc doesn't have syncId/instanceId/originalId concepts — the only
// thing we need to remap during paste is *clipboard ID → new node ID(s)* so
// the post-paste passes can fix up references that targeted clipboard IDs:
//
//   - Overlay triggers point at an overlay node by data-id
//   - Future: ordered connections (sliders, marquees, motion trails)
//   - Future: navigation connections (carousel dots, prev/next)
//
// The map is array-valued because a single clipboard node can produce N
// new nodes (one for each viewport target, in builder-style cascade). In
// Revyme we usually create exactly 1 new node per clipboard root.

import { trace } from '@/shared/debug-trace';

export class IdMapper {
  private clipboardToNew = new Map<string, string[]>();

  mapClipboardToNew(oldId: string, newId: string): void {
    const existing = this.clipboardToNew.get(oldId) ?? [];
    existing.push(newId);
    this.clipboardToNew.set(oldId, existing);
  }

  getNewIdsForClipboard(oldId: string): string[] {
    return this.clipboardToNew.get(oldId) ?? [];
  }

  hasMapping(oldId: string): boolean {
    return this.clipboardToNew.has(oldId);
  }

  getAllMappings(): Map<string, string[]> {
    return new Map(this.clipboardToNew);
  }

  reset(): void {
    trace.fn('IdMapper.reset', { size: this.clipboardToNew.size });
    this.clipboardToNew.clear();
  }
}

export function createIdMapper(): IdMapper {
  return new IdMapper();
}
