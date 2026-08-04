// NewWebsiteTemplatesModal.test.tsx — the fresh-site "start from a
// template" prompt: shows free templates once armed + canvas-painted,
// stands down silently on an empty catalog, and a dismissal writes the
// per-site marker + hands off to the onboarding tour.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import NewWebsiteTemplatesModal from './NewWebsiteTemplatesModal';
import {
  setTemplatePromptArmed,
  isTemplatePromptArmed,
  templatePromptDismissKey,
} from '@/code/stores/fresh-site-store';
import { listFreeTemplates } from '@/backend/revyme-backend';
import { startOnboarding } from '@/editor/onboarding';

vi.mock('@/backend/revyme-backend', () => ({
  listFreeTemplates: vi.fn(),
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
  { id: 't1', name: 'Folio', author: 'Ana', pricing_type: 'free', price_cents: null, thumbnail_url: null },
  { id: 't2', name: 'Studio', author: null, pricing_type: 'free', price_cents: null, thumbnail_url: null },
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
  it('shows the free template cards once armed and the canvas has painted', async () => {
    vi.mocked(listFreeTemplates).mockResolvedValue(TEMPLATES as never);
    render(<NewWebsiteTemplatesModal />);
    expect(screen.queryByText('Folio')).toBeNull();

    await armAndReveal();
    // Reveal is delayed 400ms after render-complete (loading-shell fade).
    await waitFor(() => expect(screen.getByText('Folio')).toBeTruthy(), { timeout: 2000 });
    expect(screen.getByText('Studio')).toBeTruthy();
    expect(screen.getByText('Start from scratch')).toBeTruthy();
  });

  it('stands down silently when the catalog has no free templates', async () => {
    vi.mocked(listFreeTemplates).mockResolvedValue([] as never);
    render(<NewWebsiteTemplatesModal />);
    await armAndReveal();
    await waitFor(() => expect(isTemplatePromptArmed()).toBe(false));
    expect(screen.queryByText('Start from scratch')).toBeNull();
  });

  it('dismiss writes the per-site marker, disarms, and starts onboarding', async () => {
    vi.mocked(listFreeTemplates).mockResolvedValue(TEMPLATES as never);
    render(<NewWebsiteTemplatesModal />);
    await armAndReveal();
    await waitFor(() => expect(screen.getByText('Start from scratch')).toBeTruthy(), { timeout: 2000 });

    await userEvent.click(screen.getByText('Start from scratch'));
    expect(localStorage.getItem(templatePromptDismissKey('site-1'))).toBe('1');
    expect(isTemplatePromptArmed()).toBe(false);
    expect(startOnboarding).toHaveBeenCalledTimes(1);
  });
});
