// save-revision.test.ts — when may a tab adopt a revision another tab saved?
// Adopting means "my copy already holds that content" — only true while this
// tab has been in the realtime room the whole time AND the saver was too.

import { beforeEach, describe, expect, it } from 'vitest';
import {
  getBaseRevision, isRevisionInSync, noteRemoteSaved, noteRoomJoined, noteRoomLeft,
  noteSaved, resetSaveRevisionForTest, setLoadedRevision, adoptForOverwrite,
} from './save-revision';

beforeEach(() => resetSaveRevisionForTest());

describe('save revision', () => {
  it('starts from the loaded revision; unknown stays null (saves carry no base)', () => {
    setLoadedRevision(7);
    expect(getBaseRevision()).toBe(7);
    setLoadedRevision(undefined);
    expect(getBaseRevision()).toBeNull();
  });

  it('joining a room whose row matches our copy → in sync → adopts in-sync saves', () => {
    setLoadedRevision(3);
    noteRoomJoined(3);
    expect(isRevisionInSync()).toBe(true);
    expect(noteRemoteSaved(4, true)).toBe(true);
    expect(getBaseRevision()).toBe(4);
  });

  it('joining after someone saved (row moved) → never adopts; next save conflicts', () => {
    setLoadedRevision(3);
    noteRoomJoined(5);
    expect(noteRemoteSaved(6, true)).toBe(false);
    expect(getBaseRevision()).toBe(3);
  });

  it('a disconnect stops adoption — relayed writes may have been missed', () => {
    setLoadedRevision(3);
    noteRoomJoined(3);
    noteRoomLeft();
    expect(noteRemoteSaved(4, true)).toBe(false);
    expect(getBaseRevision()).toBe(3);
  });

  it('a save announced by an out-of-sync saver puts us behind it', () => {
    setLoadedRevision(3);
    noteRoomJoined(3);
    expect(noteRemoteSaved(4, false)).toBe(false);
    expect(isRevisionInSync()).toBe(false);
    // …and we stay behind for its later saves too.
    expect(noteRemoteSaved(5, true)).toBe(false);
  });

  it('our own successful save re-syncs us while connected', () => {
    setLoadedRevision(3);
    noteRoomJoined(9);
    expect(isRevisionInSync()).toBe(false);
    noteSaved(10);
    expect(getBaseRevision()).toBe(10);
    expect(isRevisionInSync()).toBe(true);
  });

  it('our own save echoed back by the room is a no-op', () => {
    setLoadedRevision(3);
    noteRoomJoined(3);
    noteSaved(4);
    expect(noteRemoteSaved(4, true)).toBe(false);
    expect(isRevisionInSync()).toBe(true);
  });

  it('overwrite bases the next save on the row as it is now', () => {
    setLoadedRevision(3);
    adoptForOverwrite(8);
    expect(getBaseRevision()).toBe(8);
  });
});
