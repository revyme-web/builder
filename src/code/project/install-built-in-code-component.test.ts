import { describe, it, expect } from 'vitest';
import { InMemoryProjectFS, installBuiltInCodeComponent, syncBuiltInCodeComponents, createDefaultProject } from './project-fs';

describe('createDefaultProject', () => {
  it('ships zero components — code components install lazily on Insert drop', () => {
    const files = createDefaultProject();
    const componentFiles = [...files.keys()].filter(p => p.startsWith('components/') && p.endsWith('.tsx'));
    expect(componentFiles).toEqual([]);
  });
});

describe('installBuiltInCodeComponent', () => {
  it('writes a known code component file when missing and returns true', () => {
    const fs = new InMemoryProjectFS(createDefaultProject());
    expect(fs.readFile('components/AuroraBackground.tsx')).toBeFalsy();

    const result = installBuiltInCodeComponent(fs, 'AuroraBackground');

    expect(result).toBe(true);
    const written = fs.readFile('components/AuroraBackground.tsx');
    expect(written).toBeDefined();
    expect(written).toContain('@label "Aurora Background"');
  });

  it('is a no-op (returns false) when the code component is already installed', () => {
    const fs = new InMemoryProjectFS(createDefaultProject());
    installBuiltInCodeComponent(fs, 'MatrixRain');
    const first = fs.readFile('components/MatrixRain.tsx');

    const result = installBuiltInCodeComponent(fs, 'MatrixRain');

    expect(result).toBe(false);
    expect(fs.readFile('components/MatrixRain.tsx')).toBe(first);
  });

  it('returns null for an unknown PascalCase tag (not in the registry)', () => {
    const fs = new InMemoryProjectFS(createDefaultProject());
    const result = installBuiltInCodeComponent(fs, 'TotallyMadeUpComponent');
    expect(result).toBeNull();
    expect(fs.readFile('components/TotallyMadeUpComponent.tsx')).toBeFalsy();
  });

  it('returns null for lowercase tags (HTML elements, not components)', () => {
    const fs = new InMemoryProjectFS(createDefaultProject());
    expect(installBuiltInCodeComponent(fs, 'div')).toBeNull();
    expect(installBuiltInCodeComponent(fs, 'p')).toBeNull();
    expect(installBuiltInCodeComponent(fs, '')).toBeNull();
  });
});

describe('syncBuiltInCodeComponents (refresh-only)', () => {
  it('does NOT install code components that are absent from the project', () => {
    const fs = new InMemoryProjectFS(createDefaultProject());
    syncBuiltInCodeComponents(fs);
    expect(fs.readFile('components/AnimatedCounter.tsx')).toBeFalsy();
    expect(fs.readFile('components/YouTubeEmbed.tsx')).toBeFalsy();
  });

  it('NEVER overwrites an installed file that differs — a modified built-in belongs to the user', () => {
    // The old refresh-on-differ behavior silently DESTROYED customized
    // built-ins on every project load (the endlessly-reverting
    // LocaleSwitcher, 2026-07-22). "Differs" cannot distinguish stale
    // template from user customization — so differing files are untouchable.
    const fs = new InMemoryProjectFS(createDefaultProject());
    fs.writeFile('components/AnimatedCounter.tsx', '// user customized version');

    syncBuiltInCodeComponents(fs);

    expect(fs.readFile('components/AnimatedCounter.tsx')).toBe('// user customized version');
  });
});
