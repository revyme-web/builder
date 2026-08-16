import { describe, it, expect } from 'vitest';
import { parse } from '@babel/parser';
import { parseMetadataFromCode, parseSiteConfigFromCode, updateMetadataInCode, updateSiteConfigInCode, ensureLayoutFile, ensureCustomCodeRenderInCode, healLayoutFile } from './metadata-gen';

const parses = (c: string) => { parse(c, { sourceType: 'module', plugins: ['jsx', 'typescript'] }); return true; };

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
    expect(result).toContain('title: "New Title"');
    expect(result).toContain('description: "Old desc"');
  });

  it('adds metadata export when none exists', () => {
    const code = `export default function RootLayout({ children }) {
  return <html><body>{children}</body></html>;
}`;
    const result = updateMetadataInCode(code, { title: 'Brand New' });
    expect(result).toContain('export const metadata');
    expect(result).toContain('title: "Brand New"');
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
    expect(result).toContain('title: "Site"');
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
    expect(result).toContain('title: "Site"');
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
    expect(result).toContain('theme: "dark"');
    expect(result).toContain('language: "en"');
  });

  it('adds siteConfig when none exists', () => {
    const code = `export default function RootLayout({ children }) {
  return <html><body>{children}</body></html>;
}`;
    const result = updateSiteConfigInCode(code, { language: 'fr' });
    expect(result).toContain('export const siteConfig');
    expect(result).toContain('language: "fr"');
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

describe('custom-code hardening (the finance-project corruption, 2026-08-16)', () => {
  // The real pasted snippet class: multi-line <script> with quotes,
  // backslashes, `};` inside the string, and </script>.
  const NASTY = `<script>
(function() {
  const init = function() { return document.querySelector('.menu'); };
  if (!init()) {
    const observer = new MutationObserver(() => { if (init()) observer.disconnect(); });
    observer.observe(document.body, { childList: true, subtree: true });
  }
})();
</script>`;

  it('any pasted content survives a save as a valid module', () => {
    const out = updateSiteConfigInCode(ensureLayoutFile(), { customBody: NASTY });
    expect(parses(out)).toBe(true);
    expect(parseSiteConfigFromCode(out).customBody).toBe(NASTY);
  });

  it('repeated saves never strand tails (the lazy-regex corruption)', () => {
    let code = updateSiteConfigInCode(ensureLayoutFile(), { customBody: NASTY });
    code = updateSiteConfigInCode(code, { customHead: '<script>alert("x\'y")</script>' });
    code = updateSiteConfigInCode(code, { customBody: '' });   // clear
    code = updateSiteConfigInCode(code, { customBody: NASTY });
    expect(parses(code)).toBe(true);
    expect((code.match(/export const siteConfig/g) ?? []).length).toBe(1);
    expect(code).not.toMatch(/<\/script>',\n\};/);            // no stranded tails
    const cfg = parseSiteConfigFromCode(code);
    expect(cfg.customBody).toBe(NASTY);
    expect(cfg.customHead).toBe('<script>alert("x\'y")</script>');
  });

  it('metadata twin: a title with quotes, newlines and }; round-trips', () => {
    const title = 'Weird "title" with \'quotes\' and };\nnewline';
    const out = updateMetadataInCode(ensureLayoutFile(), { title });
    expect(parses(out)).toBe(true);
    expect(parseMetadataFromCode(out).title).toBe(title);
  });

  it('legacy single-quoted values still parse', () => {
    const legacy = `export const siteConfig = {\n  language: 'fr',\n  customHead: 'a\\'b',\n};\n\nexport default function X() { return null; }`;
    const cfg = parseSiteConfigFromCode(legacy);
    expect(cfg.language).toBe('fr');
    expect(cfg.customHead).toBe("a'b");
  });

  it('fresh layout renders the custom code natively (no publish-time injection)', () => {
    const code = ensureLayoutFile();
    expect(code).toContain('data-custom-code="head"');
    expect(code).toContain('data-custom-code="body"');
    expect(code).toContain('dangerouslySetInnerHTML={{ __html: siteConfig.customHead }}');
    expect(parses(code)).toBe(true);
  });

  it('ensureCustomCodeRenderInCode retrofits legacy layouts, idempotently', () => {
    const legacy = `import './globals.css';
import { Providers } from './providers';

export const metadata = {};

export const siteConfig = {
  customBody: "x",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
`;
    const once = ensureCustomCodeRenderInCode(legacy);
    expect(parses(once)).toBe(true);
    expect(once).toContain('data-custom-code="head"');
    expect(once).toContain('data-custom-code="body"');
    expect(ensureCustomCodeRenderInCode(once)).toBe(once);
  });

  it('the wild corrupted layout still yields a usable config read (no crash)', () => {
    const corrupted = `export const siteConfig = {};if(!init()){const o=1});</script>',\n};\n\nexport default function X() { return null; }`;
    expect(parseSiteConfigFromCode(corrupted)).toEqual({});
  });
});

describe('healLayoutFile', () => {
  // The REAL corrupted file from the wild (finance project) — an empty
  // siteConfig head + three stranded string tails + CursorPortal.
  const WILD = `import './globals.css';
import { Providers } from './providers';
import { CursorPortal } from '@revyme/runtime';

export const metadata = {
  title: 'finance',
};

export const siteConfig = {};if(!init()){const observer=new MutationObserver(()=>{if(init())observer.disconnect()});observer.observe(document.body,{childList:true,subtree:true})}})();</script>',
};if(!init()){const observer=new MutationObserver(()=>{if(init())observer.disconnect()});observer.observe(document.body,{childList:true,subtree:true})}})();</script>',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <Providers>{children}</Providers>
              <CursorPortal />
      </body>
    </html>
  );
}
`;

  it('rebuilds the wild corrupted layout: parses, keeps title + CursorPortal', () => {
    const healed = healLayoutFile(WILD);
    expect(parses(healed)).toBe(true);
    expect(parseMetadataFromCode(healed).title).toBe('finance');
    expect(healed).toContain("import { CursorPortal } from '@revyme/runtime'");
    expect(healed).toContain('<CursorPortal />');
    expect(healed).toContain('data-custom-code="body"');
    expect(healed).not.toContain('</script>');   // the garbage is gone
  });

  it('a valid layout passes through byte-identical', () => {
    const good = ensureLayoutFile();
    expect(healLayoutFile(good)).toBe(good);
  });

  it('a save on a corrupted layout produces a working file end to end', () => {
    const healed = healLayoutFile(WILD);
    const saved = updateSiteConfigInCode(healed, { customBody: '<script>console.log("back")</script>' });
    expect(parses(saved)).toBe(true);
    expect(parseSiteConfigFromCode(saved).customBody).toBe('<script>console.log("back")</script>');
  });
});
