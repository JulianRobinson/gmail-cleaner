import { describe, expect, it, vi } from 'vitest';
import { AccountMismatchError, confirmAccount } from './auth';

function mocks(address: string | Error) {
  const lookupEmail = vi.fn(async (_accessToken: string) => {
    if (address instanceof Error) throw address;
    return address;
  });
  const revoke = vi.fn(async (_accessToken: string) => {});
  return { lookupEmail, revoke };
}

describe('confirmAccount', () => {
  it('looks up the address with the new token', async () => {
    const { lookupEmail, revoke } = mocks('me@example.com');
    await expect(confirmAccount('new-token', 'me@example.com', lookupEmail, revoke)).resolves.toBe('me@example.com');
    expect(lookupEmail).toHaveBeenCalledWith('new-token');
    expect(revoke).not.toHaveBeenCalled();
  });

  it('compares addresses case-insensitively', async () => {
    const { lookupEmail, revoke } = mocks('Me@Example.com');
    await expect(confirmAccount('new-token', 'me@example.com', lookupEmail, revoke)).resolves.toBe('Me@Example.com');
    expect(revoke).not.toHaveBeenCalled();
  });

  it('revokes the new token and refuses a different account', async () => {
    const { lookupEmail, revoke } = mocks('other@example.com');
    await expect(confirmAccount('new-token', 'me@example.com', lookupEmail, revoke)).rejects.toThrow(AccountMismatchError);
    expect(revoke).toHaveBeenCalledExactlyOnceWith('new-token');
  });

  it('accepts any account when none is expected', async () => {
    const { lookupEmail, revoke } = mocks('other@example.com');
    await expect(confirmAccount('new-token', '', lookupEmail, revoke)).resolves.toBe('other@example.com');
    expect(revoke).not.toHaveBeenCalled();
  });

  it('does not revoke when the lookup fails', async () => {
    const { lookupEmail, revoke } = mocks(new Error('network down'));
    await expect(confirmAccount('new-token', 'me@example.com', lookupEmail, revoke)).rejects.toThrow('network down');
    expect(revoke).not.toHaveBeenCalled();
  });
});
