import { describe, test, it, expect, beforeEach } from 'vitest';
import {
  listTemplates,
  getPageTemplate,
  templateExists,
  pagePathForTemplate,
  assignTemplate,
  applyTemplate,
  createTemplate,
  renameTemplate,
  deleteTemplate,
  validateTemplateName,
} from './template-ops';
import { projectFS, resetProjectFS } from './project-fs';

beforeEach(() => {
  resetProjectFS();
});

// ─── Pure helpers ───────────────────────────────────────────────────────────

describe('pagePathForTemplate', () => {
  test('inserts a route group after app/ for an unassigned page', () => {
    expect(pagePathForTemplate('app/about/page.tsx', 'marketing'))
      .toBe('app/(marketing)/about/page.tsx');
  });

  test('strips an existing group when assigning null (unassign)', () => {
    expect(pagePathForTemplate('app/(marketing)/about/page.tsx', null))
      .toBe('app/about/page.tsx');
  });

  test('swaps from one group to another', () => {
    expect(pagePathForTemplate('app/(blog)/post/page.tsx', 'marketing'))
      .toBe('app/(marketing)/post/page.tsx');
  });

  test('handles the home page (no slug between app/ and page.tsx)', () => {
    expect(pagePathForTemplate('app/page.tsx', 'default'))
      .toBe('app/(default)/page.tsx');
    expect(pagePathForTemplate('app/(default)/page.tsx', null))
      .toBe('app/page.tsx');
  });

  test('null on an already-unassigned page is a no-op', () => {
    expect(pagePathForTemplate('app/about/page.tsx', null))
      .toBe('app/about/page.tsx');
  });
});

// ─── listTemplates ──────────────────────────────────────────────────────────

describe('listTemplates', () => {
  test('default starter ships zero templates', () => {
    expect(listTemplates()).toEqual([]);
  });

  test('plain route groups (no LayoutClient.tsx) are excluded', () => {
    // Create a route group with only a page — no LayoutClient. Should not
    // count as a template.
    projectFS.writeFile('app/(archive)/old/page.tsx', '/* page */');
    const templates = listTemplates();
    const names = templates.map(t => t.name);
    expect(names).not.toContain('archive');
  });

  test('templates are returned sorted by name', () => {
    createTemplate('zulu');
    createTemplate('alpha');
    createTemplate('mike');
    const names = listTemplates().map(t => t.name);
    expect(names).toEqual(['alpha', 'mike', 'zulu']);
  });
});

// ─── getPageTemplate / templateExists ───────────────────────────────────────

describe('getPageTemplate', () => {
  test('reads the route-group name from a templated page path', () => {
    expect(getPageTemplate('app/(default)/about/page.tsx')).toBe('default');
  });

  test('returns null for a page outside any group', () => {
    expect(getPageTemplate('app/about/page.tsx')).toBe(null);
  });
});

describe('templateExists', () => {
  test('true when LayoutClient.tsx is present in the route group', () => {
    createTemplate('marketing');
    expect(templateExists('marketing')).toBe(true);
  });

  test('false for a non-existent group', () => {
    expect(templateExists('does-not-exist')).toBe(false);
  });
});

// ─── createTemplate ─────────────────────────────────────────────────────────

describe('createTemplate', () => {
  test('creates layout + LayoutClient files in a new group', () => {
    const path = createTemplate('marketing');
    expect(path).toBe('app/(marketing)/LayoutClient.tsx');
    expect(projectFS.exists('app/(marketing)/layout.tsx')).toBe(true);
    expect(projectFS.exists('app/(marketing)/LayoutClient.tsx')).toBe(true);
  });

  test('rejects names with invalid characters', () => {
    expect(createTemplate('with spaces')).toBe(null);
    expect(createTemplate('hi!')).toBe(null);
    expect(createTemplate('')).toBe(null);
  });

  test('rejects when template already exists', () => {
    createTemplate('marketing');
    expect(createTemplate('marketing')).toBe(null);
  });

  test('newly-created template appears in listTemplates', () => {
    createTemplate('marketing');
    const names = listTemplates().map(t => t.name);
    expect(names).toContain('marketing');
  });
});

// ─── assignTemplate ─────────────────────────────────────────────────────────

describe('assignTemplate', () => {
  test('moves an unassigned page into a template group', () => {
    createTemplate('marketing');
    const newPath = assignTemplate('app/about/page.tsx', 'marketing');
    expect(newPath).toBe('app/(marketing)/about/page.tsx');
    expect(projectFS.exists('app/about/page.tsx')).toBe(false);
    expect(projectFS.exists('app/(marketing)/about/page.tsx')).toBe(true);
  });

  test('unassigns a templated page (template → null moves it out)', () => {
    createTemplate('marketing');
    assignTemplate('app/about/page.tsx', 'marketing');
    const newPath = assignTemplate('app/(marketing)/about/page.tsx', null);
    expect(newPath).toBe('app/about/page.tsx');
    expect(projectFS.exists('app/(marketing)/about/page.tsx')).toBe(false);
    expect(projectFS.exists('app/about/page.tsx')).toBe(true);
  });

  test('swaps from one template to another', () => {
    createTemplate('marketing');
    createTemplate('blog');
    assignTemplate('app/about/page.tsx', 'marketing');
    const newPath = assignTemplate('app/(marketing)/about/page.tsx', 'blog');
    expect(newPath).toBe('app/(blog)/about/page.tsx');
    expect(projectFS.exists('app/(blog)/about/page.tsx')).toBe(true);
    expect(projectFS.exists('app/(marketing)/about/page.tsx')).toBe(false);
  });

  test('no-op when target template matches current', () => {
    createTemplate('marketing');
    assignTemplate('app/about/page.tsx', 'marketing');
    const path = 'app/(marketing)/about/page.tsx';
    const result = assignTemplate(path, 'marketing');
    expect(result).toBe(path);
    expect(projectFS.exists(path)).toBe(true);
  });

  test('refuses to clobber an existing destination', () => {
    // Two pages with the same slug — one bare, one templated. Trying to
    // assign the bare one would overwrite the templated one; the helper
    // should refuse and return the original path unchanged.
    createTemplate('marketing');
    projectFS.writeFile('app/(marketing)/about/page.tsx', '/* templated about */');
    const result = assignTemplate('app/about/page.tsx', 'marketing');
    expect(result).toBe('app/about/page.tsx'); // unchanged
    expect(projectFS.exists('app/about/page.tsx')).toBe(true);
    // Original templated about untouched
    expect(projectFS.readFile('app/(marketing)/about/page.tsx')).toBe('/* templated about */');
  });
});

// ─── applyTemplate ──────────────────────────────────────────────────────────

describe('applyTemplate', () => {
  test('creates the template and moves every given page inside it', () => {
    projectFS.writeFile('app/page.client.tsx', '/* home */');
    projectFS.writeFile('app/pricing/page.client.tsx', '/* pricing */');
    projectFS.writeFile('app/faq/page.client.tsx', '/* faq */');

    const { layoutClient, moved } = applyTemplate('site', [
      'app/page.client.tsx',
      'app/pricing/page.client.tsx',
      'app/faq/page.client.tsx',
    ]);

    expect(layoutClient).toBe('app/(site)/LayoutClient.tsx');
    expect(templateExists('site')).toBe(true);
    // Home keeps its slug (route groups are URL-invisible).
    expect(projectFS.exists('app/(site)/page.client.tsx')).toBe(true);
    expect(projectFS.exists('app/(site)/pricing/page.client.tsx')).toBe(true);
    expect(projectFS.exists('app/(site)/faq/page.client.tsx')).toBe(true);
    expect(projectFS.exists('app/page.client.tsx')).toBe(false);
    expect(moved).toHaveLength(3);
  });

  test('is idempotent — re-running performs zero new moves', () => {
    projectFS.writeFile('app/pricing/page.client.tsx', '/* pricing */');
    applyTemplate('site', ['app/pricing/page.client.tsx']);
    // The page now lives at the templated path; feed THAT back in.
    const second = applyTemplate('site', ['app/(site)/pricing/page.client.tsx']);
    expect(second.moved).toHaveLength(0);
    expect(projectFS.exists('app/(site)/pricing/page.client.tsx')).toBe(true);
  });

  test('reuses an existing template instead of recreating it', () => {
    createTemplate('site');
    projectFS.writeFile('app/(site)/LayoutClient.tsx', '/* MY EDITED TEMPLATE */');
    projectFS.writeFile('app/about/page.client.tsx', '/* about */');

    const { moved } = applyTemplate('site', ['app/about/page.client.tsx']);

    // The authored LayoutClient is NOT overwritten.
    expect(projectFS.readFile('app/(site)/LayoutClient.tsx')).toBe('/* MY EDITED TEMPLATE */');
    expect(moved).toHaveLength(1);
    expect(projectFS.exists('app/(site)/about/page.client.tsx')).toBe(true);
  });

  test('moves the page-pair server wrapper alongside the client', () => {
    projectFS.writeFile('app/pricing/page.client.tsx', '/* client */');
    projectFS.writeFile('app/pricing/page.tsx', '/* server */');
    applyTemplate('site', ['app/pricing/page.client.tsx']);
    expect(projectFS.exists('app/(site)/pricing/page.tsx')).toBe(true);
    expect(projectFS.exists('app/(site)/pricing/page.client.tsx')).toBe(true);
    expect(projectFS.exists('app/pricing/page.tsx')).toBe(false);
  });

  test('throws on an invalid template name', () => {
    expect(() => applyTemplate('has spaces', [])).toThrow();
    expect(() => applyTemplate('', [])).toThrow();
  });
});

// ─── renameTemplate ─────────────────────────────────────────────────────────

describe('renameTemplate', () => {
  test('moves every file under the group folder', () => {
    createTemplate('marketing');
    assignTemplate('app/about/page.tsx', 'marketing');
    expect(renameTemplate('marketing', 'main')).toBe(true);
    expect(projectFS.exists('app/(marketing)/LayoutClient.tsx')).toBe(false);
    expect(projectFS.exists('app/(main)/LayoutClient.tsx')).toBe(true);
    expect(projectFS.exists('app/(main)/about/page.tsx')).toBe(true);
  });

  test('blocks rename when destination already exists', () => {
    createTemplate('marketing');
    createTemplate('blog');
    expect(renameTemplate('marketing', 'blog')).toBe(false);
    // Originals untouched
    expect(projectFS.exists('app/(marketing)/LayoutClient.tsx')).toBe(true);
    expect(projectFS.exists('app/(blog)/LayoutClient.tsx')).toBe(true);
  });

  test('rejects invalid names', () => {
    createTemplate('marketing');
    expect(renameTemplate('marketing', 'with spaces')).toBe(false);
  });

  test('renaming to the same name is a no-op success', () => {
    createTemplate('marketing');
    expect(renameTemplate('marketing', 'marketing')).toBe(true);
    expect(projectFS.exists('app/(marketing)/LayoutClient.tsx')).toBe(true);
  });
});

// ─── deleteTemplate ─────────────────────────────────────────────────────────

describe('deleteTemplate', () => {
  test('removes the template files but moves pages out (preserves user work)', () => {
    createTemplate('marketing');
    assignTemplate('app/about/page.tsx', 'marketing');
    deleteTemplate('marketing');
    // Layout files gone
    expect(projectFS.exists('app/(marketing)/LayoutClient.tsx')).toBe(false);
    expect(projectFS.exists('app/(marketing)/layout.tsx')).toBe(false);
    // Pages survived, moved back to bare
    expect(projectFS.exists('app/about/page.tsx')).toBe(true);
  });

  test('a conflicted templated page is LEFT IN PLACE — never deleted', () => {
    // Contract change (2026-08-12): the old behavior DELETED the templated
    // copy on a slug conflict "to avoid clobbering" — but when the templated
    // copy is the one with the user's latest work, that delete IS the
    // clobber. Now nothing is deleted: the page stays inside the (now
    // chrome-less) group, still renders at its URL-invisible route-group
    // path, and the conflict is traced for the caller to surface.
    createTemplate('marketing');
    projectFS.writeFile('app/(marketing)/contact/page.client.tsx', '/* templated contact */');
    projectFS.writeFile('app/(marketing)/contact/page.tsx', '/* templated wrapper */');
    projectFS.writeFile('app/contact/page.client.tsx', '/* my bare contact */');
    deleteTemplate('marketing');
    // The bare page is untouched AND the templated copy still exists.
    expect(projectFS.readFile('app/contact/page.client.tsx')).toBe('/* my bare contact */');
    expect(projectFS.readFile('app/(marketing)/contact/page.client.tsx')).toBe('/* templated contact */');
    // Chrome still removed.
    expect(projectFS.exists('app/(marketing)/LayoutClient.tsx')).toBe(false);
    expect(projectFS.exists('app/(marketing)/layout.tsx')).toBe(false);
  });

  test('listTemplates no longer shows a deleted template', () => {
    createTemplate('marketing');
    deleteTemplate('marketing');
    const names = listTemplates().map(t => t.name);
    expect(names).not.toContain('marketing');
  });

  // ─── The Wisp data loss (2026-08-12) ──────────────────────────────────
  // The old implementation rescued only files matching `endsWith('page.tsx')`
  // with raw single-file moves — `page.client.tsx` doesn't match — and then
  // DELETED "anything left in the group folder". That was every page's entire
  // content: one Delete Template erased a 47KB home page, unrecoverable.
  test('page pairs move out as PAIRS — the client half (page content) survives', () => {
    createTemplate('site');
    assignTemplate('app/about/page.tsx', 'site');
    // The pair really is inside the group before the delete.
    expect(projectFS.exists('app/(site)/about/page.client.tsx')).toBe(true);
    expect(projectFS.exists('app/(site)/about/page.tsx')).toBe(true);

    deleteTemplate('site');

    // BOTH halves back at the bare path; the page's actual content intact.
    expect(projectFS.exists('app/about/page.tsx')).toBe(true);
    const client = projectFS.readFile('app/about/page.client.tsx');
    expect(client).toBeTruthy();
    expect(client).toContain('data-id="about-hero"'); // seed page body marker
    // Chrome gone; NOTHING left behind in the group.
    expect(projectFS.listFiles('app/(site)/')).toEqual([]);
  });

  test('WISP REPLAY: templated home + fr/es locale wrappers — content survives, wrappers follow', () => {
    // The incident's exact file layout: home pair inside (Layout), generated
    // locale wrappers beside it. The old delete left es/fr wrappers moved
    // verbatim (still pointing at the group) next to a husk of a home page.
    projectFS.writeFile('i18n/config.json', JSON.stringify({
      defaultLocale: 'en',
      locales: [
        { code: 'en', label: 'English' },
        { code: 'fr', label: 'Français' },
        { code: 'es', label: 'Español' },
      ],
    }));
    createTemplate('Layout');
    assignTemplate('app/page.tsx', 'Layout'); // pair moves in; sync regenerates wrappers in-group
    expect(projectFS.exists('app/(Layout)/page.client.tsx')).toBe(true);
    expect(projectFS.exists('app/(Layout)/es/page.tsx')).toBe(true);
    expect(projectFS.readFile('app/(Layout)/es/page.tsx')).toContain('@/app/(Layout)/page');

    deleteTemplate('Layout');

    // Home pair back at the root with its content.
    expect(projectFS.exists('app/page.tsx')).toBe(true);
    expect(projectFS.readFile('app/page.client.tsx')).toContain('data-id=');
    // Wrappers REGENERATED at the bare paths, pointing at the bare page —
    // not moved verbatim with stale (Layout) exports.
    expect(projectFS.readFile('app/es/page.tsx')).toContain("from '@/app/page'");
    expect(projectFS.readFile('app/fr/page.tsx')).toContain("from '@/app/page'");
    // Group folder completely settled — no zombie files.
    expect(projectFS.listFiles('app/(Layout)/')).toEqual([]);
  });

  test('a client half without its wrapper (orphaned pair) still survives', () => {
    // Half-broken projects exist in the wild (this is exactly what the Wisp
    // project looked like mid-cascade). The rescue keys on the CLIENT half,
    // so an orphaned page.client.tsx moves out rather than being swept.
    createTemplate('site');
    projectFS.writeFile('app/(site)/lonely/page.client.tsx', '/* my orphaned page */');
    deleteTemplate('site');
    expect(projectFS.readFile('app/lonely/page.client.tsx')).toBe('/* my orphaned page */');
    expect(projectFS.listFiles('app/(site)/')).toEqual([]);
  });
});

describe('createTemplate — the returned path is the ONLY truth about the name', () => {
  test('preserves case: "Body" creates app/(Body)/, and templateExists agrees', () => {
    // Regression (2026-07-27): the TemplatePicker re-derived the name with its
    // OWN cleaning rules (toLowerCase) — templateExists('body') was false for
    // the just-created 'Body', so create-and-apply silently skipped the apply
    // and the tool looked like it "did nothing". Callers must parse the name
    // from the returned clientPath, never re-sanitize the input themselves.
    const clientPath = createTemplate('Body');
    expect(clientPath).toBe('app/(Body)/LayoutClient.tsx');
    const name = clientPath!.match(/^app\/\(([^)]+)\)\//)?.[1];
    expect(name).toBe('Body');
    expect(templateExists(name!)).toBe(true);
    expect(templateExists('body')).toBe(false);   // case-sensitive FS
  });
});

// ─── Name validation — the silent-failure fix ───────────────────────────────
//
// `createTemplate` returned null for a duplicate/invalid name and reported it
// ONLY to the console (`template-ops:create-exists`), while every caller closed
// its dialog regardless — so the button "did nothing" (user report 2026-08-08,
// after a first attempt had already created that name). Dialogs now validate
// through the same function `createTemplate` itself uses, so they cannot
// disagree about what will be accepted.

describe('validateTemplateName', () => {
  beforeEach(() => { resetProjectFS(); });

  it('accepts a fresh, well-formed name', () => {
    expect(validateTemplateName('marketing')).toBeNull();
    expect(validateTemplateName('blog-2024')).toBeNull();
    expect(validateTemplateName('my_group')).toBeNull();
  });

  it('rejects an empty name', () => {
    expect(validateTemplateName('')).toMatch(/required/i);
    expect(validateTemplateName('   ')).toMatch(/required/i);
  });

  it('rejects characters the route-group folder cannot carry', () => {
    expect(validateTemplateName('my template')).toMatch(/letters, numbers/i);
    expect(validateTemplateName('a/b')).toMatch(/letters, numbers/i);
  });

  it('rejects a name already in use, and names it', () => {
    expect(createTemplate('sdfsdf')).toBe('app/(sdfsdf)/LayoutClient.tsx');
    expect(validateTemplateName('sdfsdf')).toContain('sdfsdf');
    expect(validateTemplateName('sdfsdf')).toMatch(/already exists/i);
  });

  it('agrees with createTemplate — a name it accepts always creates', () => {
    expect(validateTemplateName('fresh')).toBeNull();
    expect(createTemplate('fresh')).not.toBeNull();
    // …and one it refuses never does.
    expect(validateTemplateName('fresh')).not.toBeNull();
    expect(createTemplate('fresh')).toBeNull();
  });
});
