import { describe, test, expect, vi, beforeEach } from 'vitest';
vi.mock('@/shared/debug-trace', () => ({ trace: { action: vi.fn(), fn: vi.fn(), dom: vi.fn(), error: vi.fn() } }));
import { projectFS } from '@/code/project/project-fs';
import { migrateBoundImageSizing } from './cms-image-size-migrate';

const PAGE = `'use client';
import React from 'react';
import team from '@/cms/team.json';
export default function Page() {
  return (
    <div data-id="root" style={{ backgroundImage: 'url(bg.jpg)', backgroundSize: 'cover' }}>
      {team.map((item, idx) => (
        <div data-id="row" key={idx} style={{ display: 'flex' }}>
          <div data-id="avatar" style={{ width: '40px', height: '40px', backgroundImage: \`url(\${item.photo})\` }}></div>
        </div>
      ))}
    </div>
  );
}`;

describe('migrateBoundImageSizing', () => {
  beforeEach(() => { projectFS.loadSnapshot(new Map([['app/page.client.tsx', PAGE], ['components/Card.tsx', 'export default function Card() { return <div data-id="c" />; }']])); });
  test('seeds cover/center on a bound node that lacks them, once', () => {
    migrateBoundImageSizing();
    const out = projectFS.readFile('app/page.client.tsx')!;
    const avatar = out.slice(out.indexOf('data-id="avatar"'));
    expect(avatar).toMatch(/backgroundSize: 'cover'/);
    expect(avatar).toMatch(/backgroundPosition: 'center'/);
    expect((out.match(/backgroundSize/g) || []).length).toBe(2);
    migrateBoundImageSizing();
    expect(projectFS.readFile('app/page.client.tsx')).toBe(out);
    expect(projectFS.readFile('components/Card.tsx')).toContain('data-id="c"');
  });
});
