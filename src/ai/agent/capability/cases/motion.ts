// Motion, animation, scroll & effects — audit §8.
import type { CapabilityCase } from '../harness';
import { HOME, ABOUT } from '../fixture';

const must = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };

export const MOTION_CASES: CapabilityCase[] = [
  {
    id: 'motion/appear', domain: 'motion', status: 'supported',
    feature: 'Appear (enter on scroll into view)',
    ask: 'fade the title in when it scrolls into view',
    calls: [{ tool: 'set_motion_preset', args: { node_id: 'hero-title', effect: 'appear' } }],
    expect: (w) => {
      const tag = w.tag('hero-title');
      must(/whileInView=/.test(tag) && /initial=/.test(tag), 'the title has no whileInView / initial');
      must(/motion\.h1/.test(tag), 'the element was not promoted to motion.h1');
    },
  },
  {
    id: 'motion/hover', domain: 'motion', status: 'supported',
    feature: 'Hover (scale)',
    ask: 'make the cards grow slightly on hover',
    calls: [{ tool: 'set_motion_preset', args: { node_id: 'card-1', effect: 'hover', scale: 1.04 } }],
    expect: (w) => must(/whileHover=\{\{[^}]*scale:\s*1\.04/.test(w.tag('card-1')), 'no whileHover scale 1.04'),
  },
  {
    id: 'motion/tap', domain: 'motion', status: 'supported',
    feature: 'Tap (press)',
    ask: 'make the card shrink when pressed',
    calls: [{ tool: 'set_motion_preset', args: { node_id: 'card-2', effect: 'tap' } }],
    expect: (w) => must(/whileTap=/.test(w.tag('card-2')), 'no whileTap'),
  },
  {
    id: 'motion/loop', domain: 'motion', status: 'supported',
    feature: 'Loop (continuous)',
    ask: 'make the hero image slowly spin forever',
    calls: [{ tool: 'set_motion_preset', args: { node_id: 'hero-image', effect: 'loop', transition: { duration: 8, ease: 'linear' } } }],
    expect: (w) => {
      // A loop is carried by `data-scroll-fx` (what the Animation panel reads)
      // driving a motion value — not an inline `animate={{ repeat: Infinity }}`.
      const tag = w.tag('hero-image');
      must(/data-scroll-fx=/.test(tag) && /"loop"/.test(tag) && /"repeat":"Infinity"/.test(tag), 'no loop carrier on the image');
      must(/"duration":"8"/.test(tag), 'the 8s duration was not written');
    },
  },
  {
    id: 'motion/appear-on-breakpoint', domain: 'motion', status: 'supported',
    feature: 'An effect scoped to one breakpoint',
    ask: 'on mobile only, fade the subtitle in',
    calls: [{ tool: 'set_motion_preset', args: { node_id: 'hero-sub', effect: 'appear', viewport: 375 } }],
    expect: (w) => must(/hero-sub/.test(w.read(HOME) ?? '') && /whileInView/.test(w.read(HOME) ?? ''), 'no scoped appear written'),
  },
  {
    id: 'motion/verify', domain: 'motion', status: 'supported',
    feature: 'Verify that motion landed',
    ask: '(internal) check the hover effect is really on the card',
    calls: [
      { tool: 'set_motion_preset', args: { node_id: 'card-1', effect: 'hover' } },
      { tool: 'verify_effect', args: { request: 'hover effect on the first card', node_ids: ['card-1'], expected_mechanism: ['whileHover'] } },
    ],
    expect: (w) => must(w.replies[1].data?.satisfied === true, `verify_effect: ${w.replies[1].text.slice(0, 200)}`),
  },
  {
    id: 'motion/effect-on-instance', domain: 'motion', status: 'supported',
    feature: 'An effect on a COMPONENT INSTANCE lands (or is refused loudly)',
    ask: 'make the hero button grow on hover',
    calls: [{ tool: 'set_motion_preset', args: { node_id: 'hero-cta', effect: 'hover' } }],
    expect: (w) => {
      // An instance cannot carry motion; the effect lands on the MASTER's root
      // (what the Animation panel does), and the reply says so.
      const master = w.read('components/PrimaryButton.tsx') ?? '';
      must(/whileHover=/.test(w.tag('pb-root', 'components/PrimaryButton.tsx')), 'the master root did not get whileHover');
      must(w.replies[0].data?.landed_on?.master_path === 'components/PrimaryButton.tsx', 'the reply does not say where it landed');
      must(!/whileHover/.test(w.tag('hero-cta')), 'a motion prop was written on the instance tag (framer-motion ignores it)');
      must(master.length > 0, 'master missing');
    },
  },

  // ── not possible yet ──
  {
    id: 'motion/hover-custom', domain: 'motion', status: 'supported',
    feature: 'Hover / tap with x, y, rotate, opacity, colour targets',
    ask: 'on hover lift the card 8px and darken it',
    calls: [{ tool: 'set_motion', args: { node_id: 'card-1', effect: 'hover', targets: { y: -8, backgroundColor: '#e4e4e7' } } }],
    expect: (w) => {
      const tag = w.tag('card-1');
      must(/whileHover=/.test(tag) && /y:\s*-8/.test(tag) && /#e4e4e7/.test(tag), `no custom hover: ${tag.slice(0, 200)}`);
    },
  },
  {
    id: 'motion/appear-custom', domain: 'motion', status: 'supported',
    feature: 'Appear with direction, distance, duration, delay, stagger',
    ask: 'slide the cards in from the left one after another',
    calls: [
      { tool: 'set_motion', args: { node_id: 'card-1', effect: 'appear', from: { opacity: 0, x: -60 }, transition: { duration: 0.6, ease: 'easeOut', delay: 0 } } },
      { tool: 'set_motion', args: { node_id: 'card-2', effect: 'appear', from: { opacity: 0, x: -60 }, transition: { duration: 0.6, ease: 'easeOut', delay: 0.15 } } },
      { tool: 'set_motion', args: { node_id: 'card-3', effect: 'appear', from: { opacity: 0, x: -60 }, transition: { duration: 0.6, ease: 'easeOut', delay: 0.3 } } },
    ],
    expect: (w) => {
      must(/x:\s*-60/.test(w.tag('card-1')) && /whileInView=/.test(w.tag('card-1')), 'card-1 has no slide-in appear');
      must(/delay:\s*0\.3/.test(w.tag('card-3')), 'the stagger delay is not on the third card');
    },
  },
  {
    id: 'motion/transition-spring', domain: 'motion', status: 'supported',
    feature: 'Spring transitions',
    ask: 'make the card pop in with a bounce',
    calls: [{ tool: 'set_motion', args: { node_id: 'card-2', effect: 'appear', from: { opacity: 0, scale: 0.8 }, transition: { type: 'spring', stiffness: 300, damping: 18 } } }],
    expect: (w) => must(/spring/.test(w.tag('card-2')) && /stiffness:\s*300/.test(w.tag('card-2')), 'no spring transition'),
  },
  {
    id: 'motion/scroll-speed', domain: 'motion', status: 'supported',
    feature: 'Scroll speed (parallax)',
    ask: 'make the hero image move slower than the page',
    calls: [{ tool: 'set_motion', args: { node_id: 'hero-image', effect: 'speed', speed: 60 } }],
    // Parallax is a scroll-driven motion value on the element (`y: <id>SpeedY`) fed by useScroll.
    expect: (w) => {
      const code = w.read(HOME) ?? '';
      must(/y:\s*heroImageSpeedY/.test(w.tag('hero-image')), 'the image has no scroll-driven y');
      must(/useTransform\(heroImageSpeedScroll, \(v\) => v \* \(1 - 60 \/ 100\)\)/.test(code), 'the parallax factor is not 60%');
    },
  },
  {
    id: 'motion/scroll-transform', domain: 'motion', status: 'supported',
    feature: 'Scroll transform (from → to as you scroll)',
    ask: 'fade the title out as I scroll past it',
    calls: [{ tool: 'set_motion', args: { node_id: 'hero-title', effect: 'transform', trigger: 'layerInView', from: { opacity: 1 }, to: { opacity: 0 } } }],
    expect: (w) => {
      const code = w.read(HOME) ?? '';
      must(/useTransform/.test(code) && /useScroll/.test(code), 'no scroll-driven transform in the page');
      must(/opacity:\s*heroTitle\w*/.test(w.tag('hero-title')), `the title\'s opacity is not a scroll motion value: ${w.tag('hero-title').slice(0, 200)}`);
    },
  },
  {
    id: 'motion/scroll-animation', domain: 'motion', status: 'supported',
    feature: 'Scroll-direction animation',
    ask: 'hide the hero when scrolling down, bring it back when scrolling up',
    calls: [{ tool: 'set_motion', args: { node_id: 'hero', effect: 'animation', direction: 'down', replay: true, targets: { y: -40, opacity: 0 } } }],
    expect: (w) => {
      const code = w.read(HOME) ?? '';
      must(/useMotionValueEvent/.test(code) && /heroScrollY/.test(code), 'nothing drives the hero from the scroll direction');
      must(/^<motion\.div/.test(w.tag('hero')), 'the hero was not promoted to a motion element');
    },
  },
  {
    id: 'motion/text-effects', domain: 'motion', status: 'supported',
    feature: 'Text effects (split by char / word / line)',
    ask: 'animate the headline word by word, sliding up',
    calls: [{ tool: 'set_text_effect', args: { node_id: 'hero-title', preset: 'Slide Up', split: 'word', stagger: 0.08 } }],
    expect: (w) => {
      const code = w.read(HOME) ?? '';
      must(/data-text-anim=/.test(w.tag('hero-title')), 'no text effect carrier on the title');
      must(/"animationType":"word"/.test(w.tag('hero-title')), 'not split by word');
      must(/RevymeSplitText/.test(code), 'the split-text runtime is not used');
    },
  },
  {
    id: 'motion/glide', domain: 'motion', status: 'supported',
    feature: 'Glide (layout spring)',
    ask: 'make the cards animate when they reorder',
    calls: [{ tool: 'set_glide', args: { node_id: 'cards', bounce: 0.3 } }],
    expect: (w) => {
      const code = w.read(HOME) ?? '';
      must(/LayoutGroup/.test(code), 'no LayoutGroup around the cards');
      must(/data-id="cards"[^>]*data-glide='/.test(code) || /data-glide='[^>]*data-id="cards"/.test(code), 'the container carries no data-glide spec');
      must((code.match(/data-glide-item/g) ?? []).length === 3, 'the three cards are not glide members');
    },
  },
  {
    id: 'motion/page-transition', domain: 'motion', status: 'supported',
    feature: 'Page transitions',
    ask: 'crossfade between pages',
    calls: [
      { tool: 'create_template', args: { name: 'site', pages: [HOME, ABOUT] } },
      { tool: 'set_page_transition', args: { preset: 'crossfade', page: 'app/(site)/page.client.tsx' } },
    ],
    expect: (w) => {
      must(w.read('app/(site)/LayoutClient.tsx') !== null, 'no template layout');
      must(/<PageTransitions>/.test(w.read('app/(site)/LayoutClient.tsx') ?? ''), 'the layout does not mount PageTransitions');
      must(/crossfade/.test(w.replies[1].text), 'the effect is not reported');
      must(w.changed.some((p) => /page-effects/.test(p) && /crossfade/.test(w.read(p) ?? '')), 'no page-effects data with the crossfade');
    },
  },
  {
    id: 'motion/page-transition-needs-template', domain: 'motion', status: 'supported',
    feature: 'A page transition on a page without a template is refused with the way forward',
    ask: 'crossfade between pages (no template yet)',
    calls: [{ tool: 'set_page_transition', args: { preset: 'crossfade' } }],
    allowFailedCalls: true,
    expect: (w) => must(w.replies[0].isError && /create_template/.test(w.replies[0].text), 'not refused with the template hint'),
  },
  {
    id: 'motion/smooth-scroll', domain: 'motion', status: 'supported',
    feature: 'Smooth scroll',
    ask: 'turn on smooth scrolling everywhere',
    calls: [{ tool: 'set_smooth_scroll', args: { enabled: true, all_pages: true, intensity: 15 } }],
    expect: (w) => {
      must(/<SmoothScroll/.test(w.read('app/layout.tsx') ?? ''), 'the root layout does not mount SmoothScroll');
      must(/"intensity":\s*15/.test(w.read('app/smooth-scroll.ts') ?? ''), 'no smooth-scroll config with the intensity');
    },
  },
  {
    id: 'motion/cursor', domain: 'motion', status: 'supported',
    feature: 'Custom cursor',
    ask: 'use the button component as a cursor over the hero',
    calls: [{ tool: 'set_cursor', args: { node_id: 'hero', component: 'PrimaryButton', mode: 'follow', side: 'right' } }],
    expect: (w) => {
      const code = w.read(HOME) ?? '';
      must(/withCursor\(PrimaryButton/.test(code), 'no withCursor(...) on the hero');
      must(/CursorPortal/.test(w.read('app/layout.tsx') ?? ''), 'the root layout does not mount the cursor portal');
    },
  },
  {
    id: 'motion/connection-arbitrary', domain: 'motion', status: 'supported',
    feature: 'Arbitrary connection (from / to / trigger / source node)',
    ask: 'clicking the label switches the button to its hover look',
    calls: [{ tool: 'add_connection', args: { component: 'PrimaryButton', from: 'default', to: 'default-hover', trigger: 'click', source_node: 'pb-label' } }],
    expect: (w) => {
      const master = w.read('components/PrimaryButton.tsx') ?? '';
      must(/from: 'default', to: 'default-hover', trigger: 'click'/.test(master) && /sourceNode: 'pb-label'/.test(master), 'the connection is not declared with its source node');
    },
  },
  {
    id: 'motion/read-motion', domain: 'motion', status: 'supported',
    feature: 'Read the motion already on a node',
    ask: 'what animations does the first card have?',
    calls: [
      { tool: 'set_motion', args: { node_id: 'card-1', effect: 'hover', targets: { scale: 1.05 } } },
      { tool: 'set_motion', args: { node_id: 'card-1', effect: 'appear', from: { opacity: 0, y: 24 } } },
      { tool: 'get_motion', args: { node_id: 'card-1' } },
    ],
    expect: (w) => {
      const m = w.replies[2].data?.motion;
      must(m?.hover?.scale === '1.05', `hover not reported: ${JSON.stringify(m)}`);
      must(m?.appear?.from?.y === '24', `appear not reported: ${JSON.stringify(m)}`);
    },
  },
  {
    id: 'motion/remove', domain: 'motion', status: 'supported',
    feature: 'Remove one effect, keep the others',
    ask: 'remove the hover but keep the appear',
    calls: [
      { tool: 'set_motion', args: { node_id: 'card-1', effect: 'hover', targets: { scale: 1.05 } } },
      { tool: 'set_motion', args: { node_id: 'card-1', effect: 'appear', from: { opacity: 0 } } },
      { tool: 'remove_motion', args: { node_id: 'card-1', effect: 'hover' } },
    ],
    expect: (w) => must(!/whileHover=/.test(w.tag('card-1')) && /whileInView=/.test(w.tag('card-1')), 'hover not removed or appear lost'),
  },
];
