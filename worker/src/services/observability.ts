import type { Env } from '../types';

type FieldValue = string | number | boolean | null | undefined;

interface LogOptions {
  force?: boolean;
}

export function logEvent(env: Env, event: string, fields: Record<string, FieldValue>, options: LogOptions = {}): void {
  if (!options.force && !shouldSample(env)) return;

  console.log(JSON.stringify({
    event,
    timestamp: new Date().toISOString(),
    ...fields
  }));
}

function shouldSample(env: Env): boolean {
  const sampleRate = Number(env.OBSERVABILITY_SAMPLE_RATE ?? '0');
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) return false;
  if (sampleRate >= 1) return true;
  return Math.random() < sampleRate;
}
