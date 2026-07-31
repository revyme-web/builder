import { describe, it, expect, beforeEach } from 'vitest';
import { hydrateCameras } from './camera-persist';
import { cameraStash } from './camera-stash';
import { projectFS, resetProjectFS } from '@/code/project/project-fs';

describe('camera-persist — hydrateCameras', () => {
  beforeEach(() => {
    resetProjectFS();
    cameraStash.clear();
  });

  it('loads saved cameras for files that still exist into the stash', () => {
    projectFS.writeFile('app/page.client.tsx', 'export default function P(){return <div/>;}');
    projectFS.writeFile('components/Hero.tsx', 'export default function Hero(){return <div/>;}');
    projectFS.writeFile('_meta/page-camera.json', JSON.stringify({
      'app/page.client.tsx': { x: 10, y: 20, scale: 0.8 },
      'components/Hero.tsx': { x: -5, y: 7, scale: 2 },
    }));

    hydrateCameras();

    expect(cameraStash.get('app/page.client.tsx')).toEqual({ x: 10, y: 20, scale: 0.8 });
    expect(cameraStash.get('components/Hero.tsx')).toEqual({ x: -5, y: 7, scale: 2 });
  });

  it('skips entries for files that no longer exist (no phantom cameras)', () => {
    projectFS.writeFile('app/page.client.tsx', 'export default function P(){return <div/>;}');
    projectFS.writeFile('_meta/page-camera.json', JSON.stringify({
      'app/page.client.tsx': { x: 1, y: 1, scale: 1 },
      'app/deleted.client.tsx': { x: 9, y: 9, scale: 3 }, // file was removed
    }));

    hydrateCameras();

    expect(cameraStash.get('app/page.client.tsx')).toEqual({ x: 1, y: 1, scale: 1 });
    expect(cameraStash.get('app/deleted.client.tsx')).toBeNull();
  });

  it('ignores a missing or malformed camera file without throwing', () => {
    expect(() => hydrateCameras()).not.toThrow(); // no _meta/page-camera.json
    projectFS.writeFile('_meta/page-camera.json', 'not json{');
    expect(() => hydrateCameras()).not.toThrow();
    expect(cameraStash.entries()).toEqual([]);
  });

  it('skips entries with a non-numeric / incomplete transform', () => {
    projectFS.writeFile('app/page.client.tsx', 'export default function P(){return <div/>;}');
    projectFS.writeFile('_meta/page-camera.json', JSON.stringify({
      'app/page.client.tsx': { x: 'nope', y: 1, scale: 1 },
    }));
    hydrateCameras();
    expect(cameraStash.get('app/page.client.tsx')).toBeNull();
  });
});
