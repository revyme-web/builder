// Code components, overrides, plugins, templates & marketplace — audit §10.
import type { CapabilityCase } from '../harness';
import { HOME, GALAXY, FIXTURE_FILES } from '../fixture';

const must = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };

/** The fixture's Galaxy with its speed control's default changed 1 → 2. */
const GALAXY_FASTER = FIXTURE_FILES[GALAXY]
  .replace('"default": 1, "step": 0.1', '"default": 2, "step": 0.1')
  .replace('speed = 1,', 'speed = 2,');

const NEW_CODE_COMPONENT = `'use client';

/** @label "Pulse" */
/** @comment "A dot that pulses" */
/** @defaultWidth 120 */
/** @defaultHeight 120 */
/** @controls {
  "color": { "type": "color", "label": "Color", "default": "#f97316" }
} */

import { useEffect, useRef } from 'react';
import { withResponsiveProps, useStaticCanvas } from '@revyme/runtime';

function Pulse({
  color = '#f97316',
  ...props
}: {
  color?: string;
  [key: string]: any;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const isStatic = useStaticCanvas();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (isStatic) { el.style.transform = 'scale(1)'; return; }
    let raf = 0;
    const tick = (t: number) => { el.style.transform = \`scale(\${1 + Math.sin(t / 400) * 0.1})\`; raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isStatic]);

  return (
    <div {...props} style={{ position: 'relative', width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', ...props.style }}>
      <div ref={ref} style={{ width: '40px', height: '40px', borderRadius: '50%', backgroundColor: color }} />
    </div>
  );
}

export default withResponsiveProps(Pulse);
`;

export const CODE_PLUGINS_TEMPLATES_CASES: CapabilityCase[] = [
  {
    id: 'code-plugins-templates/edit-code-component', domain: 'code-plugins-templates', status: 'supported',
    feature: 'Edit an existing code component',
    ask: 'make the galaxy spin twice as fast by default',
    calls: [{ tool: 'apply_file_edit', args: { path: GALAXY, kind: 'component', code: GALAXY_FASTER } }],
    expect: (w) => must(/speed = 2,/.test(w.read(GALAXY) ?? '') && /"default": 2/.test(w.read(GALAXY) ?? ''), 'the default speed did not change in both places'),
  },
  {
    id: 'code-plugins-templates/create-code-component', domain: 'code-plugins-templates', status: 'supported',
    feature: 'Create a code component and place it',
    ask: 'make me a pulsing dot component and put it in the hero',
    calls: [
      { tool: 'apply_file_edit', args: { path: 'components/Pulse.tsx', kind: 'component', code: NEW_CODE_COMPONENT } },
      { tool: 'add_component_instance', args: { name: 'Pulse', parent_id: 'hero' } },
    ],
    expect: (w) => {
      must(w.read('components/Pulse.tsx'), 'components/Pulse.tsx was not written');
      must(/<Pulse\b/.test(w.read(HOME) ?? ''), 'no <Pulse> instance on the page');
    },
  },
  {
    id: 'code-plugins-templates/code-component-rejected', domain: 'code-plugins-templates', status: 'supported',
    feature: 'A code component missing its contract is refused with the rule',
    ask: '(safety) write a code component without @defaultWidth',
    calls: [{ tool: 'apply_file_edit', args: { path: 'components/Bad.tsx', kind: 'component', code: NEW_CODE_COMPONENT.replace('/** @defaultWidth 120 */\n/** @defaultHeight 120 */\n', '') } }],
    allowFailedCalls: true,
    expect: (w) => {
      must(w.replies[0].isError && /CODE_COMPONENT_MISSING_DEFAULT_SIZE/.test(w.replies[0].text), 'not refused with the size rule');
      must(w.read('components/Bad.tsx') === null, 'the bad file was written anyway');
    },
  },
  {
    id: 'code-plugins-templates/set-control-prop', domain: 'code-plugins-templates', status: 'supported',
    feature: 'Set a code component control on an instance',
    ask: 'make this galaxy faster',
    files: { [HOME]: FIXTURE_FILES[HOME].replace(
      `<div data-id="card-3" data-name="Card"`,
      `<Galaxy data-id="galaxy-1" data-name="Galaxy" speed="1" style={{ position: 'relative', width: '320px', height: '200px', flex: '0 0 auto', order: '3' }} />\n        <div data-id="card-3" data-name="Card"`,
    ).replace("import PrimaryButton from '@/components/PrimaryButton';", "import PrimaryButton from '@/components/PrimaryButton';\nimport Galaxy from '@/components/Galaxy';") },
    calls: [{ tool: 'set_component_prop', args: { node_id: 'galaxy-1', component_name: 'Galaxy', prop: 'speed', value: '4' } }],
    expect: (w) => must(/speed="4"/.test(w.read(HOME) ?? ''), 'speed was not set to 4'),
  },
  {
    id: 'code-plugins-templates/read-code-component', domain: 'code-plugins-templates', status: 'supported',
    feature: 'Read a code component\'s controls',
    ask: 'what can I tweak on the galaxy?',
    calls: [{ tool: 'get_component', args: { name: 'Galaxy' } }],
    expect: (w) => must(/speed/.test(w.replies[0].text), 'get_component does not report the speed control'),
  },
  {
    id: 'code-plugins-templates/list-components', domain: 'code-plugins-templates', status: 'supported',
    feature: 'List the project\'s components, code ones included',
    ask: 'what components do I have?',
    calls: [{ tool: 'list_components', args: {} }],
    expect: (w) => must(/Galaxy/.test(w.replies[0].text) && /PrimaryButton/.test(w.replies[0].text), 'the list is incomplete'),
  },
  {
    id: 'code-plugins-templates/manual', domain: 'code-plugins-templates', status: 'supported',
    feature: 'The code-component manual is loadable',
    ask: '(internal) load the code-component manual',
    calls: [{ tool: 'load_manual', args: { name: 'code-component' } }],
    // The manual lives in the service; here we only prove the tool is on the
    // surface and fails HONESTLY when the service is not reachable.
    allowFailedCalls: true,
    expect: (w) => must(/Manual: code components/.test(w.replies[0].text) || /Could not reach|Could not load/.test(w.replies[0].text), 'neither the manual nor an honest failure'),
  },

  // ── not possible yet ──
  {
    id: 'code-plugins-templates/built-in-components', domain: 'code-plugins-templates', status: 'supported',
    feature: 'Use one of the built-in code components',
    ask: 'add an animated counter to the hero',
    calls: [
      { tool: 'list_built_in_components', args: { query: 'counter' } },
      { tool: 'add_built_in_component', args: { tag: 'AnimatedCounter', parent_id: 'hero' } },
    ],
    expect: (w) => {
      must(w.replies[0].data?.components?.some((c: { tag: string }) => c.tag === 'AnimatedCounter'), 'the counter is not listed');
      must(w.read('components/AnimatedCounter.tsx') !== null, 'the component was not installed');
      must(/<AnimatedCounter\b/.test(w.read(HOME) ?? ''), 'no instance on the page');
    },
  },
  {
    id: 'code-plugins-templates/controls-validated', domain: 'code-plugins-templates', status: 'supported',
    feature: 'Malformed @controls JSON is refused',
    ask: '(safety) write a code component with broken @controls',
    calls: [{ tool: 'apply_file_edit', args: { path: 'components/Broken.tsx', kind: 'component', code: NEW_CODE_COMPONENT.replace('"color": { "type": "color", "label": "Color", "default": "#f97316" }', '"color": { "type": "colour", "label": "Color", "default": "#f97316", }') } }],
    allowFailedCalls: true,
    expect: (w) => {
      must(w.replies[0].isError && /CODE_COMPONENT_CONTROLS_INVALID/.test(w.replies[0].text), 'not refused with the controls rule');
      must(w.read('components/Broken.tsx') === null, 'the broken component was written anyway');
    },
  },
  {
    id: 'code-plugins-templates/code-override', domain: 'code-plugins-templates', status: 'supported',
    feature: 'Attach a code override to a node',
    ask: 'give the first card a hover spring through a code override',
    calls: [
      { tool: 'write_override', args: { name: 'Effects', code: `import { forwardRef, type ComponentType } from 'react';

export function withHoverSpring(Component): ComponentType {
  return forwardRef((props, ref) => {
    return <Component ref={ref} {...props} whileHover={{ scale: 1.04 }} transition={{ type: 'spring', stiffness: 300, damping: 20 }} />;
  });
}
` } },
      { tool: 'set_code_overrides', args: { node_id: 'card-1', overrides: [{ file: 'overrides/Effects.tsx', name: 'withHoverSpring' }] } },
      { tool: 'list_overrides', args: { node_id: 'card-1' } },
    ],
    expect: (w) => {
      must(w.read('overrides/Effects.tsx') !== null, 'the override file was not written');
      const code = w.read(HOME) ?? '';
      must(/<Override with=\{withHoverSpring\}>\s*<[a-z.]+ data-id="card-1"/.test(code), 'card-1 is not wrapped in <Override>');
      must(/import \{ withHoverSpring \} from '@\/overrides\/Effects'/.test(code), 'the override is not imported');
      must(w.replies[2].data?.on_node?.some((o: { name: string }) => o.name === 'withHoverSpring'), 'list_overrides does not read it back');
    },
  },
  {
    id: 'code-plugins-templates/code-override-rejected', domain: 'code-plugins-templates', status: 'supported',
    feature: 'An override file the site cannot resolve is refused',
    ask: '(safety) write an override importing lodash',
    calls: [{ tool: 'write_override', args: { name: 'Bad', code: "import { forwardRef } from 'react';\nimport debounce from 'lodash';\nexport function withX(C) { return forwardRef((p, r) => <C ref={r} {...p} />); }\n" } }],
    allowFailedCalls: true,
    expect: (w) => must(w.replies[0].isError && /lodash/.test(w.replies[0].text) && w.read('overrides/Bad.tsx') === null, 'not refused / written anyway'),
  },
  {
    id: 'code-plugins-templates/template-create', domain: 'code-plugins-templates', status: 'supported',
    feature: 'Create / assign a page template',
    ask: 'make a site template with a shared header and put both pages in it',
    calls: [
      { tool: 'create_template', args: { name: 'site' } },
      { tool: 'assign_template', args: { page: HOME, template: 'site' } },
      { tool: 'assign_template', args: { page: 'app/about/page.client.tsx', template: 'site' } },
      { tool: 'set_page', args: { page: 'app/(site)/LayoutClient.tsx' } },
      { tool: 'add_component_instance', args: { name: 'PrimaryButton', parent_id: 'root', index: 0 } },
      { tool: 'list_templates', args: {} },
    ],
    expect: (w) => {
      must(w.read('app/(site)/LayoutClient.tsx') !== null && w.read('app/(site)/page.client.tsx') !== null && w.read('app/(site)/about/page.client.tsx') !== null, 'the template or the moved pages are missing');
      must(w.read(HOME) === null, 'the home page still exists at its old path');
      must(/<PrimaryButton\b/.test(w.read('app/(site)/LayoutClient.tsx') ?? ''), 'the shared header instance is not in the layout');
      must(w.replies[5].data?.templates?.some((t: { name: string; pages: string[] }) => t.name === 'site' && t.pages.length === 2), 'list_templates does not report the two pages');
    },
  },
  {
    id: 'code-plugins-templates/template-variable', domain: 'code-plugins-templates', status: 'supported',
    feature: 'Template variables',
    ask: 'give the template a "pageTitle" text every page can override, shown in the layout',
    calls: [
      { tool: 'create_template', args: { name: 'site', pages: [HOME] } },
      { tool: 'set_page', args: { page: 'app/(site)/LayoutClient.tsx' } },
      { tool: 'add_node', args: { parent_id: 'root', tag: 'p', id: 'layout-title', text: 'Site', index: 0 } },
      { tool: 'set_page_variable', args: { name: 'pageTitle', type: 'text', value: 'Revyme' } },
      { tool: 'bind_variable', args: { node_id: 'layout-title', variable: 'pageTitle', bind: 'text' } },
    ],
    expect: (w) => {
      const code = w.read('app/(site)/LayoutClient.tsx') ?? '';
      must(/pageTitle = ['"]Revyme['"]/.test(code), 'the template variable is not a function param with its default');
      must(!/useState\(['"]Revyme['"]\)/.test(code), 'a template variable must not be useState');
      must(/data-id="layout-title"[\s\S]*?>\{pageTitle\}/.test(code), 'the layout text is not bound to the variable');
      must(/"pageTitle"[\s\S]{0,80}plainText/.test(code), 'the variable has no @propMeta type');
    },
  },
  {
    id: 'code-plugins-templates/plugin', domain: 'code-plugins-templates', status: 'supported',
    feature: 'Author or edit a plugin',
    ask: 'make a plugin that shows how many layers are selected',
    calls: [
      { tool: 'load_manual', args: { name: 'plugin' } },
      { tool: 'write_plugin', args: { name: 'Selection Counter', code: `import { createPlugin } from '@revyme/plugin-sdk';
import { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';

function App({ plugin }: { plugin: any }) {
  const [ids, setIds] = useState<string[]>([]);
  useEffect(() => plugin.revyme.subscribe.selection(setIds), [plugin]);
  return (
    <div>
      <h3 style={{ margin: '0 0 8px' }}>Selection Counter</h3>
      <p style={{ margin: 0 }}>Selected: {ids.length}</p>
    </div>
  );
}

const plugin = await createPlugin({ pluginId: 'local.selection-counter' });
createRoot(document.getElementById('root')!).render(<App plugin={plugin} />);
` } },
      { tool: 'list_plugins', args: {} },
      { tool: 'launch_plugin', args: { name: 'Selection Counter' } },
    ],
    // load_manual reaches the service: honest failure headless, the manual live.
    allowFailedCalls: true,
    expect: (w) => {
      must(/Manual: plugins/.test(w.replies[0].text) || /Could not reach|Could not load/.test(w.replies[0].text), 'neither the plugin manual nor an honest failure');
      must(!w.replies[1].isError && w.read('plugins/SelectionCounter.tsx') !== null, `the plugin was not written: ${w.replies[1].text.slice(0, 200)}`);
      must(w.replies[2].data?.plugins?.some((p: { name: string }) => p.name === 'SelectionCounter'), 'list_plugins does not list it');
      must(!w.replies[3].isError && w.replies[3].data?.launched === 'plugins/SelectionCounter.tsx', 'launch_plugin did not open it');
    },
  },
  {
    id: 'code-plugins-templates/plugin-rejected', domain: 'code-plugins-templates', status: 'supported',
    feature: 'A plugin that would not run is refused with the reasons',
    ask: '(safety) write a plugin with a relative import and no createRoot',
    calls: [{ tool: 'write_plugin', args: { name: 'Broken', code: "import { createPlugin } from '@revyme/plugin-sdk';\nimport { helper } from './helper';\nconst plugin = await createPlugin({ pluginId: 'local.broken' });\n" } }],
    allowFailedCalls: true,
    expect: (w) => must(w.replies[0].isError && /createRoot/.test(w.replies[0].text) && /self-contained/.test(w.replies[0].text) && w.read('plugins/Broken.tsx') === null, 'not refused with both reasons / written anyway'),
  },
  { id: 'code-plugins-templates/marketplace-insert', domain: 'code-plugins-templates', status: 'missing', feature: 'Insert a marketplace item', ask: 'insert the pricing section from the marketplace', gap: 'the one-shot insert is ADMIN-ONLY by decision (bridge insertMarketplaceComponent, 2026-08-11); users import a free listing by URL through the Insert panel' },
  {
    id: 'code-plugins-templates/icon-from-set', domain: 'code-plugins-templates', status: 'supported',
    feature: 'Place an icon from an icon library',
    ask: 'add a menu icon to the hero',
    // Iconify is network; the case passes the markup the way search_icons + a fetch would.
    calls: [{ tool: 'add_icon', args: { parent_id: 'hero', svg: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#000000" stroke-width="2"><path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/></svg>', name: 'Menu', size: 32, color: '#111827' } }],
    expect: (w) => {
      const id = w.replies[0].data?.node_id;
      must(id && w.node(id).type === 'svg' && w.node(id).parentId === 'hero', 'no svg icon in the hero');
      must(w.replies[0].data?.editable === true && w.node(id).children.length >= 1, 'the icon is not an editable vector');
      must(/stroke="currentColor"/.test(w.read(HOME) ?? '') && w.node(id).styles.color === '#111827', 'the icon does not tint through color (stroke must be currentColor on the paths)');
      must(/order:/.test(w.tag(id)) && /flex: '0 0 auto'/.test(w.tag(id)), 'the icon has no layout slot');
    },
  },
  {
    id: 'code-plugins-templates/section-blueprint', domain: 'code-plugins-templates', status: 'supported',
    feature: 'Insert a section blueprint (hero, header)',
    ask: 'add an editorial header at the top of the page',
    calls: [
      { tool: 'list_sections', args: { category: 'header' } },
      { tool: 'insert_section', args: { section: 'header-editorial', index: 0 } },
    ],
    expect: (w) => {
      must(w.replies[0].data?.sections?.some((s: { id: string }) => s.id === 'header-editorial'), 'the header blueprint is not listed');
      const id = w.replies[1].data?.node_id;
      must(id && w.node(id).parentId === 'root' && w.node('root').children[0] === id, 'the header is not the first section of the page');
      must(w.node(id).styles.order === '0' && w.node('hero').styles.order === '1', 'the sections were not re-slotted (order)');
      must(w.replies[1].data?.elements > 3, 'the section came in without its elements');
    },
  },
];
