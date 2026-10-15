// edit-source.test.ts — partial code edits of an existing file through the
// REAL oracle gate, and read_source as the way to find the anchors.
//
// Agent report 2026-10-15: code changes only stuck as a whole-file
// apply_file_edit, which a 3,000-line page cannot fit through — the rewrite
// arrived truncated and bounced (SYNTAX_ERROR / CANVAS_CONFIG_DESTROYED).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '@/ai/agent';
import { projectFS, resetProjectFS } from '@/code/project/project-fs';
import { editSourceTool, applyFileEditTool, truncatedRewriteHint } from './whole-file';
import { readSourceTool, READ_SOURCE_CAP_CHARS } from './read';
import { applySourceEdits } from '../source-edits';
import { ALL_TOOLS } from './index';

const ctx = (): ToolContext => ({ ensureCheckpoint: vi.fn(), vpWidth: 1440, signal: new AbortController().signal });

/** A large page: N sections, each with a heading and a paragraph. */
function bigPage(sections: number): string {
  const body = Array.from({ length: sections }, (_, i) => `      <section data-id="s${i}" style={{ position: 'relative', width: '100%', height: 'auto' }}>
        <h2 data-id="h${i}" style={{ position: 'relative', width: 'auto', height: 'auto' }}>Heading ${i}</h2>
        <p data-id="p${i}" style={{ position: 'relative', width: 'auto', height: 'auto' }}>Paragraph number ${i} with some words in it.</p>
      </section>`).join('\n');
  // Already in the committed shape (blank lines after the imports), so a
  // commit's import sync has nothing to normalize.
  return `'use client';

import React from 'react';

export default function Page() {
  return (
    <div data-id="root" style={{ position: 'relative', width: '100%', height: 'auto' }}>
${body}
    </div>
  );
}
`;
}

const PATH = 'app/page.client.tsx';
const text = (r: { content: unknown[] }) => JSON.parse((r.content[0] as { text: string }).text);

beforeEach(() => {
  resetProjectFS();
  projectFS.loadSnapshot(new Map([[PATH, bigPage(600)]]));
});

describe('edit_source', () => {
  it('is a registered agent tool', () => {
    expect(ALL_TOOLS.map((t) => t.name)).toContain('edit_source');
  });

  it('changes only the anchored lines of a 3,000-line page and commits through the gate', async () => {
    const before = projectFS.readFile(PATH)!;
    expect(before.split('\n').length).toBeGreaterThan(2400);
    const r = await editSourceTool.execute({
      path: PATH,
      edits: [
        { old_text: '>Heading 412<', new_text: '>A new heading<' },
        { old_text: 'Paragraph number 413 with some words in it.', new_text: 'Rewritten copy.' },
      ],
    }, ctx());
    expect(r.isError).toBeFalsy();
    const data = text(r);
    expect(data.committed).toBe(PATH);
    expect(data.replacements).toEqual([1, 1]);
    const after = projectFS.readFile(PATH)!;
    expect(after).toContain('>A new heading<');
    expect(after).toContain('Rewritten copy.');
    // Nothing else moved: the rest of the file is byte-identical.
    expect(after.replace('>A new heading<', '>Heading 412<').replace('Rewritten copy.', 'Paragraph number 413 with some words in it.')).toBe(before);
  });

  it('an ambiguous anchor is refused with the line numbers of every match; nothing written', async () => {
    const before = projectFS.readFile(PATH)!;
    const r = await editSourceTool.execute({ edits: [{ old_text: 'with some words in it.', new_text: 'x' }] }, ctx());
    expect(r.isError).toBe(true);
    expect(text(r).error).toMatch(/matches 600 places \(lines \d+, \d+/);
    expect(projectFS.readFile(PATH)).toBe(before);
  });

  it('a missing anchor points at the whitespace-insensitive match', async () => {
    const r = await editSourceTool.execute({ edits: [{ old_text: '<h2   data-id="h7"', new_text: '<h2 data-id="h7"' }] }, ctx());
    expect(r.isError).toBe(true);
    expect(text(r).error).toMatch(/matches at line \d+ if whitespace is ignored/);
  });

  it('the batch is atomic: a failing second edit leaves the first unwritten', async () => {
    const before = projectFS.readFile(PATH)!;
    const r = await editSourceTool.execute({ edits: [{ old_text: '>Heading 1<', new_text: '>One<' }, { old_text: 'NOPE-NOT-THERE', new_text: '' }] }, ctx());
    expect(r.isError).toBe(true);
    expect(projectFS.readFile(PATH)).toBe(before);
  });

  it('an edit that breaks the file is bounced by the gate and not written', async () => {
    const before = projectFS.readFile(PATH)!;
    const r = await editSourceTool.execute({ edits: [{ old_text: '      </section>\n      <section data-id="s9"', new_text: '      <section data-id="s9"' }] }, ctx());
    expect(r.isError).toBe(true);
    expect(text(r).violations.map((v: { code: string }) => v.code)).toContain('SYNTAX_ERROR');
    expect(projectFS.readFile(PATH)).toBe(before);
  });

  it('refuses a file that does not exist (new files are apply_file_edit)', async () => {
    const r = await editSourceTool.execute({ path: 'app/nope/page.client.tsx', edits: [{ old_text: 'a', new_text: 'b' }] }, ctx());
    expect(r.isError).toBe(true);
    expect(text(r).error).toMatch(/EXISTING files/);
  });
});

describe('apply_file_edit on a large file says the rewrite looks truncated', () => {
  it('a cut-off rewrite bounces with TRUNCATED_REWRITE first, pointing at edit_source', async () => {
    const full = projectFS.readFile(PATH)!;
    const cut = full.slice(0, Math.floor(full.length / 3));
    const r = await applyFileEditTool.execute({ code: cut, path: PATH, kind: 'page' }, ctx());
    expect(r.isError).toBe(true);
    const rows = JSON.parse((r.content[0] as { text: string }).text);
    expect(rows[0].code).toBe('TRUNCATED_REWRITE');
    expect(rows[0].message).toMatch(/edit_source/);
    expect(projectFS.readFile(PATH)).toBe(full);
  });

  it('truncatedRewriteHint stays quiet for a small file rewritten at similar length', () => {
    expect(truncatedRewriteHint('a\nb\nc', 'a\nb\nd')).toBeNull();
  });
});

describe('read_source', () => {
  it('node_id returns exactly that element with its line range', async () => {
    const data = text(await readSourceTool.execute({ node_id: 's300' }, ctx()));
    expect(data.content.startsWith('      <section data-id="s300"')).toBe(true);
    expect(data.content.trimEnd().endsWith('</section>')).toBe(true);
    expect(data.node_lines.to_line - data.node_lines.from_line).toBe(3);
    expect(data.truncated).toBe(false);
  });

  it('query finds lines with their numbers (text and regex)', async () => {
    const data = text(await readSourceTool.execute({ query: 'heading 42<' }, ctx()));
    expect(data.total_matches).toBe(1);
    const line = data.matches[0].line;
    expect(projectFS.readFile(PATH)!.split('\n')[line - 1]).toContain('Heading 42<');
    const rx = text(await readSourceTool.execute({ query: 'data-id="h5\\d\\d"', regex: true }, ctx()));
    expect(rx.total_matches).toBe(100);
    expect(rx.matches).toHaveLength(40);
  });

  it('paging cuts on a line boundary and next_from_line continues exactly', async () => {
    const all = projectFS.readFile(PATH)!.split('\n');
    const first = text(await readSourceTool.execute({}, ctx()));
    expect(first.truncated).toBe(true);
    expect(first.content.length).toBeLessThanOrEqual(READ_SOURCE_CAP_CHARS);
    expect(first.content).toBe(all.slice(0, first.to_line).join('\n'));
    const second = text(await readSourceTool.execute({ from_line: first.next_from_line }, ctx()));
    expect(second.from_line).toBe(first.to_line + 1);
    expect(second.content.split('\n')[0]).toBe(all[first.to_line]);
    expect(first.note).toMatch(/edit_source/);
  });

  it('a giant single line is clipped and flagged, not dumped', async () => {
    projectFS.loadSnapshot(new Map([['app/layout.tsx', `export const x = 1;\nconst head = "${'A'.repeat(100_000)}";\n`]]));
    const data = text(await readSourceTool.execute({ path: 'app/layout.tsx' }, ctx()));
    expect(data.clipped_lines).toEqual([2]);
    expect(data.content.length).toBeLessThan(3000);
  });
});

describe('applySourceEdits', () => {
  it('splices by index — $ patterns in new_text are literal', () => {
    const r = applySourceEdits('a X b', [{ old_text: 'X', new_text: "$& $1 $' `${x}`" }]);
    expect(r.ok && r.code).toBe("a $& $1 $' `${x}` b");
  });

  it('replace_all changes every occurrence and reports the count', () => {
    const r = applySourceEdits('x.x.x', [{ old_text: 'x', new_text: 'y', replace_all: true }]);
    expect(r.ok && r.code).toBe('y.y.y');
    expect(r.ok && r.counts).toEqual([3]);
  });

  it('later edits anchor on text earlier ones produced', () => {
    const r = applySourceEdits('one', [{ old_text: 'one', new_text: 'two' }, { old_text: 'two', new_text: 'three' }]);
    expect(r.ok && r.code).toBe('three');
  });

  it('reports the changed line range in the new file', () => {
    const r = applySourceEdits('a\nb\nc\nd', [{ old_text: 'c', new_text: 'C1\nC2' }]);
    expect(r.ok && r.changed).toEqual({ from_line: 3, to_line: 4 });
  });
});
