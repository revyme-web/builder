// Editor — the page object every new spec drives.
//
// Extends the existing EditorPage (drag helpers with engagement guards,
// replica-tile locators, band readers) with: seeding from a ProjectData,
// `settled()`, Babel-backed source reads, undo/redo, and the bookkeeping the
// fixtures use for the oracle and error guards.

import type { Page } from '@playwright/test';
import { EditorPage } from '../../src/canvas/drag/e2e/helpers/editor-page';
import type { ProjectData } from '../fixtures/project';
import { parseSource, bandDecl, duplicateIds, type ParsedSource } from './code';

export interface OracleViolation { code: string; tier: 1 | 2 | 3; message: string; elementId?: string }

/** A multi-tile seed needs the wide window: at 1600px a replica tile can't be
 *  hit at all — clicks select nothing and drags silently no-op. */
export const TILES_VIEWPORT = { width: 1720, height: 1000 };

export class Editor extends EditorPage {
  /** File contents right after load settled (migrations/heals included). */
  private baseline: Record<string, string> | null = null;
  private baselineViolations = new Map<string, Set<string>>();
  private readonly allowed: RegExp[] = [];

  constructor(page: Page, readonly errors: string[] = []) {
    super(page);
  }

  // ─── Setup ─────────────────────────────────────────────────────────

  /** Seed the project, open the editor, wait for the canvas and settle.
   *  `fit` zooms to fit (Shift+1) — required before touching replica tiles,
   *  which boot off-camera and are culled (no box at all). */
  async load(seed: ProjectData, opts: { fit?: boolean; path?: string } = {}): Promise<void> {
    const page = this.page();
    await page.addInitScript((data) => {
      // Once per tab: a reload must find what the editor SAVED, not the seed.
      if (sessionStorage.getItem('__e2e_seeded')) return;
      sessionStorage.setItem('__e2e_seeded', '1');
      localStorage.setItem('revyme-project-local', JSON.stringify(data));
      // A fresh profile mounts the onboarding spotlight, which eats every pointer event.
      localStorage.setItem('revyme-onboarding-completed', 'true');
    }, seed);
    await page.goto(opts.path ?? '/');
    await this.waitForCanvas();
    await this.settled();
    if (opts.fit) await this.fitCamera();
    this.baseline = await this.snapshotFiles();
    for (const path of Object.keys(this.baseline)) {
      if (!path.endsWith('.tsx')) continue;
      this.baselineViolations.set(path, new Set((await this.oracle(path)).map(violationKey)));
    }
  }

  async waitForCanvas(): Promise<void> {
    const sandbox = this.sandbox();
    await sandbox.locator('[data-content-root]').first().waitFor({ state: 'attached', timeout: 60_000 });
    await sandbox.locator('[data-viewport]').first().waitFor({ state: 'attached', timeout: 30_000 });
  }

  /** Mutation queue idle for 3 frames + 2 paint frames. Use instead of sleeps. */
  async settled(): Promise<void> {
    await this.page().evaluate(() => (window as any).__e2e.settled());
  }

  /** Accept console errors matching this pattern for the rest of the test. */
  allowErrors(re: RegExp): void {
    this.allowed.push(re);
  }

  isAllowed(text: string): boolean {
    return this.allowed.some(re => re.test(text));
  }

  // ─── Source reads ──────────────────────────────────────────────────

  async activeFile(): Promise<string> {
    return this.page().evaluate(() => (window as any).__e2e.activeFile());
  }

  /** A file's current contents (default: the file open in the editor). */
  async code(path?: string): Promise<string> {
    const p = path ?? (await this.activeFile());
    return (await this.readFile(p)) ?? '';
  }

  async source(path?: string): Promise<ParsedSource> {
    return parseSource(await this.code(path));
  }

  /** Nearest data-id children of `parentId`, in source order. */
  async childIds(parentId: string, path?: string): Promise<string[]> {
    return (await this.source(path)).byId.get(parentId)?.childIds ?? [];
  }

  async exists(id: string, path?: string): Promise<boolean> {
    return (await this.source(path)).byId.has(id);
  }

  async parentOf(id: string, path?: string): Promise<string | null> {
    return (await this.source(path)).byId.get(id)?.parentId ?? null;
  }

  /** Inline style object of a node in the source ({} if the node is missing). */
  async style(id: string, path?: string): Promise<Record<string, string>> {
    return (await this.source(path)).byId.get(id)?.style ?? {};
  }

  async attr(id: string, name: string, path?: string): Promise<string | null> {
    return (await this.source(path)).byId.get(id)?.attrs[name] ?? null;
  }

  /** A declaration in the `@media (max-width: <width>px)` band for `id`. */
  async bandStyle(width: number, id: string, prop: string, path?: string) {
    return bandDecl(await this.code(path), width, id, prop);
  }

  async duplicateIds(path?: string): Promise<string[]> {
    return duplicateIds(await this.source(path));
  }

  async listFiles(): Promise<string[]> {
    return this.page().evaluate(() => (window as any).__e2e.listFiles());
  }

  async snapshotFiles(): Promise<Record<string, string>> {
    return this.page().evaluate(() => {
      const e2e = (window as any).__e2e;
      const out: Record<string, string> = {};
      for (const p of e2e.listFiles() as string[]) out[p] = e2e.readFile(p) ?? '';
      return out;
    });
  }

  /** Files whose contents differ from right after load (added ones included). */
  async changedFiles(): Promise<string[]> {
    if (!this.baseline) return [];
    const now = await this.snapshotFiles();
    return Object.keys(now).filter(p => now[p] !== this.baseline![p]);
  }

  // ─── Oracle ────────────────────────────────────────────────────────

  async oracle(path: string): Promise<OracleViolation[]> {
    return this.page().evaluate(p => (window as any).__e2e.checkFile(p), path);
  }

  /** Oracle violations in changed files that were not there after load. */
  async newOracleViolations(): Promise<Array<OracleViolation & { path: string }>> {
    if (!this.baseline) return [];
    const out: Array<OracleViolation & { path: string }> = [];
    for (const path of await this.changedFiles()) {
      if (!path.endsWith('.tsx')) continue;
      const before = this.baselineViolations.get(path) ?? new Set<string>();
      for (const v of await this.oracle(path)) if (!before.has(violationKey(v))) out.push({ ...v, path });
    }
    return out;
  }

  get loaded(): boolean {
    return this.baseline !== null;
  }

  // ─── History ───────────────────────────────────────────────────────

  /** One Cmd/Ctrl+Z on the canvas (focus is taken out of any panel input first). */
  async undo(): Promise<void> {
    await this.blur();
    await this.page().keyboard.press('ControlOrMeta+z');
    await this.settled();
  }

  async redo(): Promise<void> {
    await this.blur();
    await this.page().keyboard.press('ControlOrMeta+Shift+z');
    await this.settled();
  }

  async blur(): Promise<void> {
    await this.page().evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
  }

  // ─── Pointer conveniences ──────────────────────────────────────────

  /** Real click on a node's center (on a tile when `vpId` is given). */
  async click(id: string, opts: { vpId?: string; modifiers?: Array<'Shift' | 'Alt' | 'ControlOrMeta'> } = {}): Promise<void> {
    const box = opts.vpId ? await this.nodeBoxIn(opts.vpId, id) : await this.nodeBox(id);
    await this.page().mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (const m of opts.modifiers ?? []) await this.page().keyboard.down(m);
    await this.page().mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    for (const m of opts.modifiers ?? []) await this.page().keyboard.up(m);
    await this.settled();
  }

  async selection(): Promise<string[]> {
    return this.page().evaluate(() => (window as any).__e2e.selection());
  }

  /** Screen point at a fraction of a node's box: `at('b', 0.5, 0.9)` = near its bottom edge. */
  async at(id: string, fx: number, fy: number, vpId?: string): Promise<{ x: number; y: number }> {
    const b = vpId ? await this.nodeBoxIn(vpId, id) : await this.nodeBox(id);
    return { x: b.x + b.width * fx, y: b.y + b.height * fy };
  }
}

function violationKey(v: OracleViolation): string {
  return `${v.code}|${v.elementId ?? ''}`;
}
