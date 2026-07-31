import { describe, it, expect } from 'vitest';
import {
  templateGroupFromLayoutFile,
  templatePreviewRoute,
  templatePreviewPages,
} from './template-preview';

describe('templateGroupFromLayoutFile', () => {
  it('extracts the group from a template LayoutClient path', () => {
    expect(templateGroupFromLayoutFile('app/(marketing)/LayoutClient.tsx')).toBe('marketing');
  });

  it('also matches the server layout.tsx half', () => {
    expect(templateGroupFromLayoutFile('app/(blog)/layout.tsx')).toBe('blog');
  });

  it('returns null for normal pages and non-template files', () => {
    expect(templateGroupFromLayoutFile('app/page.client.tsx')).toBeNull();
    expect(templateGroupFromLayoutFile('app/(marketing)/about/page.client.tsx')).toBeNull();
    expect(templateGroupFromLayoutFile('components/Hero.tsx')).toBeNull();
    expect(templateGroupFromLayoutFile(null)).toBeNull();
    expect(templateGroupFromLayoutFile(undefined)).toBeNull();
  });
});

describe('templatePreviewRoute', () => {
  it('builds a route-group-nested dir and a URL that embeds the group', () => {
    expect(templatePreviewRoute('marketing')).toEqual({
      dir: 'app/(marketing)/__template_preview/marketing',
      url: '/__template_preview/marketing',
    });
  });
});

describe('templatePreviewPages', () => {
  it('emits both page-pair halves for each template group', () => {
    const pages = templatePreviewPages([
      'app/page.client.tsx',
      'app/(marketing)/LayoutClient.tsx',
      'app/(marketing)/layout.tsx',
      'app/(blog)/LayoutClient.tsx',
      'components/Hero.tsx',
    ]);
    const files = pages.map((p) => p.file).sort();
    expect(files).toEqual([
      'app/(blog)/__template_preview/blog/page.client.tsx',
      'app/(blog)/__template_preview/blog/page.tsx',
      'app/(marketing)/__template_preview/marketing/page.client.tsx',
      'app/(marketing)/__template_preview/marketing/page.tsx',
    ]);
    // Every emitted file carries the placeholder component.
    expect(pages.every((p) => p.content.includes('TemplatePreviewPlaceholder'))).toBe(true);
  });

  it('returns nothing when there are no templates', () => {
    expect(templatePreviewPages(['app/page.client.tsx', 'app/about/page.client.tsx'])).toEqual([]);
  });
});
