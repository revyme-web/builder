import { describe, test, expect, beforeEach } from 'vitest';
import { updateKeyframeInTokensCSS, removeKeyframeFromTokensCSS } from './keyframe-ops';
import { projectFS } from './project-fs';

const TOKENS_PATH = 'app/globals.css';

const INITIAL_TOKENS = `/* Design Tokens — Presets */
:root {
  --color-brand: #6366f1;
}`;

const KF_FADE = `@keyframes fade-in {
  0% { opacity: 0; }
  100% { opacity: 1; }
}`;

const KF_SLIDE = `@keyframes slide-up {
  0% { transform: translateY(20px); opacity: 0; }
  100% { transform: translateY(0); opacity: 1; }
}`;

beforeEach(() => {
  projectFS.writeFile(TOKENS_PATH, INITIAL_TOKENS);
});

describe('updateKeyframeInTokensCSS', () => {
  test('appends new @keyframes block to tokens.css', () => {
    updateKeyframeInTokensCSS('fade-in', KF_FADE);
    const css = projectFS.readFile(TOKENS_PATH)!;
    expect(css).toContain('@keyframes fade-in');
    expect(css).toContain('opacity: 0');
    expect(css).toContain('opacity: 1');
  });

  test('adds Keyframes section marker before first keyframe', () => {
    updateKeyframeInTokensCSS('fade-in', KF_FADE);
    const css = projectFS.readFile(TOKENS_PATH)!;
    expect(css).toContain('/* Keyframes */');
    // Marker should come before the @keyframes block
    const markerIdx = css.indexOf('/* Keyframes */');
    const kfIdx = css.indexOf('@keyframes fade-in');
    expect(markerIdx).toBeLessThan(kfIdx);
  });

  test('does not add duplicate section marker on second keyframe', () => {
    updateKeyframeInTokensCSS('fade-in', KF_FADE);
    updateKeyframeInTokensCSS('slide-up', KF_SLIDE);
    const css = projectFS.readFile(TOKENS_PATH)!;
    const count = (css.match(/\/\* Keyframes \*\//g) ?? []).length;
    expect(count).toBe(1);
  });

  test('preserves existing design tokens', () => {
    updateKeyframeInTokensCSS('fade-in', KF_FADE);
    const css = projectFS.readFile(TOKENS_PATH)!;
    expect(css).toContain('--color-brand: #6366f1');
  });

  test('replaces existing @keyframes block with same name', () => {
    updateKeyframeInTokensCSS('fade-in', KF_FADE);
    const updatedKF = `@keyframes fade-in {
  0% { opacity: 0; transform: scale(0.8); }
  100% { opacity: 1; transform: scale(1); }
}`;
    updateKeyframeInTokensCSS('fade-in', updatedKF);
    const css = projectFS.readFile(TOKENS_PATH)!;
    expect(css).toContain('scale(0.8)');
    expect(css).not.toContain('opacity: 0; }'); // old line gone
    // Only one @keyframes fade-in block
    const count = (css.match(/@keyframes fade-in/g) ?? []).length;
    expect(count).toBe(1);
  });

  test('multiple keyframes can coexist', () => {
    updateKeyframeInTokensCSS('fade-in', KF_FADE);
    updateKeyframeInTokensCSS('slide-up', KF_SLIDE);
    const css = projectFS.readFile(TOKENS_PATH)!;
    expect(css).toContain('@keyframes fade-in');
    expect(css).toContain('@keyframes slide-up');
  });

  test('works when tokens.css does not exist yet', () => {
    projectFS.deleteFile(TOKENS_PATH);
    updateKeyframeInTokensCSS('fade-in', KF_FADE);
    const css = projectFS.readFile(TOKENS_PATH);
    expect(css).toBeTruthy();
    expect(css).toContain('@keyframes fade-in');
  });
});

describe('removeKeyframeFromTokensCSS', () => {
  test('removes named @keyframes block', () => {
    updateKeyframeInTokensCSS('fade-in', KF_FADE);
    removeKeyframeFromTokensCSS('fade-in');
    const css = projectFS.readFile(TOKENS_PATH)!;
    expect(css).not.toContain('@keyframes fade-in');
  });

  test('leaves other keyframes intact when removing one', () => {
    updateKeyframeInTokensCSS('fade-in', KF_FADE);
    updateKeyframeInTokensCSS('slide-up', KF_SLIDE);
    removeKeyframeFromTokensCSS('fade-in');
    const css = projectFS.readFile(TOKENS_PATH)!;
    expect(css).not.toContain('@keyframes fade-in');
    expect(css).toContain('@keyframes slide-up');
  });

  test('leaves design tokens intact when removing keyframe', () => {
    updateKeyframeInTokensCSS('fade-in', KF_FADE);
    removeKeyframeFromTokensCSS('fade-in');
    const css = projectFS.readFile(TOKENS_PATH)!;
    expect(css).toContain('--color-brand: #6366f1');
  });

  test('no-op when keyframe does not exist', () => {
    const before = projectFS.readFile(TOKENS_PATH)!;
    removeKeyframeFromTokensCSS('nonexistent');
    const after = projectFS.readFile(TOKENS_PATH)!;
    expect(after).toBe(before);
  });

  test('no-op when tokens.css does not exist', () => {
    projectFS.deleteFile(TOKENS_PATH);
    // Should not throw
    expect(() => removeKeyframeFromTokensCSS('fade-in')).not.toThrow();
  });
});
