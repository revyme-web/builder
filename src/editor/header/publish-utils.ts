// publish-utils.ts — Pure helpers extracted from RightHeader.tsx so the
// publish UX can be unit-tested without spinning up React + jotai + the
// fetch mock harness.
//
// Two pieces:
//   1. `sigmoidPublishProgress(elapsedSec)` — the fake-monotonic
//      progress curve that drives the in-button fill bar. Sigmoid
//      so it moves fast early (looks responsive) and decelerates
//      toward an asymptote (never finishes early), capped at 0.95
//      so only a real success snaps it to 1.0.
//   2. `parseWebsiteMeta(raw)` — normalizes the `GET /api/websites/:id`
//      response (Prisma row, snake_case, mixed truthy types for
//      `is_published`) into the Revyme `WebsiteMeta` shape the
//      LiveDropdown consumes.
//
// Both are callable from the React component AND directly from tests;
// they hold zero React state.

import type { WebsiteMeta } from '@/backend/types';

/**
 * Asymptote of the fake-publish progress bar. Real success snaps to 1.0;
 * real failure snaps to 0. Choosing 0.95 (and not 0.99 or 1.0) leaves a
 * visible gap at the right edge so the user knows the bar is still
 * waiting for the real result.
 */
export const PUBLISH_PROGRESS_ASYMPTOTE = 0.95;

/**
 * Time constant of the sigmoid in seconds. The exponent in the formula
 * is `-elapsed / TAU` — at `elapsed = TAU` the bar reaches ~63 % of the
 * asymptote (≈ 0.60), and at `3 * TAU` it reaches ~95 % of the asymptote
 * (≈ 0.90). 8 s gives the bar a "fast at first, slow tail" feel that
 * matches the actual ~25 s deploy duration.
 */
export const PUBLISH_PROGRESS_TAU_SEC = 8;

/**
 * Compute the in-progress publish fill `0 → ASYMPTOTE` from elapsed
 * seconds. Pure function — caller drives `elapsedSec` from `performance.now()`
 * deltas. Negative elapsed is treated as 0 so a clock skew can't take
 * the bar negative.
 */
export function sigmoidPublishProgress(elapsedSec: number): number {
  const t = Math.max(0, elapsedSec);
  return Math.min(
    PUBLISH_PROGRESS_ASYMPTOTE,
    PUBLISH_PROGRESS_ASYMPTOTE * (1 - Math.exp(-t / PUBLISH_PROGRESS_TAU_SEC)),
  );
}

/**
 * Shape of the `GET /api/websites/:id` response we care about for the
 * publish dropdown. Loose-typed because:
 *  - Different DB drivers serialize booleans differently (`true`, `1`,
 *    `'1'`).
 *  - `published_at`, `subdomain`, `custom_subdomain`, `custom_domain`
 *    can each be `null` or absent.
 */
export interface RawWebsiteRow {
  is_published?: boolean | number | string | null;
  published_at?: string | null;
  subdomain?: string | null;
  custom_subdomain?: string | null;
  custom_domain?: string | null;
  live_snapshot_id?: string | null;
  live_snapshot_created_at?: string | null;
  latest_snapshot_id?: string | null;
  plan?: string | null;
  plan_status?: string | null;
}

/**
 * Normalize the snake_case backend payload into the camelCase
 * `WebsiteMeta` the dropdown consumes. Tolerates the `is_published`
 * truthy-zoo (boolean / 0|1 / '0'|'1') in one place so the React side
 * never has to re-derive it.
 */
export function parseWebsiteMeta(raw: RawWebsiteRow): WebsiteMeta {
  const isPublished =
    raw.is_published === true ||
    raw.is_published === 1 ||
    raw.is_published === '1';
  return {
    isPublished,
    publishedAt: raw.published_at ?? null,
    subdomain: raw.subdomain ?? null,
    customSubdomain: raw.custom_subdomain ?? null,
    customDomain: raw.custom_domain ?? null,
    liveSnapshotId: raw.live_snapshot_id ?? null,
    liveSnapshotCreatedAt: raw.live_snapshot_created_at ?? null,
    latestSnapshotId: raw.latest_snapshot_id ?? null,
    plan: raw.plan ?? null,
    planStatus: raw.plan_status ?? null,
  };
}
