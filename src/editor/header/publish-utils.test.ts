// publish-utils.test.ts — Coverage for the pure helpers behind the
// RightHeader publish UX (sigmoid progress curve + meta parsing).

import { describe, it, expect } from 'vitest';
import {
  sigmoidPublishProgress,
  parseWebsiteMeta,
  PUBLISH_PROGRESS_ASYMPTOTE,
  PUBLISH_PROGRESS_TAU_SEC,
} from './publish-utils';

// ─── sigmoidPublishProgress ─────────────────────────────────────────────────

describe('sigmoidPublishProgress', () => {
  it('returns 0 at t=0', () => {
    expect(sigmoidPublishProgress(0)).toBe(0);
  });

  it('clamps negative elapsed to 0 (no negative progress on clock skew)', () => {
    expect(sigmoidPublishProgress(-1)).toBe(0);
    expect(sigmoidPublishProgress(-1000)).toBe(0);
  });

  it('asymptotes to PUBLISH_PROGRESS_ASYMPTOTE — never reaches 1.0', () => {
    expect(sigmoidPublishProgress(60)).toBeLessThan(1);
    expect(sigmoidPublishProgress(60)).toBeLessThanOrEqual(PUBLISH_PROGRESS_ASYMPTOTE);
    expect(sigmoidPublishProgress(600)).toBeCloseTo(PUBLISH_PROGRESS_ASYMPTOTE, 3);
  });

  it('reaches ~63% of asymptote at t = TAU (sigmoid signature)', () => {
    // 1 - e^(-1) ≈ 0.6321, scaled by 0.95 ≈ 0.6005
    const v = sigmoidPublishProgress(PUBLISH_PROGRESS_TAU_SEC);
    expect(v).toBeCloseTo(PUBLISH_PROGRESS_ASYMPTOTE * (1 - Math.exp(-1)), 5);
  });

  it('is strictly monotonic increasing in elapsed', () => {
    let prev = -1;
    for (let t = 0; t < 30; t += 0.5) {
      const v = sigmoidPublishProgress(t);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it('moves visibly in the first second (catches "stuck at 0" regressions)', () => {
    expect(sigmoidPublishProgress(1)).toBeGreaterThan(0.05);
  });

  it('passes 50% well before a typical 25 s deploy completes', () => {
    // If a future tweak makes the bar feel "dead" (e.g. raises TAU too
    // high) this catches it.
    expect(sigmoidPublishProgress(8)).toBeGreaterThan(0.5);
  });
});

// ─── parseWebsiteMeta ───────────────────────────────────────────────────────

describe('parseWebsiteMeta', () => {
  it('returns isPublished=false on empty row', () => {
    // parseWebsiteMeta grew snapshot + plan fields (publish snapshots and
    // plan gating) — all null on an empty row.
    expect(parseWebsiteMeta({})).toEqual({
      isPublished: false,
      publishedAt: null,
      subdomain: null,
      customSubdomain: null,
      customDomain: null,
      latestSnapshotId: null,
      liveSnapshotId: null,
      liveSnapshotCreatedAt: null,
      plan: null,
      planStatus: null,
    });
  });

  it('treats is_published === true as published', () => {
    expect(parseWebsiteMeta({ is_published: true }).isPublished).toBe(true);
  });

  it('treats is_published === 1 as published (Prisma int driver)', () => {
    expect(parseWebsiteMeta({ is_published: 1 }).isPublished).toBe(true);
  });

  it("treats is_published === '1' as published (string driver)", () => {
    expect(parseWebsiteMeta({ is_published: '1' }).isPublished).toBe(true);
  });

  it('treats is_published === 0 / false / null / undefined as not published', () => {
    expect(parseWebsiteMeta({ is_published: 0 }).isPublished).toBe(false);
    expect(parseWebsiteMeta({ is_published: false }).isPublished).toBe(false);
    expect(parseWebsiteMeta({ is_published: null }).isPublished).toBe(false);
    expect(parseWebsiteMeta({}).isPublished).toBe(false);
  });

  it('does NOT coerce truthy strings other than "1" (e.g. "true" stays false)', () => {
    // Defensive: the Prisma layer never emits the literal string "true",
    // and treating arbitrary truthy strings would mask a backend bug.
    expect(parseWebsiteMeta({ is_published: 'true' }).isPublished).toBe(false);
    expect(parseWebsiteMeta({ is_published: 'yes' }).isPublished).toBe(false);
  });

  it('passes through publishedAt, subdomain, customSubdomain, customDomain unchanged', () => {
    expect(parseWebsiteMeta({
      is_published: true,
      published_at: '2026-05-08T18:30:00Z',
      subdomain: 'cool-noun-42',
      custom_subdomain: 'my-site',
      custom_domain: 'example.com',
    })).toEqual({
      isPublished: true,
      publishedAt: '2026-05-08T18:30:00Z',
      subdomain: 'cool-noun-42',
      customSubdomain: 'my-site',
      customDomain: 'example.com',
      // snapshot/plan fields default to null when the row omits them
      latestSnapshotId: null,
      liveSnapshotId: null,
      liveSnapshotCreatedAt: null,
      plan: null,
      planStatus: null,
    });
  });

  it('coerces missing optional fields to null (not undefined)', () => {
    const meta = parseWebsiteMeta({ is_published: true, subdomain: 'foo' });
    expect(meta.publishedAt).toBeNull();
    expect(meta.customSubdomain).toBeNull();
    expect(meta.customDomain).toBeNull();
  });
});
