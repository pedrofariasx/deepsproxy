import test from 'node:test';
import assert from 'node:assert';

process.env.TEST_MOCK_PLAYWRIGHT = 'true';

import { app, assertSafeListenConfig } from './index.ts';
import { acquireSessionLease } from './services/hybrid-sessions.ts';

function setupFetchMock(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : ('url' in input ? input.url : String(input));
    if (url.includes('chat.deepseek.com')) return handler(url, init);
    return originalFetch(input, init);
  };
  return () => { globalThis.fetch = originalFetch; };
}

function upstream(messageId: number, content = 'ok'): Response {
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`event: ready\ndata: {"response_message_id":${messageId}}\n\n`));
      controller.enqueue(new TextEncoder().encode(`data: {"p":"response/content","v":${JSON.stringify(content)}}\n\n`));
      controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
      controller.close();
    }
  }), { status: 200 });
}

async function request(body: Record<string, unknown>): Promise<Response> {
  return await app.fetch(new Request('http://localhost/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }));
}

test('OpenAI user does not act as a conversation identifier', async () => {
  const payloads: any[] = [];
  const restore = setupFetchMock((_url, init) => {
    payloads.push(JSON.parse(init?.body as string || '{}'));
    return upstream(13000 + payloads.length);
  });
  try {
    process.env.TEST_SESSION_ID = 'user-semantics-session-a';
    assert.strictEqual((await request({ model: 'deepseek-v4-pro', user: 'same-end-user', messages: [{ role: 'user', content: 'one' }], stream: false })).status, 200);
    process.env.TEST_SESSION_ID = 'user-semantics-session-b';
    assert.strictEqual((await request({ model: 'deepseek-v4-pro', user: 'same-end-user', messages: [{ role: 'user', content: 'two' }], stream: false })).status, 200);
    assert.strictEqual(payloads[1].chat_session_id, 'user-semantics-session-b');
    assert.strictEqual(payloads[1].parent_message_id, null);
  } finally {
    delete process.env.TEST_SESSION_ID;
    restore();
  }
});

test('opaque session_id explicitly continues a conversation', async () => {
  const payloads: any[] = [];
  const restore = setupFetchMock((_url, init) => {
    payloads.push(JSON.parse(init?.body as string || '{}'));
    return upstream(14000 + payloads.length);
  });
  try {
    process.env.TEST_SESSION_ID = 'opaque-session-a';
    assert.strictEqual((await request({ model: 'deepseek-v4-pro', session_id: 'opaque-conversation-key', messages: [{ role: 'user', content: 'one' }], stream: false })).status, 200);
    process.env.TEST_SESSION_ID = 'opaque-session-b';
    assert.strictEqual((await request({ model: 'deepseek-v4-pro', session_id: 'opaque-conversation-key', messages: [{ role: 'user', content: 'two' }], stream: false })).status, 200);
    assert.strictEqual(payloads[1].chat_session_id, 'opaque-session-a');
    assert.strictEqual(payloads[1].parent_message_id, 14001);
  } finally {
    delete process.env.TEST_SESSION_ID;
    restore();
  }
});

test('explicit incremental turns do not publish incomplete lineage aliases', async () => {
  const payloads: any[] = [];
  const restore = setupFetchMock((_url, init) => {
    payloads.push(JSON.parse(init?.body as string || '{}'));
    return upstream(15000 + payloads.length, payloads.length === 2 ? 'short answer' : 'ok');
  });
  try {
    process.env.TEST_SESSION_ID = 'hidden-history-session-a';
    assert.strictEqual((await request({ model: 'deepseek-v4-pro', session_id: 'hidden-history-key', messages: [{ role: 'user', content: 'original hidden turn' }], stream: false })).status, 200);
    assert.strictEqual((await request({ model: 'deepseek-v4-pro', session_id: 'hidden-history-key', messages: [{ role: 'user', content: 'short current turn' }], stream: false })).status, 200);

    process.env.TEST_SESSION_ID = 'hidden-history-session-b';
    assert.strictEqual((await request({
      model: 'deepseek-v4-pro',
      messages: [
        { role: 'user', content: 'short current turn' },
        { role: 'assistant', content: 'short answer' },
        { role: 'user', content: 'must not attach to hidden history' },
      ],
      stream: false,
    })).status, 200);
    assert.strictEqual(payloads[2].chat_session_id, 'hidden-history-session-b');
    assert.strictEqual(payloads[2].parent_message_id, null);
  } finally {
    delete process.env.TEST_SESSION_ID;
    restore();
  }
});

test('upstream streams have a deadline and release with 504', async () => {
  const restore = setupFetchMock(() => {
    let timer: ReturnType<typeof setTimeout>;
    return new Response(new ReadableStream({
      start(controller) {
        timer = setTimeout(() => controller.close(), 100);
      },
      cancel() {
        clearTimeout(timer);
      }
    }), { status: 200 });
  });
  process.env.DEEPSPROXY_UPSTREAM_TIMEOUT_MS = '20';
  try {
    const started = Date.now();
    const response = await request({ model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'timeout' }], stream: false });
    assert.strictEqual(response.status, 504);
    assert.ok(Date.now() - started < 250);
  } finally {
    delete process.env.DEEPSPROXY_UPSTREAM_TIMEOUT_MS;
    restore();
  }
});

test('streaming timeout emits an OpenAI-compatible SSE error and releases cleanly', async () => {
  const restore = setupFetchMock(() => {
    let timer: ReturnType<typeof setTimeout>;
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: ready\ndata: {"response_message_id":17001}\n\n'));
        controller.enqueue(new TextEncoder().encode('data: {"p":"response/content","v":"partial"}\n\n'));
        timer = setTimeout(() => controller.close(), 100);
      },
      cancel() {
        clearTimeout(timer);
      }
    }), { status: 200 });
  });
  process.env.DEEPSPROXY_UPSTREAM_TIMEOUT_MS = '20';
  try {
    const response = await request({ model: 'deepseek-v4-pro', session_id: 'stream-timeout-key', messages: [{ role: 'user', content: 'timeout stream' }], stream: true });
    assert.strictEqual(response.status, 200);
    const text = await response.text();
    assert.match(text, /upstream_timeout/);
    assert.match(text, /data: \[DONE\]/);
  } finally {
    delete process.env.DEEPSPROXY_UPSTREAM_TIMEOUT_MS;
    restore();
  }
});

test('client cancellation cancels the upstream DeepSeek stream', async () => {
  let sourceController!: ReadableStreamDefaultController<Uint8Array>;
  let sourceCancelled = false;
  const restore = setupFetchMock(() => new Response(new ReadableStream({
    start(controller) {
      sourceController = controller;
      controller.enqueue(new TextEncoder().encode('event: ready\ndata: {"response_message_id":18001}\n\n'));
      controller.enqueue(new TextEncoder().encode('data: {"p":"response/content","v":"partial"}\n\n'));
    },
    cancel() {
      sourceCancelled = true;
    }
  }), { status: 200 }));

  try {
    const response = await request({
      model: 'deepseek-v4-pro', session_id: 'client-cancel-key',
      messages: [{ role: 'user', content: 'cancel stream' }], stream: true,
    });
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel('client disconnected');
    assert.strictEqual(sourceCancelled, true);
  } finally {
    if (!sourceCancelled) sourceController.close();
    restore();
  }
});

test('immediate response cancellation awaits upstream cancellation before releasing the session', async () => {
  let firstSourceCancelled = false;
  let cancellationFinished = false;
  let fetches = 0;
  let releaseCancellation!: () => void;
  let signalCancellationStarted!: () => void;
  let signalSecondFetch!: () => void;
  const cancellationGate = new Promise<void>(resolve => { releaseCancellation = resolve; });
  const cancellationStarted = new Promise<void>(resolve => { signalCancellationStarted = resolve; });
  const secondFetchStarted = new Promise<void>(resolve => { signalSecondFetch = resolve; });
  const restore = setupFetchMock(() => {
    fetches++;
    if (fetches > 1) {
      signalSecondFetch();
      return upstream(18002, 'second');
    }
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: ready\ndata: {"response_message_id":18001}\n\n'));
        controller.enqueue(new TextEncoder().encode('data: {"p":"response/content","v":"partial"}\n\n'));
      },
      async cancel() {
        firstSourceCancelled = true;
        signalCancellationStarted();
        await cancellationGate;
        cancellationFinished = true;
      }
    }), { status: 200 });
  });
  process.env.DEEPSPROXY_SESSION_LEASE_TIMEOUT_MS = '200';

  try {
    const first = await request({
      model: 'deepseek-v4-pro', session_id: 'immediate-cancel-key',
      messages: [{ role: 'user', content: 'cancel immediately' }], stream: true,
    });
    const cancellation = first.body!.cancel('cancel before read');
    await cancellationStarted;
    const secondRequest = request({
      model: 'deepseek-v4-pro', session_id: 'immediate-cancel-key',
      messages: [{ role: 'user', content: 'second request' }], stream: false,
    });
    const reachedUpstreamEarly = await Promise.race([
      secondFetchStarted.then(() => true),
      new Promise<false>(resolve => setImmediate(() => resolve(false))),
    ]);
    assert.strictEqual(reachedUpstreamEarly, false);
    releaseCancellation();
    await cancellation;
    const second = await secondRequest;
    assert.strictEqual(firstSourceCancelled, true);
    assert.strictEqual(cancellationFinished, true);
    assert.strictEqual(second.status, 200);
    assert.strictEqual(fetches, 2);
  } finally {
    releaseCancellation();
    delete process.env.DEEPSPROXY_SESSION_LEASE_TIMEOUT_MS;
    restore();
  }
});

test('invalid successful upstream status is normalized to 502', async () => {
  const restore = setupFetchMock(() => new Response(null, { status: 200 }));
  try {
    const response = await request({
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: 'missing upstream body' }], stream: false,
    });
    assert.strictEqual(response.status, 502);
  } finally {
    restore();
  }
});

test('session lease wait is bounded and returns 429 with Retry-After', async () => {
  const key = 'lease-timeout-key';
  const release = await acquireSessionLease(`explicit:${key}`);
  if (!release) throw new Error('Failed to acquire setup lease');
  process.env.DEEPSPROXY_SESSION_LEASE_TIMEOUT_MS = '20';
  try {
    const result = await Promise.race([
      request({
        model: 'deepseek-v4-pro', session_id: key,
        messages: [{ role: 'user', content: 'must not wait forever' }], stream: false,
      }),
      new Promise<'timed-out'>(resolve => setTimeout(() => resolve('timed-out'), 250)),
    ]);
    assert.notStrictEqual(result, 'timed-out');
    const response = result as Response;
    assert.strictEqual(response.status, 429);
    assert.strictEqual(response.headers.get('Retry-After'), '1');
  } finally {
    delete process.env.DEEPSPROXY_SESSION_LEASE_TIMEOUT_MS;
    release();
  }
});

test('non-loopback binding requires API_KEY', () => {
  assert.throws(() => assertSafeListenConfig('0.0.0.0', undefined), /API_KEY/);
  assert.doesNotThrow(() => assertSafeListenConfig('127.0.0.1', undefined));
  assert.doesNotThrow(() => assertSafeListenConfig('0.0.0.0', 'secret'));
});
