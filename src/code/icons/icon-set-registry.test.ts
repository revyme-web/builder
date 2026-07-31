import { describe, it, expect, beforeEach } from 'vitest';
import { projectFS } from '../project/project-fs';
import { buildIconSetRegistry, clearIconSetCache } from './icon-set-registry';

describe('buildIconSetRegistry', () => {
  beforeEach(() => {
    for (const f of projectFS.listFiles()) projectFS.deleteFile(f);
    clearIconSetCache();
  });

  it('parses icons from a file with data-id="root" master', () => {
    projectFS.writeFile('icons/NewSet.tsx', `
import React from 'react';
/** @name "New Set" */
/** @iconSet */
export default function NewSet() {
  const master = (
    <div data-id="root" style={{}}>
      <svg data-id="icon-1" data-name="Square" viewBox="0 0 100 100"><rect /></svg>
      <svg data-id="icon-2" data-name="Circle" viewBox="0 0 100 100"><circle /></svg>
    </div>
  );
  return master;
}
`);
    const reg = buildIconSetRegistry(projectFS);
    const info = reg.get('NewSet');
    expect(info).toBeDefined();
    expect(info!.icons).toHaveLength(2);
    expect(info!.icons[0].id).toBe('icon-1');
    expect(info!.icons[1].id).toBe('icon-2');
  });

  it('still parses icons from a legacy data-id="iconset-master" file', () => {
    projectFS.writeFile('icons/Legacy.tsx', `
import React from 'react';
/** @name "Legacy Set" */
/** @iconSet */
export default function Legacy() {
  const master = (
    <div data-id="iconset-master" style={{}}>
      <svg data-id="icon-1" data-name="Square" viewBox="0 0 100 100"><rect /></svg>
    </div>
  );
  return master;
}
`);
    const reg = buildIconSetRegistry(projectFS);
    const info = reg.get('Legacy');
    expect(info).toBeDefined();
    expect(info!.icons).toHaveLength(1);
  });
});
