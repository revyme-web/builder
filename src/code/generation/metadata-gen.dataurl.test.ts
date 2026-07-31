import { describe, it, expect } from 'vitest';
import { parseMetadataFromCode, updateMetadataInCode } from './metadata-gen';

describe('metadata-gen data URL round-trip', () => {
  it('round-trips a base64 data URL through openGraph.images', () => {
    const dataURL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    const seed = `import './globals.css';\n\nexport const metadata = {};\n\nexport default function Page() { return null; }\n`;
    const updates = { title: 'Hello', openGraph: { images: [dataURL] } };
    const written = updateMetadataInCode(seed, updates);
    const parsed = parseMetadataFromCode(written);
    expect(parsed.openGraph?.images?.[0]).toBe(dataURL);
  });
});
