// comments-config.test.ts — round-trip + defensive-parse coverage for
// the project-wide comments JSON file.

import { describe, expect, test } from 'vitest';
import {
  COMMENTS_FILE_PATH,
  parseComments,
  serializeComments,
  type Comment,
} from './comments-config';

const sample: Comment = {
  id: 'comment-abc',
  x: 120.5,
  y: 240,
  text: 'Hello there',
  createdAt: 1_700_000_000_000,
  resolved: false,
  filePath: 'app/page.tsx',
  color: '#3b82f6',
  authorId: 'local-user',
  authorName: 'You',
  messages: [
    { id: 'msg-1', text: 'Hello there', authorId: 'local-user', authorName: 'You', createdAt: 1_700_000_000_000 },
  ],
};

describe('comments-config', () => {
  test('COMMENTS_FILE_PATH is the project-wide single file', () => {
    expect(COMMENTS_FILE_PATH).toBe('_meta/comments.json');
  });

  test('serialize → parse round-trips a single comment', () => {
    const json = serializeComments([sample]);
    const parsed = parseComments(json);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual(sample);
  });

  test('parseComments returns [] for null (no file)', () => {
    expect(parseComments(null)).toEqual([]);
  });

  test('parseComments returns [] for malformed JSON', () => {
    expect(parseComments('{ not json }')).toEqual([]);
  });

  test('parseComments returns [] for non-array JSON', () => {
    expect(parseComments(JSON.stringify({ comments: [] }))).toEqual([]);
  });

  test('parseComments filters out entries missing required fields', () => {
    // x missing → drop. filePath missing → drop. id non-string → drop.
    const bad = JSON.stringify([
      sample,
      { id: 'no-coords', y: 0, filePath: 'p.tsx' },
      { id: 'no-path', x: 0, y: 0 },
      { id: 99, x: 0, y: 0, filePath: 'p.tsx' },
      sample,
    ]);
    const parsed = parseComments(bad);
    expect(parsed).toHaveLength(2);
    expect(parsed.every(c => c.id === sample.id)).toBe(true);
  });

  test('parseComments rejects non-finite coords (NaN / Infinity)', () => {
    const bad = JSON.stringify([
      { ...sample, x: Number.NaN },
      { ...sample, y: Number.POSITIVE_INFINITY },
    ]);
    expect(parseComments(bad)).toEqual([]);
  });

  test('serializeComments produces 2-space-indented JSON (stable diffs)', () => {
    const json = serializeComments([sample]);
    // First line is `[`, second is `  {` — JSON.stringify(_, null, 2)
    // indents each level by 2.
    const lines = json.split('\n');
    expect(lines[0]).toBe('[');
    expect(lines[1].startsWith('  {')).toBe(true);
  });
});
