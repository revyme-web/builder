// Pages, routing, assets, vectors & publish — audit §11.
import type { CapabilityCase } from '../harness';
import { HOME, ABOUT, FIXTURE_FILES } from '../fixture';
import { buildIconSetFile } from '@/code/icons/icon-set-template';

/** A one-icon set, open on the canvas — the icon-set surface. */
const NAV_SET = 'icons/NavIcons.tsx';
const NAV_SET_FILE = buildIconSetFile('NavIcons', 'Nav icons', [{
  id: 'icon-1', displayName: 'menu', leftPx: 0, topPx: 0, widthPx: 240, heightPx: 240,
  svgJSX: '<svg viewBox="0 0 24 24" style={{ width: \'100%\', height: \'100%\' }}><path d="M4 6h16" stroke="#000000" strokeWidth={2} /></svg>',
}]);
const CLOSE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#000000" stroke-width="2"><path d="M6 6l12 12"/><path d="M18 6L6 18"/></svg>';
const PLUS_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#000000" stroke-width="2"><path d="M12 5v14"/><path d="M5 12h14"/></svg>';

const must = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };

export const PAGES_ASSETS_CASES: CapabilityCase[] = [
  {
    id: 'pages-assets/create-page', domain: 'pages-assets', status: 'supported',
    feature: 'Create a page (server + client pair)',
    ask: 'add a Pricing page',
    calls: [{ tool: 'create_page', args: { name: 'Pricing' } }],
    expect: (w) => {
      must(w.read('app/pricing/page.client.tsx') && w.read('app/pricing/page.tsx'), 'the page pair was not written');
      must(/data-id="root"/.test(w.read('app/pricing/page.client.tsx') ?? ''), 'the new page has no root');
    },
  },
  {
    id: 'pages-assets/create-then-build', domain: 'pages-assets', status: 'supported',
    feature: 'Build on a page right after creating it',
    ask: 'add a Pricing page with a title',
    calls: [
      { tool: 'create_page', args: { name: 'Pricing' } },
      { tool: 'add_node', args: { parent_id: 'root', tag: 'h1', id: 'pricing-title', text: 'Pricing', styles: { fontSize: '48px', margin: '0px' } } },
    ],
    expect: (w) => {
      must(/pricing-title/.test(w.read('app/pricing/page.client.tsx') ?? ''), 'the title landed somewhere else than the new page');
      must(!/pricing-title/.test(w.read(HOME) ?? ''), 'the title landed on the home page');
    },
  },
  {
    id: 'pages-assets/nested-route', domain: 'pages-assets', status: 'supported',
    feature: 'Nested route',
    ask: 'add a page at /blog/authors',
    calls: [{ tool: 'create_page', args: { name: 'Authors', dir: 'app/blog' } }],
    expect: (w) => must(w.read('app/blog/authors/page.client.tsx'), 'no nested page'),
  },
  {
    id: 'pages-assets/switch-page', domain: 'pages-assets', status: 'supported',
    feature: 'Switch to another page and edit it',
    ask: 'on the about page, change the title to "Our story"',
    calls: [
      { tool: 'set_page', args: { page: 'about' } },
      { tool: 'set_text', args: { node_id: 'about-title', text: 'Our story' } },
    ],
    expect: (w) => must(/Our story/.test(w.read(ABOUT) ?? '') && !/Our story/.test(w.read(HOME) ?? ''), 'the edit did not land on the about page'),
  },
  {
    id: 'pages-assets/list-pages', domain: 'pages-assets', status: 'supported',
    feature: 'List the pages',
    ask: 'what pages do I have?',
    calls: [{ tool: 'list_pages', args: {} }],
    expect: (w) => must(/about/.test(w.replies[0].text), 'the about page is not listed'),
  },
  {
    id: 'pages-assets/link', domain: 'pages-assets', status: 'supported',
    feature: 'Link an element to a page',
    ask: 'make the first card go to the about page',
    calls: [{ tool: 'set_link', args: { node_id: 'card-1', href: '/about' } }],
    expect: (w) => {
      const tag = w.tag('card-1');
      must(/^<Link\b/.test(tag) && /href="\/about"/.test(tag), `not a <Link href="/about">: ${tag.slice(0, 80)}`);
      must(/import Link from 'next\/link'/.test(w.read(HOME) ?? ''), 'Link is not imported');
    },
  },
  {
    id: 'pages-assets/link-external', domain: 'pages-assets', status: 'supported',
    feature: 'Link to an external site, in a new tab',
    ask: 'make the first card open our GitHub in a new tab',
    calls: [{ tool: 'set_link', args: { node_id: 'card-1', href: 'https://github.com/flowa', new_tab: true } }],
    expect: (w) => {
      const tag = w.tag('card-1');
      must(/^<a\b/.test(tag) && /target="_blank"/.test(tag) && /rel="noopener noreferrer"/.test(tag), `not an <a target=_blank rel=…>: ${tag.slice(0, 120)}`);
    },
  },
  {
    id: 'pages-assets/link-anchor', domain: 'pages-assets', status: 'supported',
    feature: 'Anchor link with smooth scroll',
    ask: 'make the first card scroll smoothly to the cards section',
    calls: [{ tool: 'set_link', args: { node_id: 'card-1', href: '#cards', smooth_scroll: true } }],
    expect: (w) => must(/href="#cards"/.test(w.tag('card-1')) && /data-smooth-scroll="true"/.test(w.tag('card-1')), 'no smooth anchor link'),
  },
  {
    id: 'pages-assets/link-remove', domain: 'pages-assets', status: 'supported',
    feature: 'Remove a link',
    ask: 'the first card should not be a link any more',
    calls: [
      { tool: 'set_link', args: { node_id: 'card-1', href: '/about' } },
      { tool: 'set_link', args: { node_id: 'card-1', href: '' } },
    ],
    expect: (w) => must(/^<div\b/.test(w.tag('card-1')) && !/href=/.test(w.tag('card-1')), 'still a link'),
  },
  {
    id: 'pages-assets/link-on-master', domain: 'pages-assets', status: 'supported',
    feature: 'A link inside a design component keeps its motion',
    ask: 'make the button link to /pricing',
    activeFile: 'components/PrimaryButton.tsx',
    calls: [{ tool: 'set_link', args: { node_id: 'pb-root', href: '/pricing' } }],
    expect: (w) => {
      const code = w.read('components/PrimaryButton.tsx') ?? '';
      const tag = w.tag('pb-root', 'components/PrimaryButton.tsx');
      must(/^<MotionLink\b/.test(tag) && /href="\/pricing"/.test(tag), `not a <MotionLink>: ${tag.slice(0, 80)}`);
      must(/variants=\{pbRootVariants\}/.test(tag), 'the master lost its variants');
      must(/const MotionLink = motion\.create\(/.test(code), 'MotionLink is not declared');
    },
  },
  {
    id: 'pages-assets/image-frame', domain: 'pages-assets', status: 'supported',
    feature: 'Place an image (as a frame with a background)',
    ask: 'put a photo of a mountain lake in the second card',
    // A fill is a colour OR image layers, never both — the image replaces the
    // card's colour (BG_COLOR_WITH_IMAGE).
    calls: [{ tool: 'set_styles', args: { node_id: 'card-2', styles: { backgroundColor: '', backgroundImage: 'url(https://images.unsplash.com/photo-lake?w=800)', backgroundSize: 'cover', backgroundPosition: 'center' } } }],
    expect: (w) => must(/photo-lake/.test(String(w.node('card-2').styles.backgroundImage)) && w.node('card-2').styles.backgroundSize === 'cover', 'the image is not set as a cover background'),
  },
  {
    id: 'pages-assets/read-source', domain: 'pages-assets', status: 'supported',
    feature: 'Read a file\'s source',
    ask: '(internal) read the about page',
    calls: [{ tool: 'read_source', args: { path: ABOUT } }],
    expect: (w) => must(/about-title/.test(w.replies[0].text), 'the source was not returned'),
  },
  {
    id: 'pages-assets/tree', domain: 'pages-assets', status: 'supported',
    feature: 'Read the page tree and one node',
    ask: '(internal) inspect the page',
    calls: [{ tool: 'get_node_tree', args: {} }, { tool: 'get_node', args: { node_id: 'hero-title' } }],
    expect: (w) => must(/hero-title/.test(w.replies[0].text) && /64px/.test(w.replies[1].text), 'the tree or the node detail is wrong'),
  },

  // ── not possible yet ──
  {
    id: 'pages-assets/delete-page', domain: 'pages-assets', status: 'supported',
    feature: 'Delete a page',
    ask: 'delete the about page',
    calls: [{ tool: 'delete_page', args: { page: '/about' } }],
    expect: (w) => must(w.read(ABOUT) === null && w.read('app/about/page.tsx') === null, 'the page pair is still there'),
  },
  {
    id: 'pages-assets/delete-home-refused', domain: 'pages-assets', status: 'supported',
    feature: 'The home page cannot be deleted',
    ask: 'delete the home page',
    calls: [{ tool: 'delete_page', args: { page: '/' } }],
    allowFailedCalls: true,
    expect: (w) => must(w.replies[0].isError && w.read(HOME) !== null, 'the home page was deleted'),
  },
  {
    id: 'pages-assets/rename-page', domain: 'pages-assets', status: 'supported',
    feature: 'Rename a page / change its route',
    ask: 'rename About to Company',
    calls: [{ tool: 'rename_page', args: { page: '/about', new_name: 'Company' } }],
    expect: (w) => {
      must(w.read('app/company/page.client.tsx') && w.read('app/company/page.tsx'), 'no page at /company');
      must(w.read(ABOUT) === null, 'the old page is still there');
      must(/about-title/.test(w.read('app/company/page.client.tsx') ?? ''), 'the content did not move');
    },
  },
  {
    id: 'pages-assets/duplicate-page', domain: 'pages-assets', status: 'supported',
    feature: 'Duplicate a page',
    ask: 'duplicate the about page as "Team"',
    calls: [{ tool: 'duplicate_page', args: { page: '/about', new_name: 'Team' } }],
    expect: (w) => {
      must(w.read('app/team/page.client.tsx') && w.read('app/team/page.tsx'), 'no copy at /team');
      must(w.read(ABOUT) !== null, 'the source is gone');
      must(/about-title/.test(w.read('app/team/page.client.tsx') ?? ''), 'the copy is empty');
    },
  },
  {
    id: 'pages-assets/seo-metadata', domain: 'pages-assets', status: 'supported',
    feature: 'Page title / description (SEO)',
    ask: 'set the about page title to "About us — Flowa" with a description',
    calls: [{ tool: 'set_page_metadata', args: { page: '/about', title: 'About us — Flowa', description: 'Who we are.', og_image: 'https://images.unsplash.com/photo-og?w=1200' } }],
    expect: (w) => {
      const server = w.read('app/about/page.tsx') ?? '';
      must(/About us — Flowa/.test(server) && /Who we are\./.test(server) && /photo-og/.test(server), `metadata not written: ${server.slice(0, 300)}`);
      must(!/About us/.test(w.read(ABOUT) ?? ''), 'it landed in the client body instead of the server wrapper');
    },
  },
  {
    id: 'pages-assets/site-metadata', domain: 'pages-assets', status: 'supported',
    feature: 'Site favicon / metadata',
    ask: 'set the site title and favicon',
    files: { 'app/layout.tsx': `import './globals.css';\nimport type { Metadata } from 'next';\nimport LayoutClient from './LayoutClient';\n\nexport const metadata = { title: 'Site' };\n\nexport default function RootLayout({ children }: { children: React.ReactNode }) {\n  return <html lang="en"><body><LayoutClient>{children}</LayoutClient></body></html>;\n}\n` },
    calls: [{ tool: 'set_site_metadata', args: { title: 'Flowa', favicon: 'https://cdn.example.com/favicon.png' } }],
    expect: (w) => {
      const layout = w.read('app/layout.tsx') ?? '';
      must(/Flowa/.test(layout) && /favicon\.png/.test(layout), `not written: ${layout.slice(0, 300)}`);
    },
  },
  {
    id: 'pages-assets/seo-full', domain: 'pages-assets', status: 'supported',
    feature: 'Page SEO — canonical, robots, Twitter / X card',
    ask: 'set the about page canonical, keep it out of search, and give it a large Twitter card',
    calls: [{ tool: 'set_page_metadata', args: { page: '/about', canonical: 'https://flowa.com/about', index: false, twitter_card: 'summary_large_image', twitter_title: 'About Flowa' } }],
    expect: (w) => {
      const server = w.read('app/about/page.tsx') ?? '';
      must(/https:\/\/flowa\.com\/about/.test(server) && /canonical/.test(server), `canonical not written: ${server.slice(0, 400)}`);
      must(/index:\s*false/.test(server), 'robots noindex not written');
      must(/summary_large_image/.test(server) && /About Flowa/.test(server), 'twitter card not written');
    },
  },
  {
    id: 'pages-assets/site-settings', domain: 'pages-assets', status: 'supported',
    feature: 'Website settings — language, theme, custom code (head / body)',
    ask: 'set the site language to French, dark by default, and add my analytics snippet to the head',
    files: { 'app/layout.tsx': `import './globals.css';\nimport type { Metadata } from 'next';\nimport LayoutClient from './LayoutClient';\n\nexport const metadata = { title: 'Site' };\n\nexport default function RootLayout({ children }: { children: React.ReactNode }) {\n  return <html lang="en"><body><LayoutClient>{children}</LayoutClient></body></html>;\n}\n` },
    calls: [{ tool: 'set_site_metadata', args: { language: 'fr', theme: 'dark', custom_code_head: '<script defer src="https://plausible.io/js/script.js"></script>', custom_code_body: '<!-- chat widget -->' } }],
    expect: (w) => {
      const layout = w.read('app/layout.tsx') ?? '';
      must(/language/.test(layout) && /['"]fr['"]/.test(layout), `language not written: ${layout.slice(0, 500)}`);
      must(/theme/.test(layout) && /['"]dark['"]/.test(layout), 'theme not written');
      must(/plausible\.io/.test(layout) && /chat widget/.test(layout), 'custom code not written');
      must(w.replies[0].data?.settings?.language === 'fr', 'the reply does not read the settings back');
    },
  },
  {
    id: 'pages-assets/seo-audit', domain: 'pages-assets', status: 'supported',
    feature: 'SEO audit — what is missing on every page',
    ask: 'check the SEO of my site',
    calls: [{ tool: 'get_seo', args: {} }],
    expect: (w) => {
      const d = w.replies[0].data;
      must(Array.isArray(d?.pages) && d.pages.length > 0, 'no pages audited');
      must(d.pages.every((p: { missing?: unknown }) => Array.isArray(p.missing)), 'no missing[] per page');
      must(typeof d.site?.name === 'string' && Array.isArray(d.site?.missing), 'no site settings');
    },
  },
  {
    id: 'pages-assets/upload-asset', domain: 'pages-assets', status: 'supported',
    feature: 'Host an image in the project\'s own storage',
    ask: 'save this image to my media library',
    calls: [{ tool: 'upload_image', args: { url: 'https://images.unsplash.com/photo-1?w=1600' } }],
    // The download goes through the service and the upload through the
    // signed-in editor; headless there is neither, so the tool must say so.
    allowFailedCalls: true,
    // (The fixture URL is not a real photo — a running service reports the 404 honestly.)
    expect: (w) => must(/^https?:\/\//.test(w.replies[0].data?.url ?? '') || /Could not reach|Could not download|No website is open|view-only/.test(w.replies[0].text), 'neither a hosted url nor an honest failure'),
  },
  {
    id: 'pages-assets/asset-library', domain: 'pages-assets', status: 'supported',
    feature: 'Search the 3D asset library',
    ask: 'find a glass sphere illustration',
    calls: [{ tool: 'find_assets', args: { query: 'glass sphere', limit: 3 } }],
    // The catalog lives in the service; the tool is on the surface and fails
    // HONESTLY when the service is not reachable (same contract as load_manual).
    allowFailedCalls: true,
    expect: (w) => must(Array.isArray(w.replies[0].data?.assets) || /Could not reach/.test(w.replies[0].text), 'neither results nor an honest failure'),
  },
  {
    id: 'pages-assets/background-video', domain: 'pages-assets', status: 'supported',
    feature: 'Background video',
    ask: 'put a looping video behind the hero',
    calls: [{ tool: 'set_background_video', args: { node_id: 'hero', src: 'https://cdn.example.com/loop.mp4' } }],
    expect: (w) => {
      const code = w.read(HOME) ?? '';
      must(/data-bg-video/.test(code), 'no background video child');
      must(/loop\.mp4/.test(code) && /muted/.test(code) && /autoPlay/.test(code), 'the video is not a muted autoplaying loop');
    },
  },
  {
    id: 'pages-assets/svg-shape', domain: 'pages-assets', status: 'supported',
    feature: 'Draw / edit an SVG shape',
    ask: 'add a wavy divider under the hero and a blue circle in the first card',
    calls: [
      { tool: 'add_shape', args: { parent_id: 'root', index: 1, shape: 'path', width: 1440, height: 80, fill: '#f4f4f5', d: 'M0,40 C360,80 1080,0 1440,40 L1440,80 L0,80 Z', name: 'Wave divider' } },
      { tool: 'add_shape', args: { parent_id: 'card-1', shape: 'ellipse', width: 48, height: 48, fill: '#2563eb' } },
      { tool: 'set_styles', args: { node_id: '$node_id', styles: { position: 'absolute', left: '16px', top: '16px' } } },
    ],
    expect: (w) => {
      const wave = w.replies[0].data?.node_id;
      must(wave && w.node(wave).type === 'svg' && /preserveAspectRatio="none"/.test(w.tag(wave)), 'the wave is not a stretchable svg wrapper');
      must(/M0,40 C360,80/.test(w.read(HOME) ?? ''), 'the path data is not in the page');
      const circle = w.replies[1].data?.node_id;
      must(circle && w.node(circle).parentId === 'card-1' && w.node(circle).styles.position === 'absolute', 'the circle is not absolute in the card');
      const geom = w.node(`${circle}-g0`);
      must(geom && geom.type === 'path' && geom.attrs?.fill === '#2563eb' && /^M/.test(geom.attrs?.d ?? ''), `the ellipse is not a path child with the fill: ${JSON.stringify(geom?.attrs)}`);
    },
  },
  {
    id: 'pages-assets/icon-set', domain: 'pages-assets', status: 'supported',
    feature: 'Create an icon set',
    ask: 'make an icon set from these two SVGs',
    calls: [{ tool: 'create_icon_set', args: { name: 'Nav icons', icons: [
      { name: 'menu', svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#000000" stroke-width="2"><path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/></svg>' },
      { name: 'close', svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#000000" stroke-width="2"><path d="M6 6l12 12"/><path d="M18 6L6 18"/></svg>' },
    ] } }],
    expect: (w) => {
      const file = w.replies[0].data?.file;
      must(file && /^icons\/.+\.tsx$/.test(file) && w.read(file) !== null, `no icon set file: ${w.replies[0].text.slice(0, 200)}`);
      must(w.replies[0].data?.icons === 2, 'both icons should be in the set');
      const code = w.read(file) ?? '';
      must(/label: 'menu'/.test(code) && /label: 'close'/.test(code) && /@iconSet/.test(code), 'the set does not declare a variant per icon');
    },
  },
  {
    id: 'pages-assets/icon-set-grow', domain: 'pages-assets', status: 'supported',
    feature: 'Add icons to the open icon set, take one out',
    ask: 'add a close and a plus icon to this set — actually drop the close one',
    files: { [NAV_SET]: NAV_SET_FILE },
    activeFile: NAV_SET,
    calls: [
      { tool: 'add_icons_to_set', args: { icons: [{ name: 'close', svg: CLOSE_SVG }, { name: 'plus', svg: PLUS_SVG }] } },
      { tool: 'remove_icon_from_set', args: { icon: 'close' } },
    ],
    expect: (w) => {
      must(w.replies[0].data?.added?.length === 2 && w.replies[0].data?.set === NAV_SET, `not added to the open set: ${w.replies[0].text.slice(0, 200)}`);
      must(w.replies[0].data?.icons_in_set === 3, 'the set should hold 3 icons after the add');
      const code = w.read(NAV_SET) ?? '';
      must(/label: 'plus'/.test(code) && /label: 'menu'/.test(code), 'the set lost an icon it should keep');
      must(!/label: 'close'/.test(code) && w.replies[1].data?.icons_in_set === 2, 'the close icon is still in the set');
    },
  },
  {
    id: 'pages-assets/icon-set-refusals', domain: 'pages-assets', status: 'supported',
    feature: 'Adding to an icon set needs one; a set keeps its last icon',
    ask: '(safety) add icons with no set open; remove the only icon',
    files: { [NAV_SET]: NAV_SET_FILE },
    calls: [
      { tool: 'add_icons_to_set', args: { icons: [{ name: 'plus', svg: PLUS_SVG }] } },
      { tool: 'remove_icon_from_set', args: { set: NAV_SET, icon: 'menu' } },
      { tool: 'add_icons_to_set', args: { set: NAV_SET, icons: [{ name: 'bad', svg: 'not svg at all' }] } },
    ],
    allowFailedCalls: true,
    expect: (w) => {
      must(w.replies.every((r) => r.isError), 'one of the refusals did not hold');
      must(/No icon set/.test(w.replies[0].text), 'no set open should say so');
      must(/at least one icon/.test(w.replies[1].text), 'removing the last icon should be refused');
    },
  },
  {
    id: 'pages-assets/publish-check', domain: 'pages-assets', status: 'supported',
    feature: 'Check the site is publishable',
    ask: 'is the site ready to publish?',
    calls: [{ tool: 'check_project', args: {} }],
    expect: (w) => {
      must(w.replies[0].data?.ready === true, `the clean fixture is reported not ready: ${w.replies[0].text.slice(0, 300)}`);
      must(w.replies[0].data?.checked_files >= 4, 'not every page / component was checked');
    },
  },
  {
    id: 'pages-assets/publish-check-blocks', domain: 'pages-assets', status: 'supported',
    feature: 'The publish check names a file that would break',
    ask: 'is the site ready to publish? (with a broken about page)',
    files: { [ABOUT]: (FIXTURE_FILES[ABOUT]).replace('<h1 data-id="about-title"', '<h1') },
    calls: [{ tool: 'check_project', args: {} }],
    expect: (w) => {
      const d = w.replies[0].data;
      must(d?.ready === false || d?.drift > 0, 'the broken page was not reported');
      must(JSON.stringify(d?.files).includes(ABOUT) && /MISSING_DATA_ID/.test(JSON.stringify(d?.files)), 'the file and rule are not named');
    },
  },
];
