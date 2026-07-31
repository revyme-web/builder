// hosts.ts — external Revyme host constants, env-overridable for
// self-hosters. Every `assets.revyme.app` / `platform.revyme.app`
// string in src/ routes through these (grep-enforced in the OSS
// release checks) so a fork can point its own CDN/platform without
// hunting string literals.
//
// The CDN serves immutable shared bundles (`/components/<n>@<hash>.js`,
// `/vectors/…`, plugin archives). Cloud-only features
// (share, marketplace, linked components) are additionally gated on
// CLOUD_ENABLED — these constants just centralize the strings.

export const CDN_HOST =
  (import.meta.env.VITE_CDN_HOST as string | undefined) || 'https://assets.revyme.app';

/** CDN host without the protocol — for `.includes()` checks against import
 *  sources that may appear with or without `https://`. */
export const CDN_HOST_BARE = CDN_HOST.replace(/^https?:\/\//, '');
