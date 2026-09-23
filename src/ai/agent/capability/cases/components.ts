// Design components & variants — audit §4.
import type { CapabilityCase } from '../harness';
import { HOME, BUTTON, FIXTURE_FILES } from '../fixture';

const must = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };

export const COMPONENT_CASES: CapabilityCase[] = [
  {
    id: 'components/extract', domain: 'components', status: 'supported',
    feature: 'Create a component from a live subtree',
    ask: 'turn the first card into a reusable component called FeatureCard',
    calls: [{ tool: 'extract_component', args: { node_id: 'card-1', name: 'FeatureCard' } }],
    expect: (w) => {
      must(w.read('components/FeatureCard.tsx'), 'components/FeatureCard.tsx was not written');
      must(/<FeatureCard\b/.test(w.read(HOME) ?? ''), 'the page does not render <FeatureCard>');
      must(/import FeatureCard from '@\/components\/FeatureCard'/.test(w.read(HOME) ?? ''), 'the page does not import it');
    },
  },
  {
    id: 'components/create-from-declaration', domain: 'components', status: 'supported',
    feature: 'Author a component from a declaration',
    ask: 'make a PricingCard component with a title and a price',
    calls: [{ tool: 'create_component', args: {
      name: 'PricingCard',
      props: [{ name: 'title', type: 'string', default: 'Starter' }, { name: 'price', type: 'string', default: '$9' }],
      layout: [{ tag: 'div', style: { position: 'relative', width: '320px', height: 'auto', display: 'flex', flexDirection: 'column', gap: '8px' }, children: [
        { tag: 'h3', text: '{title}', style: { position: 'relative', margin: '0px', fontSize: '20px' } },
        { tag: 'p', text: '{price}', style: { position: 'relative', margin: '0px', fontSize: '32px' } },
      ] }],
    } }],
    expect: (w) => {
      const code = w.read('components/PricingCard.tsx') ?? '';
      must(code, 'components/PricingCard.tsx was not written');
      must(/title = ['"]Starter['"]/.test(code) && /price = ['"]\$9['"]/.test(code), 'props are not declared with their defaults');
      must(/\{title\}/.test(code) && /\{price\}/.test(code), 'props are not bound in the markup');
    },
  },
  {
    id: 'components/create-variant', domain: 'components', status: 'supported',
    feature: 'Declare a new variant',
    ask: 'add a "featured" variant to the primary button',
    calls: [{ tool: 'create_variant', args: { component: 'PrimaryButton', variant: 'featured' } }],
    expect: (w) => must(/name: 'featured'/.test(w.read(BUTTON) ?? ''), 'variantConfig has no "featured" entry'),
  },
  {
    id: 'components/create-interaction-state', domain: 'components', status: 'supported',
    feature: 'Auto-wired pressed state',
    ask: 'give the primary button a pressed state',
    calls: [{ tool: 'create_variant', args: { component: 'PrimaryButton', variant: 'pressed', interaction: 'pressed' } }],
    expect: (w) => {
      const code = w.read(BUTTON) ?? '';
      must(/interactionType: 'pressed'/.test(code), 'no pressed interaction state in variantConfig');
      must(/trigger: '(mouseDown|tapStart|pointerDown|tap)[^']*'/.test(code) || /onTapStart|onPointerDown|onMouseDown/.test(code), 'the pressed state is not wired');
    },
  },
  {
    id: 'components/variant-styles', domain: 'components', status: 'supported',
    feature: 'Per-variant styles',
    ask: 'make the button red when hovered',
    calls: [{ tool: 'set_variant', args: { node_id: 'hero-cta', variant: 'default-hover', styles: { backgroundColor: '#ff0000' } } }],
    expect: (w) => must(/'default-hover': \{[^}]*backgroundColor: '#ff0000'/.test(w.read(BUTTON) ?? ''), 'the hover variant did not get the colour'),
  },
  {
    id: 'components/place-instance', domain: 'components', status: 'supported',
    feature: 'Place a component instance',
    ask: 'add another primary button saying "Buy" under the cards',
    calls: [{ tool: 'add_component_instance', args: { name: 'PrimaryButton', parent_id: 'cards', props: { label: 'Buy' } } }],
    expect: (w) => must((w.read(HOME) ?? '').match(/<PrimaryButton\b/g)?.length === 2 && /label="Buy"/.test(w.read(HOME) ?? ''), 'no second <PrimaryButton label="Buy">'),
  },
  {
    id: 'components/set-prop', domain: 'components', status: 'supported',
    feature: 'Set a prop on an instance',
    ask: 'change the hero button to say "Try it free"',
    calls: [{ tool: 'set_component_prop', args: { node_id: 'hero-cta', component_name: 'PrimaryButton', prop: 'label', value: 'Try it free' } }],
    expect: (w) => must(/label="Try it free"/.test(w.read(HOME) ?? ''), 'the label prop was not written'),
  },
  {
    id: 'components/read-props', domain: 'components', status: 'supported',
    feature: 'Read a component\'s props',
    ask: 'what can I change on the primary button?',
    calls: [{ tool: 'get_component', args: { name: 'PrimaryButton' } }],
    expect: (w) => must(/label/.test(w.replies[0].text), 'get_component does not report the label prop'),
  },
  {
    id: 'components/overlay', domain: 'components', status: 'supported',
    feature: 'Overlay (dropdown / modal) opened from a node',
    ask: 'open a dropdown when the first card is clicked',
    calls: [{ tool: 'create_overlay', args: { node_id: 'card-1', type: 'relative', trigger: 'click' } }],
    expect: (w) => must(/data-overlay/.test(w.read(HOME) ?? ''), 'no overlay was written'),
  },

  // ── not possible yet ──
  {
    id: 'components/show-variant-on-instance', domain: 'components', status: 'supported',
    feature: 'Choose which variant an instance shows',
    ask: 'show the hover version of the hero button',
    calls: [{ tool: 'show_variant', args: { node_id: 'hero-cta', variant: 'default-hover' } }],
    expect: (w) => must(/initialVariant="default-hover"/.test(w.tag('hero-cta')), `no initialVariant on the instance: ${w.tag('hero-cta').slice(0, 120)}`),
  },
  {
    id: 'components/show-variant-reset', domain: 'components', status: 'supported',
    feature: 'Reset an instance to its primary variant',
    ask: 'show the normal version of the hero button again',
    calls: [
      { tool: 'show_variant', args: { node_id: 'hero-cta', variant: 'default-hover' } },
      { tool: 'show_variant', args: { node_id: 'hero-cta', variant: 'default' } },
    ],
    expect: (w) => must(!/initialVariant="default-hover"/.test(w.tag('hero-cta')), 'still on the hover variant'),
  },
  {
    id: 'components/show-variant-unknown', domain: 'components', status: 'supported',
    feature: 'An unknown variant is refused with the list',
    ask: 'show the "giant" version of the button',
    calls: [{ tool: 'show_variant', args: { node_id: 'hero-cta', variant: 'giant' } }],
    allowFailedCalls: true,
    expect: (w) => must(w.replies[0].isError && /default-hover/.test(w.replies[0].text), 'not refused with the variant list'),
  },
  {
    id: 'components/responsive-instance-variant', domain: 'components', status: 'supported',
    feature: 'Per-breakpoint instance variant',
    ask: 'on mobile show the hover version of the hero button',
    calls: [{ tool: 'show_variant', args: { node_id: 'hero-cta', variant: 'default-hover', viewport: 375 } }],
    expect: (w) => {
      const code = w.read(HOME) ?? '';
      must(/data-responsive=/.test(w.tag('hero-cta')) && /375/.test(w.tag('hero-cta')) && /default-hover/.test(w.tag('hero-cta')), `no 375 override on the instance: ${w.tag('hero-cta').slice(0, 200)}`);
      must(!/initialVariant="default-hover"/.test(w.tag('hero-cta')), 'the base variant changed too');
      must(code.length > 0, 'page missing');
    },
  },
  {
    id: 'components/connections', domain: 'components', status: 'supported',
    feature: 'Connections: tap / hover → variant',
    ask: 'clicking the button should switch it to featured',
    calls: [
      { tool: 'create_variant', args: { component: 'PrimaryButton', variant: 'featured' } },
      { tool: 'add_connection', args: { component: 'PrimaryButton', from: 'default', to: 'featured', trigger: 'click' } },
    ],
    expect: (w) => {
      const code = w.read(BUTTON) ?? '';
      must(/from: 'default', to: 'featured', trigger: 'click'/.test(code), 'no click connection default → featured');
      must(/onClick=|onTap=/.test(w.tag('pb-root', BUTTON)), 'the root carries no click handler for it');
    },
  },
  {
    id: 'components/connection-from-child', domain: 'components', status: 'supported',
    feature: 'A connection triggered by one element inside the component',
    ask: 'hovering the label (only) should switch to featured',
    calls: [
      { tool: 'create_variant', args: { component: 'PrimaryButton', variant: 'featured' } },
      { tool: 'add_connection', args: { component: 'PrimaryButton', from: 'default', to: 'featured', trigger: 'mouseEnter', source_node: 'pb-label' } },
    ],
    expect: (w) => must(/sourceNode: 'pb-label'/.test(w.read(BUTTON) ?? ''), 'the connection is not bound to the label'),
  },
  {
    id: 'components/remove-connection', domain: 'components', status: 'supported',
    feature: 'Remove a connection',
    ask: 'the button should no longer switch on hover',
    calls: [{ tool: 'remove_connection', args: { component: 'PrimaryButton', from: 'default', to: 'default-hover', trigger: 'mouseEnter' } }],
    expect: (w) => must(!/from: 'default', to: 'default-hover', trigger: 'mouseEnter'/.test(w.read(BUTTON) ?? ''), 'the hover connection is still there'),
  },
  {
    id: 'components/rename-variant', domain: 'components', status: 'supported',
    feature: 'Rename a variant',
    ask: 'call the hover state "Glow"',
    calls: [{ tool: 'rename_variant', args: { component: 'PrimaryButton', variant: 'default-hover', label: 'Glow' } }],
    expect: (w) => must(/name: 'default-hover', label: 'Glow'/.test(w.read(BUTTON) ?? ''), 'the label did not change (or the name did)'),
  },
  {
    id: 'components/remove-variant', domain: 'components', status: 'supported',
    feature: 'Remove a variant',
    ask: 'delete the hover state',
    calls: [{ tool: 'remove_variant', args: { component: 'PrimaryButton', variant: 'default-hover' } }],
    expect: (w) => {
      const code = w.read(BUTTON) ?? '';
      must(!/name: 'default-hover'/.test(code), 'the variant is still declared');
      must(!/to: 'default-hover'/.test(code), 'connections to it were left dangling');
    },
  },
  {
    id: 'components/remove-primary-refused', domain: 'components', status: 'supported',
    feature: 'The primary variant cannot be removed',
    ask: 'delete the default state',
    calls: [{ tool: 'remove_variant', args: { component: 'PrimaryButton', variant: 'default' } }],
    allowFailedCalls: true,
    expect: (w) => must(w.replies[0].isError && /primary/.test(w.replies[0].text), 'the primary was not protected'),
  },
  {
    id: 'components/variant-visibility', domain: 'components', status: 'supported',
    feature: 'Show / hide a layer per variant',
    ask: 'hide the label in the hover state',
    // A revealing variant needs a hug-height root (oracle VARIANT_REVEAL_ROOT_SHELL).
    files: { [BUTTON]: FIXTURE_FILES[BUTTON].replace("width: '160px', height: '48px'", "width: '160px', height: 'auto'") },
    calls: [{ tool: 'set_variant_visibility', args: { component: 'PrimaryButton', node_id: 'pb-label', hidden_on: ['default-hover'] } }],
    expect: (w) => {
      const code = w.read(BUTTON) ?? '';
      must(/AnimatePresence/.test(code), 'no AnimatePresence wrapper');
      must(/variant !== ['"]default-hover['"] &&/.test(code), 'no variant gate on the label');
      must(!/pb-label[^>]*display: 'none'/.test(code), 'a baked display:none leaked (visibility must be the gate, not a style)');
    },
  },
  {
    id: 'components/declare-prop-on-existing', domain: 'components', status: 'supported',
    feature: 'Declare a new prop on an existing component',
    ask: 'let me change the button radius per instance',
    calls: [
      { tool: 'add_component_prop', args: { component: 'PrimaryButton', node_id: 'pb-root', name: 'radius', bind: 'borderRadius' } },
      { tool: 'set_component_prop', args: { node_id: 'hero-cta', component_name: 'PrimaryButton', prop: 'radius', value: '8px' } },
    ],
    expect: (w) => {
      const master = w.read(BUTTON) ?? '';
      must(/radius = ['"]50px['"]/.test(master), 'the prop is not declared with the current value as default');
      must(/borderRadius: radius/.test(master), 'borderRadius is not bound to the prop');
      must(/"radius"\s*:\s*\{[^}]*"type"\s*:\s*"plainText"/.test(master) || /"radius":\s*\{[^}]*plainText/.test(master), 'the prop has no @propMeta type');
      must(/radius="8px"/.test(w.read(HOME) ?? ''), 'the instance override was not written');
    },
  },
  {
    id: 'components/read-variants', domain: 'components', status: 'supported',
    feature: 'Read a component\'s variants and connections',
    ask: 'which states does this button have?',
    calls: [{ tool: 'get_component', args: { name: 'PrimaryButton' } }],
    expect: (w) => {
      const t = w.replies[0].text;
      must(/default-hover/.test(t) && /primary/.test(t), 'variants are not listed');
      must(/default → default-hover  on mouseEnter/.test(t), 'connections are not listed');
    },
  },
  {
    id: 'components/nested-inner-variant', domain: 'components', status: 'supported',
    feature: 'Variant of an instance nested in a component',
    ask: 'inside the hero component, show the button in its hover look',
    calls: [
      { tool: 'extract_component', args: { node_id: 'hero', name: 'HeroSection' } },
      { tool: 'get_component', args: { name: 'HeroSection' } },
      { tool: 'show_variant', args: { node_id: 'hero-cta', variant: 'default-hover', inside: 'HeroSection' } },
    ],
    expect: (w) => {
      const master = w.read('components/HeroSection.tsx') ?? '';
      must(/<PrimaryButton\b[^>]*data-id="hero-cta"/.test(master), 'the button instance is not inside the new master');
      must(/data-id="hero-cta"[^>]*initialVariant="default-hover"|initialVariant="default-hover"[^>]*data-id="hero-cta"/.test(master), 'the nested instance does not show the hover variant');
      must(w.replies[2].data?.file === 'components/HeroSection.tsx', 'the write did not land in the master');
    },
  },
  {
    id: 'components/slots', domain: 'components', status: 'supported',
    feature: 'Slots / slot children',
    ask: 'add a lens box to the hero and put a card in it',
    calls: [
      { tool: 'add_built_in_component', args: { tag: 'LensBox', parent_id: 'hero' } },
      { tool: 'get_slots', args: { node_id: '$node_id' } },
      { tool: 'add_canvas_node', args: { tag: 'div', id: 'lens-card', name: 'Lens card', styles: { width: '320px', height: '200px', backgroundColor: '#f4f4f5', borderRadius: '12px' } } },
      { tool: 'connect_slot', args: { node_id: '$instance', canvas_node_id: 'lens-card' } },
    ],
    expect: (w) => {
      const slots = w.replies[1].data;
      must(slots?.slot === 'children' && slots?.max === 1, `LensBox should expose a single-node children slot: ${w.replies[1].text.slice(0, 200)}`);
      const code = w.read(HOME) ?? '';
      must(/const cn_lens_card = \(/.test(code) || /const cn_lens_card = </.test(code), 'the canvas node was not hoisted to a cn_ const');
      must(/<LensBox\b[^>]*>\s*\{cn_lens_card\}\s*<\/LensBox>/.test(code), 'the instance does not render {cn_lens_card}');
      must(/data-id="lens-card"[^>]*data-canvas-node="true"|data-canvas-node="true"[^>]*data-id="lens-card"/.test(code), 'the connected node lost its data-canvas-node marker');
      must(w.replies[3].data?.connected?.includes('lens-card'), 'connect_slot does not report the connection');
    },
  },
  {
    id: 'components/slot-refuses-nested-node', domain: 'components', status: 'supported',
    feature: 'A node inside a viewport cannot be connected to a slot',
    ask: '(safety) put the hero title in the lens box',
    calls: [
      { tool: 'add_built_in_component', args: { tag: 'LensBox', parent_id: 'hero' } },
      { tool: 'connect_slot', args: { node_id: '$node_id', canvas_node_id: 'hero-title' } },
    ],
    allowFailedCalls: true,
    expect: (w) => must(w.replies[1].isError && /free-canvas node/.test(w.replies[1].text) && /add_canvas_node/.test(w.replies[1].text), 'not refused with the way forward'),
  },
  {
    id: 'components/detach', domain: 'components', status: 'supported',
    feature: 'Detach / expand an instance',
    ask: 'detach this button so I can edit it freely',
    calls: [{ tool: 'detach_instance', args: { node_id: 'hero-cta' } }],
    expect: (w) => {
      const code = w.read(HOME) ?? '';
      must(!/<PrimaryButton\b[^>]*data-id="hero-cta"/.test(code), 'the instance is still there');
      must(/Start free trial/.test(code), 'the instance prop value was not baked into the detached text');
      must(w.replies[0].data?.root_id && code.includes(`data-id="${w.replies[0].data.root_id}"`), 'no root id reported / not on the page');
      must(w.read(BUTTON) === FIXTURE_FILES[BUTTON], 'the master changed');
    },
  },
  {
    id: 'components/cycle-guard', domain: 'components', status: 'supported',
    feature: 'Refuse a component placed inside itself',
    ask: '(safety) put the button inside its own master',
    activeFile: BUTTON,
    calls: [{ tool: 'add_component_instance', args: { name: 'PrimaryButton', parent_id: 'pb-root' } }],
    allowFailedCalls: true,
    expect: (w) => {
      must(w.replies[0].isError && /render itself/.test(w.replies[0].text), 'not refused with the cycle reason');
      must(w.read(BUTTON) === FIXTURE_FILES[BUTTON], 'the master was written anyway');
    },
  },
  {
    id: 'components/shape-reference', domain: 'components', status: 'supported',
    feature: 'Reference shape for hand-written component code',
    ask: '(internal) fetch a reference master before writing component code',
    calls: [{ tool: 'component_example', args: { pattern: 'two-state-toggle' } }],
    // The examples live in the service; the tool is on the surface and fails
    // HONESTLY when the service is not reachable (same contract as load_manual).
    allowFailedCalls: true,
    expect: (w) => must(/variantConfig/.test(w.replies[0].text) || /Could not reach|Could not load/.test(w.replies[0].text), 'neither an example nor an honest failure'),
  },
];
