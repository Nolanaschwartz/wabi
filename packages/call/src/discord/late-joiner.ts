// Late-joiner privacy circuit-breaker (ADR-0043; ADR-0002/0017).
//
// A voice call's recalled memory is private to the single human it belongs to. The recall gate
// (buildMemoryContext) is a snapshot taken at /call time: it only loads memory when exactly one human is
// present. That snapshot can't see a SECOND human arriving mid-call — so we end the call the moment one
// does while memory is loaded, rather than mutating the live session's prompt.
//
// We key off the voice-state TRANSITION (the member's old→new channel carried by the event) rather than a
// recount of the channel's member cache: that cache can lag the join event and undercount the very joiner
// that triggered it, leaving the call up — the exact ADR-0043 breach this guard exists to close. The
// transition is also self-gating against unrelated events (a mute/deafen has from === to === bridged, so
// it never fires), so the guard does no per-event member scan.
//
// A memory-less call (a group call from the start, or an unknown/unconsented user) carries no private
// facts, so a late joiner there is harmless and the call is left alone. Pure so the privacy decision is
// provable with no Discord mock.
export interface LateJoinerEvent {
  /** Whether this call loaded private memory at /call time. */
  memoryLoaded: boolean;
  /** The member whose voice state changed is a bot. */
  joinerIsBot: boolean;
  /** The member whose voice state changed is our own bot user. */
  joinerIsSelf: boolean;
  /** The channel the member was in before this event (`oldState.channelId`), or null. */
  fromChannelId: string | null;
  /** The channel the member is in after this event (`newState.channelId`), or null. */
  toChannelId: string | null;
  /** The voice channel the call is bridged to. */
  bridgedChannelId: string;
}

/**
 * True when a human (not a bot, not us) just MOVED INTO the bridged channel while private memory is
 * loaded — the only state change that can break the single-human privacy precondition. Entering means
 * the new channel is the bridged one and the old channel was not (a within-channel mute/deafen has
 * from === to, so it is not a join). A memory-less call is never torn down.
 */
export function isLateJoiner(e: LateJoinerEvent): boolean {
  if (!e.memoryLoaded || e.joinerIsBot || e.joinerIsSelf) return false;
  return e.toChannelId === e.bridgedChannelId && e.fromChannelId !== e.bridgedChannelId;
}
