/*
 * File: types.ts
 * Project: deepsproxy
 * Provider abstraction layer — shared types and interfaces
 */

// ─── Model Information ─────────────────────────────────────────────────────────

export interface ModelInfo {
  /** Unique model identifier (e.g. "GLM-5-Turbo", "deepseek-v4-flash") */
  id: string;
  /** Human-readable name */
  name?: string;
  /** Provider that owns this model */
  owned_by: string;
  /** Unix timestamp of model creation */
  created: number;
  /** Whether this model supports thinking/reasoning */
  supports_thinking?: boolean;
}

// ─── Provider Stream Events ────────────────────────────────────────────────────

export interface ProviderStreamEvent {
  type: 'content' | 'reasoning' | 'tool_call' | 'tool_call_error' | 'done' | 'none';
  content?: string;
  toolCall?: {
    id: string;
    index: number;
    type: 'function';
    function: { name: string; arguments: string };
  };
  rawText?: string;
  /** Token usage update, if available */
  completionTokens?: number;
}

// ─── Provider Options ──────────────────────────────────────────────────────────

export interface ProviderChatOptions {
  /** The model to use */
  model: string;
  /** The formatted prompt/messages to send */
  prompt: string;
  /** Whether thinking/reasoning is enabled */
  enableThinking: boolean;
  /** Whether this is a new session (no prior assistant messages) */
  isNewSession: boolean;
  /** Original messages array for providers that support native message format */
  messages?: any[];
  /** Tool definitions, if any */
  tools?: any[];
  /** Tool choice preference */
  toolChoice?: any;
}

// ─── Provider Stream Result ────────────────────────────────────────────────────

export interface ProviderStreamResult {
  /** The raw SSE stream from the provider */
  stream: ReadableStream;
  /** Provider-specific session identifier */
  sessionId: string;
}

// ─── Provider Health Status ────────────────────────────────────────────────────

export type ProviderStatus = 'healthy' | 'degraded' | 'offline';

export type ProviderErrorKind =
  | 'auth'
  | 'rate_limit'
  | 'network'
  | 'playwright'
  | 'provider_5xx'
  | 'bad_request'
  | 'timeout'
  | 'unknown';

export interface ProviderHealth {
  status: ProviderStatus;
  lastError?: string;
  lastErrorKind?: ProviderErrorKind;
  lastErrorAt?: number;
  lastSuccessAt?: number;
  consecutiveFailures?: number;
  cooldownUntil?: number;
  queueDepth?: number;
  successCount: number;
  errorCount: number;
}

// ─── Chat Provider Interface ───────────────────────────────────────────────────

/**
 * Abstract interface that every chat provider must implement.
 * Each provider is fully independent — failures in one provider
 * MUST NOT affect any other provider.
 */
export interface ChatProvider {
  /** Unique provider name (e.g. "deepseek", "zai", "qwen") */
  readonly name: string;

  /** Current health status */
  readonly health: ProviderHealth;

  /**
   * Initialize the provider (e.g. start Playwright, obtain tokens).
   * Should NOT throw — instead, set health status to 'offline'.
   */
  initialize(): Promise<void>;

  /**
   * List available models from this provider.
   * Returns empty array on failure (never throws).
   */
  listModels(): Promise<ModelInfo[]>;

  /**
   * Check if this provider handles the given model ID.
   */
  handlesModel(modelId: string): boolean;

  /**
   * Create a chat completion stream.
   * Returns parsed events from the provider's SSE stream.
   * 
   * @throws ProviderError on failure
   */
  createStream(options: ProviderChatOptions): Promise<{
    events: AsyncIterable<ProviderStreamEvent>;
    sessionId: string;
    promptTokens: number;
  }>;

  /**
   * Cleanup resources (close browser, etc.)
   */
  shutdown(): Promise<void>;
}

// ─── Provider Error ────────────────────────────────────────────────────────────

export class ProviderError extends Error {
  constructor(
    public readonly provider: string,
    message: string,
    public readonly statusCode: number = 500,
    public readonly retryable: boolean = false,
    public readonly kind: ProviderErrorKind = 'unknown'
  ) {
    super(`[${provider}] ${message}`);
    this.name = 'ProviderError';
  }
}
