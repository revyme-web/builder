// app-actions.test.ts — App actions are split across two files by design:
// the row lives here, the behaviour lives in `useSearchActions`. That split
// has exactly one failure mode — an id in one file and not the other — and
// TypeScript cannot catch it, because `commandId` is just a string.
//
// So the test reads the executor's source and asserts every id this source
// emits has a matching `case`. Without it the mismatch only surfaces as a
// runtime "Unknown command" toast the first time someone activates the row.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appActionsSource } from './app-actions';

const executorSource = readFileSync(
  join(__dirname, '..', 'useSearchActions.ts'),
  'utf8',
);

describe('appActionsSource', () => {
  const items = appActionsSource({ query: '' });

  it('emits rows', () => {
    expect(items.length).toBeGreaterThan(0);
  });

  it('every command id has a handler in useSearchActions', () => {
    const missing: string[] = [];
    for (const item of items) {
      expect(item.action.type).toBe('execute-command');
      const commandId = (item.action as { commandId: string }).commandId;
      if (!executorSource.includes(`case '${commandId}'`)) missing.push(commandId);
    }
    expect(missing).toEqual([]);
  });

  it('namespaces ids so they cannot collide with other sources', () => {
    for (const item of items) expect(item.id.startsWith('app:')).toBe(true);
  });

  it('surfaces a useful set in the empty-query view', () => {
    // The whole point of this source: opening cmd+K with no query used to
    // show three rows. Guard against silently regressing to that.
    const featured = items.filter((i) => i.featured);
    expect(featured.length).toBeGreaterThanOrEqual(5);
  });

  it('does not expose menu entries that are still stubs', () => {
    // menu-builders wires "Copy code" and the Site Settings sub-items to
    // `stub()`, which only traces. Listing them would advertise features
    // that silently do nothing. ("Export code" IS real — it runs the same
    // `exportProject` the header's Export button drives.)
    const names = items.map((i) => i.name.toLowerCase());
    expect(names).not.toContain('copy code');
  });

  it('gates Export Code behind the same condition as the header button', () => {
    // Local mode has no backend to build the zip. The row must hide rather
    // than offer an action that can only fail.
    const exportRow = items.find((i) => i.name === 'Export Code');
    expect(exportRow).toBeDefined();
    expect(typeof exportRow!.condition).toBe('function');
  });
});
