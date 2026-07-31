// cloud-flag.ts — THE single switch between standalone (open-source,
// localStorage-backed) mode and Revyme cloud mode.
//
// Set `VITE_REVYME_CLOUD=true` (plus `VITE_API_URL`) to enable the cloud
// backend, auth, collaboration, CDN component sharing, plans/billing UI,
// and the plugin marketplace. Without it the editor runs fully standalone:
// every core editing feature works, projects persist to localStorage.
//
// ⚠️ Gate on THIS constant, not on raw `import.meta.env.VITE_REVYME_CLOUD`:
// env values are strings, so the string 'false' is truthy and has caused a
// real auth-redirect loop before. `=== 'true'` matches vite.config.ts.
export const CLOUD_ENABLED = import.meta.env.VITE_REVYME_CLOUD === 'true';
