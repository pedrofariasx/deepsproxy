import test from 'node:test';
import assert from 'node:assert';

process.env.TEST_MOCK_PLAYWRIGHT = 'true';

import { app } from './index.ts';

function setupFetchMock(factory: () => Response) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : ('url' in input ? input.url : String(input));
    if (url.includes('chat.deepseek.com')) return factory();
    return originalFetch(input, init);
  };
  return () => { globalThis.fetch = originalFetch; };
}

async function request(stream: boolean): Promise<Response> {
  return await app.fetch(new Request('http://localhost/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4-pro-thinking',
      session_id: `semantic-${stream ? 'stream' : 'nonstream'}`,
      messages: [{ role: 'user', content: 'test' }],
      stream,
    }),
  }));
}

test('non-stream reasoning-only response is accepted as semantic output', async () => {
  const restore = setupFetchMock(() => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('event: ready\ndata: {"response_message_id":12001}\n\n'));
      controller.enqueue(new TextEncoder().encode('data: {"p":"response/thinking_content","v":"reasoning only"}\n\n'));
      controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
      controller.close();
    }
  }), { status: 200 }));

  try {
    const response = await request(false);
    assert.strictEqual(response.status, 200);
    const body = await response.json();
    assert.strictEqual(body.choices[0].message.reasoning_content, 'reasoning only');
  } finally {
    restore();
  }
});

test('all fragments in one DeepSeek SSE update are parsed', async () => {
  const restore = setupFetchMock(() => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('event: ready\ndata: {"response_message_id":12002}\n\n'));
      controller.enqueue(new TextEncoder().encode('data: {"v":{"response":{"fragments":[{"type":"THINK","content":"reasoning"},{"type":"RESPONSE","content":"later answer"}]}}}\n\n'));
      controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
      controller.close();
    }
  }), { status: 200 }));

  try {
    const response = await request(true);
    assert.strictEqual(response.status, 200);
    const text = await response.text();
    assert.match(text, /reasoning_content/);
    assert.match(text, /later answer/);
  } finally {
    restore();
  }
});
