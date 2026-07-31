// plugins/sdk-impl/_id-gen.ts — shared id generator for plugin-created nodes.
//
// Centralizes the convention `<prefix>-<base36-time>-<counter>` so every
// namespace that creates nodes uses the same shape. Underscore prefix
// flags it as an internal helper, not a namespace handler module.

let counter = 0;

export function makeNodeId(prefix = 'plugin'): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}
