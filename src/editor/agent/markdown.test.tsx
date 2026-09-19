import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { renderMarkdown } from './markdown';

// The model writes `**bold**` and `- ` lists because that is how a model
// writes; the panel rendered them literally, asterisks and all.
describe('renderMarkdown', () => {
  it('renders **bold** as a real element, not asterisks', () => {
    render(<div data-testid="o">{renderMarkdown('The **Header** changed.')}</div>);
    expect(screen.getByText('Header').tagName).toBe('STRONG');
    expect(screen.getByTestId('o').textContent).toBe('The Header changed.');
  });

  it('renders `code` spans', () => {
    render(<div data-testid="o">{renderMarkdown('Set `position` on it.')}</div>);
    expect(screen.getByText('position').tagName).toBe('CODE');
  });

  it('renders *italic*', () => {
    render(<div data-testid="o">{renderMarkdown('a *quiet* word')}</div>);
    expect(screen.getByText('quiet').tagName).toBe('EM');
  });

  it('turns consecutive bullet lines into one list', () => {
    const { container } = render(<div>{renderMarkdown('- one\n- two\n- three')}</div>);
    expect(container.querySelectorAll('li')).toHaveLength(3);
    expect(container.querySelectorAll('ul')).toHaveLength(1);
  });

  it('accepts *, - and numbered bullets', () => {
    const { container } = render(<div>{renderMarkdown('* a\n- b\n1. c')}</div>);
    expect(container.querySelectorAll('li')).toHaveLength(3);
  });

  it('renders marks INSIDE a bullet', () => {
    render(<div>{renderMarkdown('- **Hero** — bigger')}</div>);
    expect(screen.getByText('Hero').tagName).toBe('STRONG');
  });

  it('separates paragraphs on a blank line', () => {
    const { container } = render(<div>{renderMarkdown('first\n\nsecond')}</div>);
    expect(container.querySelectorAll('p')).toHaveLength(2);
  });

  it('keeps line breaks inside one paragraph', () => {
    const { container } = render(<div>{renderMarkdown('line a\nline b')}</div>);
    expect(container.querySelectorAll('p')).toHaveLength(1);
    expect(container.textContent).toContain('line a');
    expect(container.textContent).toContain('line b');
  });

  it('leaves plain text untouched', () => {
    render(<div data-testid="o">{renderMarkdown('Added a burger menu.')}</div>);
    expect(screen.getByTestId('o').textContent).toBe('Added a burger menu.');
  });

  it('never emits raw HTML — a tag in the text stays text', () => {
    const { container } = render(<div>{renderMarkdown('use <script>alert(1)</script> here')}</div>);
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<script>alert(1)</script>');
  });

  it('does not mangle an unmatched asterisk', () => {
    render(<div data-testid="o">{renderMarkdown('2 * 3 = 6')}</div>);
    expect(screen.getByTestId('o').textContent).toBe('2 * 3 = 6');
  });

  it('handles an empty string', () => {
    const { container } = render(<div>{renderMarkdown('')}</div>);
    expect(container.textContent).toBe('');
  });
});
