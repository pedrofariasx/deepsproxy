/*
 * File: deepseek.ts
 * Project: deepsproxy
 * DeepSeek Provider — wraps existing Playwright-based DeepSeek integration
 * into the ChatProvider interface.
 */

import type {
  ChatProvider,
  ModelInfo,
  ProviderChatOptions,
  ProviderHealth,
  ProviderStreamEvent,
  ProviderErrorKind,
} from './types.ts';
import { ProviderError } from './types.ts';
import { createDeepSeekStream, updateSessionParent } from '../services/deepseek.ts';
import { activePage } from '../services/playwright.ts';
import { robustParseJSON } from '../utils/json.ts';
import { v4 as uuidv4 } from 'uuid';
import { ProviderLimiter, envInt } from './control.ts';

// ─── Constants ─────────────────────────────────────────────────────────────────

const TOOL_START = '<tool_call>';
const TOOL_END = '</tool_call>';

const deepseekLimiter = new ProviderLimiter({
  maxConcurrent: envInt('DEEPSEEK_MAX_CONCURRENT', 1),
  minIntervalMs: process.env.TEST_MOCK_PLAYWRIGHT ? 0 : envInt('DEEPSEEK_MIN_INTERVAL_MS', 2500),
  queueTimeoutMs: envInt('DEEPSEEK_QUEUE_TIMEOUT_MS', 90000),
});

const DEEPSEEK_MODELS: ModelInfo[] = [
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', owned_by: 'deepseek', created: Math.floor(Date.now() / 1000) },
  { id: 'deepseek-v4-flash-thinking', name: 'DeepSeek V4 Flash Thinking', owned_by: 'deepseek', created: Math.floor(Date.now() / 1000), supports_thinking: true },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', owned_by: 'deepseek', created: Math.floor(Date.now() / 1000) },
  { id: 'deepseek-v4-pro-thinking', name: 'DeepSeek V4 Pro Thinking', owned_by: 'deepseek', created: Math.floor(Date.now() / 1000), supports_thinking: true },
];

// ─── DeepSeek SSE Parse State ──────────────────────────────────────────────────

interface DeepSeekParseState {
  currentAppendPath: string;
  currentFragmentType: string;
  insideTool: boolean;
  contentEmitBuffer: string;
  emittedToolCallCount: number;
  completionTokens: number;
}

function createParseState(): DeepSeekParseState {
  return {
    currentAppendPath: '',
    currentFragmentType: '',
    insideTool: false,
    contentEmitBuffer: '',
    emittedToolCallCount: 0,
    completionTokens: 0,
  };
}

/**
 * Parse a single DeepSeek SSE data line into provider events.
 */
function parseDeepSeekLine(
  dataStr: string,
  state: DeepSeekParseState,
  uiSessionId: string
): ProviderStreamEvent[] {
  if (dataStr === '[DONE]') {
    return [{ type: 'done' }];
  }

  const events: ProviderStreamEvent[] = [];

  try {
    const chunk = JSON.parse(dataStr);

    // ── Extract message ID for session tracking ──
    let dsMessageId: any = null;
    if (chunk.response_message_id) {
      dsMessageId = chunk.response_message_id;
    } else if (chunk.v && typeof chunk.v === 'object') {
      if (chunk.v.response && chunk.v.response.message_id) {
        dsMessageId = chunk.v.response.message_id;
      } else if (chunk.v.message_id) {
        dsMessageId = chunk.v.message_id;
      }
    } else if (chunk.message_id) {
      dsMessageId = chunk.message_id;
    }

    if (dsMessageId) {
      updateSessionParent(uiSessionId, dsMessageId);
    }

    // ── Track path and token usage ──
    let vStr = '';
    let foundStr = false;
    let isThinkingChunk = false;

    if (typeof chunk.p === 'string') {
      state.currentAppendPath = chunk.p;
      if (chunk.p === 'response/accumulated_token_usage' && typeof chunk.v === 'number') {
        state.completionTokens = chunk.v;
        events.push({ type: 'none', completionTokens: chunk.v });
      }
    }

    // ── Extract string value ──
    if (typeof chunk.v === 'string') {
      vStr = chunk.v;
      foundStr = true;
    } else if (chunk.v && typeof chunk.v === 'object') {
      if (chunk.v.response && chunk.v.response.fragments && chunk.v.response.fragments.length > 0) {
        const frag = chunk.v.response.fragments[0];
        if (typeof frag.content === 'string') {
          vStr = frag.content;
          foundStr = true;
          state.currentAppendPath = frag.type === 'THINK' ? 'response/thinking_content' : 'response/content';
          state.currentFragmentType = frag.type || '';
        }
      } else if (Array.isArray(chunk.v) && chunk.v.length > 0) {
        const firstObj = chunk.v[0];
        if (typeof firstObj.content === 'string') {
          vStr = firstObj.content;
          foundStr = true;
          state.currentAppendPath = firstObj.type === 'THINK' ? 'response/thinking_content' : 'response/content';
          state.currentFragmentType = firstObj.type || '';
        }
      }
    }

    // ── Detect fragment type changes for v2.0.0 ──
    if (chunk.p === 'response/fragments' && Array.isArray(chunk.v)) {
      const lastFrag = chunk.v[chunk.v.length - 1];
      if (lastFrag && lastFrag.type) {
        state.currentFragmentType = lastFrag.type;
      }
    }

    // ── Determine thinking vs content ──
    if (state.currentAppendPath.includes('thinking_content') ||
        state.currentAppendPath.includes('THINK') ||
        (state.currentAppendPath.includes('fragments/-1/content') && state.currentFragmentType === 'THINK')) {
      isThinkingChunk = true;
    }

    if (foundStr && vStr !== '') {
      if (vStr === 'FINISHED') return [];

      if (isThinkingChunk) {
        events.push({ type: 'reasoning', content: vStr });
      } else {
        state.contentEmitBuffer += vStr;

        // Process content buffer for tool calls
        while (state.contentEmitBuffer.length > 0) {
          if (!state.insideTool) {
            const startIdx = state.contentEmitBuffer.indexOf(TOOL_START);
            if (startIdx !== -1) {
              const textToEmit = state.contentEmitBuffer.substring(0, startIdx);
              if (textToEmit && state.emittedToolCallCount === 0) {
                events.push({ type: 'content', content: textToEmit });
              }
              state.insideTool = true;
              state.contentEmitBuffer = state.contentEmitBuffer.substring(startIdx + TOOL_START.length);
              continue;
            } else {
              let flushIndex = state.contentEmitBuffer.length;
              for (let i = 1; i <= TOOL_START.length; i++) {
                if (state.contentEmitBuffer.endsWith(TOOL_START.substring(0, i))) {
                  flushIndex = state.contentEmitBuffer.length - i;
                  break;
                }
              }
              const textToEmit = state.contentEmitBuffer.substring(0, flushIndex);
              if (textToEmit && state.emittedToolCallCount === 0) {
                events.push({ type: 'content', content: textToEmit });
              }
              state.contentEmitBuffer = state.contentEmitBuffer.substring(flushIndex);
              break;
            }
          } else {
            const endIdx = state.contentEmitBuffer.indexOf(TOOL_END);
            if (endIdx !== -1) {
              const toolJsonStr = state.contentEmitBuffer.substring(0, endIdx).trim();
              try {
                const toolCallObj = robustParseJSON(toolJsonStr);
                if (!toolCallObj) throw new Error('Empty tool call');

                const nameMatch = toolJsonStr.match(/<tool_call\s+name="([^"]+)"/);
                const toolName = nameMatch ? nameMatch[1] : toolCallObj.name || '';

                let toolArgs: Record<string, unknown> = {};
                if (toolCallObj.arguments && typeof toolCallObj.arguments === 'object') {
                  toolArgs = toolCallObj.arguments;
                } else {
                  const keys = Object.keys(toolCallObj).filter(k => k !== 'name');
                  for (const k of keys) {
                    toolArgs[k] = toolCallObj[k];
                  }
                }

                const toolId = 'call_' + uuidv4();
                events.push({
                  type: 'tool_call',
                  toolCall: {
                    id: toolId,
                    index: state.emittedToolCallCount,
                    type: 'function',
                    function: {
                      name: toolName,
                      arguments: JSON.stringify(toolArgs),
                    },
                  },
                });
                state.emittedToolCallCount++;
              } catch (e) {
                if (state.emittedToolCallCount === 0) {
                  events.push({
                    type: 'tool_call_error',
                    rawText: TOOL_START + toolJsonStr + TOOL_END,
                  });
                }
              }
              state.insideTool = false;
              state.contentEmitBuffer = state.contentEmitBuffer.substring(endIdx + TOOL_END.length);
            } else {
              break;
            }
          }
        }
      }
    }
  } catch (e) {
    // parse error, ignore
  }

  return events;
}

// ─── DeepSeek Provider ─────────────────────────────────────────────────────────

export class DeepSeekProvider implements ChatProvider {
  readonly name = 'deepseek';

  private _health: ProviderHealth = {
    status: 'healthy',
    successCount: 0,
    errorCount: 0,
    consecutiveFailures: 0,
  };

  get health(): ProviderHealth {
    return {
      ...this._health,
      queueDepth: deepseekLimiter.queueDepth,
    };
  }

  async initialize(): Promise<void> {
    if (process.env.TEST_MOCK_PLAYWRIGHT) {
      this._health.status = 'healthy';
      console.log('[deepseek] Provider initialized (mock)');
      return;
    }

    if (!activePage) {
      this._health.status = 'offline';
      this._health.lastError = 'Playwright not initialized';
      this._health.lastErrorKind = 'playwright';
      this._health.lastErrorAt = Date.now();
      console.warn('[deepseek] Provider offline: Playwright not initialized');
      return;
    }

    this._health.status = 'healthy';
    console.log('[deepseek] Provider initialized');
  }

  handlesModel(modelId: string): boolean {
    return modelId.toLowerCase().startsWith('deepseek-');
  }

  async listModels(): Promise<ModelInfo[]> {
    // DeepSeek models are static (determined by the web UI)
    return DEEPSEEK_MODELS.map(m => ({ ...m, created: Math.floor(Date.now() / 1000) }));
  }

  async createStream(options: ProviderChatOptions): Promise<{
    events: AsyncIterable<ProviderStreamEvent>;
    sessionId: string;
    promptTokens: number;
  }> {
    const isThinkingModel = options.model.includes('thinking');
    const isProModel = options.model.includes('pro');

    let stream: ReadableStream;
    let uiSessionId: string;

    try {
      const result = await deepseekLimiter.run(() => createDeepSeekStream(
        options.prompt,
        isThinkingModel,
        isProModel,
        options.isNewSession ? null : undefined
      ));
      stream = result.stream;
      uiSessionId = result.uiSessionId;

      this._health.successCount++;
      this._health.consecutiveFailures = 0;
      this._health.lastSuccessAt = Date.now();
      this._health.status = 'healthy';
    } catch (err: any) {
      const kind = classifyDeepSeekError(err);
      this._health.errorCount++;
      this._health.consecutiveFailures = (this._health.consecutiveFailures || 0) + 1;
      this._health.status = 'degraded';
      this._health.lastError = err.message;
      this._health.lastErrorKind = kind;
      this._health.lastErrorAt = Date.now();

      throw new ProviderError(
        'deepseek',
        `Chat request failed: ${err.message}`,
        statusCodeForKind(kind),
        kind !== 'bad_request',
        kind
      );
    }

    const promptTokens = Math.ceil(options.prompt.length / 3.5);
    const events = this.createEventIterable(stream, uiSessionId);

    return { events, sessionId: uiSessionId, promptTokens };
  }

  private async *createEventIterable(
    stream: ReadableStream,
    uiSessionId: string
  ): AsyncIterable<ProviderStreamEvent> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const state = createParseState();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;

          const dataStr = trimmed.slice(6);
          const events = parseDeepSeekLine(dataStr, state, uiSessionId);

          for (const event of events) {
            if (event.type !== 'none') {
              yield event;
            }
          }
        }
      }

      // Flush remaining content buffer
      if (!state.insideTool && state.contentEmitBuffer.length > 0 && state.emittedToolCallCount === 0) {
        yield { type: 'content', content: state.contentEmitBuffer };
      }

      // Emit final completion tokens
      if (state.completionTokens > 0) {
        yield { type: 'none', completionTokens: state.completionTokens };
      }
    } finally {
      reader.releaseLock();
    }
  }

  async shutdown(): Promise<void> {
    console.log('[deepseek] Provider shut down');
  }
}

function classifyDeepSeekError(err: any): ProviderErrorKind {
  const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  if (message.includes('login') || message.includes('unauthorized') || message.includes('forbidden')) return 'auth';
  if (message.includes('429') || message.includes('rate')) return 'rate_limit';
  if (message.includes('queue timeout') || message.includes('timeout') || message.includes('abortsignal')) return 'timeout';
  if (message.includes('playwright') || message.includes('browser') || message.includes('page') || message.includes('selector')) return 'playwright';
  if (message.includes('fetch failed') || message.includes('network') || message.includes('econn') || message.includes('dns')) return 'network';
  if (message.includes('400') || message.includes('bad request')) return 'bad_request';
  if (message.includes('500') || message.includes('502') || message.includes('503') || message.includes('504')) return 'provider_5xx';
  return 'unknown';
}

function statusCodeForKind(kind: ProviderErrorKind): number {
  switch (kind) {
    case 'auth':
      return 401;
    case 'rate_limit':
      return 429;
    case 'timeout':
      return 504;
    case 'bad_request':
      return 400;
    case 'playwright':
    case 'provider_5xx':
      return 503;
    default:
      return 500;
  }
}
