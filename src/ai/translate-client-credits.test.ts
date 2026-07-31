// Out-of-credits handling: the 402 from ai-generator surfaces as
// `outOfCredits: true` (the overlay swaps the raw message for a Top Up
// button), and `openWorkspaceCreditsPage` deep-links the workspace
// credits page in a new tab (no-op in local mode).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runAiTranslate } from './translate-client';
import { setCredits, openWorkspaceCreditsPage } from '@/code/stores/credits-store';

describe('runAiTranslate out-of-credits', () => {
  it('flags outOfCredits on a 402 response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 402,
      json: async () => ({ success: false, error: 'Out of credits — top up in Settings → Credits to keep using AI.' }),
    }));
    const result = await runAiTranslate({ items: [{ key: 'a', text: 'Hi' }], sourceLocale: 'English', targetLocale: 'French' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.outOfCredits).toBe(true);
      expect(result.error).toContain('Out of credits');
    }
    vi.unstubAllGlobals();
  });

  it('does not flag outOfCredits on other failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 500,
      json: async () => ({ success: false, error: 'boom' }),
    }));
    const result = await runAiTranslate({ items: [{ key: 'a', text: 'Hi' }], sourceLocale: 'English', targetLocale: 'French' });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.outOfCredits).toBe(false);
    vi.unstubAllGlobals();
  });
});

describe('openWorkspaceCreditsPage', () => {
  beforeEach(() => setCredits(null));

  it('opens the workspace credits dashboard in a new tab', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    setCredits({ balance: 12, workspaceId: 'ws-123' });
    openWorkspaceCreditsPage();
    expect(open).toHaveBeenCalledTimes(1);
    const [href, target] = open.mock.calls[0];
    expect(String(href)).toContain('/dashboard?ws=ws-123&view=settings%3Acredits');
    expect(target).toBe('_blank');
    open.mockRestore();
  });

  it('no-ops without a workspace (local mode)', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    openWorkspaceCreditsPage();
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });
});
