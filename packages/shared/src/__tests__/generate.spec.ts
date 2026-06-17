// generate owns the MECHANISM of a model call: lazy provider resolution per-call, the
// @ai-sdk/openai client + generateText, opt-in retry-on-empty, usage+latency summed across
// attempts. It owns no fail policy — emptiness is a value (returned), transport errors throw.

jest.mock('@ai-sdk/openai', () => ({ createOpenAI: jest.fn(() => jest.fn((m: string) => ({ model: m }))) }));
jest.mock('ai', () => ({ generateText: jest.fn() }));
jest.mock('../provider', () => ({ getProvider: jest.fn() }));

import { generate } from '../generate';

const { generateText } = require('ai') as { generateText: jest.Mock };
const { createOpenAI } = require('@ai-sdk/openai') as { createOpenAI: jest.Mock };
const { getProvider } = require('../provider') as { getProvider: jest.Mock };

beforeEach(() => {
  jest.clearAllMocks();
  getProvider.mockReturnValue({ baseUrl: 'http://t', model: 'm', apiKey: 'k' });
});

describe('generate', () => {
  it('resolves the provider on EVERY call (no caching)', async () => {
    generateText.mockResolvedValue({ text: 'ok', usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } });
    await generate('research', { prompt: 'p', maxOutputTokens: 100 });
    await generate('research', { prompt: 'p', maxOutputTokens: 100 });
    expect(getProvider).toHaveBeenCalledTimes(2);
    expect(getProvider).toHaveBeenCalledWith('research');
    // and re-builds the client each call rather than caching it
    expect(createOpenAI).toHaveBeenCalledTimes(2);
  });

  it('returns { text, usage, model, latencyMs } with text pre-trimmed', async () => {
    getProvider.mockReturnValue({ baseUrl: 'http://t', model: 'gpt-x', apiKey: 'k' });
    generateText.mockResolvedValue({ text: '  hi  ', usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 } });
    const r = await generate('coach', { system: 's', prompt: 'p', temperature: 0.7, maxOutputTokens: 100 });
    expect(r.text).toBe('hi');
    expect(r.model).toBe('gpt-x');
    expect(r.usage).toEqual({ inputTokens: 4, outputTokens: 6, totalTokens: 10 });
    expect(typeof r.latencyMs).toBe('number');
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('forwards the telemetry option to the AI SDK as experimental_telemetry (routes spans to the tracer)', async () => {
    generateText.mockResolvedValue({ text: 'ok', usage: { totalTokens: 1 } });
    const tracer = { __isolated: true } as any;
    await generate('coach', {
      prompt: 'p',
      maxOutputTokens: 100,
      telemetry: { isEnabled: true, tracer, functionId: 'coach', recordInputs: true, recordOutputs: true },
    });
    expect(generateText.mock.calls[0][0].experimental_telemetry).toEqual({
      isEnabled: true,
      tracer,
      functionId: 'coach',
      recordInputs: true,
      recordOutputs: true,
    });
  });

  it('passes no experimental_telemetry when the caller omits telemetry (above-gate default)', async () => {
    generateText.mockResolvedValue({ text: 'ok', usage: { totalTokens: 1 } });
    await generate('classifier', { prompt: 'p', maxOutputTokens: 100 });
    expect(generateText.mock.calls[0][0].experimental_telemetry).toBeUndefined();
  });

  it('normalises usage: only reported fields present, absent never coerced to zero', async () => {
    generateText.mockResolvedValue({ text: 'x', usage: { totalTokens: 50 } });
    const r = await generate('research', { prompt: 'p', maxOutputTokens: 100 });
    expect(r.usage).toEqual({ totalTokens: 50 });
    expect(r.usage).not.toHaveProperty('inputTokens');
    expect(r.usage).not.toHaveProperty('outputTokens');
  });

  it('returns empty text (NOT a throw) on empty output, and does not retry without retryOnEmpty', async () => {
    generateText.mockResolvedValue({ text: '', usage: { totalTokens: 400 } });
    const r = await generate('research', { prompt: 'p', maxOutputTokens: 100 });
    expect(r.text).toBe('');
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry when the first attempt is non-empty even if retryOnEmpty is set', async () => {
    generateText.mockResolvedValue({ text: 'done', usage: { totalTokens: 5 } });
    await generate('coach', { prompt: 'p', maxOutputTokens: 100, retryOnEmpty: { temperature: 0.3 } });
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it('retries ONCE at the lower temperature when opted in and first text is empty', async () => {
    generateText
      .mockResolvedValueOnce({ text: '', usage: { totalTokens: 100 } })
      .mockResolvedValueOnce({ text: 'recovered', usage: { totalTokens: 20 } });
    const r = await generate('coach', { prompt: 'p', temperature: 0.7, maxOutputTokens: 100, retryOnEmpty: { temperature: 0.3 } });
    expect(generateText).toHaveBeenCalledTimes(2);
    expect(r.text).toBe('recovered');
    expect(generateText.mock.calls[0][0].temperature).toBe(0.7);
    expect(generateText.mock.calls[1][0].temperature).toBe(0.3);
  });

  it('sums usage AND latency across the two attempts', async () => {
    generateText
      .mockResolvedValueOnce({ text: '', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } })
      .mockResolvedValueOnce({ text: 'ok', usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } });
    const r = await generate('coach', { prompt: 'p', maxOutputTokens: 100, retryOnEmpty: { temperature: 0.3 } });
    expect(r.usage).toEqual({ inputTokens: 13, outputTokens: 9, totalTokens: 22 });
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('fires the log callback on empty-after-retry with kind/model/baseUrl/cap', async () => {
    getProvider.mockReturnValue({ baseUrl: 'http://endpoint', model: 'reasoner', apiKey: 'k' });
    generateText.mockResolvedValue({ text: '', usage: { totalTokens: 100 } });
    const log = jest.fn();
    await generate('coach', { prompt: 'p', maxOutputTokens: 256, retryOnEmpty: { temperature: 0.3 }, log });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatchObject({ model: 'reasoner', baseUrl: 'http://endpoint', cap: 256 });
  });

  it('does NOT fire the log callback when output is non-empty', async () => {
    generateText.mockResolvedValue({ text: 'hi', usage: { totalTokens: 5 } });
    const log = jest.fn();
    await generate('research', { prompt: 'p', maxOutputTokens: 100, log });
    expect(log).not.toHaveBeenCalled();
  });

  it('PROPAGATES (throws) a transport error — callers own fail policy', async () => {
    generateText.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(generate('research', { prompt: 'p', maxOutputTokens: 100 })).rejects.toThrow('ECONNREFUSED');
  });
});
