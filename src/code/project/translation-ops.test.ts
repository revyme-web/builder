// translation-ops.test.ts — per-locale text/attr commits + the legacy
// override migration (localization overhaul Phases 2/3/5).

import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('@/shared/debug-trace', () => ({
  trace: { action: vi.fn(), fn: vi.fn(), dom: vi.fn(), error: vi.fn() },
}));

const fsStore = vi.hoisted(() => new Map<string, string>());

vi.mock('./project-fs', () => ({
  DEFAULT_PROVIDERS: "'use client';\nexport function Providers({ children }) { return children; }\n",
  projectFS: {
    readFile: vi.fn((path: string) => fsStore.get(path) ?? null),
    writeFile: vi.fn((path: string, content: string) => { fsStore.set(path, content); }),
    deleteFile: vi.fn((path: string) => { fsStore.delete(path); }),
    listFiles: vi.fn(() => [...fsStore.keys()].sort()),
    exists: vi.fn((path: string) => fsStore.has(path)),
  },
}));

// modifyProjectFile flushes the mutation queue in the real app; here just
// run the transform against the mock store directly.
vi.mock('./modify-file', () => ({
  modifyProjectFile: vi.fn((path: string, fn: (code: string) => string) => {
    const cur = fsStore.get(path) ?? '';
    fsStore.set(path, fn(cur));
  }),
}));

import {
  commitTranslationText,
  commitTranslationAttr,
  readTranslationText,
  migrateLegacyLocaleTextOverrides,
  listTranslatableTexts,
} from './translation-ops';

const PAGE = `'use client';
export default function Page() {
  return (
    <div data-id="root" style={{ width: '100%' }}>
      <p data-id="intro" style={{ color: '#fff' }}>Painter</p>
      <input data-id="email" placeholder="jane@x.com" type="email" />
    </div>
  );
}
`;

const FILE = 'app/page.client.tsx';

beforeEach(() => {
  fsStore.clear();
  fsStore.set(FILE, PAGE);
  fsStore.set('messages/en.json', '{}');
  fsStore.set('messages/fr.json', '{}');
});

describe('commitTranslationText', () => {
  test('non-default locale: transforms JSX, seeds default, writes locale message', () => {
    commitTranslationText({ filePath: FILE, nodeId: 'intro', locale: 'fr', defaultLocale: 'en', text: 'Peintre' });
    const code = fsStore.get(FILE)!;
    expect(code).toMatch(/\{t\(["']intro["']\)\}/);
    expect(code).toContain('useTranslations');
    expect(readTranslationText({ filePath: FILE, key: 'intro', locale: 'en' })).toBe('Painter');
    expect(readTranslationText({ filePath: FILE, key: 'intro', locale: 'fr' })).toBe('Peintre');
  });

  test('default locale on an untransformed node: plain JSX text update', () => {
    commitTranslationText({ filePath: FILE, nodeId: 'intro', locale: 'en', defaultLocale: 'en', text: 'Sculptor' });
    expect(fsStore.get(FILE)).toContain('Sculptor');
    expect(fsStore.get(FILE)).not.toContain('useTranslations');
  });

  test('default locale on a transformed node: writes messages only', () => {
    commitTranslationText({ filePath: FILE, nodeId: 'intro', locale: 'fr', defaultLocale: 'en', text: 'Peintre' });
    const transformed = fsStore.get(FILE)!;
    commitTranslationText({ filePath: FILE, nodeId: 'intro', locale: 'en', defaultLocale: 'en', text: 'Artist' });
    expect(fsStore.get(FILE)).toBe(transformed); // JSX untouched
    expect(readTranslationText({ filePath: FILE, key: 'intro', locale: 'en' })).toBe('Artist');
  });

  test('seed fallback used when the transform cannot capture original text', () => {
    commitTranslationText({
      filePath: FILE, nodeId: 'root', locale: 'fr', defaultLocale: 'en',
      text: 'Bonjour', fallbackDefaultText: 'Hello from canvas',
    });
    // root has no JSXText children — originalText comes from the fallback.
    expect(readTranslationText({ filePath: FILE, key: 'root', locale: 'en' })).toBe('Hello from canvas');
  });
});

// ─── Rich-text runs (mixed content) ─────────────────────────────────────────
// The overlay leaked raw `<span style={{…}}>` JSX for rich text (user report
// 2026-07-30). Mixed nodes now list one row per visible text RUN under
// `<nodeId>__r<k>`; commits splice/transform ONLY that run — spans keep their
// styling in every locale.

const RICH_PAGE = `'use client';
export default function Page() {
  return (
    <div data-id="root" style={{ width: '100%' }}>
      <p data-id="rich" style={{ fontSize: '20px' }}>I'm <span style={{ color: 'red' }}>Jenny,</span><br />Product Designer</p>
    </div>
  );
}
`;

describe('rich-text run rows + commits', () => {
  beforeEach(() => {
    fsStore.set(FILE, RICH_PAGE);
  });

  test('listTranslatableTexts lists runs as plain text, never raw JSX', () => {
    const rows = listTranslatableTexts('en').filter(r => r.nodeId.startsWith('rich'));
    expect(rows.map(r => [r.nodeId, r.source])).toEqual([
      ['rich__r0', "I'm"],
      ['rich__r1', 'Jenny,'],
      ['rich__r2', 'Product Designer'],
    ]);
    expect(rows.every(r => !r.source.includes('<span'))).toBe(true);
  });

  test('non-default run commit transforms ONLY that run + seeds + writes', () => {
    commitTranslationText({ filePath: FILE, nodeId: 'rich__r1', locale: 'fr', defaultLocale: 'en', text: 'Jenny !' });
    const code = fsStore.get(FILE)!;
    expect(code).toMatch(/<span[^>]*>\{t\(["']rich__r1["']\)\}<\/span>/s);
    expect(code).toContain("I'm ");                 // sibling runs untouched
    expect(code).toContain('Product Designer');
    expect(code).toContain('useTranslations');
    expect(readTranslationText({ filePath: FILE, key: 'rich__r1', locale: 'en' })).toBe('Jenny,');
    expect(readTranslationText({ filePath: FILE, key: 'rich__r1', locale: 'fr' })).toBe('Jenny !');
  });

  test('default-locale edit on an untransformed run splices the JSX in place', () => {
    commitTranslationText({ filePath: FILE, nodeId: 'rich__r2', locale: 'en', defaultLocale: 'en', text: 'Product Painter' });
    const code = fsStore.get(FILE)!;
    expect(code).toContain('Product Painter');
    expect(code).not.toContain('Product Designer');
    expect(code).toContain('<span style={{');       // formatting intact
    expect(code).not.toContain('useTranslations');
  });

  test('default-locale edit on a TRANSFORMED run writes messages only', () => {
    commitTranslationText({ filePath: FILE, nodeId: 'rich__r1', locale: 'fr', defaultLocale: 'en', text: 'Jenny !' });
    const transformed = fsStore.get(FILE)!;
    commitTranslationText({ filePath: FILE, nodeId: 'rich__r1', locale: 'en', defaultLocale: 'en', text: 'Janie,' });
    expect(fsStore.get(FILE)).toBe(transformed);
    expect(readTranslationText({ filePath: FILE, key: 'rich__r1', locale: 'en' })).toBe('Janie,');
  });

  test('transformed runs keep their persisted key in later listings', () => {
    commitTranslationText({ filePath: FILE, nodeId: 'rich__r1', locale: 'fr', defaultLocale: 'en', text: 'Jenny !' });
    const rows = listTranslatableTexts('en').filter(r => r.nodeId.startsWith('rich'));
    expect(rows.map(r => r.nodeId)).toEqual(['rich__r0', 'rich__r1', 'rich__r2']);
    expect(rows[1].source).toBe('Jenny,');          // from the seeded default message
  });
});

describe('commitTranslationAttr', () => {
  test('non-default locale: rewrites the attr to a t() call + seeds + writes', () => {
    commitTranslationAttr({
      filePath: FILE, nodeId: 'email', attr: 'placeholder', locale: 'fr',
      defaultLocale: 'en', text: 'jeanne@x.fr', transformed: false,
      fallbackDefaultValue: 'jane@x.com',
    });
    const code = fsStore.get(FILE)!;
    expect(code).toMatch(/placeholder=\{t\(["']email__attr_placeholder["']\)\}/);
    expect(readTranslationText({ filePath: FILE, key: 'email__attr_placeholder', locale: 'en' })).toBe('jane@x.com');
    expect(readTranslationText({ filePath: FILE, key: 'email__attr_placeholder', locale: 'fr' })).toBe('jeanne@x.fr');
  });

  test('default locale untransformed: plain attr write', () => {
    commitTranslationAttr({
      filePath: FILE, nodeId: 'email', attr: 'placeholder', locale: 'en',
      defaultLocale: 'en', text: 'you@site.com', transformed: false,
    });
    expect(fsStore.get(FILE)).toContain('you@site.com');
    expect(fsStore.get(FILE)).not.toContain('useTranslations');
  });
});

describe('migrateLegacyLocaleTextOverrides', () => {
  test('moves legacy text overrides into messages + transforms JSX, then retires the file', () => {
    fsStore.set('i18n/fr.json', JSON.stringify({
      pages: { [FILE]: { intro: { text: 'Peintre (legacy)' } } },
      collections: { blog: { item1: { title: 'Titre' } } },
    }));
    const config = { defaultLocale: 'en', locales: [{ code: 'en' }, { code: 'fr' }] };
    migrateLegacyLocaleTextOverrides(config);

    expect(readTranslationText({ filePath: FILE, key: 'intro', locale: 'fr' })).toBe('Peintre (legacy)');
    expect(readTranslationText({ filePath: FILE, key: 'intro', locale: 'en' })).toBe('Painter');
    expect(fsStore.get(FILE)).toMatch(/\{t\(["']intro["']\)\}/);
    const legacy = JSON.parse(fsStore.get('i18n/fr.json')!);
    expect(legacy.pages).toEqual({});
    expect(legacy.collections.blog.item1.title).toBe('Titre'); // preserved

    // Idempotent: second run is a no-op.
    migrateLegacyLocaleTextOverrides(config);
    expect(readTranslationText({ filePath: FILE, key: 'intro', locale: 'fr' })).toBe('Peintre (legacy)');
  });

  test('does not overwrite an existing messages value', () => {
    fsStore.set('messages/fr.json', JSON.stringify({ home: { intro: 'Déjà là' } }));
    fsStore.set('i18n/fr.json', JSON.stringify({ pages: { [FILE]: { intro: { text: 'Stale' } } }, collections: {} }));
    migrateLegacyLocaleTextOverrides({ defaultLocale: 'en', locales: [{ code: 'fr' }] });
    expect(readTranslationText({ filePath: FILE, key: 'intro', locale: 'fr' })).toBe('Déjà là');
  });
});


// ─── Instance plainText props (nested component variable texts) ───────────────
describe('instance plainText prop rows', () => {
  const COMP = `'use client';
/** @name "Frame" */
/** @propMeta {"content":{"type":"plainText","label":"zefzef"}} */
function MaVuVu({ content = "default text" }) {
  return <p data-id="text-1">{content}</p>;
}
export default MaVuVu;
`;
  const HOST = `'use client';
import MaVuVu from '@/components/MaVuVu';
export default function Page() {
  return <div data-id="root"><MaVuVu data-id="inst-1" data-name="Frame" content="gergrg" /></div>;
}
`;
  beforeEach(() => {
    fsStore.set('components/MaVuVu.tsx', COMP);
    fsStore.set(FILE, HOST);
  });

  test('enumeration lists the instance prop with its current value (variable-bound master has no literal text)', () => {
    const rows = listTranslatableTexts('en');
    const row = rows.find(r => r.nodeId === 'inst-1#content');
    expect(row).toBeDefined();
    expect(row!.source).toBe('gergrg');
    expect(row!.label).toContain('zefzef');
    expect(row!.instanceProp).toEqual({ componentName: 'MaVuVu', prop: 'content' });
  });

  test('nested instance INSIDE another component master is listed too', () => {
    fsStore.set('components/Outer.tsx', `'use client';
import MaVuVu from '@/components/MaVuVu';
function Outer() { return <div data-id="o-root"><MaVuVu data-id="nested-1" /></div>; }
export default Outer;
`);
    const row = listTranslatableTexts('en').find(r => r.filePath === 'components/Outer.tsx' && r.nodeId === 'nested-1#content');
    expect(row).toBeDefined();
    expect(row!.source).toBe('default text'); // master signature default — no attr on the nested instance
  });

  test('write fr → scoped expression; read roundtrips; default-locale edit rewrites the base', () => {
    commitTranslationText({ filePath: FILE, nodeId: 'inst-1#content', locale: 'fr', defaultLocale: 'en', text: 'bonjour' });
    const code = fsStore.get(FILE)!;
    expect(code).toContain("__activeLocale === 'fr'");
    expect(code).toContain('"bonjour"');
    expect(readTranslationText({ filePath: FILE, key: 'inst-1#content', locale: 'fr' })).toBe('bonjour');
    // Default-locale edit rewrites the BASE branch, keeping the fr scope.
    commitTranslationText({ filePath: FILE, nodeId: 'inst-1#content', locale: 'en', defaultLocale: 'en', text: 'hello' });
    const code2 = fsStore.get(FILE)!;
    expect(code2).toContain('"hello"');
    expect(code2).toContain('"bonjour"');
    expect(listTranslatableTexts('en').find(r => r.nodeId === 'inst-1#content')!.source).toBe('hello');
  });

  test('default-locale edit on a plain attr replaces the literal in place', () => {
    commitTranslationText({ filePath: FILE, nodeId: 'inst-1#content', locale: 'en', defaultLocale: 'en', text: 'plain new' });
    expect(fsStore.get(FILE)!).toContain('content="plain new"');
  });
});

// A node dragged onto the canvas is at MODULE scope: its JSX is a baked
// literal + `data-i18n-orphan`, and `t` does not exist there. Translating it
// must not inject a call — that is the exact crash dormancy prevents.

describe('translating a DORMANT canvas node', () => {
  const DORMANT = `'use client';
import { useTranslations } from "next-intl";
const canvasNodes = <div data-id="card" data-i18n-orphan="card">Lunch arrives by boat</div>;
export default function Page() {
  const t = useTranslations("home");
  return <div data-id="root" />;
}
`;

  beforeEach(() => { fsStore.set(FILE, DORMANT); });

  test('a non-default locale writes the message and leaves the JSX alone', () => {
    commitTranslationText({
      filePath: FILE, nodeId: 'card', locale: 'fr', defaultLocale: 'en',
      text: 'Le déjeuner arrive en bateau', fallbackDefaultText: 'Lunch arrives by boat',
    });
    expect(JSON.parse(fsStore.get('messages/fr.json')!).home.card).toBe('Le déjeuner arrive en bateau');
    // The JSX must be untouched — no `{t(...)}` at module scope.
    expect(fsStore.get(FILE)).toBe(DORMANT);
  });

  test('…and seeds the default message so the round trip is not lossy', () => {
    // Without this the node renders empty on the live site once it is dragged
    // back into the page and its `{t('card')}` call is restored.
    commitTranslationText({
      filePath: FILE, nodeId: 'card', locale: 'fr', defaultLocale: 'en',
      text: 'Le déjeuner', fallbackDefaultText: 'Lunch arrives by boat',
    });
    expect(JSON.parse(fsStore.get('messages/en.json')!).home.card).toBe('Lunch arrives by boat');
  });

  test('the DEFAULT locale also updates the baked literal', () => {
    // That literal is the copy actually showing on the canvas.
    commitTranslationText({
      filePath: FILE, nodeId: 'card', locale: 'en', defaultLocale: 'en', text: 'Dinner arrives by boat',
    });
    expect(JSON.parse(fsStore.get('messages/en.json')!).home.card).toBe('Dinner arrives by boat');
    expect(fsStore.get(FILE)).toContain('Dinner arrives by boat');
    expect(fsStore.get(FILE)).toContain('data-i18n-orphan="card"');   // stash preserved
  });

  test('the stash key is what gets written, not the node id', () => {
    fsStore.set(FILE, DORMANT.replace('data-i18n-orphan="card"', 'data-i18n-orphan="original-key"'));
    commitTranslationText({ filePath: FILE, nodeId: 'card', locale: 'fr', defaultLocale: 'en', text: 'X' });
    const fr = JSON.parse(fsStore.get('messages/fr.json')!);
    expect(fr.home['original-key']).toBe('X');
    expect(fr.home.card).toBeUndefined();
  });
});
