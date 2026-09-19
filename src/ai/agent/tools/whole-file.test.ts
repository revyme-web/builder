// src/ai/agent/tools/whole-file.test.ts
//
// apply_file_edit is a thin adapter over the shared oracle gate: it must
// bounce violations verbatim without committing, and commit ONLY after a
// clean gate. The freeform module is mocked so no file I/O happens here.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { atom } from 'jotai';
import type { ToolContext } from '@/ai/agent';

vi.mock('@/code/oracle/gate', () => ({
  gateTurnFiles: vi.fn(),
  commitTurnFiles: vi.fn(),
  formatBounce: vi.fn(),
}));
// Keep shim mock for any direct freeform-client importers that remain via re-export
vi.mock('@/ai/freeform/freeform-client', () => ({
  gateTurnFiles: vi.fn(),
  commitTurnFiles: vi.fn(),
  formatBounce: vi.fn(),
}));

// A REAL jotai atom (the tool reads it through the real getDefaultStore).
vi.mock('@/code/project/active-file-store', () => ({
  activeFilePathAtom: atom('app/page.client.tsx'),
}));

import { gateTurnFiles, commitTurnFiles, formatBounce, type TurnFile } from '@/code/oracle/gate';
import { applyFileEditTool } from './whole-file';

const toolCtx: ToolContext = {
  ensureCheckpoint: vi.fn(),
  vpWidth: 1440,
  signal: new AbortController().signal,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(gateTurnFiles).mockReturnValue({ files: [], violations: [] });
  vi.mocked(commitTurnFiles).mockReturnValue([]);
});

describe('apply_file_edit', () => {
  it('bounces oracle violations without committing', async () => {
    vi.mocked(gateTurnFiles).mockReturnValue({
      files: [],
      violations: [{ code: 'NO_DATA_ID', tier: 3, message: 'missing data-id' }],
    });
    vi.mocked(formatBounce).mockReturnValue(
      'VALIDATION FAILED: missing data-id' as unknown as { code: string; message: string }[],
    );

    const result = await applyFileEditTool.execute({ code: '<bad/>' }, toolCtx);

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain('missing data-id');
    expect(formatBounce).toHaveBeenCalled();
    expect(commitTurnFiles).not.toHaveBeenCalled();
  });

  it('commits after a clean gate and reports the committed path', async () => {
    vi.mocked(gateTurnFiles).mockReturnValue({
      files: [{ path: 'app/page.client.tsx', code: 'good' }] as unknown as TurnFile[],
      violations: [],
    });
    vi.mocked(commitTurnFiles).mockReturnValue(['app/page.client.tsx']);

    const result = await applyFileEditTool.execute({ code: 'good' }, toolCtx);

    expect(result.isError).toBeFalsy();
    expect(JSON.parse((result.content[0] as any).text).committed).toBe('app/page.client.tsx');
    expect(gateTurnFiles).toHaveBeenCalledWith(
      [expect.objectContaining({ code: 'good' })],
      'app/page.client.tsx',
    );
    expect(commitTurnFiles).toHaveBeenCalledWith([
      { path: 'app/page.client.tsx', code: 'good' },
    ]);
  });

  it('forwards an explicit path and kind to the gate', async () => {
    vi.mocked(gateTurnFiles).mockReturnValue({
      files: [{ path: 'components/Hero.tsx', code: 'x', kind: 'component' }],
      violations: [],
    });

    await applyFileEditTool.execute(
      { code: 'x', path: 'components/Hero.tsx', kind: 'component' },
      toolCtx,
    );

    expect(gateTurnFiles).toHaveBeenCalledWith(
      [{ path: 'components/Hero.tsx', code: 'x', kind: 'component' }],
      'app/page.client.tsx',
    );
    expect(commitTurnFiles).toHaveBeenCalled();
  });
});
