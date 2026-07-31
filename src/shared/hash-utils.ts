// hash-utils.ts — THE cheap string-hash helper. The same djb2-style loop was
// hand-rolled in component-registry, icon-set-registry and
// code-component-runtime (as `fastContentHash`); import this instead.

/**
 * djb2-style 32-bit string hash, base-36 encoded. NOT cryptographic —
 * used for cache-invalidation keys (compiled component cache, icon-set
 * cache). Byte-identical output to the three historic copies.
 */
export function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h) + s.charCodeAt(i);
    h |= 0;
  }
  return h.toString(36);
}
