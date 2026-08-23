// project-fs.ts — Virtual file system for multi-file projects.
// Backed by a jotai atom (Map<string, string>) now.
// ProjectFS interface allows swapping to a real file API later
// without touching any canvas/parser/control code.

import { atom } from 'jotai';
import { buildProvidersSource } from './providers-gen';
import { trace } from '@/shared/debug-trace';
import { ensureLayoutFile } from '@/code/generation/metadata-gen';
import {
  ANIMATED_COUNTER_COMPONENT,
  TYPING_EFFECT_COMPONENT,
  AURORA_BACKGROUND_COMPONENT,
  MATRIX_RAIN_COMPONENT,
  WAVE_DISTORTION_COMPONENT,
  GLITCH_TEXT_COMPONENT,
  FILM_GRAIN_COMPONENT,
  STATIC_TV_COMPONENT,
  PERLIN_NOISE_COMPONENT,
  HALFTONE_COMPONENT,
  SCANLINES_COMPONENT,
  CHROMATIC_NOISE_COMPONENT,
  PATTERN_COMPONENT,
  WAVE_LINES_COMPONENT,
  WAVE_GRADIENT_COMPONENT,
  MESH_GRADIENT_COMPONENT,
  PLASMA_SHADER_COMPONENT,
  LIQUID_METAL_COMPONENT,
  CAUSTICS_LIGHT_COMPONENT,
  NEON_PARTICLE_FIELD_COMPONENT,
  LENS_BOX_COMPONENT,
  MAGNET_BOX_COMPONENT,
  MARQUEE_COMPONENT,
  CAROUSEL_COMPONENT,
  RIBBON_MARQUEE_COMPONENT,
  MARQUEE_3D_COMPONENT,
  MOTION_TRAIL_COMPONENT,
  HORIZONTAL_SCROLL_COMPONENT,
  BLOB_CURSOR_COMPONENT,
  DESIGN_CURSOR_COMPONENT,
  RIBBON_CURSOR_COMPONENT,
  SPLASH_CURSOR_COMPONENT,
  YOUTUBE_EMBED_COMPONENT,
  VIMEO_EMBED_COMPONENT,
  SOUNDCLOUD_EMBED_COMPONENT,
  SPOTIFY_EMBED_COMPONENT,
  GOOGLE_MAPS_EMBED_COMPONENT,
  FACEBOOK_EMBED_COMPONENT,
  TWITTER_EMBED_COMPONENT,
  INSTAGRAM_EMBED_COMPONENT,
  LINKEDIN_EMBED_COMPONENT,
  PINTEREST_EMBED_COMPONENT,
  TIKTOK_EMBED_COMPONENT,
  CALENDLY_EMBED_COMPONENT,
  TYPEFORM_EMBED_COMPONENT,
  GOOGLE_FORM_EMBED_COMPONENT,
  THEME_TOGGLE_COMPONENT,
  LOCALE_SWITCHER_COMPONENT,
  COPY_BUTTON_COMPONENT,
  // Creative — text effects ported from the old builder's customCodeJs.
  MORPHING_TEXT_COMPONENT,
  WORD_ROTATE_COMPONENT,
  SPINNING_TEXT_COMPONENT,
  HANGING_CURVED_COMPONENT,
  MAGNETIC_TEXT_COMPONENT,
  TEXT_PRESSURE_COMPONENT,
  TYPING_TEXT_COMPONENT,
  ROTATING_TEXT_3D_COMPONENT,
  VIDEO_TEXT_COMPONENT,
} from './default-code-components';

// ─── Interface ──────────────────────────────────────────────────────────────

export interface ProjectFS {
  readFile(path: string): string | null;
  writeFile(path: string, content: string): void;
  deleteFile(path: string): void;
  moveFile(oldPath: string, newPath: string): void;
  listFiles(dir?: string): string[];
  exists(path: string): boolean;
}

// ─── In-Memory Implementation ───────────────────────────────────────────────

/**
 * Per-mutation hook info passed to every `writeListener`. Includes the
 * `origin` flag so collaboration subscribers can skip rebroadcasting
 * writes that arrived FROM a remote peer (otherwise: feedback loop).
 */
export interface ProjectFSWriteEvent {
  kind: 'write' | 'delete' | 'move' | 'load-snapshot';
  path?: string;
  /** New content for `write`; absent for `delete` / `move` / snapshot. */
  content?: string;
  /** Set on `move`. */
  oldPath?: string;
  /** Set on `move`. */
  newPath?: string;
  /** `local` (default) — originated from a user action in this client.
   *  `remote` — applied because a collaborator's broadcast arrived. The
   *  collab broadcast hook must check this and skip re-emitting remote
   *  writes to avoid an infinite loop. */
  origin: 'local' | 'remote';
}

export class InMemoryProjectFS implements ProjectFS {
  private files: Map<string, string>;
  private listeners: Set<() => void> = new Set();
  /** Per-write observers — receive the path + content + origin tag on
   *  every mutation. Distinct from `listeners` (which is a coarse
   *  "something changed" pulse used by jotai) so collab subscribers
   *  get the typed payload they need without a full snapshot diff. */
  private writeListeners: Set<(e: ProjectFSWriteEvent) => void> = new Set();
  /** Origin flag for the NEXT mutation. Set by `applyRemoteWrite` /
   *  callers that want to skip the broadcast loop. Auto-resets after
   *  the write fires. */
  private nextOrigin: 'local' | 'remote' = 'local';

  constructor(initialFiles: Map<string, string>) {
    this.files = new Map(initialFiles);
  }

  readFile(path: string): string | null {
    return this.files.get(path) ?? null;
  }

  writeFile(path: string, content: string): void {
    const origin = this.nextOrigin;
    this.nextOrigin = 'local';
    this.files.set(path, content);
    trace.action('project-fs:write', { path, size: content.length, origin });
    this.emit({ kind: 'write', path, content, origin });
    this.notify();
  }

  deleteFile(path: string): void {
    const origin = this.nextOrigin;
    this.nextOrigin = 'local';
    this.files.delete(path);
    trace.action('project-fs:delete', { path, origin });
    this.emit({ kind: 'delete', path, origin });
    this.notify();
  }

  moveFile(oldPath: string, newPath: string): void {
    const content = this.files.get(oldPath);
    if (content === undefined) return;
    const origin = this.nextOrigin;
    this.nextOrigin = 'local';
    this.files.set(newPath, content);
    this.files.delete(oldPath);
    this.emit({ kind: 'move', oldPath, newPath, origin });
    this.notify();
    trace.action('project-fs:move', { from: oldPath, to: newPath, origin });
  }

  /** Subscribe to per-write events (typed payload). Use this for
   *  collab broadcast hooks; `subscribe()` is for jotai's coarse
   *  re-render pulse. */
  subscribeWrites(cb: (e: ProjectFSWriteEvent) => void): () => void {
    this.writeListeners.add(cb);
    return () => this.writeListeners.delete(cb);
  }

  /** Apply a write from a remote collaborator. Behaves exactly like
   *  `writeFile`, but tags the event as `origin: 'remote'` so the
   *  collab broadcast hook can skip re-emitting it. */
  applyRemoteWrite(path: string, content: string): void {
    this.nextOrigin = 'remote';
    this.writeFile(path, content);
  }

  /** Apply a remote delete. Same `origin: 'remote'` semantics as
   *  `applyRemoteWrite`. */
  applyRemoteDelete(path: string): void {
    this.nextOrigin = 'remote';
    this.deleteFile(path);
  }

  private emit(e: ProjectFSWriteEvent): void {
    for (const cb of this.writeListeners) {
      try { cb(e); } catch (err) {
        trace.error('project-fs:write-listener-throw', { error: String(err) });
      }
    }
  }

  listFiles(dir?: string): string[] {
    const prefix = dir ? (dir.endsWith('/') ? dir : dir + '/') : '';
    const result: string[] = [];
    for (const path of this.files.keys()) {
      if (!prefix || path.startsWith(prefix)) {
        result.push(path);
      }
    }
    return result.sort();
  }

  exists(path: string): boolean {
    return this.files.has(path);
  }

  /** Get all files as a snapshot (for serialization/export) */
  getSnapshot(): Map<string, string> {
    return new Map(this.files);
  }

  /** Replace all files (for import/reset) */
  loadSnapshot(files: Map<string, string>): void {
    this.files = new Map(files);
    // One-time NATIVE migration: upgrade the old seed reset (box-sizing only +
    // html/body margins) to the universal margin/padding reset the editor
    // sandboxes apply. Older projects kept the weak seed, so a <p> without an
    // inline margin looked compact in the builder (sandbox reset masked it) but
    // gained UA `1em` margins on the PUBLISHED site — 120px gaps at a 120px
    // font (live find 2026-07-14: nav menu). Exact-match on the seed block so a
    // project with a customized reset is never touched; the fix then lives IN
    // the project's own globals.css — publish ships it with no transformation.
    const globals = this.files.get('app/globals.css');
    if (globals && globals.includes(LEGACY_SEED_RESET)) {
      this.files.set('app/globals.css', globals.replace(LEGACY_SEED_RESET, UNIVERSAL_SEED_RESET));
      trace.action('project-fs:migrated-seed-reset', {});
    }
    trace.action('project-fs:load-snapshot', { fileCount: files.size });
    this.notify();
  }

  /** Subscribe to file changes */
  subscribe(callback: () => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  private notify(): void {
    for (const cb of this.listeners) cb();
  }
}

// ─── Default Project Template ───────────────────────────────────────────────

/** The OLD seed reset (pre-2026-07-14) — box-sizing universal but margins only
 *  on html/body. Upgraded in-place by loadSnapshot; see the migration there. */
const LEGACY_SEED_RESET = `*, *::before, *::after {
  box-sizing: border-box;
}
html, body {
  margin: 0;
  padding: 0;
}`;

/** The universal reset every project ships natively — matches the editor
 *  sandboxes (public/preview.html) exactly so builder and published site
 *  render identically with zero publish-time normalization. */
const UNIVERSAL_SEED_RESET = `*, *::before, *::after {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}`;

// Default @canvas block for new pages — 3 viewports side-by-side
const DEFAULT_CANVAS_BLOCK = `/** @canvas {
  "viewports": [
    { "id": "desktop", "label": "Desktop", "width": 1440, "isPrimary": true, "order": 0 },
    { "id": "tablet", "label": "Tablet", "width": 768, "isPrimary": false, "order": 1 },
    { "id": "mobile", "label": "Mobile", "width": 375, "isPrimary": false, "order": 2 }
  ],
  "positions": {
    "desktop": { "x": 0, "y": 0 },
    "tablet": { "x": 1600, "y": 0 },
    "mobile": { "x": 2528, "y": 0 }
  }
} */`;

const HOME_PAGE = `'use client';

${DEFAULT_CANVAS_BLOCK}

import React from 'react';

export default function Page() {
  return (
<div data-id="root" data-name="Page" style={{
  position: 'relative', width: '100%',
  display: 'flex', flexDirection: 'column',
  backgroundColor: '#ffffff', fontFamily: 'Inter, sans-serif'
}}>
  {/* Hero */}
  <div data-id="hero" data-name="Hero" style={{
    position: 'relative', width: '100%', backgroundColor: '#0f0f1a',
    display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center',
    gap: '24px', paddingTop: '120px', paddingBottom: '120px',
    paddingLeft: '40px', paddingRight: '40px'
  }}>
    <p data-id="title" style={{
      position: 'relative',
      fontSize: '56px', color: '#ffffff', fontWeight: '700',
      letterSpacing: '-1.5px', textAlign: 'center',
      display: 'flex', flexDirection: 'column'
    }}>
      Build the future, visually.
    </p>
    <p data-id="subtitle" style={{
      position: 'relative',
      fontSize: '18px', color: '#888888', maxWidth: '520px',
      textAlign: 'center', lineHeight: '1.7', overflowWrap: 'break-word',
      display: 'flex', flexDirection: 'column'
    }}>
      A code-first visual editor where JSX is the single source of truth. Design on canvas, code updates instantly.
    </p>
    <div data-id="cta" data-name="CTA" style={{
      position: 'relative',
      paddingTop: '14px', paddingBottom: '14px', paddingLeft: '36px', paddingRight: '36px',
      backgroundColor: '#6366f1', color: '#ffffff',
      fontSize: '15px', fontWeight: '600', borderRadius: '8px',
      cursor: 'pointer', marginTop: '8px'
    }}>
      Get Started
    </div>
  </div>

  {/* Features */}
  <div data-id="features" data-name="Features" style={{
    position: 'relative', width: '100%', backgroundColor: '#fafafa',
    display: 'flex', alignItems: 'stretch', justifyContent: 'center',
    gap: '32px', paddingTop: '80px', paddingBottom: '80px',
    paddingLeft: '60px', paddingRight: '60px', flexWrap: 'wrap'
  }}>
    <div data-id="card1" data-name="Card" style={{
      position: 'relative',
      width: '320px', backgroundColor: '#ffffff', borderRadius: '16px',
      paddingTop: '32px', paddingBottom: '32px', paddingLeft: '28px', paddingRight: '28px',
      display: 'flex', flexDirection: 'column', gap: '12px',
      boxShadow: '0 1px 3px rgba(0,0,0,0.06)'
    }}>
      <p data-id="card1-title" style={{position: 'relative', fontSize: '20px', fontWeight: '700', color: '#111'}}>
        Code First
      </p>
      <p data-id="card1-desc" style={{position: 'relative', fontSize: '14px', color: '#666', lineHeight: '1.6', overflowWrap: 'break-word'}}>
        JSX is the source of truth. No JSON, no schema — just code you already know.
      </p>
    </div>
    <div data-id="card2" data-name="Card" style={{
      position: 'relative',
      width: '320px', backgroundColor: '#ffffff', borderRadius: '16px',
      paddingTop: '32px', paddingBottom: '32px', paddingLeft: '28px', paddingRight: '28px',
      display: 'flex', flexDirection: 'column', gap: '12px',
      boxShadow: '0 1px 3px rgba(0,0,0,0.06)'
    }}>
      <p data-id="card2-title" style={{position: 'relative', fontSize: '20px', fontWeight: '700', color: '#111'}}>
        Visual Canvas
      </p>
      <p data-id="card2-desc" style={{position: 'relative', fontSize: '14px', color: '#666', lineHeight: '1.6', overflowWrap: 'break-word'}}>
        Drag, resize, and style elements on canvas. Code updates in real-time.
      </p>
    </div>
    <div data-id="card3" data-name="Card" style={{
      position: 'relative',
      width: '320px', backgroundColor: '#ffffff', borderRadius: '16px',
      paddingTop: '32px', paddingBottom: '32px', paddingLeft: '28px', paddingRight: '28px',
      display: 'flex', flexDirection: 'column', gap: '12px',
      boxShadow: '0 1px 3px rgba(0,0,0,0.06)'
    }}>
      <p data-id="card3-title" style={{position: 'relative', fontSize: '20px', fontWeight: '700', color: '#111'}}>
        Bidirectional
      </p>
      <p data-id="card3-desc" style={{position: 'relative', fontSize: '14px', color: '#666', lineHeight: '1.6', overflowWrap: 'break-word'}}>
        Edit code or canvas — both stay perfectly in sync, always.
      </p>
    </div>
  </div>

  {/* How It Works */}
  <div data-id="how" data-name="How It Works" style={{
    position: 'relative', width: '100%', backgroundColor: '#ffffff',
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    gap: '48px', paddingTop: '80px', paddingBottom: '80px',
    paddingLeft: '40px', paddingRight: '40px'
  }}>
    <p data-id="how-title" style={{
      position: 'relative',
      fontSize: '36px', fontWeight: '700', color: '#111', letterSpacing: '-0.5px'
    }}>
      How it works
    </p>
    <div data-id="steps" data-name="Steps" style={{
      position: 'relative',
      display: 'flex', gap: '60px', alignItems: 'flex-start', justifyContent: 'center',
      maxWidth: '900px', width: '100%'
    }}>
      <div data-id="step1" style={{
        position: 'relative',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px', width: '240px'
      }}>
        <div data-id="step1-num" style={{
          position: 'relative',
          width: '48px', height: '48px', borderRadius: '50%', backgroundColor: '#6366f1',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: '#ffffff', fontSize: '18px', fontWeight: '700'
        }}>1</div>
        <p data-id="step1-label" style={{position: 'relative', fontSize: '16px', fontWeight: '600', color: '#111', textAlign: 'center'}}>
          Write or generate
        </p>
        <p data-id="step1-desc" style={{position: 'relative', fontSize: '13px', color: '#888', textAlign: 'center', lineHeight: '1.5'}}>
          Start with code or let AI generate your layout.
        </p>
      </div>
      <div data-id="step2" style={{
        position: 'relative',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px', width: '240px'
      }}>
        <div data-id="step2-num" style={{
          position: 'relative',
          width: '48px', height: '48px', borderRadius: '50%', backgroundColor: '#6366f1',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: '#ffffff', fontSize: '18px', fontWeight: '700'
        }}>2</div>
        <p data-id="step2-label" style={{position: 'relative', fontSize: '16px', fontWeight: '600', color: '#111', textAlign: 'center'}}>
          Edit visually
        </p>
        <p data-id="step2-desc" style={{position: 'relative', fontSize: '13px', color: '#888', textAlign: 'center', lineHeight: '1.5'}}>
          Drag, resize, and tweak on the canvas. Code follows.
        </p>
      </div>
      <div data-id="step3" style={{
        position: 'relative',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px', width: '240px'
      }}>
        <div data-id="step3-num" style={{
          position: 'relative',
          width: '48px', height: '48px', borderRadius: '50%', backgroundColor: '#6366f1',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: '#ffffff', fontSize: '18px', fontWeight: '700'
        }}>3</div>
        <p data-id="step3-label" style={{position: 'relative', fontSize: '16px', fontWeight: '600', color: '#111', textAlign: 'center'}}>
          Ship it
        </p>
        <p data-id="step3-desc" style={{position: 'relative', fontSize: '13px', color: '#888', textAlign: 'center', lineHeight: '1.5'}}>
          Export clean Next.js code. Ready for production.
        </p>
      </div>
    </div>
  </div>

  {/* Footer */}
  <div data-id="footer" data-name="Footer" style={{
    position: 'relative', width: '100%', backgroundColor: '#0f0f1a',
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    paddingTop: '32px', paddingBottom: '32px',
    paddingLeft: '60px', paddingRight: '60px'
  }}>
    <p data-id="footer-copy" style={{position: 'relative', fontSize: '13px', color: '#555'}}>
      Built with Revyme.
    </p>
    <div data-id="footer-links" style={{position: 'relative', display: 'flex', gap: '24px'}}>
      <p data-id="link1" style={{position: 'relative', fontSize: '13px', color: '#888', cursor: 'pointer'}}>GitHub</p>
      <p data-id="link2" style={{position: 'relative', fontSize: '13px', color: '#888', cursor: 'pointer'}}>Docs</p>
      <p data-id="link3" style={{position: 'relative', fontSize: '13px', color: '#888', cursor: 'pointer'}}>Twitter</p>
    </div>
  </div>
</div>
  );
}`;

const ABOUT_PAGE = `'use client';

${DEFAULT_CANVAS_BLOCK}

import React from 'react';

export default function Page() {
  return (
<div data-id="root" data-name="About Page" style={{
  position: 'relative', width: '1440px', height: '800px',
  backgroundColor: '#0f172a'
}}>
  <div data-id="about-hero" data-name="About Hero" style={{
    position: 'absolute', left: '0px', top: '0px',
    width: '1440px', height: '400px',
    display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center',
    gap: '16px', paddingTop: '60px', paddingRight: '60px', paddingBottom: '60px', paddingLeft: '60px'
  }}>
    <p data-id="about-title" style={{
      fontSize: '48px', color: '#ffffff', fontWeight: '700',
      fontFamily: 'Inter, sans-serif'
    }}>
      About Us
    </p>
    <p data-id="about-desc" style={{
      fontSize: '18px', color: '#94a3b8', maxWidth: '600px',
      textAlign: 'center', lineHeight: '1.6'
    }}>
      We're building the future of visual development.
      Code meets canvas, and everything stays in sync.
    </p>
  </div>
  <div data-id="about-content" data-name="Content" style={{
    position: 'absolute', left: '0px', top: '400px',
    width: '1440px', height: '400px',
    backgroundColor: '#1e293b',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    gap: '40px', paddingTop: '60px', paddingRight: '60px', paddingBottom: '60px', paddingLeft: '60px'
  }}>
    <div data-id="team-card" style={{
      width: '300px', height: '200px', backgroundColor: '#334155',
      borderRadius: '12px', paddingTop: '24px', paddingRight: '24px', paddingBottom: '24px', paddingLeft: '24px',
      display: 'flex', flexDirection: 'column', gap: '8px'
    }}>
      <p data-id="team-title" style={{fontSize: '20px', fontWeight: '600', color: '#ffffff'}}>
        Our Team
      </p>
      <p data-id="team-desc" style={{fontSize: '14px', color: '#94a3b8', lineHeight: '1.5'}}>
        A small team of designers and engineers passionate about tools.
      </p>
    </div>
  </div>
</div>
  );
}`;

const PRICING_CARD_COMPONENT = `import { motion } from 'framer-motion';
import { useState } from 'react';

const variantConfig = [
  { name: 'basic', label: 'Basic', x: 0, y: 0, isPrimary: true },
  { name: 'pro', label: 'Pro (Popular)', x: 420, y: 0 },
  { name: 'enterprise', label: 'Enterprise', x: 840, y: 0 },
];

const cardVariants = {
  basic: {
    width: '340px',
    height: '480px',
    backgroundColor: '#ffffff',
    borderRadius: '16px',
    boxShadow: '0 4px 24px rgba(0,0,0,0.06)',
    y: 0,
  },
  pro: {
    width: '360px',
    height: '540px',
    backgroundColor: '#1a1a2e',
    borderRadius: '24px',
    boxShadow: '0 20px 60px rgba(99,102,241,0.3)',
    y: -30,
  },
  enterprise: {
    width: '340px',
    height: '480px',
    backgroundColor: '#0f172a',
    borderRadius: '16px',
    boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
    y: 0,
  },
};

const badgeVariants = {
  basic: { opacity: 0, scale: 0.5, y: -10 },
  pro: { opacity: 1, scale: 1, y: 0 },
  enterprise: { opacity: 0, scale: 0.5, y: -10 },
};

const priceVariants = {
  basic: { fontSize: '48px', color: '#1a1a2e' },
  pro: { fontSize: '64px', color: '#ffffff' },
  enterprise: { fontSize: '48px', color: '#e2e8f0' },
};

const labelVariants = {
  basic: { color: '#64748b', fontSize: '14px' },
  pro: { color: '#a5b4fc', fontSize: '16px' },
  enterprise: { color: '#64748b', fontSize: '14px' },
};

const titleVariants = {
  basic: { color: '#1a1a2e', fontSize: '24px' },
  pro: { color: '#ffffff', fontSize: '28px' },
  enterprise: { color: '#e2e8f0', fontSize: '24px' },
};

const featureVariants = {
  basic: { color: '#475569', x: 0 },
  pro: { color: '#c7d2fe', x: 0 },
  enterprise: { color: '#94a3b8', x: 0 },
};

const buttonVariants = {
  basic: {
    backgroundColor: '#f1f5f9',
    color: '#1a1a2e',
    borderRadius: '10px',
    padding: '14px 32px',
    scale: 1,
  },
  pro: {
    backgroundColor: '#6366f1',
    color: '#ffffff',
    borderRadius: '14px',
    padding: '18px 40px',
    scale: 1.05,
  },
  enterprise: {
    backgroundColor: '#1e293b',
    color: '#e2e8f0',
    borderRadius: '10px',
    padding: '14px 32px',
    scale: 1,
  },
};

const checkVariants = {
  basic: { color: '#6366f1', scale: 1 },
  pro: { color: '#a5b4fc', scale: 1.2 },
  enterprise: { color: '#6366f1', scale: 1 },
};

const dividerVariants = {
  basic: { backgroundColor: '#e2e8f0', width: '100%' },
  pro: { backgroundColor: '#312e81', width: '80%' },
  enterprise: { backgroundColor: '#1e293b', width: '100%' },
};

const prices = { basic: '19', pro: '49', enterprise: '99' };
const titles = { basic: 'Basic', pro: 'Pro', enterprise: 'Enterprise' };
const features = [
  '5 projects',
  'Custom domain',
  'AI prompts (100/mo)',
  'Analytics',
  'Priority support',
];

export default function PricingCard() {
  const [active, setActive] = useState('basic');

  const cycle = () => {
    const order = ['basic', 'pro', 'enterprise'];
    const next = order[(order.indexOf(active) + 1) % order.length];
    setActive(next);
  };

  return (
    <div data-id="pricing-wrapper" data-name="Pricing Wrapper" style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      gap: '24px', paddingTop: '40px', paddingRight: '40px', paddingBottom: '40px', paddingLeft: '40px',
    }}>
      {/* Variant toggle */}
      <div data-id="pricing-toggles" style={{ display: 'flex', gap: '8px' }}>
        {variantConfig.map((v) => (
          <button
            key={v.name}
            onClick={() => setActive(v.name)}
            style={{
              padding: '8px 20px',
              fontSize: '13px',
              fontWeight: active === v.name ? '600' : '400',
              border: active === v.name ? '2px solid #6366f1' : '1px solid #cbd5e1',
              borderRadius: '8px',
              backgroundColor: active === v.name ? '#eef2ff' : '#fff',
              color: active === v.name ? '#4338ca' : '#64748b',
              cursor: 'pointer',
              fontFamily: 'Inter, sans-serif',
              transition: 'all 0.15s ease',
            }}
          >
            {v.label}
          </button>
        ))}
      </div>

      {/* Animated card */}
      <motion.div
        data-id="pricing-card"
        data-name="Pricing Card"
        variants={cardVariants}
        animate={active}
        onClick={cycle}
        transition={{ type: 'spring', stiffness: 250, damping: 22 }}
        style={{
          width: '340px',
          height: '480px',
          backgroundColor: '#ffffff',
          borderRadius: '16px',
          padding: '36px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '4px',
          cursor: 'pointer',
          position: 'relative',
          overflow: 'hidden',
          fontFamily: 'Inter, sans-serif',
        }}
      >
        {/* Popular badge */}
        <motion.div
          data-id="pricing-badge"
          variants={badgeVariants}
          animate={active}
          transition={{ type: 'spring', stiffness: 400, damping: 20 }}
          style={{
            position: 'absolute', top: '16px', right: '16px',
            backgroundColor: '#6366f1', color: '#fff',
            fontSize: '11px', fontWeight: '700',
            padding: '4px 12px', borderRadius: '20px',
            letterSpacing: '0.5px', textTransform: 'uppercase',
          }}
        >
          Popular
        </motion.div>

        {/* Plan title */}
        <motion.p
          data-id="pricing-title"
          variants={titleVariants}
          animate={active}
          transition={{ type: 'spring', stiffness: 300, damping: 25 }}
          style={{ fontSize: '24px', fontWeight: '700', color: '#1a1a2e', marginBottom: '4px' }}
        >
          {titles[active]}
        </motion.p>

        {/* Price */}
        <div data-id="pricing-price-row" style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>
          <motion.span
            data-id="pricing-dollar"
            variants={labelVariants}
            animate={active}
            transition={{ type: 'spring', stiffness: 300, damping: 25 }}
            style={{ fontSize: '20px', fontWeight: '600', color: '#64748b' }}
          >
            $
          </motion.span>
          <motion.span
            data-id="pricing-amount"
            variants={priceVariants}
            animate={active}
            transition={{ type: 'spring', stiffness: 200, damping: 18 }}
            style={{ fontSize: '48px', fontWeight: '800', color: '#1a1a2e', lineHeight: '1' }}
          >
            {prices[active]}
          </motion.span>
          <motion.span
            data-id="pricing-period"
            variants={labelVariants}
            animate={active}
            transition={{ type: 'spring', stiffness: 300, damping: 25 }}
            style={{ fontSize: '14px', color: '#64748b' }}
          >
            /mo
          </motion.span>
        </div>

        {/* Divider */}
        <motion.div
          data-id="pricing-divider"
          variants={dividerVariants}
          animate={active}
          transition={{ type: 'spring', stiffness: 300, damping: 25 }}
          style={{ width: '100%', height: '1px', backgroundColor: '#e2e8f0', margin: '16px 0' }}
        />

        {/* Features list */}
        <div data-id="pricing-features" style={{
          display: 'flex', flexDirection: 'column', gap: '14px',
          width: '100%', flex: 1,
        }}>
          {features.map((feature, i) => (
            <motion.div
              key={i}
              variants={featureVariants}
              animate={active}
              transition={{ type: 'spring', stiffness: 300, damping: 25, delay: i * 0.03 }}
              style={{ display: 'flex', alignItems: 'center', gap: '12px' }}
            >
              <motion.span
                variants={checkVariants}
                animate={active}
                transition={{ type: 'spring', stiffness: 400, damping: 20 }}
                style={{ fontSize: '16px', color: '#6366f1' }}
              >
                ✓
              </motion.span>
              <span style={{ fontSize: '14px' }}>{feature}</span>
            </motion.div>
          ))}
        </div>

        {/* CTA Button */}
        <motion.div
          data-id="pricing-cta"
          variants={buttonVariants}
          animate={active}
          transition={{ type: 'spring', stiffness: 300, damping: 22 }}
          style={{
            width: '100%', textAlign: 'center',
            fontWeight: '600', fontSize: '15px',
            backgroundColor: '#f1f5f9', color: '#1a1a2e',
            borderRadius: '10px', padding: '14px 32px',
            marginTop: '8px',
          }}
        >
          {active === 'enterprise' ? 'Contact Sales' : 'Get Started'}
        </motion.div>
      </motion.div>
    </div>
  );
}`;

const GALLERY_COMPONENT = `import { motion, AnimatePresence } from 'framer-motion';
import { useState } from 'react';

const variantConfig = [
  { name: 'default', label: 'Gallery', x: 0, y: 0, isPrimary: true },
];

const images = [
  { id: 1, src: 'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=800&h=600&fit=crop', title: 'Mountains', category: 'Nature' },
  { id: 2, src: 'https://images.unsplash.com/photo-1519681393784-d120267933ba?w=800&h=600&fit=crop', title: 'Starry Night', category: 'Night' },
  { id: 3, src: 'https://images.unsplash.com/photo-1470071459604-3b5ec3a7fe05?w=800&h=600&fit=crop', title: 'Forest Path', category: 'Nature' },
  { id: 4, src: 'https://images.unsplash.com/photo-1501785888041-af3ef285b470?w=800&h=600&fit=crop', title: 'Lake Sunset', category: 'Sunset' },
  { id: 5, src: 'https://images.unsplash.com/photo-1465056836900-8f1e940f3404?w=800&h=600&fit=crop', title: 'Ocean Cliffs', category: 'Ocean' },
  { id: 6, src: 'https://images.unsplash.com/photo-1433086966358-54859d0ed716?w=800&h=600&fit=crop', title: 'Waterfall', category: 'Nature' },
];

const overlayVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1 },
};

const modalVariants = {
  hidden: { opacity: 0, scale: 0.7, y: 40 },
  visible: {
    opacity: 1, scale: 1, y: 0,
    transition: { type: 'spring', stiffness: 260, damping: 22 },
  },
  exit: {
    opacity: 0, scale: 0.85, y: 30,
    transition: { duration: 0.2, ease: 'easeIn' },
  },
};

const imageHover = {
  rest: { scale: 1, filter: 'brightness(0.9)' },
  hover: { scale: 1.05, filter: 'brightness(1.1)' },
};

const infoVariants = {
  rest: { opacity: 0, y: 20 },
  hover: { opacity: 1, y: 0 },
};

export default function Gallery() {
  const [selected, setSelected] = useState(null);

  return (
    <div data-id="gallery-root" data-name="Gallery" style={{
      width: '100%', minHeight: '600px', backgroundColor: '#0a0a0a',
      paddingTop: '40px', paddingRight: '40px', paddingBottom: '40px', paddingLeft: '40px', fontFamily: 'Inter, sans-serif',
    }}>
      {/* Header */}
      <div data-id="gallery-header" style={{
        textAlign: 'center', marginBottom: '40px',
      }}>
        <p style={{ fontSize: '13px', color: '#6366f1', fontWeight: '600',
          letterSpacing: '3px', textTransform: 'uppercase', marginBottom: '12px' }}>
          Portfolio
        </p>
        <p style={{ fontSize: '36px', fontWeight: '700', color: '#ffffff',
          letterSpacing: '-1px' }}>
          Selected Works
        </p>
      </div>

      {/* Grid */}
      <div data-id="gallery-grid" style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(3, 1fr)',
        gap: '16px',
        maxWidth: '900px',
        margin: '0 auto',
      }}>
        {images.map((img, i) => (
          <motion.div
            key={img.id}
            initial="rest"
            whileHover="hover"
            animate="rest"
            onClick={() => setSelected(img)}
            style={{
              position: 'relative',
              borderRadius: '12px',
              overflow: 'hidden',
              cursor: 'pointer',
              aspectRatio: '4/3',
            }}
          >
            <motion.img
              src={img.src}
              alt={img.title}
              variants={imageHover}
              transition={{ type: 'spring', stiffness: 300, damping: 25 }}
              style={{
                width: '100%', height: '100%',
                objectFit: 'cover', display: 'block',
              }}
            />
            {/* Hover overlay with info */}
            <motion.div
              variants={infoVariants}
              transition={{ type: 'spring', stiffness: 300, damping: 25 }}
              style={{
                position: 'absolute', bottom: 0, left: 0, right: 0,
                padding: '20px',
                background: 'linear-gradient(transparent, rgba(0,0,0,0.8))',
              }}
            >
              <p style={{ color: '#fff', fontSize: '16px', fontWeight: '600' }}>
                {img.title}
              </p>
              <p style={{ color: '#a5b4fc', fontSize: '12px', marginTop: '4px',
                textTransform: 'uppercase', letterSpacing: '1px' }}>
                {img.category}
              </p>
            </motion.div>
          </motion.div>
        ))}
      </div>

      {/* Lightbox Modal */}
      <AnimatePresence>
        {selected && (
          <motion.div
            variants={overlayVariants}
            initial="hidden"
            animate="visible"
            exit="hidden"
            onClick={() => setSelected(null)}
            style={{
              position: 'fixed', inset: 0,
              backgroundColor: 'rgba(0,0,0,0.85)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              zIndex: 9999, cursor: 'pointer',
              backdropFilter: 'blur(8px)',
            }}
          >
            <motion.div
              variants={modalVariants}
              initial="hidden"
              animate="visible"
              exit="exit"
              onClick={(e) => e.stopPropagation()}
              style={{
                maxWidth: '800px', width: '90%',
                borderRadius: '20px', overflow: 'hidden',
                backgroundColor: '#111',
                boxShadow: '0 40px 100px rgba(0,0,0,0.5)',
                cursor: 'default',
              }}
            >
              <img
                src={selected.src}
                alt={selected.title}
                style={{ width: '100%', height: 'auto', display: 'block' }}
              />
              <div style={{ padding: '24px 28px' }}>
                <p style={{ fontSize: '22px', fontWeight: '700', color: '#fff' }}>
                  {selected.title}
                </p>
                <p style={{ fontSize: '13px', color: '#6366f1', marginTop: '6px',
                  textTransform: 'uppercase', letterSpacing: '2px', fontWeight: '600' }}>
                  {selected.category}
                </p>
              </div>
              {/* Close button */}
              <motion.div
                whileHover={{ scale: 1.1, backgroundColor: 'rgba(255,255,255,0.15)' }}
                whileTap={{ scale: 0.95 }}
                onClick={() => setSelected(null)}
                style={{
                  position: 'absolute', top: '16px', right: '16px',
                  width: '36px', height: '36px',
                  borderRadius: '50%',
                  backgroundColor: 'rgba(255,255,255,0.1)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: '#fff', fontSize: '18px', cursor: 'pointer',
                }}
              >
                ✕
              </motion.div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}`;

const FEATURE_CARD_COMPONENT = `import { motion } from 'framer-motion';
import { useState } from 'react';

const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
  { name: 'expanded', label: 'Expanded', x: 500, y: 0 },
];

const cardVariants = {
  default: {
    width: '300px',
    height: '200px',
    backgroundColor: '#f0f0ff',
    borderRadius: '12px',
  },
  expanded: {
    width: '500px',
    height: '320px',
    backgroundColor: '#e0e7ff',
    borderRadius: '20px',
  },
};

const descVariants = {
  default: { opacity: 0.7, fontSize: '14px' },
  expanded: { opacity: 1, fontSize: '16px' },
};

export default function FeatureCard() {
  const [active, setActive] = useState('default');

  return (
    <motion.div
      data-id="feature-card"
      data-name="Feature Card"
      variants={cardVariants}
      animate={active}
      onClick={() => setActive(active === 'default' ? 'expanded' : 'default')}
      transition={{ type: 'spring', stiffness: 300, damping: 25 }}
      style={{
        width: '300px',
        height: '200px',
        backgroundColor: '#f0f0ff',
        borderRadius: '12px',
        paddingTop: '24px', paddingRight: '24px', paddingBottom: '24px', paddingLeft: '24px',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        cursor: 'pointer',
        overflow: 'hidden',
      }}
    >
      <p data-id="feature-title" style={{
        fontSize: '20px', fontWeight: '600', color: '#1a1a2e'
      }}>
        Code First
      </p>
      <motion.p
        data-id="feature-desc"
        variants={descVariants}
        animate={active}
        transition={{ type: 'spring', stiffness: 300, damping: 25 }}
        style={{ fontSize: '14px', color: '#666', lineHeight: '1.5' }}
      >
        JSX is the source of truth. No JSON conversion needed. Click this card to see the variant animation in action.
      </motion.p>
    </motion.div>
  );
}`;

const HOME_WITH_COMPONENT = `import FeatureCard from '@/components/FeatureCard';

export default function Page() {
  return (
<div data-id="root" data-name="Page" style={{
  position: 'relative', width: '100%', minHeight: '900px',
  backgroundColor: '#f5f5f5'
}}>
  <style>{\`
    @media (max-width: 768px) {
      [data-id="title"] { font-size: 36px !important; }
      [data-id="subtitle"] { font-size: 16px !important; }
      [data-id="features"] { flex-direction: column !important; align-items: center !important; }
    }
  \`}</style>
  <div data-id="hero" data-name="Hero Section" style={{
    position: 'absolute', left: '0px', top: '0px',
    width: '100%', height: '500px',
    backgroundColor: '#1a1a2e',
    display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center',
    gap: '24px', paddingTop: '60px', paddingRight: '60px', paddingBottom: '60px', paddingLeft: '60px'
  }}>
    <p data-id="title" data-name="Headline" style={{
      fontSize: '52px', color: '#ffffff', fontWeight: '700',
      fontFamily: 'Inter, sans-serif', letterSpacing: '-1px'
    }}>
      Welcome to the Future
    </p>
    <p data-id="subtitle" data-name="Subheadline" style={{
      fontSize: '18px', color: '#aaaaaa', maxWidth: '600px',
      textAlign: 'center', lineHeight: '1.6'
    }}>
      Build websites with code as the single source of truth.
      Edit visually on the canvas, or write code directly.
    </p>
    <div data-id="cta" data-name="CTA Button" style={{
      padding: '16px 32px', backgroundColor: '#6366f1',
      color: '#ffffff', fontSize: '16px', fontWeight: '600',
      borderRadius: '8px', cursor: 'pointer', marginTop: '12px'
    }}>
      Get Started
    </div>
  </div>
  <div data-id="features" data-name="Features Section" style={{
    position: 'absolute', left: '0px', top: '500px',
    width: '100%', height: '400px',
    backgroundColor: '#ffffff',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    gap: '40px', paddingTop: '60px', paddingRight: '60px', paddingBottom: '60px', paddingLeft: '60px'
  }}>
    <FeatureCard />
    <FeatureCard />
    <FeatureCard />
  </div>
</div>
  );
}`;

/** Create the default project file map */
// ─── Default i18n Config ─────────────────────────────────────────────────────

// ENGLISH ONLY. This used to seed en + fr + es, which meant every project
// ever created started with two languages nobody asked for: empty override
// files, empty message dictionaries, a LocaleSwitcher offering them, and a
// generated route wrapper per page per locale in the published build — all
// for content that was never written. Measured on production 2026-08-23,
// 69 of 82 published sites carried a multi-locale config and only 13 had
// translated anything.
//
// Adding a language is one click and fully self-provisioning: `addLocale`
// (locale-ops.ts) writes the config entry, creates `i18n/<code>.json`,
// regenerates `app/providers.tsx`, creates `messages/<code>.json`, and syncs
// the route wrappers. Nothing here needs to pre-create any of it.
const DEFAULT_I18N_CONFIG = JSON.stringify({
  defaultLocale: 'en',
  locales: [
    { code: 'en', label: 'English' },
  ],
}, null, 2);

// next-intl messages — namespaced by page slug: { home: { title: "..." } }.
// Pages call `useTranslations('home')` then `t('title')`. Empty by default;
// the editor populates these on first text edit (in a non-default locale,
// the JSX is rewritten to `{t('id')}` and the original copy moves to the
// default-locale messages file as the fallback).
const DEFAULT_EN_MESSAGES = JSON.stringify({}, null, 2);

// ─── Default CMS Collections ─────────────────────────────────────────────────

const TEAM_SCHEMA = JSON.stringify({
  name: 'Team Members',
  slug: 'team',
  fields: [
    { id: 'name', name: 'Name', type: 'text', required: true, translatable: true },
    { id: 'role', name: 'Role', type: 'text', translatable: true },
    { id: 'bio', name: 'Bio', type: 'richtext', translatable: true },
    { id: 'photo', name: 'Photo', type: 'image', translatable: false },
    { id: 'linkedin', name: 'LinkedIn', type: 'link', translatable: false },
    { id: 'featured', name: 'Featured', type: 'boolean', translatable: false },
  ],
}, null, 2);

const TEAM_DATA = JSON.stringify([
  { _id: 'alice', _slug: 'alice', _status: 'published', _createdAt: '2026-01-15T10:00:00Z', _updatedAt: '2026-01-15T10:00:00Z', name: 'Alice Johnson', role: 'CEO', bio: 'Leads product strategy and company vision.', photo: 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=400', linkedin: 'https://linkedin.com/in/alice', featured: true },
  { _id: 'bob', _slug: 'bob', _status: 'published', _createdAt: '2026-01-15T10:00:00Z', _updatedAt: '2026-01-15T10:00:00Z', name: 'Bob Smith', role: 'CTO', bio: 'Builds the platform and leads engineering.', photo: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=400', linkedin: 'https://linkedin.com/in/bob', featured: false },
  { _id: 'carol', _slug: 'carol', _status: 'published', _createdAt: '2026-01-15T10:00:00Z', _updatedAt: '2026-01-15T10:00:00Z', name: 'Carol Davis', role: 'Design Lead', bio: 'Crafts the visual identity and design system.', photo: 'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=400', linkedin: 'https://linkedin.com/in/carol', featured: true },
], null, 2);

const BLOG_SCHEMA = JSON.stringify({
  name: 'Blog Posts',
  slug: 'blog',
  fields: [
    { id: 'title', name: 'Title', type: 'text', required: true, translatable: true },
    { id: 'excerpt', name: 'Excerpt', type: 'text', translatable: true },
    { id: 'content', name: 'Content', type: 'richtext', translatable: true },
    { id: 'cover', name: 'Cover Image', type: 'image', translatable: false },
    { id: 'author', name: 'Author', type: 'reference', referenceCollection: 'team', translatable: false },
    { id: 'publishDate', name: 'Publish Date', type: 'date', translatable: false },
    { id: 'category', name: 'Category', type: 'enum', options: ['Engineering', 'Design', 'Product', 'Company'], translatable: false },
  ],
}, null, 2);

const BLOG_DATA = JSON.stringify([
  { _id: 'post-1', _slug: 'launching-v2', _status: 'published', _createdAt: '2026-03-01T10:00:00Z', _updatedAt: '2026-03-01T10:00:00Z', title: 'Launching v2.0', excerpt: 'Our biggest release yet with a completely redesigned editor.', content: 'We are thrilled to announce v2.0...', cover: 'https://images.unsplash.com/photo-1517694712202-14dd9538aa97?w=800', author: 'alice', publishDate: '2026-03-01', category: 'Product' },
  { _id: 'post-2', _slug: 'design-system-guide', _status: 'published', _createdAt: '2026-02-15T10:00:00Z', _updatedAt: '2026-02-15T10:00:00Z', title: 'Building a Design System', excerpt: 'How we built our component library from scratch.', content: 'Design systems are the foundation...', cover: 'https://images.unsplash.com/photo-1558655146-9f40138edfeb?w=800', author: 'carol', publishDate: '2026-02-15', category: 'Design' },
], null, 2);

const TESTIMONIALS_SCHEMA = JSON.stringify({
  name: 'Testimonials',
  slug: 'testimonials',
  fields: [
    { id: 'quote', name: 'Quote', type: 'richtext', required: true, translatable: true },
    { id: 'name', name: 'Name', type: 'text', required: true, translatable: false },
    { id: 'company', name: 'Company', type: 'text', translatable: false },
    { id: 'avatar', name: 'Avatar', type: 'image', translatable: false },
    { id: 'rating', name: 'Rating', type: 'number', translatable: false, defaultValue: 5 },
  ],
}, null, 2);

const TESTIMONIALS_DATA = JSON.stringify([
  { _id: 'test-1', _slug: 'sarah-review', _status: 'published', _createdAt: '2026-01-20T10:00:00Z', _updatedAt: '2026-01-20T10:00:00Z', quote: 'This tool completely transformed our workflow. The visual editor is incredibly intuitive.', name: 'Sarah Chen', company: 'Acme Inc', avatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=200', rating: 5 },
  { _id: 'test-2', _slug: 'james-review', _status: 'published', _createdAt: '2026-01-25T10:00:00Z', _updatedAt: '2026-01-25T10:00:00Z', quote: 'Best website builder I have used. The code output is clean and production-ready.', name: 'James Wilson', company: 'TechCorp', avatar: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=200', rating: 5 },
  { _id: 'test-3', _slug: 'maria-review', _status: 'published', _createdAt: '2026-02-01T10:00:00Z', _updatedAt: '2026-02-01T10:00:00Z', quote: 'The localization features saved us weeks of work on our international launch.', name: 'Maria Garcia', company: 'GlobalBrand', avatar: 'https://images.unsplash.com/photo-1580489944761-15a19d654956?w=200', rating: 4 },
], null, 2);

const DEFAULT_TOKENS_CSS = `/* Modern reset — without this, \`width: 100%\` + horizontal padding
   blows out the layout because the browser's default box-sizing is
   content-box. Most Next.js starters ship this (or Tailwind preflight).
   margin/padding are reset UNIVERSALLY (not just html/body) to match the
   editor sandboxes (public/preview.html) EXACTLY — the sandboxes zero UA
   margins on every element, so a <p> without an inline margin looked
   compact in the builder but gained 1em top+bottom (120px at a 120px
   font!) on the PUBLISHED site (live find 2026-07-14: nav menu links with
   huge gaps live, compact in the editor). The reset ships natively in the
   project so publish needs no post-build normalization. */
${UNIVERSAL_SEED_RESET}
body {
  /* Global default font — content that doesn't set its own font-family (e.g.
     text inside component instances / layout templates) inherits this instead
     of the browser's serif default. Matches the canvas + preview sandboxes so
     the published site renders identically to the builder. */
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
/* Links inherit their surroundings — no browser-default underline or blue/visited-purple. Matches the
   editor preview (ServerPreview) + the deploy reset so a link without inline textDecoration:'none' (e.g. a
   logo link) looks the same live as in the builder. NOT applied to the editor canvas (refreshCanvasTokens
   extracts only :root/@keyframes from this CSS, so global element selectors never leak into the editor UI). */
a {
  color: inherit;
  text-decoration: inherit;
}

/* Design Tokens */
:root {
  /* Colors */
  --color-brand: #6366f1;
  --color-brand-light: #818cf8;
  --color-surface: #ffffff;
  --color-surface-dark: #0f0f1a;
  --color-text: #111111;
  --color-text-muted: #666666;
  --color-text-light: #888888;
  --color-accent: #6366f1;
  --color-success: #22c55e;
  --color-error: #ef4444;

  /* Typography */
  --typo-heading-font: 'Inter', sans-serif;
  --typo-heading-weight: 700;
  --typo-heading-color: #111111;
  --typo-heading-transform: none;
  --typo-heading-decoration: none;
  --typo-heading-shadow: none;
  --typo-heading-size: 56px;
  --typo-heading-spacing: -1.5px;
  --typo-heading-line-height: 1.1;
  --typo-heading-size-md: 40px;
  --typo-heading-spacing-md: -1px;
  --typo-heading-line-height-md: 1.15;
  --typo-heading-size-sm: 32px;
  --typo-heading-spacing-sm: -0.5px;
  --typo-heading-line-height-sm: 1.2;
  --typo-heading-min-default: 1200;
  --typo-heading-min-md: 600;
  --typo-body-font: 'Inter', sans-serif;
  --typo-body-weight: 400;
  --typo-body-color: #333333;
  --typo-body-transform: none;
  --typo-body-decoration: none;
  --typo-body-shadow: none;
  --typo-body-size: 16px;
  --typo-body-spacing: 0px;
  --typo-body-line-height: 1.7;
  --typo-body-size-md: 15px;
  --typo-body-line-height-md: 1.6;
  --typo-body-size-sm: 14px;
  --typo-body-line-height-sm: 1.5;
  --typo-body-min-default: 1200;
  --typo-body-min-md: 600;

  /* Spacing */
  --space-section-y: 80px;
  --space-section-x: 60px;
  --space-card-padding: 32px;
  --space-gap: 24px;

  /* Radius */
  --radius-card: 16px;
  --radius-button: 8px;
  --radius-pill: 100px;

  /* Shadows */
  --shadow-card: 0 1px 3px rgba(0,0,0,0.06);
  --shadow-elevated: 0 4px 12px rgba(0,0,0,0.1);
}

/* Dark theme — applied when next-themes adds the .dark class on <html>.
   Override any token whose value should change in dark mode; tokens not
   redefined here inherit from :root above. The canvas Renderer scopes
   :root → [data-content-root] but skips :root.dark so the canvas always
   shows light mode (the editor has its own theme switcher). */
:root.dark {
  --color-surface: #0f0f1a;
  --color-surface-dark: #ffffff;
  --color-text: #f5f5f5;
  --color-text-muted: #a1a1aa;
  --color-text-light: #71717a;
  --typo-heading-color: #ffffff;
  --typo-body-color: #d4d4d8;
  --shadow-card: 0 1px 3px rgba(0,0,0,0.4);
  --shadow-elevated: 0 4px 12px rgba(0,0,0,0.6);
}
`;

// Server layout — pure server component with metadata + html/body shell.
// NO LayoutClient indirection: pages without a Template render directly
// against `{children}` here (chrome-free), and pages WITH a Template
// resolve their layout via the route-group's own `layout.tsx`. The bare
// `app/LayoutClient.tsx` was redundant.
const DEFAULT_LAYOUT = `import './globals.css';
import { Providers } from './providers';

export const metadata = {
  title: '',
  description: '',
};

export const siteConfig = {
  language: 'en',
  theme: 'light',
  customHead: '',
  customBody: '',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning: next-themes mutates the <html> class on
    // mount to apply the user's persisted theme; without this React
    // warns about the server/client class mismatch.
    <html lang="en" suppressHydrationWarning>
      <body>
        <Providers>
          {children}
        </Providers>
      </body>
    </html>
  );
}
`;

// Client-only providers wrapper. Lives separate from LayoutClient so the
// canvas-parsed layout file stays free of next-themes / next-intl /
// any runtime context that the parser doesn't know how to make transparent.
//
// i18n: NextIntlClientProvider is the standard next-intl client setup. We
// hold the active locale in client state (synced with localStorage and the
// `<html lang>` attribute) so the LocaleSwitcher Code component can flip it without
// a server round-trip. Each `messages/{locale}.json` is bundled at build
// time (Next.js + Vite/Webpack handle the JSON imports natively).
// English only — see DEFAULT_I18N_CONFIG. Must stay in step with it: providers
// imports one `messages/<code>.json` per configured locale, so listing a locale
// here that the config doesn't seed would emit an import for a missing file.
export const DEFAULT_PROVIDERS = buildProvidersSource({
  defaultLocale: 'en',
  locales: [
    { code: 'en', label: 'English' },
  ],
});

// (No root LayoutClient and no shipped Templates. The default project is
// completely template-free — `app/page.tsx` + `app/about/page.tsx` render
// against the bare `app/layout.tsx` (just `<html><body>{children}</body></html>`
// + Providers). Users create their first Template themselves from the
// Library panel; that's when chrome enters the picture.)



// ─── Empty starter ─────────────────────────────────────────────────────────
// Used by File → New project (and the no-files-on-load branch in
// ProjectLoader). One desktop viewport at 1440×900, single empty white
// root div. Runtime utilities (`withResponsiveProps`, `withCursor`,
// `CursorPortal`) are no longer seeded as projectFS files — they come
// from `@revyme/runtime` (npm package). See `revyme-open/runtime/`.
// Deliberately bare — "blank canvas" instead of the demo content
// `createDefaultProject()` ships.

const EMPTY_CANVAS_BLOCK = `/** @canvas {
  "viewports": [
    { "id": "desktop", "label": "Desktop", "width": 1440, "height": 900, "isPrimary": true, "order": 0 }
  ],
  "positions": {
    "desktop": { "x": 0, "y": 0 }
  }
} */`;

// Pages ship as a PAIR: the server wrapper (owns SEO `metadata`) and
// the client body (canvas-editable). Next.js's App Router only reads
// `export const metadata` from server components, but the editor's
// generated JSX needs `'use client'` for hooks / motion / refs — the
// pair sidesteps that constraint.

const EMPTY_HOME_PAGE_SERVER = `import PageClient from './page.client';

export const metadata = {};

export default function Page() {
  return <PageClient />;
}
`;

const EMPTY_HOME_PAGE_CLIENT = `'use client';

${EMPTY_CANVAS_BLOCK}

import React from 'react';

export default function Page() {
  return (
<div data-id="root" data-name="Page" style={{
  position: 'relative', width: '100%', height: '900px',
  backgroundColor: '#ffffff'
}}>
</div>
  );
}
`;

export function createEmptyProject(): Map<string, string> {
  return new Map([
    ['app/page.tsx', EMPTY_HOME_PAGE_SERVER],
    ['app/page.client.tsx', EMPTY_HOME_PAGE_CLIENT],
    // Root layout — REQUIRED. Next.js (and our preview's router) need a
    // root `app/layout.tsx`; without it the preview renders the page with
    // NO layout chain, so anything mounted in the layout (e.g. the cursor
    // runtime's `<CursorPortal />`) never appears. Use the same bare server
    // shell `ensureLayoutFile()` emits so this matches the canonical layout
    // every other code path creates. Omitting it was why a freshly-created
    // cloud website had no layout and component cursors didn't render.
    ['app/layout.tsx', ensureLayoutFile()],
    // The layout wraps children in Providers (next-themes + next-intl) —
    // seed the providers module + the i18n scaffold it imports, or every
    // localized page crashes with a missing NextIntlClientProvider context.
    ['app/providers.tsx', DEFAULT_PROVIDERS],
    ['i18n/config.json', DEFAULT_I18N_CONFIG],
    ['messages/en.json', '{}'],
    // `app/layout.tsx` imports `./globals.css`; seed it so the import
    // resolves (modern reset + design tokens). The preview tolerates a
    // missing CSS file, but a real Next build would error without it.
    ['app/globals.css', DEFAULT_TOKENS_CSS],
    // `withResponsiveProps` / `withCursor` / `CursorPortal` now live in the
    // `@revyme/runtime` npm package — no longer seeded as projectFS files.
    // Existing projects with `lib/withResponsiveProps.tsx` keep working
    // (the canvas runtime resolver still maps the legacy `@/lib/...` paths),
    // but new projects don't generate them.
  ]);
}

// Generic server-wrapper template for any page pair. Imports the
// sibling `./page.client` and renders it from a real function body —
// gives the user somewhere to wire `generateMetadata`, params, or
// JSON-LD later without restructuring the file. Owns the `metadata`
// export so Next.js picks up SEO config.
const PAGE_SERVER_WRAPPER = `import PageClient from './page.client';

export const metadata = {};

export default function Page() {
  return <PageClient />;
}
`;

export function createDefaultProject(): Map<string, string> {
  return new Map([
    // Starter pages — chrome-free, NO template assignment. The user
    // creates their first Template from the Library when they want a
    // shared header/footer; until then pages render against the bare
    // root layout.
    // Each route ships as a PAIR: page.tsx (server wrapper, hosts
    // metadata) + page.client.tsx (the canvas-editable body).
    ['app/page.tsx', PAGE_SERVER_WRAPPER],
    ['app/page.client.tsx', HOME_PAGE],
    ['app/about/page.tsx', PAGE_SERVER_WRAPPER],
    ['app/about/page.client.tsx', ABOUT_PAGE],
    // Runtime utilities (`withResponsiveProps`, `withCursor`, `CursorPortal`)
    // live in `@revyme/runtime` — installed via npm, no longer seeded as
    // projectFS files. See `revyme-open/runtime/`.
    // No components ship pre-installed. Built-in code components (Insert panel: Aurora,
    // Counter, FilmGrain, embeds, etc.) install lazily into `components/` on
    // drop via `installBuiltInCodeComponent()` — keeps a fresh project file tree
    // empty until the user actually uses something. User-created design /
    // code components also land in `components/` when added from the Library.
    // i18n — English only. Additional languages are created on demand by
    // `addLocale`, which writes the config entry, the `i18n/<code>.json`
    // override map (the canvas-fast-render path: text/style/prop overrides
    // keyed by file path + node id) and the `messages/<code>.json` next-intl
    // dictionary consumed by `useTranslations()`.
    ['i18n/config.json', DEFAULT_I18N_CONFIG],
    ['messages/en.json', DEFAULT_EN_MESSAGES],
    // CMS — 3 collections (Team, Blog, Testimonials)
    ['cms/team.schema.json', TEAM_SCHEMA],
    ['cms/team.json', TEAM_DATA],
    ['cms/blog.schema.json', BLOG_SCHEMA],
    ['cms/blog.json', BLOG_DATA],
    ['cms/testimonials.schema.json', TESTIMONIALS_SCHEMA],
    ['cms/testimonials.json', TESTIMONIALS_DATA],
    // Design Tokens (CSS custom properties)
    ['app/globals.css', DEFAULT_TOKENS_CSS],
    // Root layout: server-only shell with metadata + Providers wrapping
    // `{children}` directly. NO chrome here — that's a Template's job, and
    // the starter ships with zero Templates so the user picks the chrome
    // they want via the Library's "+" button.
    ['app/layout.tsx', DEFAULT_LAYOUT],
    // Providers — client-side context wrappers (next-themes, etc). Not parsed
    // by the canvas; only the live Next.js build sees it.
    ['app/providers.tsx', DEFAULT_PROVIDERS],
  ]);
}

// ─── Built-in Code component Registry ────────────────────────────────────────────────
// Lazy-install registry: each Insert-panel code component drop calls
// `installBuiltInCodeComponent(fs, tag)` which writes the file from this list IF it's
// not already in ProjectFS. A fresh project ships zero `components/*.tsx` —
// the Library panel only lists components the user actually pulled in (via
// Insert drag, AI generation, or manual creation).

const BUILT_IN_COMPONENTS: [string, string][] = [
  // Effects / animations
  ['components/AnimatedCounter.tsx', ANIMATED_COUNTER_COMPONENT],
  ['components/AuroraBackground.tsx', AURORA_BACKGROUND_COMPONENT],
  ['components/MatrixRain.tsx', MATRIX_RAIN_COMPONENT],
  ['components/WaveDistortion.tsx', WAVE_DISTORTION_COMPONENT],
  ['components/GlitchText.tsx', GLITCH_TEXT_COMPONENT],
  // Noise utility code components — overlays for grain / static / halftone / scanlines.
  ['components/FilmGrain.tsx', FILM_GRAIN_COMPONENT],
  ['components/StaticTV.tsx', STATIC_TV_COMPONENT],
  ['components/PerlinNoise.tsx', PERLIN_NOISE_COMPONENT],
  ['components/Halftone.tsx', HALFTONE_COMPONENT],
  ['components/Pattern.tsx', PATTERN_COMPONENT],
  // Shaders — animated canvas-2D gradient/wave effects (replace the
  // legacy static CSS-gradient div items in the Insert > Utility panel).
  ['components/WaveLines.tsx', WAVE_LINES_COMPONENT],
  ['components/WaveGradient.tsx', WAVE_GRADIENT_COMPONENT],
  ['components/MeshGradient.tsx', MESH_GRADIENT_COMPONENT],
  ['components/PlasmaShader.tsx', PLASMA_SHADER_COMPONENT],
  ['components/LiquidMetal.tsx', LIQUID_METAL_COMPONENT],
  ['components/CausticsLight.tsx', CAUSTICS_LIGHT_COMPONENT],
  ['components/NeonParticleField.tsx', NEON_PARTICLE_FIELD_COMPONENT],
  // Container code components — render connected canvas nodes via the slot system.
  ['components/LensBox.tsx', LENS_BOX_COMPONENT],
  ['components/MagnetBox.tsx', MAGNET_BOX_COMPONENT],
  // Effect code components — multi-slot containers that animate connected nodes.
  ['components/Marquee.tsx', MARQUEE_COMPONENT],
  ['components/Carousel.tsx', CAROUSEL_COMPONENT],
  ['components/RibbonMarquee.tsx', RIBBON_MARQUEE_COMPONENT],
  ['components/Marquee3D.tsx', MARQUEE_3D_COMPONENT],
  ['components/MotionTrail.tsx', MOTION_TRAIL_COMPONENT],
  ['components/HorizontalScroll.tsx', HORIZONTAL_SCROLL_COMPONENT],
  // Cursor code components — region hotspots (no slot). The bounding box is the
  // cursor zone; clicks pass through (pointer-events: none) so they work
  // when placed over interactive content.
  ['components/BlobCursor.tsx', BLOB_CURSOR_COMPONENT],
  ['components/DesignCursor.tsx', DESIGN_CURSOR_COMPONENT],
  ['components/RibbonCursor.tsx', RIBBON_CURSOR_COMPONENT],
  ['components/SplashCursor.tsx', SPLASH_CURSOR_COMPONENT],
  ['components/Scanlines.tsx', SCANLINES_COMPONENT],
  ['components/ChromaticNoise.tsx', CHROMATIC_NOISE_COMPONENT],
  // Integration / embed code components — Insert panel drops these as
  // `<YouTubeEmbed/>` etc. Without registering the code component file in ProjectFS
  // the iframe CodeComponentHost has nothing to mount and the canvas shows an empty
  // blue wrapper. (The live website resolves these because Next.js bundles
  // them at build time; the canvas needs the file in ProjectFS to load.)
  ['components/YouTubeEmbed.tsx', YOUTUBE_EMBED_COMPONENT],
  ['components/VimeoEmbed.tsx', VIMEO_EMBED_COMPONENT],
  ['components/SoundCloudEmbed.tsx', SOUNDCLOUD_EMBED_COMPONENT],
  ['components/SpotifyEmbed.tsx', SPOTIFY_EMBED_COMPONENT],
  ['components/GoogleMapsEmbed.tsx', GOOGLE_MAPS_EMBED_COMPONENT],
  ['components/FacebookEmbed.tsx', FACEBOOK_EMBED_COMPONENT],
  ['components/TwitterEmbed.tsx', TWITTER_EMBED_COMPONENT],
  ['components/InstagramEmbed.tsx', INSTAGRAM_EMBED_COMPONENT],
  ['components/LinkedInEmbed.tsx', LINKEDIN_EMBED_COMPONENT],
  ['components/PinterestEmbed.tsx', PINTEREST_EMBED_COMPONENT],
  ['components/TikTokEmbed.tsx', TIKTOK_EMBED_COMPONENT],
  ['components/CalendlyEmbed.tsx', CALENDLY_EMBED_COMPONENT],
  ['components/TypeformEmbed.tsx', TYPEFORM_EMBED_COMPONENT],
  ['components/GoogleFormEmbed.tsx', GOOGLE_FORM_EMBED_COMPONENT],
  // Interactive utility — theme + locale switchers. Live on production via
  // next-themes + a `locale-change` window event; canvas-only stub renders
  // the icon without firing real handlers.
  ['components/ThemeToggle.tsx', THEME_TOGGLE_COMPONENT],
  ['components/LocaleSwitcher.tsx', LOCALE_SWITCHER_COMPONENT],
  ['components/CopyButton.tsx', COPY_BUTTON_COMPONENT],
  // Creative — text effects (port batch 1 of the old builder's
  // customCodeJs library). Each one is a self-contained React code component
  // with `@controls` exposing the same axes the imperative versions
  // had. Drop via Insert > Creative > Code Snippets in the panel.
  ['components/MorphingText.tsx', MORPHING_TEXT_COMPONENT],
  ['components/WordRotate.tsx', WORD_ROTATE_COMPONENT],
  ['components/SpinningText.tsx', SPINNING_TEXT_COMPONENT],
  ['components/HangingCurved.tsx', HANGING_CURVED_COMPONENT],
  ['components/MagneticText.tsx', MAGNETIC_TEXT_COMPONENT],
  ['components/TextPressure.tsx', TEXT_PRESSURE_COMPONENT],
  // Port batch 2 — TypingText (multi-word cycle, distinct from the
  // single-string TypingEffect code component). RotatingText3D and VideoText
  // are full creative effects (3D cylinder + SVG-mask video clip).
  ['components/TypingText.tsx', TYPING_TEXT_COMPONENT],
  ['components/RotatingText3D.tsx', ROTATING_TEXT_3D_COMPONENT],
  ['components/VideoText.tsx', VIDEO_TEXT_COMPONENT],
  // TypingEffect ships in createDefaultProject already, but re-syncing
  // here keeps the canonical text-effect set discoverable via the
  // built-in registry (the AI service may import `@/components/TypingEffect`).
  ['components/TypingEffect.tsx', TYPING_EFFECT_COMPONENT],
];

/**
 * Refresh templates of built-in code components ALREADY installed in the project.
 * Does NOT install new files, and NEVER overwrites a file whose content the
 * user (or an AI/MCP session) has customized.
 *
 * ⚠️ This used to overwrite ANY installed built-in whose content differed
 * from the shipped template — which silently DESTROYED user customizations
 * on every project load (the endlessly-reverting LocaleSwitcher, 2026-07-22:
 * a rewritten switcher was stamped back to the stock template on EVERY boot,
 * then autosaved over the cloud copy). "Differs from the template" cannot
 * distinguish "stale template" from "user's own version", so the only safe
 * policy is: a modified file belongs to the user — leave it alone. Template
 * fixes reach fresh installs via `installBuiltInCodeComponent`.
 */
export function syncBuiltInCodeComponents(fs: InMemoryProjectFS): void {
  let skippedModified = 0;
  for (const [path, template] of BUILT_IN_COMPONENTS) {
    const existing = fs.readFile(path);
    // `readFile` returns null/undefined for missing files. Skip both — only
    // consider files the user actually has in their project.
    if (existing == null) continue;
    if (existing !== template) skippedModified++;
  }
  if (skippedModified > 0) {
    trace.action('project-fs:sync-built-in-components', { skippedModified, total: BUILT_IN_COMPONENTS.length });
  }
}

/**
 * Lazy-install a built-in code component by component tag (e.g. `'AuroraBackground'`).
 * No-op if the file already exists. Returns true if the code component was just
 * installed, false if already present, null if the tag isn't a known
 * built-in. Call from Insert-panel drop handlers BEFORE queueing the
 * `addNode` mutation so the import resolves on the next render cycle.
 */
export function installBuiltInCodeComponent(fs: InMemoryProjectFS, tag: string): boolean | null {
  if (!tag || !/^[A-Z]/.test(tag)) return null; // not a component tag
  const path = `components/${tag}.tsx`;
  const entry = BUILT_IN_COMPONENTS.find(([p]) => p === path);
  if (!entry) return null; // not a built-in we know about
  // `readFile` returns null/undefined for missing files — both mean install.
  if (fs.readFile(path) != null) return false; // already installed
  fs.writeFile(path, entry[1]);
  trace.action('project-fs:install-built-in-code-component', { tag, path });
  return true;
}

// ─── Singleton + Atom ───────────────────────────────────────────────────────

/** The global ProjectFS instance. Used by mutation queue and other imperative code. */
export let projectFS: InMemoryProjectFS = new InMemoryProjectFS(createDefaultProject());

/** Jotai atom — triggers re-renders when files change. Increments on every write. */
export const projectVersionAtom = atom(0);

/**
 * Mirror of `projectVersionAtom` that pauses updates while the canvas is
 * being interacted with (drag/resize). Heavy panel parsers + tool components
 * derive from this so a fast drag's per-reparent file write doesn't trigger
 * a full PropertiesPanel re-render cascade on every frame. Synced from
 * Canvas.tsx via a `useEffect` watcher — see `stableCodeAtom` in store.ts.
 */
export const stableProjectVersionAtom = atom(0);

/** Re-initialize the ProjectFS (for reset/import) */
export function resetProjectFS(files?: Map<string, string>): void {
  projectFS = new InMemoryProjectFS(files ?? createDefaultProject());
  syncBuiltInCodeComponents(projectFS);
  trace.action('project-fs:reset', { fileCount: projectFS.listFiles().length });
}

// NOTE: modifyProjectFile() lives in ./modify-file.ts (separate file to avoid circular dependency).
// Import it from '@/code/project/modify-file' — NOT from this file.
