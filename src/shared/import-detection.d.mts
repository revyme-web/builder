// Type declarations for import-detection.mjs — the implementation stays
// plain-JS so `scripts/add-template-imports.mjs` can run it from Node
// without a TS toolchain (see the note at the export site in
// mutation-queue.ts). Keep this file in sync with the .mjs exports.

/**
 * Scan a component/page body and return the auto-managed import lines
 * (React hooks, framer-motion, next/*, …) the code needs. One string
 * per emitted import statement.
 */
export function buildAutoImports(body: string): string[];
