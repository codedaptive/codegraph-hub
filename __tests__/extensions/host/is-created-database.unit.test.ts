import { beforeEach, describe, expect, it, vi } from 'vitest';

const statInode = vi.hoisted(() => vi.fn());
vi.mock('../../../src/directory', () => ({ statInode }));

import { isCreatedDatabase } from '../../../src/extensions/host/builder/is-created-database';

const dbFile = '/p/.codegraph/codegraph.db';

describe('isCreatedDatabase', () => {
  beforeEach(() => statInode.mockReset());

  it('matches the file whose identity the child reported', () => {
    statInode.mockReturnValue('1:2');
    expect(isCreatedDatabase('1:2')('/p', dbFile)).toBe(true);
    expect(statInode).toHaveBeenCalledWith(dbFile);
  });

  it('does not match a file with another identity', () => {
    statInode.mockReturnValue('1:3');
    expect(isCreatedDatabase('1:2')('/p', dbFile)).toBe(false);
  });

  it('never matches when the child reported none', () => {
    statInode.mockReturnValue(null);
    expect(isCreatedDatabase(null)('/p', dbFile)).toBe(false);
  });
});
