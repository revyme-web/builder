// capability/fixture.ts — the small project every capability case starts from.
//
// Realistic on purpose: three breakpoints, a hero with text / a button / an
// image frame, a row of cards, a design component with a hover variant, a code
// component, design tokens, a CMS collection with items, a second page. Cases
// add or replace files on top of it; none of them should need to invent a
// project of their own.
//
// It is kept ORACLE-CLEAN by capability.test.ts. That is what lets the harness
// say "every violation after a case is one the case introduced".

export const HOME = 'app/page.client.tsx';
export const HOME_SERVER = 'app/page.tsx';
export const ABOUT = 'app/about/page.client.tsx';
export const ABOUT_SERVER = 'app/about/page.tsx';
export const BUTTON = 'components/PrimaryButton.tsx';
export const GALAXY = 'components/Galaxy.tsx';
export const TOKENS = 'app/globals.css';
export const BLOG_SCHEMA = 'cms/blog.schema.json';
export const BLOG_ITEMS = 'cms/blog.json';

const CANVAS = `/** @canvas { "viewports": [{ "id": "desktop", "label": "Desktop", "width": 1440, "isPrimary": true, "order": 0 }, { "id": "tablet", "label": "Tablet", "width": 768, "isPrimary": false, "order": 1 }, { "id": "mobile", "label": "Mobile", "width": 375, "isPrimary": false, "order": 2 }], "positions": { "desktop": { "x": 0, "y": 0 }, "tablet": { "x": 1600, "y": 0 }, "mobile": { "x": 2500, "y": 0 } } } */`;

const HOME_CODE = `'use client';

${CANVAS}

import React from 'react';
import PrimaryButton from '@/components/PrimaryButton';

export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%', height: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'center', backgroundColor: 'var(--color-surface)' }}>
      <div data-id="hero" data-name="Hero" style={{ position: 'relative', width: '100%', height: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '24px', paddingTop: '96px', paddingRight: '24px', paddingBottom: '96px', paddingLeft: '24px', flex: '0 0 auto', order: '0' }}>
        <h1 data-id="hero-title" data-name="Title" style={{ position: 'relative', width: 'auto', height: 'auto', fontSize: '64px', fontWeight: '700', lineHeight: '1.1', color: 'var(--color-ink)', margin: '0px', flex: '0 0 auto', order: '0' }}>Plan, build and release</h1>
        <p data-id="hero-sub" data-name="Subtitle" style={{ position: 'relative', width: 'auto', height: 'auto', fontSize: '18px', lineHeight: '1.5', color: 'var(--color-ink)', margin: '0px', flex: '0 0 auto', order: '1' }}>The software for roadmaps and releases.</p>
        <PrimaryButton data-id="hero-cta" data-name="CTA" label="Start free trial" style={{ position: 'relative', flex: '0 0 auto', order: '2' }} />
        <div data-id="hero-image" data-name="Image" style={{ position: 'relative', width: '960px', height: '540px', backgroundImage: 'url(https://images.unsplash.com/photo-1?w=1600)', backgroundSize: 'cover', backgroundPosition: 'center', borderRadius: '16px', flex: '0 0 auto', order: '3' }}></div>
      </div>
      <div data-id="cards" data-name="Cards" style={{ position: 'relative', width: '100%', height: 'auto', display: 'flex', flexDirection: 'row', justifyContent: 'center', gap: '24px', paddingTop: '48px', paddingRight: '24px', paddingBottom: '48px', paddingLeft: '24px', flex: '0 0 auto', order: '1' }}>
        <div data-id="card-1" data-name="Card" style={{ position: 'relative', width: '320px', height: '200px', backgroundColor: '#f4f4f5', borderRadius: '12px', flex: '0 0 auto', order: '0' }}></div>
        <div data-id="card-2" data-name="Card" style={{ position: 'relative', width: '320px', height: '200px', backgroundColor: '#f4f4f5', borderRadius: '12px', flex: '0 0 auto', order: '1' }}></div>
        <div data-id="card-3" data-name="Card" style={{ position: 'relative', width: '320px', height: '200px', backgroundColor: '#f4f4f5', borderRadius: '12px', flex: '0 0 auto', order: '2' }}></div>
      </div>
    </div>
  );
}
`;

/** The server half of a page pair — byte-for-byte what createPageFile writes. */
const PAGE_SERVER = `import PageClient from './page.client';

export const metadata = {};

export default function Page() {
  return <PageClient />;
}
`;

const ABOUT_CODE = `'use client';

${CANVAS}

import React from 'react';

export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%', height: 'auto', display: 'flex', flexDirection: 'column' }}>
      <h1 data-id="about-title" data-name="Title" style={{ position: 'relative', width: 'auto', height: 'auto', fontSize: '48px', margin: '0px', flex: '0 0 auto', order: '0' }}>About</h1>
    </div>
  );
}
`;

const BUTTON_CODE = `'use client';

/** @name "Primary Button" */
/** @propMeta {"label":{"type":"plainText","label":"Label"}} */

import React, { useState, useEffect } from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

const variantConfig = [
  { name: 'default', label: 'Primary Button', x: 0, y: 0, isPrimary: true },
  { name: 'default-hover', label: 'Primary Button - Hover', x: 0, y: 72, interactionType: 'hover', parentVariant: 'default' },
];

const connections = [
  { from: 'default', to: 'default-hover', trigger: 'mouseEnter' },
  { from: 'default-hover', to: 'default', trigger: 'mouseLeave' },
];

const pbRootVariants = {
  default: {},
  'default-hover': { backgroundColor: '#000000' },
};

const pbLabelVariants = {
  default: { color: '#010205' },
  'default-hover': { color: '#ffffff' },
};

function PrimaryButton({ style, initialVariant = 'default', label = 'Get started', ...rest }: { style?: React.CSSProperties; initialVariant?: string; label?: string; [key: string]: any }) {
  const [variant, setVariant] = useState(initialVariant);
  useEffect(() => { setVariant(initialVariant); }, [initialVariant]);

  return (
    <LayoutGroup>
    <motion.div
      onHoverEnd={() => setVariant(variant === 'default-hover' ? 'default' : variant)}
      onHoverStart={() => setVariant(variant === 'default' ? 'default-hover' : variant)} layout={true} data-id="pb-root" variants={pbRootVariants} {...rest} data-name="Primary Button" style={{ position: 'absolute', width: '160px', height: '48px', display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderRadius: '50px', border: '1px solid #010205', paddingTop: '13px', paddingRight: '24px', paddingBottom: '13px', paddingLeft: '24px', cursor: 'pointer', flex: '0 0 auto', order: '0' , ...style}} initial={['default', initialVariant]} animate={['default', variant]}>
                <motion.p layout={true} data-id="pb-label" variants={pbLabelVariants} initial={['default', initialVariant]} animate={['default', variant]} data-name="Label" style={{ position: 'relative', width: 'max-content', height: 'auto', fontWeight: '700', fontSize: '16px', color: '#010205', margin: '0px', flex: '0 0 auto', order: '0' }}>{label}</motion.p>
              </motion.div>
    </LayoutGroup>
  );
}

export default withResponsiveProps(PrimaryButton);
`;

const GALAXY_CODE = `'use client';

/** @label "Galaxy" */
/** @comment "A slowly rotating field of stars" */
/** @defaultWidth 600 */
/** @defaultHeight 400 */
/** @controls {
  "speed": { "type": "slider", "label": "Speed", "min": 0, "max": 10, "default": 1, "step": 0.1 }
} */

import { useEffect, useRef } from 'react';
import { withResponsiveProps, useStaticCanvas } from '@revyme/runtime';

function Galaxy({
  speed = 1,
  ...props
}: {
  speed?: number;
  [key: string]: any;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const isStatic = useStaticCanvas();

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const draw = (t: number) => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#ffffff';
      for (let i = 0; i < 80; i++) {
        const a = i * 0.7 + (t / 1000) * speed;
        ctx.fillRect(canvas.width / 2 + Math.cos(a) * i * 3, canvas.height / 2 + Math.sin(a) * i * 2, 2, 2);
      }
    };
    if (isStatic) { draw(0); return; }
    let raf = 0;
    const tick = (t: number) => { draw(t); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isStatic, speed]);

  return (
    <div {...props} style={{ position: 'relative', width: '100%', height: '100%', backgroundColor: '#07070d', ...props.style }}>
      <canvas ref={ref} style={{ position: 'absolute', top: '0px', left: '0px', width: '100%', height: '100%' }} />
    </div>
  );
}

export default withResponsiveProps(Galaxy);
`;

const TOKENS_CODE = `/* Design Tokens — Presets */
:root {
  /* Colors */
  --color-brand: #6366f1;
  --color-ink: #0f172a;
  --color-surface: #ffffff;

  /* Typography */
  --typo-h1-size: 64px;
  --typo-body-size: 18px;

  /* Spacing */
  --space-section: 96px;

  /* Radius */
  --radius-card: 12px;
}
`;

const BLOG_SCHEMA_CODE = JSON.stringify({
  name: 'Blog',
  slug: 'blog',
  fields: [
    { id: 'title', name: 'Title', type: 'text', required: true },
    { id: 'slug', name: 'Slug', type: 'slug' },
    { id: 'excerpt', name: 'Excerpt', type: 'textarea' },
    { id: 'cover', name: 'Cover', type: 'image' },
    { id: 'date', name: 'Date', type: 'date' },
  ],
}, null, 2);

const BLOG_ITEMS_CODE = JSON.stringify([
  { _id: 'post-1', _slug: 'hello-world', _status: 'published', title: 'Hello world', slug: 'hello-world', excerpt: 'Our first post.', cover: '', date: '2026-09-01' },
  { _id: 'post-2', _slug: 'second-post', _status: 'published', title: 'Second post', slug: 'second-post', excerpt: 'More news.', cover: '', date: '2026-09-08' },
], null, 2);

export const FIXTURE_FILES: Record<string, string> = {
  [HOME]: HOME_CODE,
  [HOME_SERVER]: PAGE_SERVER,
  [ABOUT]: ABOUT_CODE,
  [ABOUT_SERVER]: PAGE_SERVER,
  [BUTTON]: BUTTON_CODE,
  [GALAXY]: GALAXY_CODE,
  [TOKENS]: TOKENS_CODE,
  [BLOG_SCHEMA]: BLOG_SCHEMA_CODE,
  [BLOG_ITEMS]: BLOG_ITEMS_CODE,
};
