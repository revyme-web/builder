import { describe, it, expect } from 'vitest';
import { parseMetadataFromCode, parseSiteConfigFromCode, updateMetadataInCode, updateSiteConfigInCode, ensureLayoutFile } from './metadata-gen';

describe('parseMetadataFromCode', () => {
  it('parses metadata export from layout code', () => {
    const code = `
export const metadata = {
  title: 'My Site',
  description: 'A cool site',
};

export default function RootLayout({ children }) {
  return <html lang="en"><body>{children}</body></html>;
}`;
    const result = parseMetadataFromCode(code);
    expect(result.title).toBe('My Site');
    expect(result.description).toBe('A cool site');
  });

  it('returns empty object when no metadata export', () => {
    const code = `export default function Page() { return <div>Hello</div>; }`;
    const result = parseMetadataFromCode(code);
    expect(result).toEqual({});
  });

  it('parses nested openGraph', () => {
    const code = `
export const metadata = {
  title: 'Site',
  openGraph: {
    images: ['https://cdn.example.com/og.png'],
  },
};
export default function RootLayout({ children }) {
  return <html><body>{children}</body></html>;
}`;
    const result = parseMetadataFromCode(code);
    expect(result.title).toBe('Site');
    expect(result.openGraph?.images).toEqual(['https://cdn.example.com/og.png']);
  });

  it('parses icons.icon', () => {
    const code = `
export const metadata = {
  title: 'Site',
  icons: {
    icon: 'https://cdn.example.com/favicon.png',
  },
};
export default function RootLayout({ children }) {
  return <html><body>{children}</body></html>;
}`;
    const result = parseMetadataFromCode(code);
    expect(result.icons?.icon).toBe('https://cdn.example.com/favicon.png');
  });
});

describe('parseSiteConfigFromCode', () => {
  it('parses siteConfig export', () => {
    const code = `
export const siteConfig = {
  language: 'en',
  theme: 'dark',
  customHead: '<script>alert(1)</script>',
  customBody: '',
};

export default function RootLayout({ children }) {
  return <html><body>{children}</body></html>;
}`;
    const result = parseSiteConfigFromCode(code);
    expect(result.language).toBe('en');
    expect(result.theme).toBe('dark');
    expect(result.customHead).toBe('<script>alert(1)</script>');
  });

  it('returns empty object when no siteConfig', () => {
    const code = `export default function Page() { return <div />; }`;
    const result = parseSiteConfigFromCode(code);
    expect(result).toEqual({});
  });
});

describe('updateMetadataInCode', () => {
  it('updates existing metadata fields', () => {
    const code = `export const metadata = {
  title: 'Old',
  description: 'Old desc',
};

export default function RootLayout({ children }) {
  return <html><body>{children}</body></html>;
}`;
    const result = updateMetadataInCode(code, { title: 'New Title' });
    expect(result).toContain("title: 'New Title'");
    expect(result).toContain("description: 'Old desc'");
  });

  it('adds metadata export when none exists', () => {
    const code = `export default function RootLayout({ children }) {
  return <html><body>{children}</body></html>;
}`;
    const result = updateMetadataInCode(code, { title: 'Brand New' });
    expect(result).toContain('export const metadata');
    expect(result).toContain("title: 'Brand New'");
    expect(result).toContain('export default');
  });

  it('updates nested openGraph.images', () => {
    const code = `export const metadata = {
  title: 'Site',
};

export default function RootLayout({ children }) {
  return <html><body>{children}</body></html>;
}`;
    const result = updateMetadataInCode(code, { openGraph: { images: ['https://cdn.example.com/new.png'] } });
    expect(result).toContain("title: 'Site'");
    expect(result).toContain('openGraph');
    expect(result).toContain('https://cdn.example.com/new.png');
  });

  it('sets icons.icon for favicon', () => {
    const code = `export const metadata = {
  title: 'Site',
};

export default function RootLayout({ children }) {
  return <html><body>{children}</body></html>;
}`;
    const result = updateMetadataInCode(code, { icons: { icon: 'https://cdn.example.com/favicon.png' } });
    expect(result).toContain('icons');
    expect(result).toContain('https://cdn.example.com/favicon.png');
  });

  it('removes field when value is empty string', () => {
    const code = `export const metadata = {
  title: 'Site',
  description: 'Old',
};

export default function RootLayout({ children }) {
  return <html><body>{children}</body></html>;
}`;
    const result = updateMetadataInCode(code, { description: '' });
    expect(result).not.toContain('description');
    expect(result).toContain("title: 'Site'");
  });

  it('preserves rest of code', () => {
    const code = `export const metadata = {
  title: 'Old',
};

export const siteConfig = {
  language: 'en',
};

export default function RootLayout({ children }) {
  return <html><body>{children}</body></html>;
}`;
    const result = updateMetadataInCode(code, { title: 'New' });
    expect(result).toContain('siteConfig');
    expect(result).toContain('export default');
  });
});

describe('updateSiteConfigInCode', () => {
  it('updates existing siteConfig fields', () => {
    const code = `export const siteConfig = {
  language: 'en',
  theme: 'light',
};

export default function RootLayout({ children }) {
  return <html><body>{children}</body></html>;
}`;
    const result = updateSiteConfigInCode(code, { theme: 'dark' });
    expect(result).toContain("theme: 'dark'");
    expect(result).toContain("language: 'en'");
  });

  it('adds siteConfig when none exists', () => {
    const code = `export default function RootLayout({ children }) {
  return <html><body>{children}</body></html>;
}`;
    const result = updateSiteConfigInCode(code, { language: 'fr' });
    expect(result).toContain('export const siteConfig');
    expect(result).toContain("language: 'fr'");
  });
});

describe('ensureLayoutFile', () => {
  it('returns default layout code with metadata and siteConfig', () => {
    const code = ensureLayoutFile();
    expect(code).toContain('export const metadata');
    expect(code).toContain('export const siteConfig');
    expect(code).toContain('export default function RootLayout');
    expect(code).toContain('<html');
    expect(code).toContain('<body');
  });

  it('is parseable by parseMetadataFromCode', () => {
    const code = ensureLayoutFile();
    const meta = parseMetadataFromCode(code);
    expect(meta).toHaveProperty('title');
  });

  it('is parseable by parseSiteConfigFromCode', () => {
    const code = ensureLayoutFile();
    const config = parseSiteConfigFromCode(code);
    expect(config.language).toBe('en');
    expect(config.theme).toBe('light');
  });

  it('server layout renders {children} inside Providers (no LayoutClient indirection)', () => {
    // The bare root LayoutClient was removed — pages without a Template
    // render against the body directly. Providers (next-themes + next-intl)
    // MUST wrap children: a bare body crashed localized pages with a missing
    // NextIntlClientProvider context (2026-07-22).
    const code = ensureLayoutFile();
    expect(code).not.toContain("import LayoutClient from './LayoutClient'");
    expect(code).not.toContain('<LayoutClient>{children}</LayoutClient>');
    expect(code).toContain('<Providers>{children}</Providers>');
  });
});
