// project-fs.branch-roundtrip.test.ts — branches survive save → reload exactly.
//
// Branches are saved as deltas (project-fs FileDelta) instead of two full
// copies each. The in-memory model is unchanged, so the one thing the new
// encoding can break is the round trip. This drives hundreds of random
// branch sessions through the REAL API — create (from main and from other
// branches), switch, edit, add, delete, edit main underneath, rebase, delete
// branches — and after every save reboots a fresh FS exactly like
// ProjectLoader (loadSnapshot + hydrateBranches with the saved main), then
// keeps editing in the rebooted FS. Every branch's files, merge base and
// metadata must come back identical, cycle after cycle.

import { describe, expect, it } from 'vitest';
import { InMemoryProjectFS, MAIN_BRANCH_ID } from './project-fs';

function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PATHS = [
  'app/(site)/page.client.tsx', 'app/(site)/about/page.client.tsx', 'app/(site)/track-record/[slug]/page.tsx',
  'app/(site)/zh-CN/track-record/page.tsx', 'components/Nav.tsx', 'components/Footer.tsx', 'components/Card.tsx',
  'cms/track-record.json', 'i18n/zh-CN.json', 'app/globals-extra.css', '_meta/page-camera.json', '_meta/chats.json',
];

/** Boot a saved envelope the way ProjectLoader does. */
function boot(saved: string): InMemoryProjectFS {
  const data = JSON.parse(saved);
  const fs = new InMemoryProjectFS(new Map());
  fs.loadSnapshot(new Map(Object.entries(data.files as Record<string, string>)));
  if (data.branches) fs.hydrateBranches(data.branches, data.activeBranchId, data.files);
  return fs;
}

function snapshot(fs: InMemoryProjectFS) {
  const branches: Record<string, unknown> = {};
  for (const b of fs.listBranches()) {
    branches[b.id] = {
      status: b.status, parentId: b.parentId, order: b.order, createdAt: b.createdAt, lastEditedAt: b.lastEditedAt,
      files: Object.fromEntries([...(fs.readBranchFiles(b.id) ?? new Map())].sort()),
      base: b.id === MAIN_BRANCH_ID ? null : Object.fromEntries([...(fs.readBranchBase(b.id) ?? new Map())].sort()),
    };
  }
  return { active: fs.getActiveBranchId(), branches };
}

function randomSession(seed: number, steps: number, saves: number[]): void {
  const rnd = prng(seed);
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
  // Empty content only for non-page files: loading a project deliberately
  // heals an EMPTY page file into a blank starter page (the empty-page guard
  // in loadSnapshot — main only, unrelated to branches).
  const content = (path: string) => (rnd() < 0.08 && !path.endsWith('.tsx') ? '' : `v${Math.floor(rnd() * 1e6)}:${'x'.repeat(Math.floor(rnd() * 40))}`);
  let fs = new InMemoryProjectFS(new Map(PATHS.slice(0, 8).map((p) => [p, `init:${p}`])));
  let n = 0;
  for (let step = 0; step < steps; step++) {
    const ids = fs.listBranches().map((b) => b.id);
    const nonMain = ids.filter((id) => id !== MAIN_BRANCH_ID);
    const r = rnd();
    if (r < 0.32) { const p = pick(PATHS); fs.writeFile(p, content(p)); }
    else if (r < 0.42) fs.deleteFile(pick(PATHS));
    else if (r < 0.52) fs.createBranch(`b-${seed}-${n++}`, rnd() < 0.3 ? { from: fs.readBranchFiles(MAIN_BRANCH_ID)! } : {});
    else if (r < 0.66) fs.switchBranch(pick(ids));
    else if (r < 0.74 && nonMain.length) { const p = pick(PATHS); fs.writeBranchFile(pick(nonMain), p, content(p)); }
    else if (r < 0.78 && nonMain.length) fs.deleteBranchFile(pick(nonMain), pick(PATHS));
    else if (r < 0.84) {
      // Edit MAIN underneath the branches (their bases must not follow).
      const back = fs.getActiveBranchId();
      fs.switchBranch(MAIN_BRANCH_ID);
      const p = pick(PATHS);
      fs.writeFile(p, content(p));
      if (rnd() < 0.3) fs.deleteFile(pick(PATHS));
      fs.switchBranch(back);
    } else if (r < 0.88 && nonMain.length) fs.rebaseBranch(pick(nonMain), fs.readBranchFiles(MAIN_BRANCH_ID)!);
    else if (r < 0.91 && nonMain.length) {
      const id = pick(nonMain);
      if (fs.getActiveBranchId() === id) fs.switchBranch(MAIN_BRANCH_ID);
      fs.deleteBranch(id);
    }

    if (saves.includes(step)) {
      const before = snapshot(fs);
      const saved = JSON.stringify(fs.toEnvelope());
      const rebooted = boot(saved);
      expect(snapshot(rebooted), `seed ${seed}, step ${step}`).toEqual(before);
      // Keep working in the REBOOTED editor, as after a real reload.
      fs = rebooted;
    }
  }
}

describe('branches round-trip through save → reload (random sessions)', () => {
  it('300 random sessions, 4 save/reload cycles each, identical every time', () => {
    for (let seed = 1; seed <= 300; seed++) randomSession(seed, 60, [14, 29, 44, 59]);
  });

  it('a legacy (full-copy) save loads, then re-saves as deltas without losing anything', () => {
    const fs = new InMemoryProjectFS(new Map(PATHS.slice(0, 6).map((p) => [p, `init:${p}`])));
    fs.createBranch('legacy');
    fs.switchBranch('legacy');
    fs.writeFile('components/Nav.tsx', 'branch-nav');
    fs.deleteFile('components/Footer.tsx');
    const env = fs.toEnvelope();
    // Rewrite the branch record into the OLD on-disk shape.
    const legacy = JSON.parse(JSON.stringify(env));
    legacy.branches.legacy.files = Object.fromEntries(fs.readBranchFiles('legacy')!);
    legacy.branches.legacy.baseSnapshot = Object.fromEntries(fs.readBranchBase('legacy')!);
    delete legacy.branches.legacy.filesDelta;
    delete legacy.branches.legacy.baseDelta;
    const fromLegacy = boot(JSON.stringify(legacy));
    expect(snapshot(fromLegacy)).toEqual(snapshot(fs));
    const resaved = boot(JSON.stringify(fromLegacy.toEnvelope()));
    expect(snapshot(resaved)).toEqual(snapshot(fs));
  });
});
