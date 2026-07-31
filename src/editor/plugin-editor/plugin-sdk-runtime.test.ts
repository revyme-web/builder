// plugin-sdk-runtime.test.ts — keep the runtime mirror in shape-sync
// with the canonical SDK source.
//
// `SDK_RUNTIME_SOURCE` is a hand-maintained JS string that the
// bundler turns into a `blob:` URL and registers under
// `@revyme/plugin-sdk` in the iframe's import map. Plugin authors
// then write idiomatic `import { createPlugin } from
// '@revyme/plugin-sdk'`. When the .ts SDK source files change shape,
// this test fails — forcing a paired update to the runtime string.
//
// We assert SHAPE not LITERAL EQUALITY (the runtime is plain JS, the
// .ts source is TypeScript with types and import statements). The
// shape we care about: same public surface (`createPlugin`,
// `SDK_VERSION`, `PROTOCOL_VERSION`, `HOST_NAME`), same RPC method
// names referenced, same protocol constants, ES-module exports.

import { describe, it, expect } from 'vitest';
import { SDK_RUNTIME_SOURCE } from './plugin-sdk-runtime';
import { PROTOCOL_VERSION, HOST_NAME, SDK_VERSION } from '@revyme/plugin-sdk';

describe('plugin-sdk-runtime — shape parity with .ts source', () => {
  it('exports createPlugin and the protocol constants as ES modules', () => {
    // Plugin authors write `import { createPlugin } from
    // '@revyme/plugin-sdk'` — that fails if the runtime doesn't
    // expose these as named ES exports.
    expect(SDK_RUNTIME_SOURCE).toMatch(/export\s*\{[^}]*\bcreatePlugin\b[^}]*\}/);
    expect(SDK_RUNTIME_SOURCE).toMatch(/export\s*\{[^}]*\bSDK_VERSION\b[^}]*\}/);
    expect(SDK_RUNTIME_SOURCE).toMatch(/export\s*\{[^}]*\bPROTOCOL_VERSION\b[^}]*\}/);
    expect(SDK_RUNTIME_SOURCE).toMatch(/export\s*\{[^}]*\bHOST_NAME\b[^}]*\}/);
  });

  it('protocol constants match the .ts source values', () => {
    expect(SDK_RUNTIME_SOURCE).toMatch(
      new RegExp(`const PROTOCOL_VERSION\\s*=\\s*${PROTOCOL_VERSION};`),
    );
    expect(SDK_RUNTIME_SOURCE).toMatch(
      new RegExp(`const HOST_NAME\\s*=\\s*'${HOST_NAME}';`),
    );
    expect(SDK_RUNTIME_SOURCE).toMatch(
      new RegExp(`const SDK_VERSION\\s*=\\s*'${SDK_VERSION}';`),
    );
  });

  it('routes every canvas namespace method', () => {
    // Methods the SDK proxy must call into via transport.send.
    // If you add a method to `CanvasNamespace` in plugin-sdk/types.ts,
    // mirror it here AND add the test row below.
    const expected = [
      'canvas.getSelection',
      'canvas.setSelection',
      'canvas.getNode',
      'canvas.getRect',
    ];
    for (const method of expected) {
      expect(SDK_RUNTIME_SOURCE).toContain(`'${method}'`);
    }
  });

  it('routes every ui namespace method', () => {
    const expected = ['ui.show', 'ui.hide', 'ui.notify'];
    for (const method of expected) {
      expect(SDK_RUNTIME_SOURCE).toContain(`'${method}'`);
    }
  });

  it('handles every protocol message type', () => {
    // The runtime must respond to all `HostToPluginMessage` discriminants
    // and emit all `PluginToHostMessage` discriminants. If you add a
    // new message type to `plugin-sdk/protocol.ts`, mirror it here.
    const handled = ['handshake-ack', 'rpc-response', 'event'];
    const emitted = ['handshake', 'rpc', 'subscribe', 'unsubscribe', 'close'];
    for (const t of handled) expect(SDK_RUNTIME_SOURCE).toContain(`'${t}'`);
    for (const t of emitted) expect(SDK_RUNTIME_SOURCE).toContain(`'${t}'`);
  });

  it('binds to window.parent (iframe-only contract)', () => {
    expect(SDK_RUNTIME_SOURCE).toMatch(/window\.parent/);
    expect(SDK_RUNTIME_SOURCE).toMatch(/window\.parent === window/);
  });

  it('does NOT use the legacy window.revymeSDK global pattern', () => {
    // Pre-importmap version assigned everything to a window global.
    // ES-module form should have no trace of that.
    expect(SDK_RUNTIME_SOURCE).not.toMatch(/window\.revymeSDK/);
  });
});
