import { isLateJoiner, type LateJoinerEvent } from './late-joiner';

const base: LateJoinerEvent = {
  memoryLoaded: true,
  joinerIsBot: false,
  joinerIsSelf: false,
  fromChannelId: null,
  toChannelId: 'bridged',
  bridgedChannelId: 'bridged',
};

describe('isLateJoiner — late-joiner privacy circuit-breaker', () => {
  it('fires when a human moves INTO the bridged channel while memory is loaded', () => {
    expect(isLateJoiner(base)).toBe(true); // joined from no channel
    expect(isLateJoiner({ ...base, fromChannelId: 'other' })).toBe(true); // moved from another channel
  });

  it('does not fire on a within-channel change (mute/deafen — from === to)', () => {
    // The cache-free guard: a mute in the bridged channel is not a join, so no per-event teardown.
    expect(isLateJoiner({ ...base, fromChannelId: 'bridged' })).toBe(false);
  });

  it('does not fire when the move targets a different channel', () => {
    expect(isLateJoiner({ ...base, toChannelId: 'elsewhere' })).toBe(false);
  });

  it('ignores the bot and our own user', () => {
    expect(isLateJoiner({ ...base, joinerIsBot: true })).toBe(false);
    expect(isLateJoiner({ ...base, joinerIsSelf: true })).toBe(false);
  });

  it('never tears down a memory-less call', () => {
    expect(isLateJoiner({ ...base, memoryLoaded: false })).toBe(false);
  });
});
