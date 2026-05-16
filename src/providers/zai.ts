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

// ─── Configuration ─────────────────────────────────────────────────────────────

const ZAI_BASE_URL = process.env.ZAI_BASE_URL || 'https://chat.z.ai';
const ZAI_PROFILE_PATH = path.resolve('zai_profile');
const ZAI_TOKEN_FILE = path.resolve('zai_token.json');

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

    const savedToken = readSavedToken();
    if (!savedToken) {
      this._health.status = 'offline';
      this._health.lastError = 'No Z.ai token. Run: npx tsx src/loginZai.ts';
      console.warn('[zai] No saved token found. Run: npx tsx src/loginZai.ts');
      return;
    }

    try {
      zaiProfileLockPath = acquireProfileLock(ZAI_PROFILE_PATH);
      // Launch a persistent context using the saved Z.ai profile
      zaiContext = await chromium.launchPersistentContext(ZAI_PROFILE_PATH, {
        headless: true,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
        args: [
          '--disable-blink-features=AutomationControlled',
          '--exclude-switches=enable-automation',
          '--disable-infobars',
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
        ],
      });

      zaiPage = await zaiContext.newPage();
      await zaiPage.goto(`${ZAI_BASE_URL}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });

      // Wait for the page to be ready (chat input should appear)
      await zaiPage.waitForSelector('textarea, [contenteditable]', { timeout: 15000 }).catch(() => {
        console.warn('[zai] Chat input not found, page might not be fully loaded');
      });

      this._health.status = 'healthy';
      console.log(`[zai] Provider initialized with Playwright (user: ${savedToken.name || savedToken.id})`);
    } catch (err: any) {
      releaseProfileLock(zaiProfileLockPath);
      zaiProfileLockPath = null;
      this._health.status = 'offline';
      this._health.lastError = err.message;
      this._health.lastErrorAt = Date.now();
      console.warn(`[zai] Provider initialization failed: ${err.message}`);
    }
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
          throw new ProviderError('zai', 'Playwright not initialized. Run: npx tsx src/loginZai.ts', 503, true, 'playwright');
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

        console.log(`[zai] POST /api/v2/chat/completions (model: ${options.model})`);

        const response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(120000),
        });

        if (!response.ok || !response.body) {
          const errText = await response.text().catch(() => '');
          const kind = classifyZaiError(`HTTP ${response.status}: ${errText}`);
          throw new ProviderError(
            'zai',
            `Chat request failed: ${response.status} - ${errText.substring(0, 200)}`,
            response.status,
            response.status >= 500 || response.status === 429 || response.status === 408,
            kind
          );
        }

        this._health.successCount++;
        this._health.consecutiveFailures = 0;
        this._health.lastSuccessAt = Date.now();
        this._health.status = 'healthy';

        const promptTokens = Math.ceil(options.prompt.length / 3.5);
        const events = this.createEventIterable(response.body);

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
      const timeout = setTimeout(() => reject(new ProviderError('zai', 'Timeout capturing captcha params', 504, true, 'timeout')), 30000);

      const routeHandler = async (route: any, request: any) => {
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
        await page.unroute('**/api/v2/chat/completions**', routeHandler);

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
            clearTimeout(timeout);
            reject(new ProviderError('zai', 'Could not find chat input element', 503, true, 'playwright'));
          }
        }
      } catch (err: any) {
        clearTimeout(timeout);
        reject(new ProviderError('zai', `Failed to trigger captcha: ${err.message}`, 503, true, 'playwright'));
      }
    });
  }

  private async *createEventIterable(stream: ReadableStream): AsyncIterable<ProviderStreamEvent> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
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

          if (event.type !== 'none') {
            yield event;
          }

          if (event.type === 'done') return;
        }
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
