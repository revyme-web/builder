// oracle/extensions/editability/index.ts — public surface of the Phase 2
// editability extension. The core oracle (`check-file.ts`) imports
// `runEditabilityRules` from here; nothing else in the codebase touches this
// path so the extension stays reversible (remove the import + the trailing
// call in check-file.ts and the entire feature rolls back).

export { runEditabilityRules } from './rules';
export { analyzeEditability } from './analyzer';
export type {
  EditabilityClass,
  EditabilityFinding,
  EditabilityReport,
} from './analyzer';