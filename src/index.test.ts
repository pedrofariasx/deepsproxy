import test from 'node:test';
import assert from 'node:assert';
import { app, resolveListenHost } from './index.ts';

test('Server binds to loopback by default and allows an explicit host override', () => {
  assert.strictEqual(resolveListenHost(undefined), '127.0.0.1');
  assert.strictEqual(resolveListenHost('0.0.0.0'), '0.0.0.0');
});

test('Health check endpoint returns status ok', async () => {
  const req = new Request('http://localhost/health');
  const res = await app.fetch(req);
  
  assert.strictEqual(res.status, 200);
  
  const body = await res.json();
  assert.deepStrictEqual(body, { status: 'ok' });
});

test('Models endpoint returns deepseek-v4-flash and deepseek-v4-flash-thinking', async () => {
  const req = new Request('http://localhost/v1/models');
  const res = await app.fetch(req);
  
  assert.strictEqual(res.status, 200);
  
  const body = await res.json();
  assert.strictEqual(body.object, 'list');
  assert.ok(Array.isArray(body.data));
  assert.ok(body.data.some((m: any) => m.id === 'deepseek-v4-flash'));
  assert.ok(body.data.some((m: any) => m.id === 'deepseek-v4-flash-thinking'));
  const flash = body.data.find((m: any) => m.id === 'deepseek-v4-flash');
  const pro = body.data.find((m: any) => m.id === 'deepseek-v4-pro');
  assert.strictEqual(flash.context_length, 1_000_000);
  assert.strictEqual(flash.max_context_tokens, 1_000_000);
  assert.strictEqual(pro.context_length, 1_000_000);
  assert.strictEqual(pro.max_context_tokens, 1_000_000);
});

test('Chat Completions maps DeepSeek thinking and content chunks deterministically', async () => {
  const originalFetch = globalThis.fetch;
  process.env.TEST_MOCK_PLAYWRIGHT = 'true';
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('chat.deepseek.com/api/v0/chat/completion')) {
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('event: ready\ndata: {"response_message_id":4101}\n\n'));
          controller.enqueue(new TextEncoder().encode('data: {"p":"response/thinking_content","v":"reasoning"}\n\n'));
          controller.enqueue(new TextEncoder().encode('data: {"p":"response/content","v":"answer"}\n\n'));
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          controller.close();
        }
      }), { status: 200 });
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  try {
    const payload = {
      model: 'deepseek-v4-flash-thinking',
      messages: [{ role: 'user', content: 'What is 99 * 182? Please think step by step.' }],
      stream: true
    };

    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('Content-Type'), 'text/event-stream');

    const reader = res.body?.getReader();
    assert.ok(reader, 'Response should have a readable body');

    const decoder = new TextDecoder();
    let hasReasoning = false;
    let hasContent = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      const lines = chunk.split('\n');
      
      for (const line of lines) {
        if (line.trim() === 'data: [DONE]') {
          break;
        }
        if (line.startsWith('data: ')) {
          try {
            const dataStr = line.slice(6);
            if (dataStr !== '[DONE]') {
              const data = JSON.parse(dataStr);
              
              if (data.choices && data.choices[0] && data.choices[0].delta) {
              const delta = data.choices[0].delta;
              if (delta.content) {
                hasContent = true;
              }
                if (delta.reasoning_content) {
                  hasReasoning = true;
                }
              }
            }
          } catch (err) {
            // Partial JSON ignored
            // console.error("Parse error:", err);
          }
        }
      }
    }

    assert.ok(hasReasoning, 'Should have received streamed chunks with reasoning_content (Thinking enabled)');
    assert.ok(hasContent, 'Should have received streamed chunks with content');
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.TEST_MOCK_PLAYWRIGHT;
  }
});
