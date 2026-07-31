// library-usage-store.test.ts — cross-file instance counting for Library entries.

import { describe, test, expect, it } from 'vitest';
import { scanComponentUsage } from './library-usage-store';

const page = (imports: string, body: string) =>
  `${imports}\nexport default function Page() {\n  return <div data-id="root" data-name="Root">${body}</div>;\n}\n`;

describe('scanComponentUsage', () => {
  test('counts a design-component instance on a page, keyed by resolved file path', () => {
    const files = new Map<string, string>([
      ['app/page.client.tsx', page(`import Header from '@/components/Header';`,
        `<Header data-id="Header-1" data-name="Header" />`)],
      ['components/Header.tsx', `export default function Header() { return <div data-id="h" />; }`],
    ]);
    const usage = scanComponentUsage(files);
    const hits = usage.get('components/Header.tsx') ?? [];
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ filePath: 'app/page.client.tsx', fileLabel: 'Home', nodeId: 'Header-1' });
  });

  test('aggregates instances across pages AND nested inside another master', () => {
    const files = new Map<string, string>([
      ['app/page.client.tsx', page(`import Header from '@/components/Header';`,
        `<Header data-id="Header-1" /><Header data-id="Header-2" />`)],
      ['app/about/page.client.tsx', page(`import Header from '@/components/Header';`,
        `<Header data-id="Header-3" />`)],
      // nested: a component master that itself instantiates Header
      ['components/Hero.tsx', `import Header from '@/components/Header';\nexport default function Hero() { return <div data-id="hero"><Header data-id="Header-nested" /></div>; }`],
      ['components/Header.tsx', `export default function Header() { return <div data-id="h" />; }`],
    ]);
    const hits = scanComponentUsage(files).get('components/Header.tsx') ?? [];
    expect(hits).toHaveLength(4);
    const files_ = hits.map((h) => h.filePath).sort();
    expect(files_).toEqual([
      'app/about/page.client.tsx', 'app/page.client.tsx', 'app/page.client.tsx', 'components/Hero.tsx',
    ]);
    // the nested one carries the master file label
    expect(hits.find((h) => h.nodeId === 'Header-nested')?.fileLabel).toBe('Hero');
  });

  test('strips Next.js route-group segments from the page label (metadata, not URL)', () => {
    const files = new Map<string, string>([
      ['app/(Body)/advisors/page.client.tsx', page(`import W from '@/components/WeavingWaves';`, `<W data-id="w-1" />`)],
      ['app/(Body)/blog/[slug]/page.client.tsx', page(`import W from '@/components/WeavingWaves';`, `<W data-id="w-2" />`)],
      ['app/(Body)/page.client.tsx', page(`import W from '@/components/WeavingWaves';`, `<W data-id="w-3" />`)],
      ['components/WeavingWaves.tsx', `export default function WeavingWaves(){ return <div data-id="w" />; }`],
    ]);
    const hits = scanComponentUsage(files).get('components/WeavingWaves.tsx') ?? [];
    const labelFor = (id: string) => hits.find((h) => h.nodeId === id)?.fileLabel;
    expect(labelFor('w-1')).toBe('/advisors');          // NOT '/(Body)/advisors'
    expect(labelFor('w-2')).toBe('/blog/[slug]');       // NOT '/(Body)/blog/[slug]'
    expect(labelFor('w-3')).toBe('Home');               // the (Body) group index
  });

  test('counts a vector (icon-set) instance via @/icons import', () => {
    const files = new Map<string, string>([
      ['app/page.client.tsx', page(`import Shapes from '@/icons/Shapes';`,
        `<Shapes name="triangle" data-id="vec-1" data-name="Triangle" />`)],
      ['icons/Shapes.tsx', `/** @iconSet */\nexport default function Shapes() { return null; }`],
    ]);
    const hits = scanComponentUsage(files).get('icons/Shapes.tsx') ?? [];
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ nodeId: 'vec-1', filePath: 'app/page.client.tsx' });
  });

  test('ignores external-package tags and const-defined tags (not library entries)', () => {
    const files = new Map<string, string>([
      ['app/page.client.tsx',
        `import Link from 'next/link';\nimport { motion } from 'framer-motion';\nconst MotionLink = motion.create(Link);\n` +
        page('', `<Link data-id="l1" href="/x">x</Link><MotionLink data-id="ml1" href="/y">y</MotionLink>`)],
    ]);
    const usage = scanComponentUsage(files);
    // next/link resolves to null (external); MotionLink is a const, not an import
    expect(usage.get('next/link.tsx')).toBeUndefined();
    expect(usage.size).toBe(0);
  });

  test('COUNTS instances inside a template/layout file (the Header-in-(Body)-template case)', () => {
    const files = new Map<string, string>([
      ['app/(Body)/LayoutClient.tsx', `import Header from '@/components/Header';\nexport default function L(){ return <Header data-id="Header-layout" data-name="Header" />; }`],
      ['components/Header.tsx', `export default function Header() { return <div data-id="h" />; }`],
    ]);
    const hits = scanComponentUsage(files).get('components/Header.tsx') ?? [];
    expect(hits).toHaveLength(1);
    // labelled by its route group, not the raw file path
    expect(hits[0]).toMatchObject({ nodeId: 'Header-layout', fileLabel: 'Body Template', filePath: 'app/(Body)/LayoutClient.tsx' });
  });

  test('does not count the <LayoutClient> tag itself (server layout.tsx → not a library entry)', () => {
    const files = new Map<string, string>([
      ['app/(Body)/layout.tsx', `import LayoutClient from './LayoutClient';\nexport default function Layout({ children }){ return <LayoutClient>{children}</LayoutClient>; }`],
      ['app/(Body)/LayoutClient.tsx', `import Header from '@/components/Header';\nexport default function L(){ return <Header data-id="Header-layout" />; }`],
      ['components/Header.tsx', `export default function Header() { return <div data-id="h" />; }`],
    ]);
    const usage = scanComponentUsage(files);
    // LayoutClient resolves to an app/ path (not components/ or icons/) → skipped
    expect(usage.has('app/(Body)/LayoutClient.tsx')).toBe(false);
    // Header still counted exactly once (from the template body)
    expect(usage.get('components/Header.tsx')).toHaveLength(1);
  });
});

// CDN-linked components (URL imports) — usages keyed by the import URL so
// the Linked rows' badges (which identify by URL) resolve counts.
describe('scanComponentUsage — CDN url imports', () => {
  it('keys url-imported instances by the URL', () => {
    const files = new Map<string, string>([
      ['app/page.client.tsx', `import ArcMeter from "https://assets.revyme.app/components/ArcMeter@211980617944ad1d.js";
export default function Page() {
  return <div data-id="root" style={{ width: '100%' }}>
    <ArcMeter data-id="arc-1" data-name="Arc" style={{ position: 'relative' }} />
    <ArcMeter data-id="arc-2" data-name="Arc 2" style={{ position: 'relative' }} />
  </div>;
}`],
    ]);
    const map = scanComponentUsage(files);
    const usages = map.get('https://assets.revyme.app/components/ArcMeter@211980617944ad1d.js') ?? [];
    expect(usages.length).toBe(2);
    expect(usages[0].nodeId).toBe('arc-1');
  });

  it('still ignores real external packages', () => {
    const files = new Map<string, string>([
      ['app/p.client.tsx', `import { Something } from "some-npm-package";
export default function Page() { return <div data-id="root" style={{ width: '100%' }}><Something data-id="s1" /></div>; }`],
    ]);
    const map = scanComponentUsage(files);
    expect(map.size).toBe(0);
  });
});
