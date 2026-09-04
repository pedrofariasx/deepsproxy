/*
 * File: telemetry.ts
 * Project: deepsproxy
 * Telemetry system to automatically detect and estimate model context window limits based on usage.
 */

export interface ModelTelemetry {
  detectedLimit: number; // in characters
  maxSuccessSize: number; // in characters
  minFailureSize: number; // in characters
}

const DEFAULT_CONTEXT_CHARACTERS = 64_000 * 3.5; // Roughly 224,000 characters (representing 64,000 tokens)
const MIN_CONTEXT_CHARACTERS = 50 * 3.5; // 175 characters (representing 50 tokens)

const telemetryStore: Record<string, ModelTelemetry> = (globalThis as any)._telemetryStore || {};
(globalThis as any)._telemetryStore = telemetryStore;

function initTelemetry(model: string): ModelTelemetry {
  if (!telemetryStore[model]) {
    telemetryStore[model] = {
      detectedLimit: DEFAULT_CONTEXT_CHARACTERS,
      maxSuccessSize: 0,
      minFailureSize: Infinity,
    };
  }
  return telemetryStore[model];
}

export function getModelTelemetry(model: string): ModelTelemetry {
  return initTelemetry(model);
}

export function getContextLength(model: string): number {
  const stats = initTelemetry(model);
  // Return in tokens (assuming roughly 3.5 characters per token)
  return Math.ceil(stats.detectedLimit / 3.5);
}

/**
 * True only when the upstream error is a genuine context-window overflow.
 * Generic failures (network, login, 5xx, empty replies) must NOT lower the
 * context estimate — only a server-side rejection naming the context limit
 * is evidence that the prompt was actually too large.
 */
export function isContextOverflowError(err: any): boolean {
  const message = String(err?.message || err || '');
  return /maximum context length|context length|context window|too many tokens|prompt is too long/i.test(message);
}

export function recordSuccess(model: string, promptSize: number): void {
  const stats = initTelemetry(model);
  stats.maxSuccessSize = Math.max(stats.maxSuccessSize, promptSize);
  
  // If the successful prompt was larger than our estimated limit, increase the limit
  if (promptSize > stats.detectedLimit) {
    stats.detectedLimit = promptSize;
  }
  
  // Ensure detectedLimit is not above minFailureSize if we have recorded a failure
  if (stats.detectedLimit >= stats.minFailureSize) {
    stats.detectedLimit = Math.floor(stats.minFailureSize * 0.95);
  }
  
  console.log(`[Telemetry] Recorded success for model '${model}'. Prompt size: ${promptSize} chars. Estimated context limit: ${stats.detectedLimit} chars (~${Math.ceil(stats.detectedLimit / 3.5)} tokens).`);
}

export function recordFailure(model: string, promptSize: number): void {
  const stats = initTelemetry(model);
  stats.minFailureSize = Math.min(stats.minFailureSize, promptSize);
  
  // On failure, adjust the estimated limit downwards.
  // We estimate the new limit as 85% of the failed prompt size
  const newLimit = Math.floor(promptSize * 0.85);
  
  // Do not let it drop below our safe minimum context size
  stats.detectedLimit = Math.max(MIN_CONTEXT_CHARACTERS, Math.min(stats.detectedLimit, newLimit));
  
  // Keep it above the maximum known success size
  if (stats.detectedLimit < stats.maxSuccessSize) {
    stats.detectedLimit = stats.maxSuccessSize;
  }
  
  console.log(`[Telemetry] Recorded failure for model '${model}'. Prompt size: ${promptSize} chars. Estimated context limit reduced to: ${stats.detectedLimit} chars (~${Math.ceil(stats.detectedLimit / 3.5)} tokens).`);
}
