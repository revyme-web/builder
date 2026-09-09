// out-of-flow-order-migrate.ts — one-shot, idempotent load heal for pages
// whose flow siblings were renumbered by an earlier builder reorder: Chrome
// paints an absolute / fixed child of a flex container as if its `order` were
// 0, so every overlay following a sibling with `order ≥ 1` paints BEHIND it —
// how a pinned hero vanished under the next section (2026-09-09). Same rule the
// committer now applies (outOfFlowLayeringForOrders): such overlays get
// `z-index: 1` when they have none. Parse-gated like the other ProjectLoader
// migrations.
import { projectFS } from '@/code/project/project-fs';
import { parseJSXToNodes } from '@/code/parsing/parser';
import { parseJSX } from '@/code/parsing/ast-utils';
import { updateNodeInCode } from '@/code/generation/generator-crud';
import { trace } from '@/shared/debug-trace';

const LAYOUT_DISPLAY = new Set(['flex', 'inline-flex', 'grid', 'inline-grid']);

/** Pure: the (nodeId → order) writes a file needs. Exported for tests. */
export function outOfFlowOrderHealsForCode(code: string): Array<{ nodeId: string; zIndex: number }> {
  const nodes = parseJSXToNodes(code);
  const writes: Array<{ nodeId: string; zIndex: number }> = [];
  for (const parent of nodes.values()) {
    if (!LAYOUT_DISPLAY.has((parent.styles?.display || '').trim())) continue;
    if (!parent.children || parent.children.length < 2) continue;
    let lastFlow: number | undefined;
    for (const id of parent.children) {
      const child = nodes.get(id);
      if (!child) continue;
      const pos = (child.styles?.position || '').trim();
      const oof = pos === 'absolute' || pos === 'fixed';
      const raw = child.styles?.order;
      const n = raw == null || raw === '' ? NaN : parseInt(String(raw), 10);
      if (!oof) { if (Number.isFinite(n)) lastFlow = n; continue; }
      if (lastFlow === undefined || lastFlow <= 0) continue; // browser already paints in DOM order
      const z = String(child.styles?.zIndex ?? '').trim();
      if (z !== '' && z !== 'auto') continue;        // authored layering wins
      writes.push({ nodeId: id, zIndex: 1 });
    }
  }
  return writes;
}

export function migrateOutOfFlowSiblingOrders(): void {
  let migrated = 0;
  for (const path of projectFS.listFiles()) {
    if (!path.endsWith('.tsx') || !(path.startsWith('app/') || path.startsWith('components/'))) continue;
    const src = projectFS.readFile(path);
    if (!src || !src.includes("position: 'absolute'") && !src.includes("position: 'fixed'")) continue;
    let writes: Array<{ nodeId: string; zIndex: number }>;
    try { writes = outOfFlowOrderHealsForCode(src); } catch { continue; }
    if (writes.length === 0) continue;
    let healed = src;
    for (const w of writes) healed = updateNodeInCode(healed, w.nodeId, { zIndex: String(w.zIndex) });
    if (healed === src) continue;
    if (!parseJSX(healed)) { trace.error('out-of-flow-order-migrate:unparseable', { path }); continue; }
    projectFS.writeFile(path, healed);
    migrated++;
    trace.action('out-of-flow-order-migrate:healed', { path, writes });
  }
  if (migrated) trace.action('out-of-flow-order-migrate:done', { migrated });
}
