/*
 * File: playwright.ts
 * Project: deepsproxy
 * Author: Pedro Farias
 * Created: 2026-05-09
 *
 * Last Modified: Sat May 09 2026
 * Modified By: Pedro Farias
 */

import { chromium, BrowserContext, Page } from 'playwright';
import path from 'path';

interface DeepSeekHeadersResult {
  headers: Record<string, string>;
  chatSessionId: string;
  parentMessageId: number | null;
}

let context: BrowserContext | null = null;
export let activePage: Page | null = null;
let powQueue: Promise<unknown> = Promise.resolve();
let powQueueDepth = 0;
let powQueuePoisoned = false;

function positiveIntegerEnv(name: string, fallback: number): number {
  const configured = Number(process.env[name] || String(fallback));
  return Number.isInteger(configured) && configured > 0 ? configured : fallback;
}

function headerValue(headers: Record<string, string>, name: string): string {
  return headers[name] || '';
}

function powQueueError(message: string, status: number, code: string): Error {
  const error: any = new Error(message);
  error.upstreamStatus = status;
  error.code = code;
  return error;
}

function abortError(signal: AbortSignal): any {
  return signal.reason || powQueueError('DeepSeek PoW extraction aborted', 504, 'pow_aborted');
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortError(signal);
  let rejectOnAbort!: (reason: any) => void;
  const aborted = new Promise<never>((_, reject) => { rejectOnAbort = reject; });
  const listener = () => rejectOnAbort(abortError(signal));
  signal.addEventListener('abort', listener, { once: true });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener('abort', listener);
  }
}

async function waitForTaskCleanup(task: Promise<unknown>, graceMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task.then(() => true, () => true),
      new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), graceMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function initPlaywright(headless = true) {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return;
  if (context) return;

  const profilePath = path.resolve('deepseek_profile');
  context = await chromium.launchPersistentContext(profilePath, {
    headless,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--exclude-switches=enable-automation',
      '--disable-infobars',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  });

  const pages = context.pages();
  activePage = pages.length > 0 ? pages[0] : await context.newPage();
}

export async function closePlaywright() {
  resetPowQueueForTests();
  if (process.env.TEST_MOCK_PLAYWRIGHT) return;
  if (context) await context.close();
  context = null;
  activePage = null;
}

export function enqueueSerializedPowTask<T>(
  task: (remainingMs: number, signal: AbortSignal) => Promise<T>
): Promise<T> {
  const maxDepth = positiveIntegerEnv('DEEPSPROXY_POW_QUEUE_MAX', 32);
  if (powQueuePoisoned) {
    return Promise.reject(powQueueError('DeepSeek PoW queue is unavailable until the timed-out task terminates', 503, 'pow_queue_unavailable'));
  }
  if (powQueueDepth >= maxDepth) {
    return Promise.reject(powQueueError('DeepSeek PoW queue is full', 429, 'pow_queue_full'));
  }

  powQueueDepth++;
  const deadlineAt = Date.now() + positiveIntegerEnv('DEEPSPROXY_POW_TIMEOUT_MS', 30000);
  let resolveResult!: (value: T | PromiseLike<T>) => void;
  let rejectResult!: (reason: any) => void;
  const result = new Promise<T>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const turn = powQueue.catch(() => {}).then(async () => {
    if (powQueuePoisoned) {
      rejectResult(powQueueError('DeepSeek PoW queue is unavailable until the timed-out task terminates', 503, 'pow_queue_unavailable'));
      return;
    }
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      rejectResult(powQueueError('Timed out waiting for DeepSeek PoW queue', 504, 'pow_queue_timeout'));
      return;
    }

    const controller = new AbortController();
    const timeoutFailure = powQueueError('Timed out extracting DeepSeek PoW headers', 504, 'pow_timeout');
    let rejectOnTimeout!: (reason: any) => void;
    const timedOut = new Promise<never>((_, reject) => { rejectOnTimeout = reject; });
    const timer = setTimeout(() => {
      controller.abort(timeoutFailure);
      rejectOnTimeout(timeoutFailure);
    }, remainingMs);
    const taskResult = Promise.resolve().then(() => task(remainingMs, controller.signal));

    try {
      resolveResult(await Promise.race([taskResult, timedOut]));
    } catch (error) {
      rejectResult(controller.signal.aborted ? abortError(controller.signal) : error);
      if (controller.signal.aborted) {
        const cleanupGraceMs = positiveIntegerEnv('DEEPSPROXY_POW_CLEANUP_GRACE_MS', 1000);
        const terminated = await waitForTaskCleanup(taskResult, cleanupGraceMs);
        if (!terminated) {
          powQueuePoisoned = true;
          void taskResult.finally(() => { powQueuePoisoned = false; }).catch(() => {});
        }
      }
    } finally {
      clearTimeout(timer);
    }
  }).catch(rejectResult).finally(() => {
    powQueueDepth--;
  });

  powQueue = turn.then(() => undefined, () => undefined);
  return result;
}

export function resetPowQueueForTests(): void {
  powQueue = Promise.resolve();
  powQueueDepth = 0;
  powQueuePoisoned = false;
}

/**
 * Ensures the session is valid and extracts headers, PoW, and session ID.
 * Work is serialized because concurrent UI submissions corrupt browser state.
 */
export function getDeepSeekHeaders(forceNew = false): Promise<DeepSeekHeadersResult> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) {
    const mockSessionId = process.env.TEST_SESSION_ID || 'mock-session';
    return Promise.resolve({ headers: { authorization: 'Bearer MOCK' }, chatSessionId: mockSessionId, parentMessageId: null });
  }

  return enqueueSerializedPowTask((remainingMs, signal) =>
    getDeepSeekHeadersInternal(forceNew, remainingMs, signal)
  );
}

async function getDeepSeekHeadersInternal(
  forceNew: boolean,
  timeoutMs: number,
  signal: AbortSignal
): Promise<DeepSeekHeadersResult> {
  if (!context && !activePage) throw new Error('Playwright not initialized');

  let capturePage: Page;
  let ownsCapturePage = false;
  if (context) {
    const pagePromise = context.newPage();
    try {
      capturePage = await abortable(pagePromise, signal);
      ownsCapturePage = true;
    } catch (error) {
      void pagePromise.then(page => page.close().catch(() => {})).catch(() => {});
      throw error;
    }
  } else {
    capturePage = activePage!;
  }

  try {
    return await captureDeepSeekHeadersFromPage(capturePage, forceNew, timeoutMs, signal);
  } finally {
    if (ownsCapturePage && !capturePage.isClosed()) {
      await capturePage.close().catch(() => {});
    }
  }
}

/** Isolated capture primitive exported for deterministic browser-state tests. */
export async function captureDeepSeekHeadersFromPage(
  page: Page,
  forceNew: boolean,
  timeoutMs: number,
  signal: AbortSignal = new AbortController().signal
): Promise<DeepSeekHeadersResult> {
  const currentUrl = page.url();
  const isOnHomePage = currentUrl === 'https://chat.deepseek.com/' || currentUrl === 'https://chat.deepseek.com';
  if (!isOnHomePage || forceNew) {
    await abortable(page.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded' }), signal);
  }

  const chatInputSelector = 'textarea, [role="textbox"], [contenteditable="true"]';
  const configuredInputTimeout = positiveIntegerEnv('DEEPSPROXY_CHAT_INPUT_TIMEOUT_MS', 8000);
  const inputTimeoutMs = Math.max(1, Math.min(configuredInputTimeout, timeoutMs));
  await abortable(page.waitForSelector(chatInputSelector, { timeout: inputTimeoutMs }), signal).catch(async () => {
    if (signal.aborted) throw abortError(signal);
    const pageState = await abortable(page.evaluate(() => {
      const fullBodyText = document.body?.innerText || '';
      const bodyText = fullBodyText.slice(0, 5000);
      const suspensionMatch = fullBodyText.match(/Due to violation of user policies, your account has been suspended until\s+([^\.\n]+)\.\s*If you have any questions, please Contact us\./i);
      const suspendedUntil = suspensionMatch?.[1]?.trim() || null;
      const suspensionOriginal = suspensionMatch?.[0]?.trim() || null;
      return {
        url: location.href,
        title: document.title,
        bodyText,
        textareaCount: document.querySelectorAll('textarea').length,
        inputCount: document.querySelectorAll('input, textarea, [role="textbox"], [contenteditable]').length,
        suspended: /suspended until|violation of user policies|account has been suspended/i.test(fullBodyText),
        suspendedUntil,
        suspensionOriginal,
        loginRequired: /log in|login|sign in|entrar/i.test(fullBodyText),
      };
    }), signal).catch((error: any) => {
      if (signal.aborted) throw abortError(signal);
      return { evaluateError: error?.message || String(error) };
    });

    const state: any = pageState;
    if (state?.suspended) {
      const until = typeof state.suspendedUntil === 'string' && state.suspendedUntil.trim() ? state.suspendedUntil.trim() : '';
      const original = typeof state.suspensionOriginal === 'string' && state.suspensionOriginal.trim() ? state.suspensionOriginal.trim() : '';
      const detail = original || (until ? `Due to violation of user policies, your account has been suspended until ${until}.` : 'DeepSeek reported an account suspension.');
      throw new Error(`DeepSeek account is suspended; chat input is unavailable. Original DeepSeek message: ${detail}`);
    }
    if (state?.loginRequired) throw new Error('DeepSeek login is required; chat input is unavailable.');
    throw new Error('DeepSeek chat input unavailable; page did not expose an input box.');
  });

  return await new Promise<DeepSeekHeadersResult>((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout>;
    const routePattern = '**/api/v0/chat/completion';

    const cleanup = async (closePage: boolean) => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      await page.unroute(routePattern, routeHandler).catch(() => {});
      if (closePage && !page.isClosed()) await page.close().catch(() => {});
    };

    const fail = async (error: any, closePage: boolean) => {
      if (settled) return;
      settled = true;
      await cleanup(closePage);
      reject(error);
    };

    const succeed = async (result: DeepSeekHeadersResult) => {
      if (settled) return;
      settled = true;
      await cleanup(false);
      resolve(result);
    };

    const onAbort = () => {
      void fail(abortError(signal), true);
    };

    const routeHandler = async (route: any, request: any) => {
      if (settled) {
        await route.abort('aborted').catch(() => {});
        return;
      }
      try {
        const reqHeaders = request.headers();
        let uiSessionId = '';
        let uiParentMessageId: number | null = null;
        const postData = request.postData();
        if (postData) {
          try {
            const payload = JSON.parse(postData);
            if (payload.chat_session_id) uiSessionId = payload.chat_session_id;
            if (payload.parent_message_id !== undefined) uiParentMessageId = payload.parent_message_id;
          } catch {
            // Ignore malformed intercepted payloads; the request is aborted below.
          }
        }

        const extractedHeaders = {
          'x-ds-pow-response': headerValue(reqHeaders, 'x-ds-pow-response'),
          'x-hif-dliq': headerValue(reqHeaders, 'x-hif-dliq'),
          'x-hif-leim': headerValue(reqHeaders, 'x-hif-leim'),
          authorization: headerValue(reqHeaders, 'authorization'),
          cookie: headerValue(reqHeaders, 'cookie'),
        };

        await route.abort('aborted').catch(() => {});
        await succeed({ headers: extractedHeaders, chatSessionId: uiSessionId, parentMessageId: uiParentMessageId });
      } catch (error) {
        await fail(error, false);
      }
    };

    timeout = setTimeout(() => {
      void fail(powQueueError('Timeout waiting for PoW headers', 504, 'pow_timeout'), true);
    }, Math.max(1, Math.min(20000, timeoutMs)));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }

    page.route(routePattern, routeHandler).then(async () => {
      try {
        const input = await abortable(page.waitForSelector(chatInputSelector, { timeout: Math.min(5000, timeoutMs) }), signal);
        if (!input) throw new Error('Chat input not found');
        await abortable(input.fill('a'), signal);
        await abortable(page.keyboard.press('Enter'), signal);
      } catch (error) {
        await fail(error, signal.aborted);
      }
    }).catch(error => {
      void fail(error, signal.aborted);
    });
  });
}
