/*
 * File: zai.ts
 * Project: deepsproxy
 * Z.ai (GLM) Provider — Uses Playwright to intercept browser requests
 * and capture captcha_verify_param + signatures from the real frontend.
 * Similar approach to the DeepSeek provider.
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
import { chromium, BrowserContext, Page } from 'playwright';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import { ProviderLimiter, envInt } from './control.ts';
import { acquireProfileLock, releaseProfileLock } from '../utils/profileLock.ts';
import { robustParseJSON } from '../utils/json.ts';

// ─── Configuration ─────────────────────────────────────────────────────────────

const ZAI_BASE_URL = process.env.ZAI_BASE_URL || 'https://chat.z.ai';
const ZAI_PROFILE_PATH = path.resolve('zai_profile');
const ZAI_TOKEN_FILE = path.resolve('zai_token.json');
const TOOL_START = '<tool_call>';
const TOOL_END = '</tool_call>';

const zaiLimiter = new ProviderLimiter({
  maxConcurrent: envInt('ZAI_MAX_CONCURRENT', 1),
  minIntervalMs: process.env.TEST_MOCK_PLAYWRIGHT ? 0 : envInt('ZAI_MIN_INTERVAL_MS', 1000),
  queueTimeoutMs: envInt('ZAI_QUEUE_TIMEOUT_MS', 90000),
});

const ZAI_TEST_MODELS: ModelInfo[] = [
  { id: 'GLM-4.6', name: 'GLM-4.6', owned_by: 'z.ai', created: Math.floor(Date.now() / 1000), supports_thinking: true },
  { id: 'GLM-4.5', name: 'GLM-4.5', owned_by: 'z.ai', created: Math.floor(Date.now() / 1000), supports_thinking: true },
];

// ─── Playwright State ──────────────────────────────────────────────────────────

let zaiContext: BrowserContext | null = null;
let zaiPage: Page | null = null;
let zaiProfileLockPath: string | null = null;

// Shared state for browser-based streaming (managed via page.exposeFunction)
let zaiChunkQueue: string[] = [];
let zaiDonePushing = false;
let zaiPushError: Error | null = null;
let zaiExposeInitialized = false;

interface ZaiParseState {
  insideTool: boolean;
  contentEmitBuffer: string;
  emittedToolCallCount: number;
}

function createZaiParseState(): ZaiParseState {
  return {
    insideTool: false,
    contentEmitBuffer: '',
    emittedToolCallCount: 0,
  };
}

// ─── Token from file ───────────────────────────────────────────────────────────

function readSavedToken(): { token: string; id: string; name?: string } | null {
  try {
    if (fs.existsSync(ZAI_TOKEN_FILE)) {
      const data = JSON.parse(fs.readFileSync(ZAI_TOKEN_FILE, 'utf-8'));
      if (data?.token && data?.id) {
        return data;
      }
    }
  } catch (e) { /* ignore */ }
  return null;
}

// ─── SSE Parser ────────────────────────────────────────────────────────────────

function parseZaiChunk(dataStr: string): ProviderStreamEvent {
  if (dataStr === '[DONE]') {
    return { type: 'done' };
  }

  try {
    const parsed = JSON.parse(dataStr);
    // V2 format: {"type":"chat:completion","data":{"data":{...}}}
    const outer = parsed?.data;
    const data = outer?.data || outer;

    if (!data) return { type: 'none' };

    // Check for errors
    if (data.error) {
      console.warn(`[zai] Stream error: ${data.error.detail || data.error.code}`);
      return { type: 'none' };
    }

    if (data.done) {
      return { type: 'done' };
    }

    const content = data.delta_content || data.edit_content || '';
    if (!content) return { type: 'none' };

    const phase = data.phase || 'answer';

    if (phase === 'thinking') {
      return { type: 'reasoning', content };
    } else {
      return { type: 'content', content };
    }
  } catch (e) {
    return { type: 'none' };
  }
}

function processZaiContent(content: string, state: ZaiParseState): ProviderStreamEvent[] {
  const events: ProviderStreamEvent[] = [];
  state.contentEmitBuffer += content;

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
      }

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

    const endIdx = state.contentEmitBuffer.indexOf(TOOL_END);
    if (endIdx === -1) break;

    const toolJsonStr = state.contentEmitBuffer.substring(0, endIdx).trim();
    try {
      const raw = robustParseJSON(toolJsonStr);
      const toolCallObj = normalizeToolCallObject(raw);
      if (!toolCallObj) throw new Error('Invalid tool call object');

      events.push({
        type: 'tool_call',
        toolCall: {
          id: 'call_' + uuidv4(),
          index: state.emittedToolCallCount,
          type: 'function',
          function: {
            name: toolCallObj.name,
            arguments: JSON.stringify(toolCallObj.arguments),
          },
        },
      });
      state.emittedToolCallCount++;
    } catch {
      if (state.emittedToolCallCount === 0) {
        events.push({
          type: 'tool_call_error',
          rawText: TOOL_START + toolJsonStr + TOOL_END,
        });
      }
    }

    state.insideTool = false;
    state.contentEmitBuffer = state.contentEmitBuffer.substring(endIdx + TOOL_END.length);
  }

  return events;
}

function normalizeToolCallObject(raw: any): { name: string; arguments: Record<string, unknown> } | null {
  if (!raw || typeof raw !== 'object') return null;

  const candidate = raw.tool_call && typeof raw.tool_call === 'object'
    ? raw.tool_call
    : raw;

  const name = candidate.name || candidate.function?.name;
  const args = candidate.arguments ?? candidate.function?.arguments ?? {};
  if (typeof name !== 'string' || !name) return null;

  let parsedArgs: Record<string, unknown>;
  if (typeof args === 'string') {
    const parsed = robustParseJSON(args);
    parsedArgs = parsed && typeof parsed === 'object' ? parsed : {};
  } else if (args && typeof args === 'object' && !Array.isArray(args)) {
    parsedArgs = args;
  } else {
    parsedArgs = {};
  }

  return { name, arguments: parsedArgs };
}

// ─── Z.ai Provider ────────────────────────────────────────────────────────────

export class ZaiProvider implements ChatProvider {
  readonly name = 'zai';

  private _health: ProviderHealth = {
    status: 'healthy',
    successCount: 0,
    errorCount: 0,
    consecutiveFailures: 0,
  };

  get health(): ProviderHealth {
    return {
      ...this._health,
      queueDepth: zaiLimiter.queueDepth,
    };
  }

  async initialize(): Promise<void> {
    if (process.env.TEST_MOCK_PLAYWRIGHT) {
      this._health.status = 'healthy';
      return;
    }

    // Z.ai API endpoint /api/v2/chat/completions returns 405 (WAF blocked).
    // Tested with: different accounts, browser fetch, realistic User-Agent,
    // and direct browser evaluate(). All return 405. Endpoint is offline.
    this._health.status = 'offline';
    this._health.lastError = 'Z.ai API endpoint blocked (405). Provider temporarily unavailable.';
    console.warn('[zai] Provider offline: Z.ai API endpoint /api/v2/chat/completions returns 405 (WAF blocked).');
    return;
  }

  handlesModel(modelId: string): boolean {
    const lower = modelId.toLowerCase();
    return lower.startsWith('glm-') || lower.startsWith('glm') || lower.startsWith('z-');
  }

  async listModels(): Promise<ModelInfo[]> {
    if (process.env.TEST_MOCK_PLAYWRIGHT) {
      return ZAI_TEST_MODELS.map(m => ({ ...m, created: Math.floor(Date.now() / 1000) }));
    }

    const savedToken = readSavedToken();
    if (!savedToken) return [];

    try {
      const response = await fetch(`${ZAI_BASE_URL}/api/models`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Authorization': `Bearer ${savedToken.token}`,
          'X-FE-Version': 'prod-fe-1.1.33',
          'Origin': ZAI_BASE_URL,
        },
        signal: AbortSignal.timeout(8000),
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const result = await response.json() as any;
      const models: ModelInfo[] = [];

      for (const m of result?.data || []) {
        if (m?.info?.is_active === false) continue;
        const modelId = m.id || '';
        if (!modelId.startsWith('GLM') && !modelId.startsWith('Z')) continue;

        models.push({
          id: modelId,
          name: m.name || modelId,
          owned_by: 'z.ai',
          created: m?.info?.created_at || Math.floor(Date.now() / 1000),
          supports_thinking: m?.info?.meta?.capabilities?.think || false,
        });
      }

      this._health.status = 'healthy';
      return models;
    } catch (err: any) {
      console.warn(`[zai] Failed to list models: ${err.message}`);
      const kind = classifyZaiError(err);
      this._health.status = 'degraded';
      this._health.lastError = err.message;
      this._health.lastErrorKind = kind;
      this._health.lastErrorAt = Date.now();
      return [];
    }
  }

  /**
   * Creates a stream by:
   * 1. Navigating to a new chat on Z.ai
   * 2. Typing a dummy message to trigger the frontend's captcha/signature generation
   * 3. Intercepting the outgoing request to capture all needed headers/params
   * 4. Aborting the dummy request
   * 5. Making a real request with our actual prompt using the captured params
   */
  async createStream(options: ProviderChatOptions): Promise<{
    events: AsyncIterable<ProviderStreamEvent>;
    sessionId: string;
    promptTokens: number;
  }> {
    if (process.env.TEST_MOCK_PLAYWRIGHT) {
      this._health.successCount++;
      this._health.consecutiveFailures = 0;
      this._health.lastSuccessAt = Date.now();
      return {
        events: mockZaiEvents(options.enableThinking),
        sessionId: 'mock-zai-session',
        promptTokens: Math.ceil(options.prompt.length / 3.5),
      };
    }

    try {
      return await zaiLimiter.run(async () => {
        if (!zaiPage || !zaiContext) {
          throw new ProviderError('zai', 'Z.ai provider is offline (API endpoint blocked). Use DeepSeek models instead.', 503, false, 'network');
        }

        const savedToken = readSavedToken();
        if (!savedToken) {
          throw new ProviderError('zai', 'No saved token. Run: npx tsx src/loginZai.ts', 401, false, 'auth');
        }

        // Navigate to new chat (force fresh state)
        const currentUrl = zaiPage.url();
        if (!currentUrl.includes('chat.z.ai')) {
          await zaiPage.goto(`${ZAI_BASE_URL}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        }

        // Wait for chat input
        await zaiPage.waitForSelector('textarea, [contenteditable]', { timeout: 15000 }).catch(() => {
          throw new ProviderError('zai', 'Chat input not found. Are you logged in?', 503, true, 'auth');
        });

        // Intercept the outgoing chat request to capture captcha + all params
        const capturedData = await this.captureRequestParams(zaiPage!);

        // Now make the REAL request with the captured params + our actual prompt
        const chatId = uuidv4();
        const zaiMessages = options.tools && options.tools.length > 0
          ? [{ role: 'user', content: options.prompt }]
          : (options.messages || [{ role: 'user', content: options.prompt }]);

        // Extract last user message for signature_prompt
        let lastUserMessage = options.prompt;
        for (const msg of zaiMessages) {
          if (msg.role === 'user') {
            lastUserMessage = typeof msg.content === 'string' ? msg.content : options.prompt;
          }
        }

        const payload: any = {
          stream: true,
          model: options.model,
          messages: zaiMessages,
          signature_prompt: lastUserMessage,
          params: {},
          extra: {},
          features: {
            enable_thinking: options.enableThinking,
            image_generation: false,
            web_search: false,
            auto_web_search: false,
            preview_mode: true,
            flags: [],
          },
          chat_id: chatId,
          id: uuidv4(),
          captcha_verify_param: capturedData.captchaParam,
        };

        // Use captured headers
        const headers: Record<string, string> = {
          ...capturedData.headers,
          'Content-Type': 'application/json',
        };

        const queryString = capturedData.queryString;
        const url = `${ZAI_BASE_URL}/api/v2/chat/completions?${queryString}`;

        console.log(`[zai] POST /api/v2/chat/completions via browser (model: ${options.model})`);

        // Reset shared state for this request
        zaiChunkQueue = [];
        zaiDonePushing = false;
        zaiPushError = null;

        // Create a ReadableStream that will receive chunks from the browser
        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();

        // Start the fetch in the browser context
        const browserPayload = JSON.stringify(payload);
        const browserHeaders = JSON.stringify(headers);

        // Fire-and-forget the browser fetch
        zaiPage!.evaluate(async (args) => {
          const { url, payload, headers } = args;
          try {
            const res = await fetch(url, {
              method: 'POST',
              headers: JSON.parse(headers),
              body: payload,
              credentials: 'include',
            });

            if (!res.ok || !res.body) {
              const text = await res.text().catch(() => '');
              (window as any).__zaiPushError(`HTTP ${res.status}: ${text.substring(0, 200)}`);
              return;
            }

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let chunkCount = 0;
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              const chunk = decoder.decode(value, { stream: true });
              chunkCount++;
              if (chunkCount <= 3) {
                console.log(`[zai-browser] Chunk ${chunkCount}:`, chunk.substring(0, 200));
              }
              (window as any).__zaiPushChunk(chunk);
            }
            console.log(`[zai-browser] Total chunks: ${chunkCount}`);
            (window as any).__zaiPushDone();
          } catch (e: any) {
            (window as any).__zaiPushError(e.message);
          }
        }, { url, payload: browserPayload, headers: browserHeaders }).catch((err) => {
          console.warn('[zai] Browser fetch error:', err.message);
          zaiDonePushing = true;
          zaiPushError = err;
        });

        // Drain the chunk queue into the stream
        (async () => {
          try {
            while (!zaiDonePushing || zaiChunkQueue.length > 0) {
              if (zaiChunkQueue.length > 0) {
                const chunks = zaiChunkQueue.splice(0);
                for (const chunk of chunks) {
                  await writer.write(new TextEncoder().encode(chunk));
                }
              } else {
                await new Promise(r => setTimeout(r, 50));
              }
            }
            await writer.close();
          } catch (e) {
            await writer.abort(e);
          }
        })();

        this._health.successCount++;
        this._health.consecutiveFailures = 0;
        this._health.lastSuccessAt = Date.now();
        this._health.status = 'healthy';

        const promptTokens = Math.ceil(options.prompt.length / 3.5);
        const events = this.createEventIterable(readable);

        return { events, sessionId: chatId, promptTokens };
      });
    } catch (err: any) {
      const kind = err instanceof ProviderError ? err.kind : classifyZaiError(err);
      this._health.errorCount++;
      this._health.consecutiveFailures = (this._health.consecutiveFailures || 0) + 1;
      this._health.status = 'degraded';
      this._health.lastError = err instanceof Error ? err.message : String(err);
      this._health.lastErrorKind = kind;
      this._health.lastErrorAt = Date.now();

      if (err instanceof ProviderError) throw err;
      throw new ProviderError('zai', this._health.lastError, statusCodeForKind(kind), kind !== 'bad_request', kind);
    }
  }

  /**
   * Trigger a dummy message in the browser to capture the captcha_verify_param
   * and all required headers/query params from the frontend.
   */
  private async captureRequestParams(page: Page): Promise<{
    headers: Record<string, string>;
    queryString: string;
    captchaParam: string;
  }> {
    return new Promise(async (resolve, reject) => {
      let settled = false;
      const cleanup = async () => {
        await page.unroute('**/api/v2/chat/completions**', routeHandler).catch(() => {});
      };
      const fail = async (err: ProviderError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        await cleanup();
        reject(err);
      };
      const timeout = setTimeout(() => {
        void fail(new ProviderError('zai', 'Timeout capturing captcha params', 504, true, 'timeout'));
      }, 30000);

      const routeHandler = async (route: any, request: any) => {
        if (settled) {
          await route.fallback().catch(() => route.continue().catch(() => {}));
          return;
        }
        settled = true;
        clearTimeout(timeout);

        const reqHeaders = request.headers();
        const postData = request.postData();
        const url = new URL(request.url());

        // Extract captcha param from the POST body
        let captchaParam = '';
        if (postData) {
          try {
            const body = JSON.parse(postData);
            captchaParam = body.captcha_verify_param || '';
          } catch (e) { /* ignore */ }
        }

        // Extract useful headers
        const capturedHeaders: Record<string, string> = {
          'authorization': reqHeaders['authorization'] || '',
          'x-fe-version': reqHeaders['x-fe-version'] || 'prod-fe-1.1.33',
          'x-signature': reqHeaders['x-signature'] || '',
          'x-region': reqHeaders['x-region'] || 'overseas',
          'user-agent': reqHeaders['user-agent'] || '',
          'origin': reqHeaders['origin'] || ZAI_BASE_URL,
          'referer': reqHeaders['referer'] || `${ZAI_BASE_URL}/`,
        };

        // Extract query string (has all the telemetry + timestamp + signature)
        const queryString = url.search.substring(1); // remove leading '?'

        // Abort the dummy request so it doesn't pollute chat history
        await route.abort('aborted');

        // Cleanup route
        await cleanup();

        if (!capturedHeaders.authorization || !capturedHeaders['x-signature'] || !queryString) {
          reject(new ProviderError('zai', 'Captured request is missing authorization/signature/query params', 503, true, 'auth'));
          return;
        }

        resolve({
          headers: capturedHeaders,
          queryString,
          captchaParam,
        });
      };

      // Register the interceptor
      await page.route('**/api/v2/chat/completions**', routeHandler);

      // Trigger the frontend to send a request by typing and pressing Enter
      try {
        // Click on "New Chat" if available to get a fresh chat
        const newChatBtn = await page.$('text=New Chat');
        if (newChatBtn) {
          await newChatBtn.click();
          await page.waitForTimeout(1000);
        }

        // Find and fill the textarea
        const textarea = await page.waitForSelector('textarea', { timeout: 5000 });
        if (textarea) {
          await textarea.fill('a');
          await page.keyboard.press('Enter');
        } else {
          // Try contenteditable div
          const editable = await page.$('[contenteditable="true"]');
          if (editable) {
            await editable.fill('a');
            await page.keyboard.press('Enter');
          } else {
            await fail(new ProviderError('zai', 'Could not find chat input element', 503, true, 'playwright'));
          }
        }
      } catch (err: any) {
        await fail(new ProviderError('zai', `Failed to trigger captcha: ${err.message}`, 503, true, 'playwright'));
      }
    });
  }

  private async *createEventIterable(stream: ReadableStream): AsyncIterable<ProviderStreamEvent> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const state = createZaiParseState();
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
          const event = parseZaiChunk(dataStr);

          if (event.type === 'content' && event.content) {
            for (const parsedEvent of processZaiContent(event.content, state)) {
              yield parsedEvent;
            }
          } else if (event.type !== 'none') {
            yield event;
          }

          if (event.type === 'done') return;
        }
      }

      if (!state.insideTool && state.contentEmitBuffer.length > 0 && state.emittedToolCallCount === 0) {
        yield { type: 'content', content: state.contentEmitBuffer };
      }
    } finally {
      reader.releaseLock();
    }
  }

  async shutdown(): Promise<void> {
    if (zaiContext) {
      await zaiContext.close().catch(() => {});
      zaiContext = null;
      zaiPage = null;
    }
    releaseProfileLock(zaiProfileLockPath);
    zaiProfileLockPath = null;
    console.log('[zai] Provider shut down');
  }
}

async function* mockZaiEvents(enableThinking: boolean): AsyncIterable<ProviderStreamEvent> {
  if (enableThinking) {
    yield { type: 'reasoning', content: 'mock zai thinking' };
  }
  yield { type: 'content', content: 'mock zai response' };
  yield { type: 'done' };
}

function classifyZaiError(err: any): ProviderErrorKind {
  const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  if (message.includes('login') || message.includes('token') || message.includes('unauthorized') || message.includes('forbidden') || message.includes('captcha')) return 'auth';
  if (message.includes('429') || message.includes('rate')) return 'rate_limit';
  if (message.includes('queue timeout') || message.includes('timeout') || message.includes('abortsignal')) return 'timeout';
  if (message.includes('playwright') || message.includes('browser') || message.includes('page') || message.includes('selector') || message.includes('input element')) return 'playwright';
  if (message.includes('fetch failed') || message.includes('network') || message.includes('econn') || message.includes('dns')) return 'network';
  if (message.includes('405')) return 'provider_5xx';
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
