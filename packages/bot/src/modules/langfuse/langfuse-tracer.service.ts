const SAMPLE_RATE = 0.1;

export type TraceStep = 'classify' | 'coach' | 'retrieval';

export class LangfuseTracer {
  private enabled: boolean;

  constructor() {
    this.enabled = !!(
      process.env.LANGFUSE_HOST &&
      process.env.LANGFUSE_PUBLIC_KEY &&
      process.env.LANGFUSE_SECRET_KEY
    );
  }

  trace(
    traceId: string,
    step: TraceStep,
    input: string,
    output: string,
    options?: { isCrisis?: boolean; latencyMs?: number },
  ): void {
    if (!this.enabled) return;
    if (options?.isCrisis) return;

    const isSampled = Math.random() < SAMPLE_RATE;
    const level = isSampled ? 'debug' : 'info';

    const payload = {
      id: `${traceId}-${step}`,
      name: step,
      input: this.scrubInput(input),
      output: this.scrubOutput(output),
      level,
      metadata: {
        latencyMs: options?.latencyMs ?? 0,
        sampled: isSampled,
      },
    };

    this.sendPayload(payload);
  }

  score(
    traceId: string,
    name: string,
    value: number,
    isCrisis?: boolean,
  ): void {
    if (!this.enabled) return;
    if (isCrisis) return;

    const payload = {
      traceId,
      name,
      value,
    };

    this.sendPayload(payload);
  }

  private scrubInput(input: string): string {
    if (input.length > 200) {
      return input.slice(0, 200) + '... [truncated]';
    }
    return input;
  }

  private scrubOutput(output: string): string {
    if (output.length > 200) {
      return output.slice(0, 200) + '... [truncated]';
    }
    return output;
  }

  private sendPayload(payload: Record<string, unknown>): void {
    try {
      const host = process.env.LANGFUSE_HOST;
      if (!host) return;

      fetch(`${host}/api/traces`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.LANGFUSE_PUBLIC_KEY ?? '',
        },
        body: JSON.stringify(payload),
      }).catch(() => {});
    } catch {
      // Best-effort tracing
    }
  }
}
