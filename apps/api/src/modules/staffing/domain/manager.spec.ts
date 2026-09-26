import { describe, expect, it } from 'vitest';
import { pickManager, type ChainLink } from './manager.js';

const link = (depth: number, unitId: string, head: string | null, user: string | null): ChainLink => ({ unitId, depth, headEmploymentId: head, headUserId: user });

describe('pickManager', () => {
  it('the head of the employee’s own unit', () => {
    expect(pickManager([link(0, 'AG', 'chef', 'u-chef'), link(1, 'REG', 'dir', 'u-dir')], 'agent')).toEqual({
      kind: 'user', userId: 'u-chef', employmentId: 'chef', unitId: 'AG',
    });
  });

  it('the employee heads the unit → next head up (self-approval impossible)', () => {
    expect(pickManager([link(1, 'REG', 'dir', 'u-dir'), link(0, 'AG', 'chef', 'u-chef')], 'chef')).toMatchObject({ kind: 'user', userId: 'u-dir', unitId: 'REG' });
  });

  it('no head in the unit → walk up; a head without a linked user stops the walk (escalation)', () => {
    expect(pickManager([link(0, 'SRV', null, null), link(1, 'AG', 'chef', 'u-chef')], 'x')).toMatchObject({ userId: 'u-chef' });
    expect(pickManager([link(0, 'AG', 'chef', null), link(1, 'REG', 'dir', 'u-dir')], 'x')).toEqual({
      kind: 'none', reason: 'manager-not-linked', employmentId: 'chef', unitId: 'AG',
    });
  });

  it('no head anywhere → no manager', () => {
    expect(pickManager([link(0, 'AG', null, null), link(1, 'DG', 'x', 'u-x')], 'x')).toEqual({ kind: 'none', reason: 'no-manager' });
    expect(pickManager([], 'x')).toEqual({ kind: 'none', reason: 'no-manager' });
  });
});
