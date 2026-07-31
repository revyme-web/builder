// heal-duplicate-layout.test.ts — EMPIRICAL PIN, live find 2026-07-13:
// a nested make-component blanket-added `layout={true}` to elements that
// ALREADY carried it, producing `<motion.div layout={true} layout={true} …>`.
// Once corrupted, the duplicate-attribute validator blocked EVERY subsequent
// mutation on the file ("resize height on the nested cross errors forever").
// The queue now heals identical duplicate layout attrs on the batch's base
// code before mutations apply, so the output validates clean.
import { describe, it, expect, beforeEach } from 'vitest';
import { projectFS } from '@/code/project/project-fs';
import { setActiveFilePath, flushNow, initMutationQueue, queueMutation, validateGeneratedCode } from './mutation-queue';
import { setBumpVersion } from '@/code/project/modify-file';

const FILE = 'components/CrossTest.tsx';
const CORRUPTED = `'use client';
import React, { useState, useEffect } from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

/** @name "Cross" */
const variantConfig = [
  { name: 'default', label: 'Cross', x: 0, y: 0, isPrimary: true },
];

function CrossTest({ style, initialVariant = 'default', ...rest }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any; }) {
  const [variant, setVariant] = useState(initialVariant);
  useEffect(() => { setVariant(initialVariant); }, [initialVariant]);
  return <LayoutGroup>
    <motion.div
      onHoverStart={() => setVariant(variant === 'default' ? 'default-hover' : variant)} layout={true} layout={true} data-id="cross-root" {...rest} data-name="Frame" style={{
      position: 'absolute',
      width: '50px',
      height: '50px',
      ...style
    }} animate={['default', variant]}>
    <motion.div layout={true} data-id="cross-bar" data-name="Bar" style={{
        position: 'absolute',
        width: '6px',
        height: '30px',
        left: '22px',
        top: '10px'
      }}></motion.div>
  </motion.div>
    </LayoutGroup>;
}

export default withResponsiveProps(CrossTest);
`;

describe('duplicate layout attr self-heal', () => {
  beforeEach(() => {
    projectFS.writeFile(FILE, CORRUPTED);
    setActiveFilePath(FILE);
    setBumpVersion(() => {});
    initMutationQueue(CORRUPTED, code => projectFS.writeFile(FILE, code));
  });

  it('a style mutation on a corrupted file heals the duplicate and commits', () => {
    // Sanity: the corrupted input IS rejected by the validator.
    expect(validateGeneratedCode(CORRUPTED)).toContain('Duplicate JSX attribute');

    queueMutation({ type: 'updateStyles', nodeId: 'cross-bar', styles: { height: '40px' } });
    flushNow();

    const out = projectFS.readFile(FILE)!;
    // The mutation actually landed (was NOT blocked)…
    expect(out).toContain("height: '40px'");
    // …and the duplicate is merged to a single attribute.
    expect(out).not.toContain('layout={true} layout={true}');
    expect(validateGeneratedCode(out)).toBeNull();
  });
});
