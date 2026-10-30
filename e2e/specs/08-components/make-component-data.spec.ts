// CMP · Make Component on subtrees that carry runtime state (E2E_TEST_PLAN.md
// §8, CMP-026..032, 036): translations + responsive text, instance effects,
// forms, overlays, slot canvas nodes and collection lists. The state and the
// hooks move with the JSX, the page keeps only what it still uses, and the
// live page keeps working.

import { test, expect } from '../../fixtures/test';
import type { Editor } from '../../helpers/editor';
import {
  i18nPage, FX_PAGE, OVERLAY_PAGE, slotPage, CMS_ROW_PAGE, PAGINATED_PAGE, FORM_PAGE,
  makeComponentViaMenu, exitToPage, allowMasterEntryNoise, allowPreviewNoise,
  parses, count, elementFacts, attrExpr, openPreview, hasDefaultImport, stableCode,
} from '../../helpers/c1';

const PAGE = 'app/page.client.tsx';

test.beforeEach(async ({ editor }) => {
  test.slow();
  allowMasterEntryNoise(editor);
  allowPreviewNoise(editor);
});

async function onPage(editor: Editor) {
  if ((await editor.activeFile()) !== PAGE) await exitToPage(editor);
}

async function switchLocale(editor: Editor, label: string) {
  const page = editor.page();
  await page.getByTitle('Language').click();
  await page.getByRole('button', { name: label }).click();
  await editor.settled();
}

test('CMP-026 translated and responsive text keep working inside the new master', { tag: ['@p1', '@cmp'] }, async ({ editor, page }) => {
  test.fail(true, 'BUG: the preview never renders a page that calls useTranslations (pageerror "context from NextIntlClientProvider was not found", already before Make Component) — the live check of the translated text cannot pass');
  await editor.load(i18nPage());
  const made = await makeComponentViaMenu(editor, 'card', 'Pricing Card', { at: [0.04, 0.03] });
  const master = await editor.code(made.file);

  // Its own responsive-text hook and translation hook…
  expect(count(master, /function useResponsiveText\(/)).toBe(1);
  expect(master).toContain('useResponsiveText("Everything in Basic, plus more."');
  expect(master).toMatch(/from ["']next-intl["']/);
  expect(master).toContain(`useTranslations("component:${made.tag}")`);
  expect(master).toMatch(/t\(["']card-title["']\)/);
  expect(await parses(master)).toBe(true);
  // …and the words copied into the component namespace, in every locale.
  expect(JSON.parse(await editor.code('messages/en.json'))[`component:${made.tag}`]?.['card-title']).toBe('Pro plan');
  expect(JSON.parse(await editor.code('messages/fr.json'))[`component:${made.tag}`]?.['card-title']).toBe('Forfait Pro');

  // Canvas, both locales. Not: empty text.
  await expect(editor.node('card-title')).toHaveText('Pro plan');
  await expect(editor.node('card-body')).toHaveText('Everything in Basic, plus more.');
  await switchLocale(editor, 'Français');
  await expect(editor.node('card-title')).toHaveText('Forfait Pro');
  await switchLocale(editor, 'English');
  await expect(editor.node('card-title')).toHaveText('Pro plan');

  // Preview. Not: a crash.
  await onPage(editor);
  const frame = await openPreview(page, 'Pro plan');
  await expect(frame.getByText('Everything in Basic, plus more.', { exact: true })).toBeVisible();
});

test('CMP-027 an instance fx (scroll transform) + scroll variant regenerate their hooks inside the master', { tag: ['@p1', '@cmp'] }, async ({ editor, page }) => {
  await editor.load(FX_PAGE);
  const made = await makeComponentViaMenu(editor, 'fx-frame', 'Fx Frame', { at: [0.9, 0.9] });
  const master = await editor.code(made.file);
  const pageCode = await editor.code(PAGE);

  // The hooks the instance binds are declared in the master…
  expect(master).toMatch(/const kidRef = useRef\(null\)/);
  expect(master).toMatch(/const \{ scrollYProgress: kidFxTfP \} = useScroll\(\{ target: kidRef/);
  expect(master).toMatch(/const kidFxTfRotate = useTransform\(kidFxTfP/);
  expect(master).toMatch(/const \[kidSv, setKidSv\] = useState\('default'\)/);
  const inst = (await elementFacts(master, 'kid'))!.source;
  expect(inst).toContain('initialVariant={kidSv}');
  expect(inst).toContain('rotate: kidFxTfRotate');
  expect(inst).toContain('data-instance-fx=');
  expect(inst).toContain('data-scroll-variant=');
  expect(await parses(master)).toBe(true);
  // …and the page's copies are pruned (no undefined <cn>FxC… / <cn>Sv anywhere).
  expect(pageCode).not.toMatch(/kidFx|kidSv|kidRef/);
  await expect(editor.sandbox().getByText('Hover me', { exact: true }).first()).toBeVisible();

  // The effect still runs live: the badge is rotated by its scroll progress.
  await onPage(editor);
  const frame = await openPreview(page, 'Hover me');
  const badge = frame.locator('[data-id="kid"]').first();
  await expect.poll(() => badge.evaluate(el => getComputedStyle(el).transform), { timeout: 10_000 }).not.toMatch(/^(none|matrix\(1, 0, 0, 1, 0, 0\))$/);
});

test('CMP-029 overlays: a root trigger stays on the page on the instance; a descendant trigger moves its overlay into the master', { tag: ['@p1', '@cmp'] }, async ({ editor, page }) => {
  await editor.load(OVERLAY_PAGE);

  // Root trigger.
  const a = await makeComponentViaMenu(editor, 'trig', 'Trigger', { at: [0.5, 0.5] });
  const masterA = await editor.code(a.file);
  expect(masterA).not.toContain('data-overlay-trigger');
  expect(masterA).not.toContain('setOvOneOpen');
  let pageCode = await editor.code(PAGE);
  const instA = (await elementFacts(pageCode, 'trig'))!;
  expect(instA.tag).toBe(a.tag);
  expect(instA.source).toContain('"targetId":"ov-one"');
  expect(attrExpr(instA.source, 'onClick')).toContain('setOvOneOpen(');
  expect(pageCode).toContain('data-id="ov-one"');
  expect(pageCode).toMatch(/const \[ovOneOpen, setOvOneOpen\] = useState\(false\)/);
  await exitToPage(editor);
  await page.waitForTimeout(450);

  // Descendant trigger.
  const b = await makeComponentViaMenu(editor, 'ov-host', 'Overlay Host', { at: [0.9, 0.5] });
  const masterB = await editor.code(b.file);
  expect(masterB).toMatch(/const \[ovTwoOpen, setOvTwoOpen\] = (?:React\.)?useState\(false\)/);
  expect(masterB).toContain('data-id="ov-two"');
  expect(attrExpr((await elementFacts(masterB, 'ov-btn'))!.source, 'onClick')).toContain('setOvTwoOpen(');
  expect(await parses(masterB)).toBe(true);
  pageCode = await editor.code(PAGE);
  expect(pageCode).not.toContain('ovTwoOpen');
  expect(pageCode).not.toContain('data-id="ov-two"');
  expect(await parses(pageCode)).toBe(true);

  // Both overlays still open live.
  await exitToPage(editor);
  const frame = await openPreview(page, 'Bare label');
  await frame.locator('[data-id="trig"]').first().click();
  await expect(frame.getByText('Overlay one', { exact: true })).toBeVisible();
  await frame.locator('[data-id="ov-btn"]').first().click();
  await expect(frame.getByText('Overlay two', { exact: true })).toBeVisible();
});

test('CMP-030 a Marquee with connected cn_ slot nodes: the slot consts are duplicated into the master', { tag: ['@p1', '@cmp'] }, async ({ editor }) => {
  await editor.load(slotPage());
  const made = await makeComponentViaMenu(editor, 'strip-host', 'Strip', { at: [0.98, 0.05] });
  const master = await editor.code(made.file);

  const aName = /const (cn_slot_a_[a-z0-9]{6})\s*=/.exec(master)?.[1];
  const bName = /const (cn_slot_b_[a-z0-9]{6})\s*=/.exec(master)?.[1];
  expect(aName).toBeTruthy();
  expect(bName).toBeTruthy();
  expect(master).toContain(`{${aName}}{${bName}}`);
  // Fresh ids, parked left of the master tile, below the export.
  expect(master).toMatch(/data-id="slot-a-[a-z0-9]{6}"/);
  const declA = new RegExp(`const ${aName}\\s*=\\s*[\\s\\S]*?;`).exec(master)![0];
  expect(declA).toMatch(/left:\s*'-\d+px'/);
  expect(master.indexOf(`const ${aName}`)).toBeGreaterThan(master.indexOf('export default'));
  // The instance inside a slot const keeps its import.
  expect(hasDefaultImport(master, 'Badge')).toBe(true);
  expect(hasDefaultImport(master, 'Marquee')).toBe(true);
  expect(await parses(master)).toBe(true);
  // Not: a blank master — the marquee paints its items.
  await expect.poll(async () => (await editor.nodeBox('strip')).height).toBeGreaterThan(10);
  await expect(editor.sandbox().getByText('New', { exact: true }).first()).toBeVisible();
});

test('CMP-031 the template row of a collection list hoists its fields to props; every row keeps its own item', { tag: ['@p1', '@cmp'] }, async ({ editor }) => {
  test.fail(true, 'BUG: with a nav-Link row root, the hoisted field props (name, photo) are injected into the MotionLink forwardRef shim\'s params instead of the master\'s — `name`/`photo` are undefined in the component (WOULD_CRASH)');
  await editor.load(CMS_ROW_PAGE);
  const made = await makeComponentViaMenu(editor, 'team-row', 'Member', { at: [0.97, 0.5] });
  const master = await editor.code(made.file);
  const pageCode = await editor.code(PAGE);

  // The nav link became a linkHref variable; the fields are typed props.
  expect(master).toMatch(/"photo":\{"type":"image"/);
  expect(master).toMatch(/"name":\{"type":"\w+"/);
  expect(master).toMatch(/backgroundImage: photo\b/);
  expect(master).toMatch(/href=\{linkHref\}/);
  expect(master).not.toMatch(/\bitem\./);
  expect(await parses(master)).toBe(true);

  // The instance inside the surviving .map() passes each row's item.
  const inst = (await elementFacts(pageCode, 'team-row'))!;
  expect(inst.tag).toBe(made.tag);
  expect(inst.source).toContain('name={item.name}');
  expect(inst.source).toContain('photo={`url(${item.photo})`}');
  expect(inst.source).toMatch(/linkHref=\{`\/team\/\$\{item\?\._slug \?\? ''\}`\}/);
  expect(inst.source).toContain('key={idx}');
  expect((await editor.style('team-row', PAGE)).position).toBe('relative');
  expect(pageCode).toContain('team.map((item, idx)');

  // The hoisted fields are params of the MASTER, defaulted from the first item.
  const params = new RegExp(`function ${made.tag}\\(\\{([\\s\\S]*?)\\}: \\{`).exec(master)?.[1] ?? '';
  expect(params).toMatch(/\blinkHref\b/);
  expect(params).toMatch(/name = "Alice Johnson"/);
  expect(params).toMatch(/photo = "url\(data:image/);

  // Every row shows its own item on the page.
  await onPage(editor);
  for (const name of ['Alice Johnson', 'Bob Smith', 'Carol Davis']) {
    await expect(editor.sandbox().getByText(name, { exact: true }).first()).toBeVisible();
  }
});

test('CMP-032 a whole paginated collection list keeps its row bindings and carries its pagination state', { tag: ['@p1', '@cmp'] }, async ({ editor, page }) => {
  await editor.load(PAGINATED_PAGE);
  const made = await makeComponentViaMenu(editor, 'blogs', 'Blogs', { at: [0.98, 0.02] });
  const master = await editor.code(made.file);
  const pageCode = await editor.code(PAGE);

  // Rows keep `item.*` verbatim — no first-item hoist.
  expect(master).toContain('{item.title}');
  expect(master).not.toMatch(/title = "/);
  expect(master).toContain('blog.slice(0, visBlogs).map((item, idx)');
  // The pagination state moved into the master; the page's copy is pruned.
  expect(master).toMatch(/const \[visBlogs, setVisBlogs\] = (?:React\.)?useState\(2\)/);
  expect(master).toContain('{visBlogs < blog.length && <LoadMore');
  expect(hasDefaultImport(master, 'LoadMore')).toBe(true);
  expect(await parses(master)).toBe(true);
  expect(pageCode).not.toContain('visBlogs');
  expect((await elementFacts(pageCode, 'blogs'))?.tag).toBe(made.tag);

  // Load More works live. Not: every row shows item 1, not: "visBlogs is not defined".
  await onPage(editor);
  const frame = await openPreview(page, 'Launching v2.0');
  await expect(frame.getByText('Building a Design System', { exact: true })).toBeVisible();
  await expect(frame.getByText('We are hiring', { exact: true })).toHaveCount(0);
  await frame.getByText('Load More', { exact: true }).click();
  await expect(frame.getByText('We are hiring', { exact: true })).toBeVisible();
});

const FORM_STATE = 'formStateContactform';

test('CMP-036 a form frame with a FormSubmit: the master re-declares its formState', { tag: ['@p2', '@cmp'] }, async ({ editor, page }) => {
  test.fail(true, 'BUG: Make Component scaffolds a useTranslations hook into the form master — collectTranslationKeys counts every `ident("literal")` call, so setFormStateContactform("loading") reads as a t() key — and the master crashes the live page (no NextIntl context)');
  await editor.load(FORM_PAGE);
  const made = await makeComponentViaMenu(editor, 'contact-form', 'Contact Form', { at: [0.98, 0.02] });
  const master = await editor.code(made.file);
  // The lifecycle state the onSubmit + FormSubmit reference is declared once in the master.
  expect(count(master, new RegExp(`const \\[${FORM_STATE}, setFormStateContactform\\] = (?:React\\.)?useState\\('idle'\\)`))).toBe(1);
  expect(master).toContain(`setFormStateContactform("loading")`);
  expect((await elementFacts(master, 'form-submit'))?.source).toContain(`initialVariant={${FORM_STATE} === 'loading'`);
  expect(await parses(master)).toBe(true);
  await expect(editor.node('form-heading')).toHaveText('Get in touch');
  // Not translated: no translation scaffold invented for the form's state calls.
  expect(master).not.toContain('useTranslations');

  // Submit still cycles the button live (the form relay is stubbed to succeed).
  // Not: "formStateContactform is not defined".
  await page.route('**/api/form', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
  await onPage(editor);
  const frame = await openPreview(page, 'Get in touch');
  await frame.getByPlaceholder('Name').fill('Ada');
  await frame.getByPlaceholder('Email').fill('ada@example.com');
  await frame.getByText('Send', { exact: true }).first().click();
  await expect(frame.locator('[data-id="formsubmit-success"]').first()).toBeVisible({ timeout: 10_000 });
});

test('CMP-028 a form master: unmapping a Form State leaves exactly one formState declaration', { tag: ['@p1', '@cmp'] }, async ({ editor, page }) => {
  await editor.load(FORM_PAGE);
  const made = await makeComponentViaMenu(editor, 'contact-form', 'Footer Form', { at: [0.98, 0.02] });
  const declRe = new RegExp(`const \\[${FORM_STATE}\\b`, 'g');
  expect(count(await editor.code(made.file), declRe)).toBe(1);

  // Select the FormSubmit in the master → Form State → Loading: Not mapped.
  await editor.select(['form-submit'], 'desktop');
  await expect.poll(() => editor.selection()).toEqual(['form-submit']);
  const before = await stableCode(editor, made.file);
  // Form State rows list Loading first (then Success); each row's select offers "Not mapped".
  const panel = page.locator('[data-tutorial="right-toolbar"]').first();
  await expect(panel.getByText('Form State', { exact: true })).toBeVisible();
  const loading = panel.locator('select', { has: page.locator('option', { hasText: 'Not mapped' }) }).first();
  await loading.selectOption({ label: 'Not mapped' });

  await expect.poll(async () => (await editor.code(made.file)) !== before).toBe(true);
  const after = await editor.code(made.file);
  // Not: a duplicate const that makes the component vanish.
  expect(count(after, declRe)).toBe(1);
  expect(await parses(after)).toBe(true);
  const submit = (await elementFacts(after, 'form-submit'))!.source;
  expect(submit).toContain(`data-form-state='{"success":"success"}'`);
  expect(submit).not.toContain(`=== 'loading'`);
  // The master tile and the page instance still render.
  await expect(editor.node('form-submit')).toBeVisible();
  await expect(editor).toUndoInOneStep(before, { path: made.file });
  await onPage(editor);
  await expect(editor.sandbox().getByText('Get in touch').first()).toBeVisible();
});
