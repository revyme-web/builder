// plugins/manifest.ts — parse + validate plugin manifests.
//
// A plugin's `manifest.json` is the contract: id, mode, permissions,
// entry. The host parses it once at install time, normalizes shape,
// and rejects malformed manifests early so the rest of the runtime
// can trust the resulting `PluginManifest` object.
//
// Validation is intentionally permissive within the documented schema:
// unknown fields are stripped (forward compat), missing optional
// fields get defaults, and string fields are trimmed. Required field
// failures throw `ManifestParseError` with a precise reason.
//
// We do NOT validate semver, permission strings against a closed
// enum, or icon names — those are open by design (plugin authors can
// declare new permissions; the host's permission gate decides whether
// to grant them at install time, see `permission-gate.ts`).

import type { PluginManifest, PluginMode, PluginPermission } from '@revyme/plugin-sdk';

const VALID_MODES = new Set<PluginMode>([
  'panel',
  'floating',
  'modal',
  'headless',
  'contextMenu',
]);

export class ManifestParseError extends Error {
  constructor(message: string) {
    super(`manifest: ${message}`);
    this.name = 'ManifestParseError';
  }
}

const isString = (v: unknown): v is string => typeof v === 'string';
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Parse a manifest object (already JSON-parsed) and return a normalized
 * `PluginManifest`. Throws `ManifestParseError` on any required-field
 * violation. Unknown fields are dropped silently — see file header.
 */
export function parseManifest(raw: unknown): PluginManifest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ManifestParseError('expected an object');
  }
  const o = raw as Record<string, unknown>;

  const id = requireString(o, 'id');
  if (!/^[a-z0-9]+(\.[a-z0-9-]+)+$/i.test(id)) {
    throw new ManifestParseError(
      `id must be a reverse-DNS string like "com.acme.gradient" — got ${JSON.stringify(id)}`,
    );
  }
  const name = requireString(o, 'name');
  const version = requireString(o, 'version');
  const entry = requireString(o, 'entry');
  const sdkVersion = requireString(o, 'sdkVersion');

  const mode = requireString(o, 'mode') as PluginMode;
  if (!VALID_MODES.has(mode)) {
    throw new ManifestParseError(
      `mode must be one of ${[...VALID_MODES].join(', ')} — got ${JSON.stringify(mode)}`,
    );
  }

  const permissions = parsePermissions(o.permissions);

  const ui = parseUi(o.ui);

  const out: PluginManifest = {
    id: id.trim(),
    name: name.trim(),
    version: version.trim(),
    entry: entry.trim(),
    sdkVersion: sdkVersion.trim(),
    mode,
    permissions,
  };
  // Optional string fields — only include when present + non-empty so
  // round-trip via JSON.stringify doesn't carry empties forward.
  if (isString(o.author) && o.author.trim()) out.author = o.author.trim();
  if (isString(o.description) && o.description.trim()) out.description = o.description.trim();
  if (isString(o.icon) && o.icon.trim()) out.icon = o.icon.trim();
  if (ui) out.ui = ui;
  return out;
}

/** Parse a JSON string. Same validation rules as `parseManifest`. */
export function parseManifestJson(json: string): PluginManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    throw new ManifestParseError(`invalid JSON: ${(e as Error).message}`);
  }
  return parseManifest(raw);
}

function requireString(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  if (!isString(v) || v.trim() === '') {
    throw new ManifestParseError(`required string field "${key}" missing or empty`);
  }
  return v;
}

function parsePermissions(raw: unknown): PluginPermission[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new ManifestParseError('permissions must be an array of strings');
  }
  const out: PluginPermission[] = [];
  for (let i = 0; i < raw.length; i++) {
    const v = raw[i];
    if (!isString(v)) {
      throw new ManifestParseError(`permissions[${i}] must be a string`);
    }
    const trimmed = v.trim();
    if (trimmed === '') continue;
    if (!out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

function parseUi(raw: unknown): PluginManifest['ui'] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ManifestParseError('ui must be an object');
  }
  const o = raw as Record<string, unknown>;
  const ui: NonNullable<PluginManifest['ui']> = {};
  if (isNumber(o.defaultWidth)) ui.defaultWidth = o.defaultWidth;
  if (isNumber(o.defaultHeight)) ui.defaultHeight = o.defaultHeight;
  if (isNumber(o.minWidth)) ui.minWidth = o.minWidth;
  if (isNumber(o.minHeight)) ui.minHeight = o.minHeight;
  return Object.keys(ui).length > 0 ? ui : undefined;
}
