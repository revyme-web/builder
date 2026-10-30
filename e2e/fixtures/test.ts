// The `test` and `expect` every spec under e2e/specs imports.
//
//   import { test, expect } from '../../fixtures/test';
//
// Automatic for every test:
//   - network: the MCP bridge (:8082, /bridge/) and AI endpoints are blocked —
//     a headless tab on the bridge steals it from the user's own editor.
//   - guards: an uncaught page error, or a console.error that isn't allow-listed,
//     fails the test (editor.allowErrors(/…/) for a test that expects one).
//   - oracle: after the test, every .tsx file the test changed is run through
//     the builder's own oracle; a violation that wasn't there after load fails
//     the test, even when its own assertions passed.

import { test as base, expect as baseExpect } from '@playwright/test';
import { Editor } from '../helpers/editor';

const BLOCKED = [/^https?:\/\/(localhost|127\.0\.0\.1):8082\//, /\/bridge\//, /openrouter\.ai/, /api\.anthropic\.com/];

// Known console noise in a healthy editor. Keep this list short and specific.
const CONSOLE_ALLOW = [
  /ERR_BLOCKED_BY_CLIENT/,
  /Download the React DevTools/,
  /\[vite\]/,
  // KNOWN BUG (found by CMP batch C1): entering any component master logs a
  // hooks-order error — src/editor/controls/ControlLabel.tsx returns early
  // (hideLabel / plain) before its useControl()/useAtomValue hooks. Allowed
  // here so every master test isn't red for it; CMP-039 pins the bug itself.
  // msg.text() keeps React's `%s` placeholder and appends the args after it.
  /order of Hooks called by[\s\S]*ControlLabel/,
  /Expected static flag was missing/,
];

export const test = base.extend<{ editor: Editor; _network: void }>({
  viewport: { width: 1600, height: 1000 },

  _network: [async ({ context }, use) => {
    await context.route(url => BLOCKED.some(re => re.test(url.href)), route => route.abort('blockedbyclient'));
    // The dev servers broadcast `full-reload` to every tab whenever a watched
    // repo file changes — e.g. someone saving a spec while the suite runs —
    // and the reload kills the test mid-gesture. Drop those frames; HMR
    // updates for real module edits still pass through.
    await context.routeWebSocket(
      url => url.searchParams.has('token') && ['4333', '5174', '5175'].includes(url.port),
      ws => {
        const server = ws.connectToServer();
        ws.onMessage(m => server.send(m));
        server.onMessage(m => {
          if (typeof m === 'string' && m.includes('"type":"full-reload"')) return;
          ws.send(m);
        });
      },
    );
    await use();
  }, { auto: true }],

  editor: async ({ page }, use, testInfo) => {
    // Editor boot is the slow part of every test (~1,100 modules from the dev
    // server, cold per context); on a loaded machine 60s is not enough.
    testInfo.setTimeout(Math.max(testInfo.timeout, 120_000));
    const errors: string[] = [];
    const editor = new Editor(page, errors);
    page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
    page.on('console', msg => {
      if (msg.type() !== 'error') return;
      const text = msg.text();
      const where = msg.location()?.url ?? '';
      if (CONSOLE_ALLOW.some(re => re.test(text)) || BLOCKED.some(re => re.test(where)) || editor.isAllowed(text)) return;
      errors.push(`console.error: ${text}${where ? ` (${where})` : ''}`);
    });

    await use(editor);

    // Teardown checks only judge a test that otherwise ran to completion.
    if (testInfo.status !== 'passed' && testInfo.status !== testInfo.expectedStatus) return;
    if (errors.length) {
      await testInfo.attach('editor-errors', { body: errors.join('\n'), contentType: 'text/plain' });
      throw new Error(`The editor logged ${errors.length} error(s):\n${errors.slice(0, 5).join('\n')}`);
    }
    if (editor.loaded && !page.isClosed()) {
      const added = await editor.newOracleViolations().catch(() => []);
      if (added.length) {
        await testInfo.attach('oracle', { body: JSON.stringify(added, null, 2), contentType: 'application/json' });
        throw new Error(
          `The builder's oracle rejects code this test left behind:\n` +
          added.slice(0, 5).map(v => `  ${v.path} · ${v.code} (tier ${v.tier})${v.elementId ? ` on ${v.elementId}` : ''}: ${v.message.split('\n')[0]}`).join('\n'),
        );
      }
    }
  },
});

// ─── Matchers ─────────────────────────────────────────────────────────
//
// All poll (a commit can land in two flushes ~30ms apart) and honour `.not`.

type PathOpt = { path?: string; timeout?: number };

async function pollFor(want: boolean, timeout: number, check: () => Promise<boolean>): Promise<boolean> {
  const deadline = Date.now() + timeout;
  let ok = await check();
  while (ok !== want && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 100));
    ok = await check();
  }
  return ok;
}

const show = (v: unknown) => JSON.stringify(v);

export const expect = baseExpect.extend({
  /** The parent's data-id children appear in exactly this order in the source. */
  async toHaveJsxOrder(editor: Editor, parentId: string, ids: string[], opts: PathOpt = {}) {
    let actual: string[] = [];
    const pass = await pollFor(!this.isNot, opts.timeout ?? 5_000, async () => {
      actual = await editor.childIds(parentId, opts.path);
      return show(actual) === show(ids);
    });
    return {
      pass, name: 'toHaveJsxOrder', expected: ids, actual,
      message: () => `children of "${parentId}" in source${opts.path ? ` (${opts.path})` : ''}\nExpected: ${this.isNot ? 'not ' : ''}${show(ids)}\nReceived: ${show(actual)}`,
    };
  },

  /** The node's inline style in the source has this value (null = absent). */
  async toHaveStyle(editor: Editor, id: string, prop: string, value: string | null, opts: PathOpt = {}) {
    let actual: string | null = null;
    const pass = await pollFor(!this.isNot, opts.timeout ?? 5_000, async () => {
      actual = (await editor.style(id, opts.path))[prop] ?? null;
      return actual === value;
    });
    return {
      pass, name: 'toHaveStyle', expected: value, actual,
      message: () => `inline style ${prop} of "${id}" in source\nExpected: ${this.isNot ? 'not ' : ''}${show(value)}\nReceived: ${show(actual)}`,
    };
  },

  /** The `@media (max-width: <width>px)` band sets this value for the node
   *  (null = no such declaration). `important` checks the !important flag too. */
  async toHaveBandStyle(editor: Editor, width: number, id: string, prop: string, value: string | null, opts: PathOpt & { important?: boolean } = {}) {
    let actual: { value: string; important: boolean } | null = null;
    const pass = await pollFor(!this.isNot, opts.timeout ?? 5_000, async () => {
      actual = await editor.bandStyle(width, id, prop, opts.path);
      if (value === null) return actual === null;
      return !!actual && actual.value === value && (opts.important === undefined || actual.important === opts.important);
    });
    return {
      pass, name: 'toHaveBandStyle', expected: value, actual,
      message: () => `${prop} for "${id}" in the ${width}px band\nExpected: ${this.isNot ? 'not ' : ''}${show(value)}${opts.important ? ' !important' : ''}\nReceived: ${show(actual)}`,
    };
  },

  /** One undo restores the file byte-for-byte to `before`, and one redo
   *  re-applies the change exactly. */
  async toUndoInOneStep(editor: Editor, before: string, opts: PathOpt = {}) {
    const path = opts.path ?? (await editor.activeFile());
    // Take "after" only once the file has stopped changing for longer than
    // history's 300ms grouping window: on a loaded machine a panel write can
    // land in a second flush after the first read, and undoing between the
    // two compares against a half-applied state.
    await editor.settled();
    let after = await editor.code(path);
    for (let stableSince = Date.now(), deadline = Date.now() + 5_000; Date.now() < deadline;) {
      await new Promise(r => setTimeout(r, 100));
      const now = await editor.code(path);
      if (now !== after) { after = now; stableSince = Date.now(); }
      else if (Date.now() - stableSince >= 400) break;
    }
    if (after === before) {
      return { pass: false, name: 'toUndoInOneStep', message: () => `nothing to undo: ${path} is unchanged since "before"` };
    }
    await editor.undo();
    let undone = '';
    const restored = await pollFor(true, opts.timeout ?? 5_000, async () => (undone = await editor.code(path)) === before);
    if (!restored) {
      return {
        pass: false, name: 'toUndoInOneStep', expected: before, actual: undone,
        message: () => `one undo did not restore ${path} byte-for-byte`,
      };
    }
    await editor.redo();
    let redone = '';
    const reapplied = await pollFor(true, opts.timeout ?? 5_000, async () => (redone = await editor.code(path)) === after);
    return {
      pass: reapplied, name: 'toUndoInOneStep', expected: after, actual: redone,
      message: () => reapplied ? `undo/redo round-tripped ${path}` : `one redo did not re-apply the change to ${path}`,
    };
  },

  /** No data-id appears twice in the file. */
  async toHaveNoDuplicateIds(editor: Editor, opts: { path?: string } = {}) {
    const dups = await editor.duplicateIds(opts.path);
    return {
      pass: dups.length === 0, name: 'toHaveNoDuplicateIds', expected: [], actual: dups,
      message: () => `duplicate data-ids: ${show(dups)}`,
    };
  },

  /** No new oracle violation in any changed file (the fixture also checks
   *  this at teardown; call it mid-test to pin the moment it broke). */
  async toPassOracle(editor: Editor) {
    const added = await editor.newOracleViolations();
    return {
      pass: added.length === 0, name: 'toPassOracle', expected: [], actual: added,
      message: () => `oracle violations: ${added.map(v => `${v.path} ${v.code}${v.elementId ? `@${v.elementId}` : ''}`).join(', ')}`,
    };
  },
});

export { TILES_VIEWPORT } from '../helpers/editor';
export { project, TILE, TILES, pageModule, canvasHeader, type ProjectData } from './project';
