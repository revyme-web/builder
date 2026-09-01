// paste-engine — Public API.
//
// All call-sites should import from this barrel. Two groups:
//   - Copy: copyNodes, hasClipboard
//   - Paste: executePaste (the orchestrator), findMatchingRule (for tests)
// Internals (core/, types) are imported directly from their modules.

// Copy
export {
  copyNodes,
  hasClipboard,
  setExternalClipboardData,
} from './copy';

// Paste
export {
  executePaste,
  findMatchingRule,
} from './paste';

// Core (advanced — most callers don't need these)
export { resolveTargets } from './core/target-resolver';

// Types
export type { ClipboardData } from './types';
