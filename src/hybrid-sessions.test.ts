import test from 'node:test';
import assert from 'node:assert';

process.env.TEST_MOCK_PLAYWRIGHT = 'true';

import { app } from './index.ts';

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
      if (content) {
        controller.enqueue(new TextEncoder().encode(`data: {"p":"response/content","v":${JSON.stringify(content)}}\n\n`));
      }
      controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
      controller.close();
    }
  }), { status: 200 });
}

async function request(body: Record<string, unknown>): Promise<Response> {
  return await app.fetch(new Request('http://localhost/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

test('edited assistant history does not reuse a lineage session', async () => {
  const payloads: any[] = [];
  const restore = setupFetchMock((_url, init) => {
    payloads.push(JSON.parse(init?.body as string || '{}'));
    return upstream(5000 + payloads.length, 'actual answer');
  });

  try {
    const firstUser = 'lineage-integrity-unique-user-message';
    process.env.TEST_SESSION_ID = 'lineage-session-a';
    assert.strictEqual((await request({
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: firstUser }],
      stream: false,
    })).status, 200);

    process.env.TEST_SESSION_ID = 'lineage-session-b';
    assert.strictEqual((await request({
      model: 'deepseek-v4-pro',
      messages: [
        { role: 'user', content: firstUser },
        { role: 'assistant', content: 'edited answer' },
        { role: 'user', content: 'next' },
      ],
      stream: false,
    })).status, 200);

    assert.strictEqual(payloads[1].chat_session_id, 'lineage-session-b');
    assert.strictEqual(payloads[1].parent_message_id, null);
  } finally {
    delete process.env.TEST_SESSION_ID;
    restore();
  }
});

test('concurrent bootstrap requests with the same explicit key are serialized', async () => {
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  let releaseFirst!: () => void;
  let signalFirst!: () => void;
  let signalSecond!: () => void;
  let firstReleased = false;
  let secondArrivedBeforeRelease = false;
  const firstEntered = new Promise<void>(resolve => { signalFirst = resolve; });
  const secondEntered = new Promise<void>(resolve => { signalSecond = resolve; });
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  const restore = setupFetchMock(async () => {
    calls++;
    const call = calls;
    active++;
    maxActive = Math.max(maxActive, active);
    if (call === 1) {
      signalFirst();
      await firstGate;
    } else if (call === 2) {
      secondArrivedBeforeRelease = !firstReleased;
      signalSecond();
    }
    active--;
    return upstream(6000 + call);
  });

  try {
    process.env.TEST_SESSION_ID = 'concurrent-bootstrap-session';
    const first = request({
      model: 'deepseek-v4-pro', session_id: 'concurrent-bootstrap-key',
      messages: [{ role: 'user', content: 'first' }], stream: false,
    });
    await firstEntered;
    const second = request({
      model: 'deepseek-v4-pro', session_id: 'concurrent-bootstrap-key',
      messages: [{ role: 'user', content: 'second' }], stream: false,
    });
    firstReleased = true;
    releaseFirst();
    await secondEntered;
    assert.strictEqual(secondArrivedBeforeRelease, false);
    assert.strictEqual(maxActive, 1);
    assert.strictEqual((await first).status, 200);
    assert.strictEqual((await second).status, 200);
  } finally {
    firstReleased = true;
    releaseFirst();
    delete process.env.TEST_SESSION_ID;
    restore();
  }
});

test('explicit session lock remains held until a streaming response is consumed', async () => {
  let calls = 0;
  let releaseStream!: () => void;
  let signalThird!: () => void;
  let streamClosed = false;
  let thirdArrivedBeforeStreamClosed = false;
  const streamGate = new Promise<void>(resolve => { releaseStream = resolve; });
  const thirdEntered = new Promise<void>(resolve => { signalThird = resolve; });
  const restore = setupFetchMock(() => {
    calls++;
    const call = calls;
    if (call === 3) {
      thirdArrivedBeforeStreamClosed = !streamClosed;
      signalThird();
    }
    if (call !== 2) return upstream(7000 + call);
    return new Response(new ReadableStream({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode(`event: ready\ndata: {"response_message_id":${7000 + call}}\n\n`));
        controller.enqueue(new TextEncoder().encode('data: {"p":"response/content","v":"ok"}\n\n'));
        await streamGate;
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        streamClosed = true;
        controller.close();
      }
    }), { status: 200 });
  });

  try {
    process.env.TEST_SESSION_ID = 'stream-lock-session';
    assert.strictEqual((await request({
      model: 'deepseek-v4-pro', session_id: 'stream-lock-key',
      messages: [{ role: 'user', content: 'seed' }], stream: false,
    })).status, 200);

    const streamResponse = await request({
      model: 'deepseek-v4-pro', session_id: 'stream-lock-key',
      messages: [{ role: 'user', content: 'slow stream' }], stream: true,
    });
    assert.strictEqual(streamResponse.status, 200);
    const consume = streamResponse.text();
    const queued = request({
      model: 'deepseek-v4-pro', session_id: 'stream-lock-key',
      messages: [{ role: 'user', content: 'must wait' }], stream: false,
    });
    releaseStream();
    await consume;
    await thirdEntered;
    assert.strictEqual(thirdArrivedBeforeStreamClosed, false, 'Queued request reached DeepSeek before the stream finished');
    assert.strictEqual((await queued).status, 200);
    assert.strictEqual(calls, 3);
  } finally {
    releaseStream();
    delete process.env.TEST_SESSION_ID;
    restore();
  }
});

test('initial stream publishes a locked session before exposing its session header', async () => {
  let calls = 0;
  let firstClosed = false;
  let secondArrivedBeforeFirstClosed = false;
  let signalSecond!: () => void;
  let releaseFirst!: () => void;
  const secondEntered = new Promise<void>(resolve => { signalSecond = resolve; });
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  const restore = setupFetchMock(() => {
    calls++;
    const call = calls;
    if (call > 1) {
      secondArrivedBeforeFirstClosed = !firstClosed;
      signalSecond();
      return upstream(7500 + call, 'second');
    }
    return new Response(new ReadableStream({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode('event: ready\ndata: {"response_message_id":7501}\n\n'));
        controller.enqueue(new TextEncoder().encode('data: {"p":"response/content","v":"first"}\n\n'));
        await firstGate;
        firstClosed = true;
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        controller.close();
      }
    }), { status: 200 });
  });

  try {
    process.env.TEST_SESSION_ID = 'initial-stream-session';
    const firstResponse = await request({
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: 'initial stream' }], stream: true,
    });
    const exposedSessionId = firstResponse.headers.get('x-deeps-session');
    assert.strictEqual(exposedSessionId, 'initial-stream-session');
    const firstConsume = firstResponse.text();
    const secondRequest = request({
      model: 'deepseek-v4-pro', session_id: exposedSessionId,
      messages: [{ role: 'user', content: 'follow immediately' }], stream: false,
    });
    const reachedEarly = await Promise.race([
      secondEntered.then(() => true),
      new Promise<false>(resolve => setImmediate(() => resolve(false))),
    ]);
    assert.strictEqual(reachedEarly, false);
    releaseFirst();
    await firstConsume;
    await secondEntered;
    assert.strictEqual((await secondRequest).status, 200);
    assert.strictEqual(secondArrivedBeforeFirstClosed, false);
    assert.strictEqual(calls, 2);
  } finally {
    releaseFirst();
    delete process.env.TEST_SESSION_ID;
    restore();
  }
});

test('metadata-only DeepSeek streams retry and return an error instead of HTTP 200', async () => {
  let attempts = 0;
  const restore = setupFetchMock(() => upstream(8000 + ++attempts, ''));

  try {
    process.env.TEST_SESSION_ID = 'metadata-only-session';
    const response = await request({
      model: 'deepseek-v4-pro', session_id: 'metadata-only-key',
      messages: [{ role: 'user', content: 'test' }], stream: true,
    });
    assert.strictEqual(response.status, 500);
    assert.strictEqual(attempts, 3);
  } finally {
    delete process.env.TEST_SESSION_ID;
    restore();
  }
});

test('login failures retain their OpenAI-compatible HTTP status', async () => {
  let attempts = 0;
  const restore = setupFetchMock(() => {
    attempts++;
    throw new Error('DeepSeek login is required; chat input is unavailable.');
  });
  try {
    const response = await request({
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: 'test' }],
      stream: false,
    });
    assert.strictEqual(response.status, 401);
    assert.strictEqual(attempts, 1);
  } finally {
    restore();
  }
});
