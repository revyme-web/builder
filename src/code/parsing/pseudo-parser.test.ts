import { describe, it, expect } from 'vitest';
import { parsePseudoRules } from './pseudo-parser';

describe('parsePseudoRules', () => {
  it('parses ::before rules', () => {
    const css = `[data-id="title"]::before { content: attr(data-text); position: absolute; top: 0; left: 2px; color: #FF0033; }`;
    const result = parsePseudoRules(css);
    expect(result.get('title')).toEqual({
      before: { content: 'attr(data-text)', position: 'absolute', top: '0', left: '2px', color: '#FF0033' },
    });
  });

  it('parses ::after rules', () => {
    const css = `[data-id="title"]::after { content: ''; background-color: #00FF41; opacity: 0.5; }`;
    const result = parsePseudoRules(css);
    expect(result.get('title')).toEqual({
      after: { content: "''", backgroundColor: '#00FF41', opacity: '0.5' },
    });
  });

  it('parses both ::before and ::after on same node', () => {
    const css = `
      [data-id="heading"]::before { content: ''; position: absolute; left: 2px; color: #FF0033; }
      [data-id="heading"]::after { content: ''; position: absolute; left: -2px; color: #00FF41; }
    `;
    const result = parsePseudoRules(css);
    const heading = result.get('heading');
    expect(heading?.before?.color).toBe('#FF0033');
    expect(heading?.after?.color).toBe('#00FF41');
  });

  it('strips !important from values', () => {
    const css = `[data-id="box"]::before { opacity: 0.5 !important; }`;
    const result = parsePseudoRules(css);
    expect(result.get('box')?.before?.opacity).toBe('0.5');
  });

  it('returns empty map for no rules', () => {
    expect(parsePseudoRules('')).toEqual(new Map());
    expect(parsePseudoRules('[data-id="x"]:hover { color: red; }')).toEqual(new Map());
  });

  it('handles animation shorthand', () => {
    const css = `[data-id="title"]::before { animation: glitch 3s infinite linear alternate-reverse; }`;
    const result = parsePseudoRules(css);
    expect(result.get('title')?.before?.animation).toBe('glitch 3s infinite linear alternate-reverse');
  });
});
