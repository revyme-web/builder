// cms-image-size-migrate.ts — one-shot, idempotent load heal: every node with a
// CMS image binding (`backgroundImage: \`url(${item.x})\``) but no
// backgroundSize of its own gets the cover/center seed the bind should have
// written. Files bound before 2026-09-09 could miss it: the bind's presence
// check was a WHOLE-FILE regex, so any other node's backgroundSize suppressed
// the seed and the bound image rendered at its natural size ("huge,
// stretched") while the Fill panel showed "Cover". Same shape as the other
// ProjectLoader migrations (patched in place, parse-gated).
import { projectFS } from '@/code/project/project-fs';
import { parseJSX } from '@/code/parsing/ast-utils';
import { healBoundImageSizing } from './cms-gen';
import { trace } from '@/shared/debug-trace';

export function migrateBoundImageSizing(): void {
  let migrated = 0;
  for (const path of projectFS.listFiles()) {
    if (!path.endsWith('.tsx') || !(path.startsWith('app/') || path.startsWith('components/'))) continue;
    const src = projectFS.readFile(path);
    if (!src || !src.includes('`url(${')) continue;
    const healed = healBoundImageSizing(src);
    if (healed === src) continue;
    if (!parseJSX(healed)) { trace.error('cms-image-size-migrate:unparseable', { path }); continue; }
    projectFS.writeFile(path, healed);
    migrated++;
    trace.action('cms-image-size-migrate:healed', { path });
  }
  if (migrated) trace.action('cms-image-size-migrate:done', { migrated });
}
