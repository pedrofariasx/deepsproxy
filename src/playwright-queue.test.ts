import test from 'node:test';
import assert from 'node:assert';

import {
  captureDeepSeekHeadersFromPage,
  enqueueSerializedPowTask,
  resetPowQueueForTests,
} from './services/playwright.ts';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('PoW queue rejects work beyond its fixed capacity', async () => {
  resetPowQueueForTests();
  process.env.DEEPSPROXY_POW_QUEUE_MAX = '1';
  process.env.DEEPSPROXY_POW_TIMEOUT_MS = '1000';
  const gate = deferred();
  const entered = deferred();

  try {
    const first = enqueueSerializedPowTask(async () => {
      entered.resolve();
      await gate.promise;
      return 'first';
    });
    await entered.promise;
    await assert.rejects(
      enqueueSerializedPowTask(async () => 'second'),
      (error: any) => error?.upstreamStatus === 429 && error?.code === 'pow_queue_full'
    );
    gate.resolve();
    assert.strictEqual(await first, 'first');
  } finally {
    gate.resolve();
    delete process.env.DEEPSPROXY_POW_QUEUE_MAX;
    delete process.env.DEEPSPROXY_POW_TIMEOUT_MS;
    delete process.env.DEEPSPROXY_POW_CLEANUP_GRACE_MS;
    resetPowQueueForTests();
  }
});

test('PoW deadline includes time spent waiting in the queue', async () => {
  resetPowQueueForTests();
  process.env.DEEPSPROXY_POW_QUEUE_MAX = '2';
  process.env.DEEPSPROXY_POW_TIMEOUT_MS = '20';
  const entered = deferred();

  try {
    const first = enqueueSerializedPowTask(async (_remaining, signal) => {
      entered.resolve();
      await new Promise<never>((_, reject) => {
        signal.addEventListener('abort', () => {
          setTimeout(() => reject(signal.reason), 15);
        }, { once: true });
      });
    });
    await entered.promise;
    const second = enqueueSerializedPowTask(async () => 'must-not-run');

    await assert.rejects(first, (error: any) => error?.code === 'pow_timeout');
    await assert.rejects(second, (error: any) => error?.code === 'pow_queue_timeout');
  } finally {
    delete process.env.DEEPSPROXY_POW_QUEUE_MAX;
    delete process.env.DEEPSPROXY_POW_TIMEOUT_MS;
    delete process.env.DEEPSPROXY_POW_CLEANUP_GRACE_MS;
    resetPowQueueForTests();
  }
});

test('PoW timeout quarantines a task that ignores abort instead of overlapping its successor', async () => {
  resetPowQueueForTests();
  process.env.DEEPSPROXY_POW_QUEUE_MAX = '2';
  process.env.DEEPSPROXY_POW_TIMEOUT_MS = '20';
  process.env.DEEPSPROXY_POW_CLEANUP_GRACE_MS = '20';
  let active = 0;
  let maxActive = 0;

  try {
    const stuck = enqueueSerializedPowTask(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      return await new Promise<never>(() => {});
    });
    await assert.rejects(
      Promise.race([
        stuck,
        new Promise((_, reject) => setTimeout(() => reject(new Error('queue remained stuck')), 250)),
      ]),
      (error: any) => error?.code === 'pow_timeout'
    );

    process.env.DEEPSPROXY_POW_TIMEOUT_MS = '1000';
    await assert.rejects(
      enqueueSerializedPowTask(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        active--;
        return 'must-not-run';
      }),
      (error: any) => error?.code === 'pow_queue_unavailable'
    );
    assert.strictEqual(maxActive, 1);
  } finally {
    delete process.env.DEEPSPROXY_POW_QUEUE_MAX;
    delete process.env.DEEPSPROXY_POW_TIMEOUT_MS;
    delete process.env.DEEPSPROXY_POW_CLEANUP_GRACE_MS;
    resetPowQueueForTests();
  }
});

class FakePage {
  closed = false;
  routeHandler: ((route: any, request: any) => Promise<void>) | undefined;
  staleHandlers: Array<(route: any, request: any) => Promise<void>> = [];
  routed = deferred();
  keyboard = { press: async (_key: string) => {} };

  url() { return 'https://chat.deepseek.com/'; }
  async goto() { return null; }
  async waitForSelector() { return { fill: async (_value: string) => {} }; }
  async evaluate() { return {}; }
  async route(_pattern: string, handler: (route: any, request: any) => Promise<void>) {
    this.routeHandler = handler;
    this.staleHandlers.push(handler);
    this.routed.resolve();
  }
  async unroute(_pattern: string, handler: (route: any, request: any) => Promise<void>) {
    if (this.routeHandler === handler) this.routeHandler = undefined;
  }
  async close() { this.closed = true; }
  isClosed() { return this.closed; }

  async trigger(sessionId: string, parentMessageId: number) {
    if (!this.routeHandler) throw new Error('No route installed');
    await this.routeHandler(
      { abort: async () => {} },
      {
        headers: () => ({ authorization: 'Bearer TEST', 'x-ds-pow-response': sessionId }),
        postData: () => JSON.stringify({ chat_session_id: sessionId, parent_message_id: parentMessageId }),
      }
    );
  }
}

test('timed-out capture page is closed and cannot leak an old session into the next capture', async () => {
  const firstPage = new FakePage();
  await assert.rejects(
    captureDeepSeekHeadersFromPage(firstPage as any, false, 10),
    (error: any) => error?.code === 'pow_timeout'
  );
  assert.strictEqual(firstPage.closed, true);
  const staleHandler = firstPage.staleHandlers[0];

  const secondPage = new FakePage();
  const secondCapture = captureDeepSeekHeadersFromPage(secondPage as any, false, 1000);
  await secondPage.routed.promise;

  await staleHandler(
    { abort: async () => {} },
    {
      headers: () => ({ authorization: 'Bearer STALE' }),
      postData: () => JSON.stringify({ chat_session_id: 'stale-session', parent_message_id: 1 }),
    }
  );
  await secondPage.trigger('fresh-session', 2);

  const result = await secondCapture;
  assert.strictEqual(result.chatSessionId, 'fresh-session');
  assert.strictEqual(result.parentMessageId, 2);
  assert.strictEqual(result.headers.authorization, 'Bearer TEST');
});
