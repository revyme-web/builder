// revyme-backend.test.ts — Verifies the RevymeBackend talks to the Hono API
// using the right URLs, methods, body shapes, and credentials. (Auth flows
// beyond the session check and the websites index live in the dashboard
// app now — ProjectBackend is project CRUD + workspace lookups only.)

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RevymeBackend,
  isFreeTemplate,
  listApprovedTemplates,
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

  it('listApprovedTemplates GETs /approved unfiltered (caller splits free/paid)', async () => {
    setResponse({ templates: [free, paid, freeZeroPrice] });
    const rows = await listApprovedTemplates();
    expect(calls[0].url).toBe(`${API}/api/templates/approved`);
    expect(rows.map((t) => t.id)).toEqual(['t1', 't3', 't2']);
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

// 2026-10-14: stale tabs overwrote newer work (whole-row saves, last write
// wins), and the boot getters fetched the 13 MB project row seven times.
describe('RevymeBackend — revisions and the light row', () => {
  it('load records the row revision; the next save names it as its base', async () => {
    const { resetSaveRevisionForTest } = await import('./save-revision');
    resetSaveRevisionForTest();
    const backend = new RevymeBackend();
    setResponse({ id: '1', name: 'A', revision: 41, json: JSON.stringify({ format: 'revyme-v1', files: { a: 'b' } }) });
    await backend.loadProject('1');
    setResponse({ id: '1', revision: 42 });
    await backend.saveProject('1', { format: 'revyme-v1', files: { a: 'c' } });
    const body = JSON.parse(calls[1].init.body as string);
    expect(body.baseRevision).toBe(41);
    // …and the landed revision becomes the next base.
    setResponse({ id: '1', revision: 43 });
    await backend.saveProject('1', { format: 'revyme-v1', files: { a: 'd' } });
    expect(JSON.parse(calls[2].init.body as string).baseRevision).toBe(42);
  });

  it('a 409 becomes a SaveConflictError carrying the row\'s revision', async () => {
    const { SaveConflictError } = await import('./types');
    const backend = new RevymeBackend();
    setResponse({ error: { code: 'CONFLICT', message: 'stale', details: { revision: 9 } } }, { status: 409 });
    const err = await backend.saveProject('1', { format: 'revyme-v1', files: {} }).catch((e) => e);
    expect(err).toBeInstanceOf(SaveConflictError);
    expect(err.serverRevision).toBe(9);
  });

  it('a readable API error message reaches the save banner, not raw JSON', async () => {
    const backend = new RevymeBackend();
    setResponse({ error: { code: 'UNPROCESSABLE', message: 'This project is 17.0 MB — too large to save.' } }, { status: 422 });
    await expect(backend.saveProject('1', { format: 'revyme-v1', files: {} })).rejects.toThrow('Save failed: 422 This project is 17.0 MB — too large to save.');
  });

  it('the boot getters share ONE light /meta request', async () => {
    const backend = new RevymeBackend();
    setResponse({ id: '1', name: 'Site', _role: 'owner', closed_source: false, workspace_id: 'ws' });
    const [role, name, closed] = await Promise.all([
      backend.getWebsiteRole('1'), backend.getWebsiteName('1'), backend.getWebsiteClosedSource('1'),
    ]);
    expect([role, name, closed]).toEqual(['owner', 'Site', false]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${API}/api/websites/1/meta`);
  });
});

describe('RevymeBackend — compressed saves', () => {
  const big = { format: 'revyme-project@2', files: { 'app/page.client.tsx': 'x'.repeat(200_000) } } as never;

  beforeEach(async () => {
    (await import('./save-encoding')).resetSaveEncodingForTest();
  });

  it('sends plain JSON until the API has advertised gzip', async () => {
    setResponse({ revision: 1 });
    await new RevymeBackend().saveProject('site-1', big);
    expect((calls[0].init.headers as Record<string, string>)['Content-Encoding']).toBeUndefined();
    expect(typeof calls[0].init.body).toBe('string');
  });

  it('gzips a large save once a response carried x-revyme-accept-encoding: gzip', async () => {
    setResponse({ revision: 1 }, { status: 200, headers: { 'x-revyme-accept-encoding': 'gzip' } });
    const backend = new RevymeBackend();
    await backend.saveProject('site-1', big); // learns the capability
    await backend.saveProject('site-1', big);
    const second = calls[1].init;
    expect((second.headers as Record<string, string>)['Content-Encoding']).toBe('gzip');
    const inflated = await new Response(new Response(second.body as ArrayBuffer).body!.pipeThrough(new DecompressionStream('gzip'))).text();
    expect(JSON.parse(JSON.parse(inflated).json).files['app/page.client.tsx']).toHaveLength(200_000);
    expect((second.body as ArrayBuffer).byteLength).toBeLessThan(20_000);
  });

  it('a refused compressed save is resent plain, and compression stays off', async () => {
    setResponse({ revision: 1 }, { status: 200, headers: { 'x-revyme-accept-encoding': 'gzip' } });
    const backend = new RevymeBackend();
    await backend.saveProject('site-1', big);
    vi.mocked(fetch).mockImplementationOnce(async (u, init) => {
      calls.push({ url: String(u), init: init ?? {} });
      return new Response(JSON.stringify({ error: { message: 'bad body' } }), { status: 400 });
    });
    setResponse({ revision: 2 });
    await backend.saveProject('site-1', big);
    expect((calls[1].init.headers as Record<string, string>)['Content-Encoding']).toBe('gzip');
    expect((calls[2].init.headers as Record<string, string>)['Content-Encoding']).toBeUndefined();
    await backend.saveProject('site-1', big);
    expect((calls[3].init.headers as Record<string, string>)['Content-Encoding']).toBeUndefined();
  });
});
