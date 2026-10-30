// Project builder for E2E seeds.
//
// Produces the `{ format: 'revyme-v1', files }` blob the editor reads from
// localStorage (`revyme-project-local`). Every other file is supplied by
// createDefaultProject at boot, so a seed only carries what the test needs.
//
//   project()
//     .page(`<div data-id="root" …>…</div>`, { tiles: TILES.three })
//     .component('Card', CARD_SOURCE)
//     .build()
//
// Multi-tile pages ALWAYS get the full `@canvas` shape (id, label, width,
// isPrimary, order + positions). A bare `{id, width}` list renders a replica
// tile at zero size with an "undefined" header.

export type ProjectData = { format: 'revyme-v1'; files: Record<string, string> };

export interface Tile { id: string; label: string; width: number }

export const TILE = {
  desktop: { id: 'desktop', label: 'Desktop', width: 1440 },
  tablet: { id: 'tablet', label: 'Tablet', width: 768 },
  mobile: { id: 'mobile', label: 'Mobile', width: 375 },
} satisfies Record<string, Tile>;

export const TILES = {
  one: [TILE.desktop],
  two: [TILE.desktop, TILE.mobile],
  three: [TILE.desktop, TILE.tablet, TILE.mobile],
} satisfies Record<string, Tile[]>;

/** The `/** @canvas … *\/` header for a page with these tiles (first = primary). */
export function canvasHeader(tiles: Tile[] = TILES.one): string {
  // Full shape even for ONE tile: a bare `{id,width}` entry has no
  // `isPrimary`, and the editor then treats Desktop as a replica and hides
  // every primary-only action (Make Component among them).
  const GAP = 120;
  let x = 0;
  const positions: Record<string, { x: number; y: number }> = {};
  const viewports = tiles.map((t, i) => {
    positions[t.id] = { x, y: 0 };
    x += t.width + GAP;
    return { id: t.id, label: t.label, width: t.width, isPrimary: i === 0, order: i };
  });
  return `/** @canvas ${JSON.stringify({ viewports, positions }, null, 2)} */`;
}

const PAGE_SERVER_WRAPPER = `import PageClient from './page.client';

export const metadata = {};

export default function Page() {
  return <PageClient />;
}
`;

/** A whole `page.client.tsx` module around one root element. */
export function pageModule(rootJsx: string, opts: { tiles?: Tile[]; imports?: string[] } = {}): string {
  const imports = (opts.imports ?? []).map(i => `${i}\n`).join('');
  // Same order the builder writes (project-fs HOME_PAGE): the directive first.
  return `'use client';

${canvasHeader(opts.tiles)}
${imports}export default function Page() {
  return (
${indent(rootJsx.trim(), 4)}
  );
}
`;
}

class ProjectBuilder {
  private readonly files: Record<string, string> = {};

  /** The home page (`app/page.client.tsx`) from its root element. Pass a full
   *  module instead with `pageSource` when the test needs hooks/constants. */
  page(rootJsx: string, opts: { tiles?: Tile[]; imports?: string[]; route?: string } = {}): this {
    const dir = routeDir(opts.route);
    this.files[`${dir}page.tsx`] = PAGE_SERVER_WRAPPER;
    this.files[`${dir}page.client.tsx`] = pageModule(rootJsx, opts);
    return this;
  }

  /** A page from its complete `page.client.tsx` source. */
  pageSource(source: string, opts: { route?: string } = {}): this {
    const dir = routeDir(opts.route);
    this.files[`${dir}page.tsx`] = PAGE_SERVER_WRAPPER;
    this.files[`${dir}page.client.tsx`] = source;
    return this;
  }

  /** A design-component master at `components/<Name>.tsx`. */
  component(name: string, source: string): this {
    this.files[`components/${name}.tsx`] = source;
    return this;
  }

  /** Any other file, verbatim (i18n config, messages, CMS data, …). */
  file(path: string, contents: string): this {
    this.files[path] = contents;
    return this;
  }

  build(): ProjectData {
    return { format: 'revyme-v1', files: { ...this.files } };
  }
}

export function project(): ProjectBuilder {
  return new ProjectBuilder();
}

function routeDir(route?: string): string {
  if (!route || route === '/') return 'app/';
  return `app/${route.replace(/^\/+|\/+$/g, '')}/`;
}

function indent(text: string, n: number): string {
  const pad = ' '.repeat(n);
  return text.split('\n').map(l => (l ? pad + l : l)).join('\n');
}
