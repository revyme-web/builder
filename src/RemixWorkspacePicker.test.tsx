/** @vitest-environment jsdom */
// RemixWorkspacePicker.test.tsx — the workspace question, asked AFTER the remix.
//
// The first version ran BEFORE any project existed: it rendered over a black
// screen, and choosing triggered the remix + a full page load. The remix
// endpoint already defaults to the user's personal workspace when none is
// given, so the copy is now created up front, `/builder/<newId>` opens the real
// editable site, and this modal only MOVES it — no reload.
//
// Still obligatory (no ×, no Escape, no backdrop): a fresh copy should not be
// left in a workspace the user never looked at.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

const setWorkspace = vi.fn();
vi.mock('@/backend/revyme-backend', () => ({
  listAttachableWorkspaces: () => Promise.resolve([
    { id: 'w1', name: 'My workspace', is_personal: true, role: 'owner', logo: null },
    { id: 'w2', name: 'Client work', is_personal: false, role: 'owner', logo: null },
  ]),
  setWebsiteWorkspace: (...a: unknown[]) => setWorkspace(...a),
}));
vi.mock('@/shared/debug-trace', () => ({
  trace: { action: vi.fn(), fn: vi.fn(), dom: vi.fn(), error: vi.fn() },
}));

import RemixWorkspacePicker from './RemixWorkspacePicker';

const onDone = vi.fn();
beforeEach(() => { setWorkspace.mockReset(); setWorkspace.mockResolvedValue(undefined); onDone.mockReset(); });

const open = () => render(<RemixWorkspacePicker websiteId="site-1" onDone={onDone} />);

describe('the workspace choice is obligatory', () => {
  it('renders no × close button', async () => {
    open();
    await screen.findByText('My workspace');
    // Modal PORTALS to <body>, so query the document, not the render container.
    const root = document.querySelector('[data-modal-root]');
    expect(root, 'the modal should be mounted').toBeTruthy();
    expect(root!.querySelectorAll('button svg line').length, 'a × close button is present').toBe(0);
  });

  it('Escape does NOT dismiss it', async () => {
    open();
    await screen.findByText('My workspace');
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.getByText('Continue')).toBeTruthy());
    expect(onDone).not.toHaveBeenCalled();
  });

  it('a backdrop click does NOT dismiss it', async () => {
    open();
    await screen.findByText('My workspace');
    const backdrop = document.querySelector('[data-modal-root] .bg-black\\/50');
    expect(backdrop, 'backdrop should exist').toBeTruthy();
    fireEvent.click(backdrop!);
    await waitFor(() => expect(screen.getByText('Continue')).toBeTruthy());
    expect(onDone).not.toHaveBeenCalled();
  });
});

describe('assigning', () => {
  it('closes WITHOUT reloading — the site is already open behind it', async () => {
    open();
    await screen.findByText('My workspace');
    fireEvent.click(screen.getByText('Continue'));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it('preselects the personal workspace, so one click keeps it where it is', async () => {
    open();
    await screen.findByText('My workspace');
    fireEvent.click(screen.getByText('Continue'));
    await waitFor(() => expect(setWorkspace).toHaveBeenCalledWith('site-1', 'w1'));
  });

  it('moves it to the workspace actually picked', async () => {
    open();
    await screen.findByText('Client work');
    fireEvent.click(screen.getByText('Client work'));
    fireEvent.click(screen.getByText('Continue'));
    await waitFor(() => expect(setWorkspace).toHaveBeenCalledWith('site-1', 'w2'));
  });

  it('surfaces a refusal and stays open to retry', async () => {
    open();
    await screen.findByText('My workspace');
    setWorkspace.mockRejectedValue(new Error('You cannot add a website to that workspace'));
    fireEvent.click(screen.getByText('Continue'));
    await screen.findByText('You cannot add a website to that workspace');
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.getByText('Continue')).toBeTruthy();
  });
});
