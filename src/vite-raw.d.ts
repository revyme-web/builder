// Ambient declaration for Vite's `?raw` query suffix on imports.
//
// `import x from './foo.ts?raw'` returns the file's text content as a
// string at build/dev time. NOTE: Revyme's vite.config sets
// `base: '/builder/'` in cloud mode and intercepts `?raw` queries —
// the plugin-editor bundler avoids this entirely by inlining the SDK
// as a JS string in `plugin-sdk-runtime.ts`. This typedef stays for
// any future code path where `?raw` works, but no current call site
// depends on it.
declare module '*?raw' {
  const content: string;
  export default content;
}
