// viewport-size-ops.test.ts — Verifies the mutation-queue cache is synced
// before the inline-style mutation is queued, so the queue's JSX-style
// flush doesn't overwrite the post-setViewportsConfig @canvas update.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls = {
  syncQueueCode: vi.fn<(code: string) => void>(),
  updateNodeStyles: vi.fn(),
  readFile: vi.fn<(path: string) => string | null>(),
};

vi.mock('@/code/mutation/mutation-queue', () => ({
  syncQueueCode: (code: string) => calls.syncQueueCode(code),
}));
vi.mock('@/code/project/project-fs', () => ({
  projectFS: { readFile: (p: string) => calls.readFile(p) },
}));
vi.mock('./node-ops', () => ({
  updateNodeStyles: (...args: unknown[]) => calls.updateNodeStyles(...args),
}));

import { mirrorPrimaryViewportHeightToRoot } from './viewport-size-ops';

beforeEach(() => {
  Object.values(calls).forEach(fn => fn.mockReset());
  calls.readFile.mockReturnValue("export const x = 1; /** @canvas {} */");
});

afterEach(() => {
  vi.resetAllMocks();
});

describe('mirrorPrimaryViewportHeightToRoot', () => {
  it('syncs queue code BEFORE writing the root style mutation', () => {
    const order: string[] = [];
    calls.syncQueueCode.mockImplementation(() => { order.push('sync'); });
    calls.updateNodeStyles.mockImplementation(() => { order.push('update'); });

    const contentEl = {} as HTMLElement;
    mirrorPrimaryViewportHeightToRoot({ activeFilePath: 'app/page.tsx', contentEl, height: 1640 });

    expect(order).toEqual(['sync', 'update']);
  });

  it('passes the freshly-read code to syncQueueCode', () => {
    calls.readFile.mockReturnValue('FRESH-CODE');
    mirrorPrimaryViewportHeightToRoot({
      activeFilePath: 'app/page.tsx',
      contentEl: {} as HTMLElement,
      height: 900,
    });
    expect(calls.readFile).toHaveBeenCalledWith('app/page.tsx');
    expect(calls.syncQueueCode).toHaveBeenCalledWith('FRESH-CODE');
  });

  it('writes a `${height}px` style on root for height > 0', () => {
    mirrorPrimaryViewportHeightToRoot({
      activeFilePath: 'app/page.tsx',
      contentEl: {} as HTMLElement,
      height: 1640,
    });
    expect(calls.updateNodeStyles).toHaveBeenCalledWith(expect.objectContaining({
      id: 'root',
      styles: { height: '1640px' },
    }));
  });

  it('clears the inline height when height is 0 (auto mode)', () => {
    mirrorPrimaryViewportHeightToRoot({
      activeFilePath: 'app/page.tsx',
      contentEl: {} as HTMLElement,
      height: 0,
    });
    expect(calls.updateNodeStyles).toHaveBeenCalledWith(expect.objectContaining({
      id: 'root',
      styles: { height: '' },
    }));
  });

  it('skips syncQueueCode when the file is missing — still queues the style write', () => {
    calls.readFile.mockReturnValue(null);
    mirrorPrimaryViewportHeightToRoot({
      activeFilePath: 'missing.tsx',
      contentEl: {} as HTMLElement,
      height: 100,
    });
    expect(calls.syncQueueCode).not.toHaveBeenCalled();
    expect(calls.updateNodeStyles).toHaveBeenCalledOnce();
  });
});
