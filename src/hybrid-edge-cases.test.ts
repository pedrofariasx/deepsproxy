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

function upstream(messageId: number | null, content = 'ok'): Response {
  return new Response(new ReadableStream({
    start(controller) {
      if (messageId !== null) {
        controller.enqueue(new TextEncoder().encode(`event: ready\ndata: {"response_message_id":${messageId}}\n\n`));
      }
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

test('lineage continuation sends every turn after the exact matched prefix', async () => {
  const payloads: any[] = [];
  const restore = setupFetchMock((_url, init) => {
    payloads.push(JSON.parse(init?.body as string || '{}'));
    return upstream(9000 + payloads.length, payloads.length === 1 ? 'a1' : payloads.length === 2 ? 'a2' : 'a3');
  });
  const u1 = 'prefix-integrity-u1';

  try {
    process.env.TEST_SESSION_ID = 'prefix-integrity-session';
    assert.strictEqual((await request({ model: 'deepseek-v4-pro', messages: [{ role: 'user', content: u1 }], stream: false })).status, 200);
    assert.strictEqual((await request({
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: u1 }, { role: 'assistant', content: 'a1' }, { role: 'user', content: 'u2' }],
      stream: false,
    })).status, 200);
    assert.strictEqual((await request({
      model: 'deepseek-v4-pro',
      messages: [
        { role: 'user', content: u1 },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'u2' },
        { role: 'assistant', content: 'edited a2' },
        { role: 'user', content: 'u3' },
      ],
      stream: false,
    })).status, 200);

    assert.match(payloads[2].prompt, /User: u2/);
    assert.match(payloads[2].prompt, /Assistant: edited a2/);
    assert.match(payloads[2].prompt, /User: u3/);
  } finally {
    delete process.env.TEST_SESSION_ID;
    restore();
  }
});

test('explicit and lineage aliases for one chat share the same lock', async () => {
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  let releaseFirstConcurrent!: () => void;
  let signalFirstConcurrent!: () => void;
  let signalSecondConcurrent!: () => void;
  let firstConcurrentReleased = false;
  let secondArrivedBeforeRelease = false;
  const firstConcurrentEntered = new Promise<void>(resolve => { signalFirstConcurrent = resolve; });
  const secondConcurrentEntered = new Promise<void>(resolve => { signalSecondConcurrent = resolve; });
  const gate = new Promise<void>(resolve => { releaseFirstConcurrent = resolve; });
  const restore = setupFetchMock(async () => {
    calls++;
    const call = calls;
    if (call >= 2) {
      active++;
      maxActive = Math.max(maxActive, active);
      if (call === 2) {
        signalFirstConcurrent();
        await gate;
      } else {
        secondArrivedBeforeRelease = !firstConcurrentReleased;
        signalSecondConcurrent();
      }
      active--;
    }
    return upstream(10000 + call, 'seed answer');
  });

  try {
    process.env.TEST_SESSION_ID = 'alias-lock-session';
    const seedUser = 'alias-lock-seed-user';
    assert.strictEqual((await request({
      model: 'deepseek-v4-pro', session_id: 'alias-lock-explicit',
      messages: [{ role: 'user', content: seedUser }], stream: false,
    })).status, 200);

    const explicit = request({
      model: 'deepseek-v4-pro', session_id: 'alias-lock-explicit',
      messages: [{ role: 'user', content: 'explicit continuation' }], stream: false,
    });
    await firstConcurrentEntered;
    const lineage = request({
      model: 'deepseek-v4-pro',
      messages: [
        { role: 'user', content: seedUser },
        { role: 'assistant', content: 'seed answer' },
        { role: 'user', content: 'lineage continuation' },
      ],
      stream: false,
    });
    firstConcurrentReleased = true;
    releaseFirstConcurrent();
    await secondConcurrentEntered;
    assert.strictEqual(secondArrivedBeforeRelease, false);
    assert.strictEqual(maxActive, 1);
    assert.strictEqual((await explicit).status, 200);
    assert.strictEqual((await lineage).status, 200);
  } finally {
    firstConcurrentReleased = true;
    releaseFirstConcurrent();
    delete process.env.TEST_SESSION_ID;
    restore();
  }
});

test('oversized explicit session keys are not retained', async () => {
  const payloads: any[] = [];
  const restore = setupFetchMock((_url, init) => {
    payloads.push(JSON.parse(init?.body as string || '{}'));
    return upstream(11000 + payloads.length);
  });
  const oversized = 'x'.repeat(1024);

  try {
    process.env.TEST_SESSION_ID = 'oversized-key-session-a';
    assert.strictEqual((await request({ model: 'deepseek-v4-pro', session_id: oversized, messages: [{ role: 'user', content: 'one' }], stream: false })).status, 200);
    process.env.TEST_SESSION_ID = 'oversized-key-session-b';
    assert.strictEqual((await request({ model: 'deepseek-v4-pro', session_id: oversized, messages: [{ role: 'user', content: 'two' }], stream: false })).status, 200);
    assert.strictEqual(payloads[1].chat_session_id, 'oversized-key-session-b');
    assert.strictEqual(payloads[1].parent_message_id, null);
  } finally {
    delete process.env.TEST_SESSION_ID;
    restore();
  }
});

test('a valid response without response_message_id is not registered for continuation', async () => {
  const payloads: any[] = [];
  const restore = setupFetchMock((_url, init) => {
    payloads.push(JSON.parse(init?.body as string || '{}'));
    return upstream(null);
  });

  try {
    process.env.TEST_SESSION_ID = 'missing-id-session-a';
    assert.strictEqual((await request({ model: 'deepseek-v4-pro', session_id: 'missing-id-key', messages: [{ role: 'user', content: 'one' }], stream: false })).status, 200);
    process.env.TEST_SESSION_ID = 'missing-id-session-b';
    assert.strictEqual((await request({ model: 'deepseek-v4-pro', session_id: 'missing-id-key', messages: [{ role: 'user', content: 'two' }], stream: false })).status, 200);
    assert.strictEqual(payloads[1].chat_session_id, 'missing-id-session-b');
    assert.strictEqual(payloads[1].parent_message_id, null);
  } finally {
    delete process.env.TEST_SESSION_ID;
    restore();
  }
});

test('branching from an older lineage uses that lineage parent', async () => {
  const payloads: any[] = [];
  const restore = setupFetchMock((_url, init) => {
    payloads.push(JSON.parse(init?.body as string || '{}'));
    const call = payloads.length;
    return upstream(16000 + call, call === 1 ? 'a1' : call === 2 ? 'a2' : 'branch answer');
  });
  try {
    process.env.TEST_SESSION_ID = 'versioned-lineage-session';
    const u1 = 'versioned-lineage-u1';
    assert.strictEqual((await request({ model: 'deepseek-v4-pro', messages: [{ role: 'user', content: u1 }], stream: false })).status, 200);
    assert.strictEqual((await request({
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: u1 }, { role: 'assistant', content: 'a1' }, { role: 'user', content: 'u2' }],
      stream: false,
    })).status, 200);
    assert.strictEqual((await request({
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: u1 }, { role: 'assistant', content: 'a1' }, { role: 'user', content: 'branch from h1' }],
      stream: false,
    })).status, 200);
    assert.strictEqual(payloads[1].parent_message_id, 16001);
    assert.strictEqual(payloads[2].parent_message_id, 16001, 'Branch must use the parent stored for H1, not the latest chat parent');
  } finally {
    delete process.env.TEST_SESSION_ID;
    restore();
  }
});

test('upstream HTTP status is propagated through the OpenAI-compatible endpoint', async () => {
  let attempts = 0;
  const restore = setupFetchMock(() => {
    attempts++;
    return new Response('{"error":"rate limited"}', { status: 429, statusText: 'Too Many Requests' });
  });
  try {
    const response = await request({ model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'test' }], stream: false });
    assert.strictEqual(response.status, 429);
    assert.strictEqual(attempts, 1);
  } finally {
    restore();
  }
});
