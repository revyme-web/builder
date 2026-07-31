import { describe, expect, it } from 'vitest';
import { pluralize, singularize } from './pluralize';

describe('pluralize', () => {
  it('consonant + y → ies', () => {
    expect(pluralize('Gallery')).toBe('Galleries');
    expect(pluralize('Category')).toBe('Categories');
    expect(pluralize('Story')).toBe('Stories');
  });

  it('vowel + y → +s (not ies)', () => {
    expect(pluralize('Day')).toBe('Days');
    expect(pluralize('Key')).toBe('Keys');
  });

  it('sibilants → +es', () => {
    expect(pluralize('Box')).toBe('Boxes');
    expect(pluralize('Class')).toBe('Classes');
    expect(pluralize('Dish')).toBe('Dishes');
    expect(pluralize('Church')).toBe('Churches');
  });

  it('default → +s', () => {
    expect(pluralize('Photo')).toBe('Photos');
    expect(pluralize('Legal')).toBe('Legals');
    expect(pluralize('Project')).toBe('Projects');
    expect(pluralize('Test')).toBe('Tests');
  });

  it('nonsense words still get +s (design-tool parity)', () => {
    expect(pluralize('bliblablublu')).toBe('bliblablublus');
  });

  it('irregulars preserve leading-letter case', () => {
    expect(pluralize('Person')).toBe('People');
    expect(pluralize('child')).toBe('children');
  });

  it('uncountables unchanged', () => {
    expect(pluralize('Media')).toBe('Media');
    expect(pluralize('series')).toBe('series');
  });

  it('empty / whitespace returns input', () => {
    expect(pluralize('')).toBe('');
    expect(pluralize('   ')).toBe('   ');
  });
});

describe('singularize', () => {
  it('plain -s → drop s', () => {
    expect(singularize('Advisors')).toBe('Advisor');
    expect(singularize('Photos')).toBe('Photo');
    expect(singularize('Projects')).toBe('Project');
    expect(singularize('bliblablublus')).toBe('bliblablublu');
  });

  it('-ies → -y', () => {
    expect(singularize('Galleries')).toBe('Gallery');
    expect(singularize('Categories')).toBe('Category');
  });

  it('sibilant + es → drop es', () => {
    expect(singularize('Boxes')).toBe('Box');
    expect(singularize('Dishes')).toBe('Dish');
    expect(singularize('Classes')).toBe('Class');
  });

  it('already singular unchanged (incl. -ss)', () => {
    expect(singularize('Gallery')).toBe('Gallery');
    expect(singularize('Photo')).toBe('Photo');
    expect(singularize('Class')).toBe('Class');
  });

  it('irregulars', () => {
    expect(singularize('People')).toBe('Person');
    expect(singularize('children')).toBe('child');
  });
});

describe('container/item naming (pluralize(singularize(x)) is idempotent)', () => {
  // The drop handler: item = singularize(name), container = pluralize(item).
  it.each([
    ['Advisors', 'Advisor', 'Advisors'],
    ['Advisor', 'Advisor', 'Advisors'],
    ['Gallery', 'Gallery', 'Galleries'],
    ['Galleries', 'Gallery', 'Galleries'],
    ['Photo', 'Photo', 'Photos'],
    ['Photos', 'Photo', 'Photos'],
  ])('%s → item %s + container %s', (name, item, container) => {
    const singular = singularize(name);
    expect(singular).toBe(item);
    expect(pluralize(singular)).toBe(container);
  });
});
