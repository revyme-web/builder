// Pure audience-filter helpers for A/B tests. Shared so the editor's
// filter UI, the Worker runtime's assignment branch, and the future
// results dashboard all answer "does this visitor match the audience?"
// the same way.
//
// A visitor matches when EVERY populated dimension matches. Empty array
// or missing key = "no constraint on that dimension". A test with no
// audience (null) trivially matches everyone — caller decides whether to
// short-circuit before calling `matchesAudience`.

/** Studio-only audience filter. Mirror of backend `AbAudience` — a
 *  visitor is "in audience" iff every populated dimension matches.
 *  Empty arrays / missing keys = no constraint on that dimension.
 *  (Type lives here — the pure leaf — so the matcher, the Worker
 *  runtime, and PageAbTestDetail's UI all share it without cycles.) */
export type AbAudienceDevice = 'mobile' | 'tablet' | 'desktop';
export interface AbAudience {
  /** ISO 3166-1 alpha-2 country codes (uppercase). */
  country?: string[];
  device?: AbAudienceDevice[];
  /** Referrer hostnames (bare, no scheme). */
  source?: string[];
  /** `name=value` cookie matcher; the visitor must carry this exact cookie. */
  cookie?: string;
}

/** Visitor context the Worker (and tests) pass in. All fields are
 *  optional so callers don't have to fabricate values they don't have. */
export interface VisitorContext {
  /** ISO 3166-1 alpha-2 (uppercase). Worker reads from `request.cf.country`. */
  country?: string | null;
  device?: AbAudienceDevice | 'bot' | 'unknown' | null;
  /** Bare hostname of the referrer (no scheme), e.g. "google.com". */
  source?: string | null;
  /** Full Cookie header from the request. The cookie dimension stores a
   *  `name=value` string; we match if that exact substring appears in the
   *  header. Cheap, allocation-free, and good enough for marketing-cookie
   *  segmentation (which is all this dimension is for). */
  cookieHeader?: string | null;
}

/** Empty audience = no filter. Used by the FE to render "no rows" state
 *  and by the worker shim to short-circuit before iterating dimensions. */
export function audienceIsEmpty(audience: AbAudience | null | undefined): boolean {
  if (!audience) return true;
  const hasCountry = (audience.country?.length ?? 0) > 0;
  const hasDevice = (audience.device?.length ?? 0) > 0;
  const hasSource = (audience.source?.length ?? 0) > 0;
  const hasCookie = (audience.cookie ?? '').trim().length > 0;
  return !hasCountry && !hasDevice && !hasSource && !hasCookie;
}

/** Strip empty dimensions and uppercase country codes so two audiences
 *  that read the same in the UI also round-trip the same JSON. Mutates
 *  via a fresh object. Returns `null` when nothing remains (caller can
 *  use this to clear the column entirely instead of writing `{}`). */
export function normalizeAudience(input: AbAudience | null | undefined): AbAudience | null {
  if (!input) return null;
  const out: AbAudience = {};
  if (input.country && input.country.length > 0) {
    const cleaned = dedupeNonEmpty(input.country.map(c => c.trim().toUpperCase()));
    if (cleaned.length > 0) out.country = cleaned;
  }
  if (input.device && input.device.length > 0) {
    const cleaned = dedupeNonEmpty(input.device.filter(isDeviceLiteral)) as AbAudienceDevice[];
    if (cleaned.length > 0) out.device = cleaned;
  }
  if (input.source && input.source.length > 0) {
    const cleaned = dedupeNonEmpty(input.source.map(s => s.trim().toLowerCase().replace(/^www\./, '')));
    if (cleaned.length > 0) out.source = cleaned;
  }
  if (input.cookie && input.cookie.trim().length > 0) {
    out.cookie = input.cookie.trim();
  }
  return audienceIsEmpty(out) ? null : out;
}

function dedupeNonEmpty<T extends string>(arr: T[]): T[] {
  const seen = new Set<T>();
  for (const v of arr) {
    if (typeof v === 'string' && v.length > 0) seen.add(v);
  }
  return [...seen];
}

function isDeviceLiteral(v: unknown): v is AbAudienceDevice {
  return v === 'mobile' || v === 'tablet' || v === 'desktop';
}

/** Returns true iff the visitor matches every populated audience
 *  dimension. The worker passes a fresh `VisitorContext` per request;
 *  callers that don't know a dimension just leave it `undefined`. */
export function matchesAudience(
  audience: AbAudience | null | undefined,
  visitor: VisitorContext,
): boolean {
  if (audienceIsEmpty(audience)) return true;
  const a = audience!;

  if (a.country && a.country.length > 0) {
    const v = (visitor.country || '').toUpperCase();
    if (!v || !a.country.includes(v)) return false;
  }
  if (a.device && a.device.length > 0) {
    const v = visitor.device;
    if (!v || !isDeviceLiteral(v)) return false;
    if (!a.device.includes(v)) return false;
  }
  if (a.source && a.source.length > 0) {
    const v = (visitor.source || '').toLowerCase().replace(/^www\./, '');
    if (!v || !a.source.includes(v)) return false;
  }
  if (a.cookie && a.cookie.trim().length > 0) {
    const header = visitor.cookieHeader || '';
    if (!cookieHeaderContains(header, a.cookie.trim())) return false;
  }
  return true;
}

/** Substring match against the visitor's Cookie header, scoped to one
 *  `name=value` pair. Splits on `;` and trims whitespace so we don't get
 *  false positives from values that happen to contain the matcher
 *  string. Returns true on exact `name=value` equality of any cookie
 *  in the header. */
function cookieHeaderContains(header: string, nameEqValue: string): boolean {
  if (!header) return false;
  for (const part of header.split(';')) {
    if (part.trim() === nameEqValue) return true;
  }
  return false;
}
