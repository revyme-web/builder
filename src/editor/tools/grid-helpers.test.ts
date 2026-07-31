import { describe, test, expect } from 'vitest';
import {
  parseSpan, formatSpan, splitGridTracks,
  parseTrack, formatTrack, parseTrackList, formatTrackList, parseAutoTrack, formatAutoTrack,
  parsePlacement, formatPlacement, parseGap, formatGap,
} from './grid-helpers';

describe('parseSpan', () => {
  test('parses span N', () => expect(parseSpan('span 2')).toBe(2));
  test('defaults to 1 for empty', () => expect(parseSpan('')).toBe(1));
  test('handles span 1', () => expect(parseSpan('span 1')).toBe(1));
  test('handles bare number as single position (span 1)', () => expect(parseSpan('3')).toBe(1));
  test('handles explicit placement 1 / 3 (spans 2 tracks)', () => expect(parseSpan('1 / 3')).toBe(2));
});

describe('formatSpan', () => {
  test('span 1 returns empty (remove property)', () => expect(formatSpan(1)).toBe(''));
  test('span 2', () => expect(formatSpan(2)).toBe('span 2'));
  test('span 0 clamps to 1 = empty', () => expect(formatSpan(0)).toBe(''));
  test('negative clamps to 1 = empty', () => expect(formatSpan(-1)).toBe(''));
});

describe('splitGridTracks', () => {
  test('simple tracks', () => expect(splitGridTracks('1fr 2fr')).toEqual(['1fr', '2fr']));
  test('with minmax', () => expect(splitGridTracks('minmax(200px, 1fr) 1fr')).toEqual(['minmax(200px, 1fr)', '1fr']));
  test('with repeat', () => expect(splitGridTracks('repeat(3, 1fr) 200px')).toEqual(['repeat(3, 1fr)', '200px']));
  test('single track', () => expect(splitGridTracks('1fr')).toEqual(['1fr']));
  test('empty', () => expect(splitGridTracks('')).toEqual([]));
  test('nested parens', () => expect(splitGridTracks('minmax(min(200px, 50%), 1fr) auto')).toEqual(['minmax(min(200px, 50%), 1fr)', 'auto']));
});

// ─── New describe blocks ─────────────────────────────────────────────────────

describe('parseTrack', () => {
  test('parses 1fr', () => {
    expect(parseTrack('1fr')).toEqual({ value: 1, unit: 'fr' });
  });
  test('parses 2fr', () => {
    expect(parseTrack('2fr')).toEqual({ value: 2, unit: 'fr' });
  });
  test('parses fractional fr like 1.5fr', () => {
    expect(parseTrack('1.5fr')).toEqual({ value: 1.5, unit: 'fr' });
  });
  test('parses 200px', () => {
    expect(parseTrack('200px')).toEqual({ value: 200, unit: 'px' });
  });
  test('parses auto', () => {
    expect(parseTrack('auto')).toEqual({ value: 0, unit: 'auto' });
  });
  test('parses min-content', () => {
    expect(parseTrack('min-content')).toEqual({ value: 0, unit: 'min-content' });
  });
  test('parses max-content', () => {
    expect(parseTrack('max-content')).toEqual({ value: 0, unit: 'max-content' });
  });
  test('empty string returns auto', () => {
    expect(parseTrack('')).toEqual({ value: 0, unit: 'auto' });
  });
  test('invalid input falls back to 1fr', () => {
    expect(parseTrack('banana')).toEqual({ value: 1, unit: 'fr' });
  });
  test('trims whitespace', () => {
    expect(parseTrack('  2fr  ')).toEqual({ value: 2, unit: 'fr' });
  });
});

describe('formatTrack', () => {
  test('formats fr track', () => {
    expect(formatTrack({ value: 2, unit: 'fr' })).toBe('2fr');
  });
  test('formats px track', () => {
    expect(formatTrack({ value: 200, unit: 'px' })).toBe('200px');
  });
  test('formats auto', () => {
    expect(formatTrack({ value: 0, unit: 'auto' })).toBe('auto');
  });
  test('formats min-content', () => {
    expect(formatTrack({ value: 0, unit: 'min-content' })).toBe('min-content');
  });
  test('formats max-content', () => {
    expect(formatTrack({ value: 0, unit: 'max-content' })).toBe('max-content');
  });
  test('fr with value 0 defaults to 1fr', () => {
    expect(formatTrack({ value: 0, unit: 'fr' })).toBe('1fr');
  });
});

describe('parseTrackList', () => {
  test('parses repeat(3, 1fr)', () => {
    const result = parseTrackList('repeat(3, 1fr)');
    expect(result.tracks).toHaveLength(3);
    expect(result.tracks[0]).toEqual({ value: 1, unit: 'fr' });
    expect(result.tracks[1]).toEqual({ value: 1, unit: 'fr' });
    expect(result.tracks[2]).toEqual({ value: 1, unit: 'fr' });
    expect(result.autoFill).toBe(false);
    expect(result.isUniform).toBe(true);
  });
  test('parses space-separated mixed tracks 2fr 1fr 1fr', () => {
    const result = parseTrackList('2fr 1fr 1fr');
    expect(result.tracks).toHaveLength(3);
    expect(result.tracks[0]).toEqual({ value: 2, unit: 'fr' });
    expect(result.tracks[1]).toEqual({ value: 1, unit: 'fr' });
    expect(result.tracks[2]).toEqual({ value: 1, unit: 'fr' });
    expect(result.autoFill).toBe(false);
    expect(result.isUniform).toBe(false);
  });
  test('parses repeat(auto-fill, minmax(200px, 1fr))', () => {
    const result = parseTrackList('repeat(auto-fill, minmax(200px, 1fr))');
    expect(result.autoFill).toBe(true);
    expect(result.autoFillTemplate).toBe('minmax(200px, 1fr)');
    expect(result.tracks).toHaveLength(0);
  });
  test('empty string returns default single 1fr track', () => {
    const result = parseTrackList('');
    expect(result.tracks).toHaveLength(1);
    expect(result.tracks[0]).toEqual({ value: 1, unit: 'fr' });
    expect(result.autoFill).toBe(false);
    expect(result.isUniform).toBe(true);
  });
  test('single track', () => {
    const result = parseTrackList('200px');
    expect(result.tracks).toHaveLength(1);
    expect(result.tracks[0]).toEqual({ value: 200, unit: 'px' });
    expect(result.isUniform).toBe(true);
  });
  test('repeat with minmax: repeat(4, minmax(0px, 1fr))', () => {
    // repeat(N, ...) regex captures the inner template; parseTrack will fallback for minmax
    const result = parseTrackList('repeat(4, minmax(0px, 1fr))');
    expect(result.tracks).toHaveLength(4);
    expect(result.isUniform).toBe(true);
    expect(result.autoFill).toBe(false);
  });
  test('uniform space-separated tracks', () => {
    const result = parseTrackList('1fr 1fr 1fr');
    expect(result.tracks).toHaveLength(3);
    expect(result.isUniform).toBe(true);
  });
});

describe('formatTrackList', () => {
  test('uniform tracks use repeat()', () => {
    const result = formatTrackList({
      tracks: [
        { value: 1, unit: 'fr' },
        { value: 1, unit: 'fr' },
        { value: 1, unit: 'fr' },
      ],
      autoFill: false,
      autoFillTemplate: '',
      raw: '',
      isUniform: true,
    });
    expect(result).toBe('repeat(3, 1fr)');
  });
  test('mixed tracks are space-separated', () => {
    const result = formatTrackList({
      tracks: [
        { value: 2, unit: 'fr' },
        { value: 1, unit: 'fr' },
        { value: 200, unit: 'px' },
      ],
      autoFill: false,
      autoFillTemplate: '',
      raw: '',
      isUniform: false,
    });
    expect(result).toBe('2fr 1fr 200px');
  });
  test('auto-fill outputs repeat(auto-fill, template)', () => {
    const result = formatTrackList({
      tracks: [],
      autoFill: true,
      autoFillTemplate: 'minmax(200px, 1fr)',
      raw: '',
      isUniform: false,
    });
    expect(result).toBe('repeat(auto-fill, minmax(200px, 1fr))');
  });
  test('auto-fill with empty template defaults to minmax(200px, 1fr)', () => {
    const result = formatTrackList({
      tracks: [],
      autoFill: true,
      autoFillTemplate: '',
      raw: '',
      isUniform: false,
    });
    expect(result).toBe('repeat(auto-fill, minmax(200px, 1fr))');
  });
  test('empty tracks returns empty string', () => {
    const result = formatTrackList({
      tracks: [],
      autoFill: false,
      autoFillTemplate: '',
      raw: '',
      isUniform: false,
    });
    expect(result).toBe('');
  });
});

describe('parseAutoTrack', () => {
  test('parses auto', () => {
    expect(parseAutoTrack('auto')).toEqual({ mode: 'auto', fixedValue: '', minmaxMin: '', minmaxMax: '' });
  });
  test('parses 200px', () => {
    expect(parseAutoTrack('200px')).toEqual({ mode: 'fixed', fixedValue: '200', minmaxMin: '', minmaxMax: '' });
  });
  test('parses minmax(200px, auto)', () => {
    expect(parseAutoTrack('minmax(200px, auto)')).toEqual({ mode: 'minmax', fixedValue: '', minmaxMin: '200px', minmaxMax: 'auto' });
  });
  test('parses minmax(100px, 1fr)', () => {
    expect(parseAutoTrack('minmax(100px, 1fr)')).toEqual({ mode: 'minmax', fixedValue: '', minmaxMin: '100px', minmaxMax: '1fr' });
  });
  test('empty string returns auto', () => {
    expect(parseAutoTrack('')).toEqual({ mode: 'auto', fixedValue: '', minmaxMin: '', minmaxMax: '' });
  });
  test('unknown value treated as fixed', () => {
    expect(parseAutoTrack('5em')).toEqual({ mode: 'fixed', fixedValue: '5em', minmaxMin: '', minmaxMax: '' });
  });
});

describe('formatAutoTrack', () => {
  test('auto mode returns empty string', () => {
    expect(formatAutoTrack({ mode: 'auto', fixedValue: '', minmaxMin: '', minmaxMax: '' })).toBe('');
  });
  test('fixed mode with value', () => {
    expect(formatAutoTrack({ mode: 'fixed', fixedValue: '200', minmaxMin: '', minmaxMax: '' })).toBe('200px');
  });
  test('fixed mode with empty value defaults to 200px', () => {
    expect(formatAutoTrack({ mode: 'fixed', fixedValue: '', minmaxMin: '', minmaxMax: '' })).toBe('200px');
  });
  test('minmax mode', () => {
    expect(formatAutoTrack({ mode: 'minmax', fixedValue: '', minmaxMin: '200px', minmaxMax: 'auto' })).toBe('minmax(200px, auto)');
  });
  test('minmax mode with empty values defaults', () => {
    expect(formatAutoTrack({ mode: 'minmax', fixedValue: '', minmaxMin: '', minmaxMax: '' })).toBe('minmax(200px, auto)');
  });
});

// ─── Placement ──────────────────────────────────────────────────────────────

describe('parsePlacement', () => {
  test('empty = auto', () => expect(parsePlacement('')).toEqual({ mode: 'auto', span: 1, start: 1, end: 2 }));
  test('span 2', () => expect(parsePlacement('span 2')).toEqual({ mode: 'span', span: 2, start: 1, end: 2 }));
  test('span 1', () => expect(parsePlacement('span 1')).toEqual({ mode: 'span', span: 1, start: 1, end: 2 }));
  test('2 / 4 explicit', () => expect(parsePlacement('2 / 4')).toEqual({ mode: 'explicit', span: 2, start: 2, end: 4 }));
  test('1 / -1 explicit', () => expect(parsePlacement('1 / -1')).toEqual({ mode: 'explicit', span: 2, start: 1, end: -1 }));
  test('1 / span 2', () => expect(parsePlacement('1 / span 2')).toEqual({ mode: 'explicit', span: 2, start: 1, end: 3 }));
  test('single number 3', () => expect(parsePlacement('3')).toEqual({ mode: 'explicit', span: 1, start: 3, end: 4 }));
});

describe('formatPlacement', () => {
  test('auto = empty', () => expect(formatPlacement({ mode: 'auto', span: 1, start: 1, end: 2 })).toBe(''));
  test('span 2', () => expect(formatPlacement({ mode: 'span', span: 2, start: 1, end: 2 })).toBe('span 2'));
  test('span 1 = empty', () => expect(formatPlacement({ mode: 'span', span: 1, start: 1, end: 2 })).toBe(''));
  test('explicit 2 / 4', () => expect(formatPlacement({ mode: 'explicit', span: 2, start: 2, end: 4 })).toBe('2 / 4'));
});

// ─── Gap ────────────────────────────────────────────────────────────────────

describe('parseGap', () => {
  test('single value', () => expect(parseGap('20px')).toEqual({ row: '20px', col: '20px', isSplit: false }));
  test('dual value', () => expect(parseGap('20px 16px')).toEqual({ row: '20px', col: '16px', isSplit: true }));
  test('empty', () => expect(parseGap('')).toEqual({ row: '', col: '', isSplit: false }));
});

describe('formatGap', () => {
  test('equal = single', () => expect(formatGap('20px', '20px')).toBe('20px'));
  test('different = dual', () => expect(formatGap('20px', '16px')).toBe('20px 16px'));
  test('empty = empty', () => expect(formatGap('', '')).toBe(''));
});
