// user-store.test.ts — message-author mapping.

import { describe, it, expect } from 'vitest';
import { userToAuthor } from './user-store';
import type { RevymeUser } from './types';

describe('userToAuthor', () => {
  it('falls back to the local author when signed out', () => {
    expect(userToAuthor(null)).toEqual({ id: 'local-user', name: 'You' });
  });

  it('maps a signed-in user to id + name + avatar', () => {
    const user: RevymeUser = { id: 'u1', name: 'Ada', email: 'ada@x.com', image: 'a.png' };
    expect(userToAuthor(user)).toEqual({ id: 'u1', name: 'Ada', avatar: 'a.png' });
  });

  it('uses the email when the user has no display name', () => {
    const user: RevymeUser = { id: 'u2', name: '', email: 'bob@x.com' };
    expect(userToAuthor(user)).toEqual({ id: 'u2', name: 'bob@x.com' });
  });
});
