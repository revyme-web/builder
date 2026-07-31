import { describe, test, expect, beforeEach } from 'vitest';
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

  test('drops a templated page when its bare slug already exists', () => {
    // Pre-create a bare page with the same slug as a templated one.
    createTemplate('marketing');
    projectFS.writeFile('app/(marketing)/contact/page.tsx', '/* templated contact */');
    projectFS.writeFile('app/contact/page.tsx', '/* my bare contact */');
    deleteTemplate('marketing');
    // The bare page survives; the templated one was dropped to avoid
    // clobbering. Layout files still removed.
    expect(projectFS.readFile('app/contact/page.tsx')).toBe('/* my bare contact */');
    expect(projectFS.exists('app/(marketing)/contact/page.tsx')).toBe(false);
    expect(projectFS.exists('app/(marketing)/LayoutClient.tsx')).toBe(false);
  });

  test('listTemplates no longer shows a deleted template', () => {
    createTemplate('marketing');
    deleteTemplate('marketing');
    const names = listTemplates().map(t => t.name);
    expect(names).not.toContain('marketing');
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
