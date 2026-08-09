// Generated app/providers.tsx — locale imports follow the config; route-first
// locale resolution ships in the template.
import { describe, it, expect } from 'vitest';
import { buildProvidersSource, looksGeneratedProviders, PROVIDERS_MARKER } from './providers-gen';

const CFG = {
  defaultLocale: 'en',
  locales: [
    { code: 'en', label: 'English' },
    { code: 'fr', label: 'French' },
    { code: 'it', label: 'Italian' },
    { code: 'pt-BR', label: 'Português (BR)' },
  ],
};

describe('buildProvidersSource', () => {
  it('imports one dictionary per configured locale (the old template hardcoded en/fr/es)', () => {
    const src = buildProvidersSource(CFG);
    expect(src).toContain("import enMessages from '@/messages/en.json';");
    expect(src).toContain("import itMessages from '@/messages/it.json';");
    expect(src).toContain("import pt_BRMessages from '@/messages/pt-BR.json';");
    expect(src).toContain("'pt-BR': pt_BRMessages,");
    expect(src).not.toContain('esMessages');
  });

  it('resolves the locale route-first via usePathname', () => {
    const src = buildProvidersSource(CFG);
    expect(src).toContain("import { usePathname } from 'next/navigation';");
    expect(src).toContain('localeFromPath');
    expect(src).toContain(PROVIDERS_MARKER);
    expect(src).toContain("const DEFAULT_LOCALE = 'en';");
    // SSR :lang() carrier
    expect(src).toContain('<div lang={locale}');
  });

  it('rejects malformed locale codes instead of interpolating them', () => {
    const src = buildProvidersSource({
      defaultLocale: 'en',
      locales: [{ code: 'en', label: 'E' }, { code: "x'; alert(1); '", label: 'evil' }],
    });
    expect(src).not.toContain('alert(1)');
  });
});

describe('looksGeneratedProviders', () => {
  it('detects v2 (marker), v1 (heuristic), and leaves hand-written alone', () => {
    expect(looksGeneratedProviders(buildProvidersSource(CFG))).toBe(true);
    expect(looksGeneratedProviders("const messagesByLocale = {}; window.addEventListener('locale-change', h);")).toBe(true);
    expect(looksGeneratedProviders('export function Providers({children}) { return children; }')).toBe(false);
  });
});

// The isolated COMPONENT preview (preview-sandbox/main.tsx) short-circuits
// route resolution, so it never mounts `app/layout.tsx` and never gets the
// providers that way. It compiles this file and reads `.Providers` off the
// module instead — which means the NAMED export is load-bearing for a surface
// that lives in a different bundle and cannot type-check against it.
//
// If this ever became a default export, the preview would silently fall back
// to rendering bare and every translated component would throw "the context
// from NextIntlClientProvider was not found" again (user report 2026-08-09).

describe('the Providers export contract', () => {
  it('is a NAMED export — the component preview looks it up by name', () => {
    const src = buildProvidersSource({ defaultLocale: 'en', locales: [{ code: 'en', label: 'English' }] });
    expect(src).toMatch(/export function Providers\b/);
  });

  it('wraps children in NextIntlClientProvider, which is the context the preview needs', () => {
    const src = buildProvidersSource({ defaultLocale: 'en', locales: [{ code: 'en', label: 'English' }] });
    expect(src).toContain('NextIntlClientProvider');
  });
});
