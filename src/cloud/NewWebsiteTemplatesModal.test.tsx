// NewWebsiteTemplatesModal.test.tsx — the fresh-site "start from a
// template" prompt: scratch card first then free then paid templates,
// paid cards deep-link to the marketplace in a new tab, stands down
// silently on an empty catalog, and a dismissal writes the per-site
// marker + hands off to the onboarding tour.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import NewWebsiteTemplatesModal from './NewWebsiteTemplatesModal';
import {
  setTemplatePromptArmed,
  isTemplatePromptArmed,
  templatePromptDismissKey,
} from '@/code/stores/fresh-site-store';
import { listApprovedTemplates } from '@/backend/revyme-backend';
import { startOnboarding } from '@/editor/onboarding';

vi.mock('@/backend/revyme-backend', async (importOriginal) => ({
  // Real isFreeTemplate (pure predicate) — mocking it would just restate it.
  isFreeTemplate: (await importOriginal<typeof import('@/backend/revyme-backend')>()).isFreeTemplate,
  listApprovedTemplates: vi.fn(),
  remixTemplateIntoWebsite: vi.fn(),
}));
vi.mock('@/backend/project-id', () => ({
  getProjectId: () => 'site-1',
}));
vi.mock('@/backend/autosave', () => ({
  cancelPendingAutosave: vi.fn(),
  setAutosaveHeld: vi.fn(),
}));
vi.mock('@/editor/onboarding', () => ({
  startOnboarding: vi.fn(),
  ONBOARDING_COMPLETED_KEY: 'revyme-onboarding-completed',
}));

const TEMPLATES = [
  // Paid listed FIRST in the API response — the modal must reorder free-first.
  { id: 't3', slug: 'pro-folio', name: 'Pro Folio', author: 'Zed', pricing_type: 'paid', price_cents: 2900, thumbnail_url: null },
  { id: 't1', slug: 'folio', name: 'Folio', author: 'Ana', pricing_type: 'free', price_cents: null, thumbnail_url: null },
  { id: 't2', slug: null, name: 'Studio', author: null, pricing_type: 'free', price_cents: null, thumbnail_url: null },
];

/** Arm the prompt and fire the render-complete signal the reveal waits on. */
async function armAndReveal() {
  await act(async () => {
    setTemplatePromptArmed(true);
  });
  await act(async () => {
    window.dispatchEvent(new Event('revyme:render-complete'));
  });
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  setTemplatePromptArmed(false);
  vi.clearAllMocks();
});

describe('NewWebsiteTemplatesModal', () => {
  it('renders scratch card first, then free templates, then paid', async () => {
    vi.mocked(listApprovedTemplates).mockResolvedValue(TEMPLATES as never);
    render(<NewWebsiteTemplatesModal />);
    await armAndReveal();
    // Reveal is delayed 400ms after render-complete (loading-shell fade).
    await waitFor(() => expect(screen.getByText('Folio')).toBeTruthy(), { timeout: 2000 });

    const cards = screen.getAllByRole('button').filter((b) => b.className.includes('flex-col'));
    const labels = cards.map((c) => c.textContent ?? '');
    expect(labels[0]).toContain('Start from scratch');
    expect(labels[1]).toContain('Folio');
    expect(labels[2]).toContain('Studio');
    expect(labels[3]).toContain('Pro Folio');
    // Free rows badge as "Free", paid rows as their price.
    expect(labels[1]).toContain('Free');
    expect(labels[3]).toContain('$29');
  });

  it('paid card opens the marketplace page in a new tab and keeps the modal up', async () => {
    vi.mocked(listApprovedTemplates).mockResolvedValue(TEMPLATES as never);
    const open = vi.fn();
    vi.stubGlobal('open', open);
    render(<NewWebsiteTemplatesModal />);
    await armAndReveal();
    await waitFor(() => expect(screen.getByText('Pro Folio')).toBeTruthy(), { timeout: 2000 });

    await userEvent.click(screen.getByText('Pro Folio'));
    expect(open).toHaveBeenCalledWith('/templates/pro-folio', '_blank', 'noopener');
    expect(isTemplatePromptArmed()).toBe(true);
    expect(screen.getByText('Folio')).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it('stands down silently when the catalog is empty', async () => {
    vi.mocked(listApprovedTemplates).mockResolvedValue([] as never);
    render(<NewWebsiteTemplatesModal />);
    await armAndReveal();
    await waitFor(() => expect(isTemplatePromptArmed()).toBe(false));
    expect(screen.queryByText('Start from scratch')).toBeNull();
  });

  it('scratch card dismisses: writes the per-site marker and starts onboarding', async () => {
    vi.mocked(listApprovedTemplates).mockResolvedValue(TEMPLATES as never);
    render(<NewWebsiteTemplatesModal />);
    await armAndReveal();
    await waitFor(() => expect(screen.getByText('Start from scratch')).toBeTruthy(), { timeout: 2000 });

    await userEvent.click(screen.getByText('Start from scratch'));
    expect(localStorage.getItem(templatePromptDismissKey('site-1'))).toBe('1');
    expect(isTemplatePromptArmed()).toBe(false);
    expect(startOnboarding).toHaveBeenCalledTimes(1);
  });
});
