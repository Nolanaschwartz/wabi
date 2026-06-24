export type Clock = () => number;
export type TurnMark = 'stt' | 'llm' | 'sentence' | 'audio' | 'done';

/**
 * Records named timestamp marks across a single voice turn and renders one
 * structured latency summary line. The clock is injectable for deterministic
 * tests; production uses Date.now.
 */
export class TurnTimer {
  private readonly start: number;
  private readonly marks = new Map<TurnMark, number>();

  constructor(private readonly clock: Clock = Date.now) {
    this.start = clock();
  }

  /** Record a stage boundary. First call for a given name wins. */
  mark(name: TurnMark): void {
    if (!this.marks.has(name)) {
      this.marks.set(name, this.clock());
    }
  }

  /** Render the one-line latency summary. Missing marks render as `na`. */
  render(): string {
    const field = (label: string, from: number | undefined, to: number | undefined): string => {
      if (from === undefined || to === undefined) return `${label}=na`;
      return `${label}=${Math.round(to - from)}ms`;
    };

    const stt = this.marks.get('stt');
    const llm = this.marks.get('llm');
    const sentence = this.marks.get('sentence');
    const audio = this.marks.get('audio');
    const done = this.marks.get('done');

    return [
      'latency',
      field('stt', this.start, stt),
      field('llm_ttft', this.start, llm),
      field('sent1', llm, sentence),
      field('tts_first', sentence, audio),
      field('first_audio', this.start, audio),
      field('total', this.start, done),
    ].join(' ');
  }
}
