// revyme-backend.test.ts — Verifies the RevymeBackend talks to the Hono API
// using the right URLs, methods, body shapes, and credentials. (Auth flows
// beyond the session check and the websites index live in the dashboard
// app now — ProjectBackend is project CRUD + workspace lookups only.)

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RevymeBackend,
  isFreeTemplate,
  listFreeTemplates,
  remixTemplateIntoWebsite,
} from './revyme-backend';

// API_URL comes from VITE_API_URL at module import — mirror the module's
// exact fallback (empty string → relative URLs through the dispatcher) so
// the expected URLs match in every environment.
const API = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');

interface FetchCall {
  url: string;
  init: RequestInit;
}

let calls: FetchCall[] = [];
let nextResponse: Response;

function setResponse(body: unknown, init: ResponseInit = { status: 200 }) {
  nextResponse = new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
}

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      return nextResponse.clone();
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RevymeBackend — session', () => {
  it('GET /api/auth/session returns the user object', async () => {
    setResponse({ user: { id: 'u1', email: 'a@b.c', name: 'A' } });
    const backend = new RevymeBackend();
    const user = await backend.getUser();
    expect(user?.id).toBe('u1');
    expect(calls[0].url).toBe(`${API}/api/auth/session`);
    expect(calls[0].init.credentials).toBe('include');
  });

  it('returns null when the session is empty', async () => {
    setResponse({ user: null });
    const backend = new RevymeBackend();
    expect(await backend.getUser()).toBeNull();
  });
});

describe('RevymeBackend — project load/save', () => {
  it('loadProject parses the json string blob', async () => {
    const data = { format: 'revyme-v1', files: { 'a': 'b' } };
    setResponse({ id: '1', name: 'A', json: JSON.stringify(data) });
    const backend = new RevymeBackend();
    expect(await backend.loadProject('1')).toEqual(data);
  });

  it('loadProject returns null for an unrecognized format', async () => {
    setResponse({ id: '1', name: 'A', json: JSON.stringify({ format: 'old' }) });
    const backend = new RevymeBackend();
    expect(await backend.loadProject('1')).toBeNull();
  });

  it('loadProject returns null when json is empty {}', async () => {
    setResponse({ id: '1', name: 'A', json: '{}' });
    const backend = new RevymeBackend();
    expect(await backend.loadProject('1')).toBeNull();
  });

  it('saveProject sends the snapshot as a JSON string', async () => {
    setResponse({ ok: true });
    const backend = new RevymeBackend();
    const data = { format: 'revyme-v1' as const, files: { foo: 'bar' } };
    await backend.saveProject('1', data);
    expect(calls[0].url).toBe(`${API}/api/websites/1`);
    expect(calls[0].init.method).toBe('PUT');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      json: JSON.stringify(data),
    });
  });

  it('saveProject throws on a non-OK response', async () => {
    setResponse({ error: 'nope' }, { status: 400 });
    const backend = new RevymeBackend();
    await expect(
      backend.saveProject('1', { format: 'revyme-v1', files: {} }),
    ).rejects.toThrow(/Save failed: 400/);
  });

  it('renameWebsite PUTs only { name } (leaves json untouched)', async () => {
    setResponse({ id: '1', name: 'New Name' });
    const backend = new RevymeBackend();
    await backend.renameWebsite('1', 'New Name');
    expect(calls[0].url).toBe(`${API}/api/websites/1`);
    expect(calls[0].init.method).toBe('PUT');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ name: 'New Name' });
  });

  it('getWebsiteName reads websites.name from the GET row', async () => {
    setResponse({ id: '1', name: 'My Site', json: '{}' });
    const backend = new RevymeBackend();
    expect(await backend.getWebsiteName('1')).toBe('My Site');
  });

  it('getWebsiteName returns null on a failed fetch', async () => {
    setResponse({ error: 'nope' }, { status: 404 });
    const backend = new RevymeBackend();
    expect(await backend.getWebsiteName('1')).toBeNull();
  });
});

describe('RevymeBackend — roles and workspace lookups', () => {
  it('getWebsiteRole reads _role from the website row', async () => {
    setResponse({ id: '1', _role: 'editor' });
    const backend = new RevymeBackend();
    expect(await backend.getWebsiteRole('1')).toBe('editor');
  });

  it('getWebsiteRole falls back to viewer on error (conservative)', async () => {
    setResponse({ error: 'nope' }, { status: 500 });
    const backend = new RevymeBackend();
    expect(await backend.getWebsiteRole('1')).toBe('viewer');
  });

  it('getWebsiteWorkspaceId reads the snake_case workspace_id field', async () => {
    // The GET spreads the raw Prisma row — camelCase `workspaceId` was a
    // latent bug that silently broke workspace deep-links.
    setResponse({ id: '1', workspace_id: 'ws-9' });
    const backend = new RevymeBackend();
    expect(await backend.getWebsiteWorkspaceId('1')).toBe('ws-9');
  });

  it('getCredits returns the balance number, null on error', async () => {
    setResponse({ balance: 42 });
    const backend = new RevymeBackend();
    expect(await backend.getCredits('ws-1')).toBe(42);

    setResponse({ error: 'nope' }, { status: 500 });
    expect(await backend.getCredits('ws-1')).toBeNull();
  });

  it('listWorkspaceFonts returns fonts, [] on error', async () => {
    const fonts = [{ id: 'f1', family: 'Inter Custom', url: 'https://cdn/x.woff2' }];
    setResponse({ fonts });
    const backend = new RevymeBackend();
    expect(await backend.listWorkspaceFonts('ws-1')).toEqual(fonts);

    setResponse({ error: 'nope' }, { status: 500 });
    expect(await backend.listWorkspaceFonts('ws-1')).toEqual([]);
  });
});

describe('Template flow — free templates + remix-into', () => {
  const free = { id: 't1', name: 'Folio', pricing_type: 'free', price_cents: null };
  const freeZeroPrice = { id: 't2', name: 'Zero', pricing_type: 'paid', price_cents: 0 };
  const paid = { id: 't3', name: 'Pro', pricing_type: 'paid', price_cents: 2900 };

  it('isFreeTemplate mirrors the backend paid predicate', () => {
    expect(isFreeTemplate(free)).toBe(true);
    // pricing_type 'paid' with no positive price is NOT gated server-side —
    // must not be hidden client-side either.
    expect(isFreeTemplate(freeZeroPrice)).toBe(true);
    expect(isFreeTemplate(paid)).toBe(false);
  });

  it('listFreeTemplates GETs /approved and filters out paid rows', async () => {
    setResponse({ templates: [free, paid, freeZeroPrice] });
    const rows = await listFreeTemplates();
    expect(calls[0].url).toBe(`${API}/api/templates/approved`);
    expect(rows.map((t) => t.id)).toEqual(['t1', 't2']);
  });

  it('remixTemplateIntoWebsite POSTs intoWebsiteId with credentials', async () => {
    setResponse({ success: true, website_id: 'w1', template_id: 't1' });
    const out = await remixTemplateIntoWebsite('t1', 'w1');
    expect(calls[0].url).toBe(`${API}/api/templates/remix/t1`);
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.credentials).toBe('include');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ intoWebsiteId: 'w1' });
    expect(out.website_id).toBe('w1');
  });

  it('remixTemplateIntoWebsite surfaces the backend error message', async () => {
    setResponse(
      { error: { message: 'This website already has content — remix into a new website instead' } },
      { status: 400 },
    );
    await expect(remixTemplateIntoWebsite('t1', 'w1')).rejects.toThrow(/already has content/);
  });
});
