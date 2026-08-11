// create-project.test.ts — File → New project must CREATE the website row
// before opening the builder.
//
// The old flow invented a client UUID and opened `/builder/<id>` cold. That
// predates the workspace ACL: `ProjectLoader` resolves the caller's role from
// the backend, and an id with no row has no membership → the builder booted
// in VIEW-ONLY mode with every save rejected (2026-08-11). Cloud mode now
// POSTs /websites first (row lands in the user's current/personal workspace,
// ownership stamped — the dashboard's own create endpoint) and only then
// points the tab, which is opened SYNCHRONOUSLY inside the click gesture so
// popup blockers don't eat it.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const backendMock = vi.hoisted(() => ({
  createWebsite: vi.fn<(name?: string, workspaceId?: string | null) => Promise<string>>(),
  shareAsTemplate: vi.fn(),
}));
vi.mock('@/backend/revyme-backend', () => backendMock);

const backendObjMock = vi.hoisted(() => ({
  getWebsiteWorkspaceId: vi.fn<(id: string) => Promise<string | null>>(),
}));

function makeTab() {
  return { location: { href: '' }, close: vi.fn() } as unknown as Window & { location: { href: string }; close: () => void };
}

async function loadWithCloud(enabled: boolean) {
  vi.resetModules();
  vi.doMock('@/shared/cloud-flag', () => ({ CLOUD_ENABLED: enabled }));
  // The real backend singleton constructs `RevymeBackend` at module scope
  // the moment CLOUD_ENABLED is true — irrelevant here and unbootable in
  // jsdom. The menu reaches it only for the current site's workspace id.
  vi.doMock('@/backend/index', () => ({ backend: backendObjMock }));
  return import('./menu-builders');
}

beforeEach(() => {
  backendMock.createWebsite.mockReset();
  backendObjMock.getWebsiteWorkspaceId.mockReset();
  backendObjMock.getWebsiteWorkspaceId.mockResolvedValue(null);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('createAndOpenProject — cloud mode', () => {
  it('creates the row first, then navigates the pre-opened tab to the returned id', async () => {
    const { createAndOpenProject } = await loadWithCloud(true);
    const tab = makeTab();
    vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    backendMock.createWebsite.mockResolvedValue('created-id-123');

    createAndOpenProject();
    // Tab opened synchronously in the gesture (blank), BEFORE the async create.
    expect(window.open).toHaveBeenCalledWith('', '_blank');
    expect(tab.location.href).toBe('');
    await vi.waitFor(() => expect(tab.location.href).toBe('/builder/created-id-123'));
    expect(backendMock.createWebsite).toHaveBeenCalledTimes(1);
  });

  it("targets the CURRENT website's workspace when it has one", async () => {
    const { createAndOpenProject } = await loadWithCloud(true);
    const tab = makeTab();
    vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    backendObjMock.getWebsiteWorkspaceId.mockResolvedValue('team-ws-9');
    backendMock.createWebsite.mockResolvedValue('id-in-team');

    createAndOpenProject();
    await vi.waitFor(() => expect(tab.location.href).toBe('/builder/id-in-team'));
    // The backend validates create-permission and falls back to personal
    // itself — the menu just names the workspace the user is looking at.
    expect(backendMock.createWebsite).toHaveBeenCalledWith(undefined, 'team-ws-9');
  });

  it('requests PERSONAL explicitly (null) when the current site has no workspace', async () => {
    const { createAndOpenProject } = await loadWithCloud(true);
    const tab = makeTab();
    vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    backendObjMock.getWebsiteWorkspaceId.mockResolvedValue(null);
    backendMock.createWebsite.mockResolvedValue('id-in-personal');

    createAndOpenProject();
    await vi.waitFor(() => expect(tab.location.href).toBe('/builder/id-in-personal'));
    // null (personal), NOT undefined — undefined would let the backend fall
    // back to the dashboard's cookie-remembered workspace, which can be
    // unrelated to the site on screen.
    expect(backendMock.createWebsite).toHaveBeenCalledWith(undefined, null);
  });

  it('closes the tab and does not navigate when the create fails', async () => {
    const { createAndOpenProject } = await loadWithCloud(true);
    const tab = makeTab();
    vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    backendMock.createWebsite.mockRejectedValue(new Error('nope'));

    createAndOpenProject();
    await vi.waitFor(() => expect(tab.close).toHaveBeenCalledTimes(1));
    expect(tab.location.href).toBe('');
  });

  it('bails without a create call when the popup is blocked', async () => {
    const { createAndOpenProject } = await loadWithCloud(true);
    vi.spyOn(window, 'open').mockReturnValue(null);
    createAndOpenProject();
    await Promise.resolve();
    expect(backendMock.createWebsite).not.toHaveBeenCalled();
  });
});

describe('createAndOpenProject — local mode', () => {
  it('uses a client-generated id with no backend call', async () => {
    const { createAndOpenProject } = await loadWithCloud(false);
    const tab = makeTab();
    vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);

    createAndOpenProject();
    expect(backendMock.createWebsite).not.toHaveBeenCalled();
    expect(tab.location.href).toMatch(/^\/builder\/[a-z0-9-]+$/i);
  });
});
