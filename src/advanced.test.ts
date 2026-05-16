import test from 'node:test';
import assert from 'node:assert';

process.env.TEST_MOCK_PLAYWRIGHT = 'true';
process.env.ZAI_ANONYMOUS = 'false'; // Disable Z.ai in tests to avoid network calls

// Initialize router before importing app
import { router } from './providers/router.ts';
await router.initialize();

import { app } from './index.ts';

// Helper to mock the fetch global for testing
function setupFetchMock(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof input === 'string' ? input : ('url' in input ? input.url : String(input));
    if (urlStr.includes('chat.deepseek.com')) {
      return handler(urlStr, init);
    }
    return originalFetch(input, init);
  };
  return () => { globalThis.fetch = originalFetch; };
}

test('multiturn-thinking-tools: maintains reasoning_content history', async () => {
  let capturedPrompt = '';

  const restore = setupFetchMock((url, init) => {
    const bodyObj = JSON.parse(init?.body as string || '{}');
    capturedPrompt = bodyObj.prompt;
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        c.close();
      }
    });
    return new Response(stream, { status: 200 });
  });

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-flash-thinking',
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'doing something', reasoning_content: 'thinking about hello', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'test', arguments: '{}' } }] },
          { role: 'tool', name: 'test', content: 'success' }
        ]
      })
    });
    
    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);

    assert.ok(capturedPrompt.includes('Tool Response (test): success'), 'Must include tool response signature');
    assert.ok(!capturedPrompt.includes('<think>\nthinking about hello\n</think>'), 'Should not include previous thinking');
    assert.ok(!capturedPrompt.includes('<tool_call>{"name": "test", "arguments": {}}</tool_call>'), 'Should not include previous tool call');
  } finally {
    restore();
  }
});

test('streaming-whitespace: preserves exact whitespace', async () => {
  const restore = setupFetchMock((url) => {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"v":{"response":{"message_id":1}}}\n\n'));
        c.enqueue(new TextEncoder().encode('data: {"p":"response/content","v":"   "}\n\n'));
        c.enqueue(new TextEncoder().encode('data: {"o":"APPEND","v":"  hello  "}\n\n'));
        c.enqueue(new TextEncoder().encode('data: {"o":"APPEND","v":"\\n\\n  "}\n\n'));
        c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        c.close();
      }
    });
    return new Response(stream, { status: 200 });
  });

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-flash-thinking', messages: [{role: 'user', content: 'test'}], stream: true })
    });
    
    const res = await app.fetch(req);
    const reader = res.body?.getReader();
    const decoder = new TextDecoder();
    let full = '';
    while (true) {
      const { done, value } = await reader!.read();
      if (done) break;
      const chunk = decoder.decode(value);
      for (const line of chunk.split('\n')) {
        if (line.startsWith('data: ') && line !== 'data: [DONE]') {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.choices?.[0]?.delta?.content) {
              full += data.choices[0].delta.content;
            }
          } catch(e) {}
        }
      }
    }
    
    assert.strictEqual(full, "     hello  \n\n  ");
  } finally {
    restore();
  }
});

test('caching-streaming and cache-control: returns prompt_tokens_details', async () => {
  const restore = setupFetchMock((url) => {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"v":{"response":{"message_id":1}}}\n\n'));
        c.enqueue(new TextEncoder().encode('data: {"p":"response/content","v":"done"}\n\n'));
        c.enqueue(new TextEncoder().encode('data: {"p":"response/accumulated_token_usage","o":"SET","v":10}\n\n'));
        c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        c.close();
      }
    });
    return new Response(stream, { status: 200 });
  });

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-flash-thinking', messages: [{role: 'user', content: 'test'}], stream: true })
    });
    
    const res = await app.fetch(req);
    const reader = res.body?.getReader();
    const decoder = new TextDecoder();
    let usageBlock = null;
    while (true) {
      const { done, value } = await reader!.read();
      if (done) break;
      const chunk = decoder.decode(value);
      for (const line of chunk.split('\n')) {
        if (line.startsWith('data: ') && line !== 'data: [DONE]') {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.usage) {
              usageBlock = data.usage;
            }
          } catch(e) {}
        }
      }
    }
    
    assert.ok(usageBlock);
    assert.strictEqual(usageBlock.completion_tokens, 10);
    assert.ok(usageBlock.prompt_tokens > 0);
    assert.strictEqual(usageBlock.prompt_tokens_details.cached_tokens, 0);
  } finally {
    restore();
  }
});

test('session-parent-tracking: appends messages using response message_id as parent', async () => {
  let capturedPayloads: any[] = [];

  const restore = setupFetchMock((url, init) => {
    const bodyObj = JSON.parse(init?.body as string || '{}');
    capturedPayloads.push(bodyObj);
    
    const mockMessageId = capturedPayloads.length === 1 ? 1001 : 1002;
    
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(`data: {"v":{"response":{"message_id":${mockMessageId}}}}\n\n`));
        c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        c.close();
      }
    });
    return new Response(stream, { status: 200 });
  });

  try {
    process.env.TEST_SESSION_ID = 'test-session-parent-tracking';
    const req1 = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-flash-thinking',
        messages: [{ role: 'user', content: 'Turn 1' }]
      })
    });
    
    const res1 = await app.fetch(req1);
    assert.strictEqual(res1.status, 200);
    await res1.text();

    const req2 = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-flash-thinking',
        messages: [
          { role: 'user', content: 'Turn 1' },
          { role: 'assistant', content: 'Response 1' },
          { role: 'user', content: 'Turn 2' }
        ]
      })
    });
    
    const res2 = await app.fetch(req2);
    assert.strictEqual(res2.status, 200);
    await res2.text();

    assert.strictEqual(capturedPayloads.length, 2);
    assert.strictEqual(capturedPayloads[0].parent_message_id, null);
    assert.strictEqual(capturedPayloads[1].parent_message_id, 1001, 'Turn 2 should use message_id from Turn 1 as parent');
    assert.strictEqual(capturedPayloads[1].prompt, 'User: Turn 2\n\n', 'Should only send the last message');
  } finally {
    restore();
  }
});

// ─── Non-Streaming (stream=false) Tests ────────────────────────────────────────

test('non-streaming: returns chat.completion JSON with application/json', async () => {
  const restore = setupFetchMock((url) => {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"v":{"response":{"message_id":1}}}\n\n'));
        c.enqueue(new TextEncoder().encode('data: {"p":"response/content","v":"Hello "}\n\n'));
        c.enqueue(new TextEncoder().encode('data: {"o":"APPEND","v":"world!"}\n\n'));
        c.enqueue(new TextEncoder().encode('data: {"p":"response/accumulated_token_usage","o":"SET","v":5}\n\n'));
        c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        c.close();
      }
    });
    return new Response(stream, { status: 200 });
  });

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: 'Hi' }],
        stream: false
      })
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);

    const body = await res.json();

    assert.strictEqual(body.object, 'chat.completion', 'object must be chat.completion');
    assert.ok(body.id.startsWith('chatcmpl-'), 'id must start with chatcmpl-');
    assert.strictEqual(body.model, 'deepseek-v4-flash');
    assert.ok(Array.isArray(body.choices), 'choices must be an array');
    assert.strictEqual(body.choices.length, 1);

    const choice = body.choices[0];
    assert.ok(choice.message, 'Non-streaming response must have "message"');
    assert.strictEqual(choice.message.role, 'assistant');
    assert.strictEqual(choice.message.content, 'Hello world!');
    assert.strictEqual(choice.finish_reason, 'stop');

    assert.ok(body.usage);
    assert.strictEqual(body.usage.completion_tokens, 5);
    assert.ok(body.usage.prompt_tokens > 0);
  } finally {
    restore();
  }
});

test('non-streaming: accumulates tool_calls correctly', async () => {
  const restore = setupFetchMock((url) => {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"v":{"response":{"message_id":2}}}\n\n'));
        c.enqueue(new TextEncoder().encode('data: {"p":"response/content","v":"<tool_call>"}\n\n'));
        c.enqueue(new TextEncoder().encode('data: {"o":"APPEND","v":"{\\"name\\": \\"get_weather\\", \\"arguments\\": {\\"location\\": \\"São Paulo\\"}}"}\n\n'));
        c.enqueue(new TextEncoder().encode('data: {"o":"APPEND","v":"</tool_call>"}\n\n'));
        c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        c.close();
      }
    });
    return new Response(stream, { status: 200 });
  });

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: 'Weather?' }],
        stream: false
      })
    });

    const res = await app.fetch(req);
    const body = await res.json();

    assert.strictEqual(body.object, 'chat.completion');
    assert.strictEqual(body.choices[0].finish_reason, 'tool_calls');

    const message = body.choices[0].message;
    assert.ok(message.tool_calls, 'message must contain tool_calls');
    assert.strictEqual(message.tool_calls.length, 1);
    assert.strictEqual(message.tool_calls[0].type, 'function');
    assert.strictEqual(message.tool_calls[0].function.name, 'get_weather');

    const args = JSON.parse(message.tool_calls[0].function.arguments);
    assert.strictEqual(args.location, 'São Paulo');
  } finally {
    restore();
  }
});

test('non-streaming: includes reasoning_content for thinking models', async () => {
  const restore = setupFetchMock((url) => {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"v":{"response":{"message_id":3}}}\n\n'));
        c.enqueue(new TextEncoder().encode('data: {"p":"response/thinking_content","v":"Let me think..."}\n\n'));
        c.enqueue(new TextEncoder().encode('data: {"p":"response/content","v":"The answer is 42."}\n\n'));
        c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        c.close();
      }
    });
    return new Response(stream, { status: 200 });
  });

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-flash-thinking',
        messages: [{ role: 'user', content: 'What is the meaning of life?' }],
        stream: false
      })
    });

    const res = await app.fetch(req);
    const body = await res.json();

    assert.strictEqual(body.object, 'chat.completion');
    const message = body.choices[0].message;
    assert.strictEqual(message.content, 'The answer is 42.');
    assert.strictEqual(message.reasoning_content, 'Let me think...');
    assert.strictEqual(body.choices[0].finish_reason, 'stop');
  } finally {
    restore();
  }
});

// ─── Provider Isolation Tests ──────────────────────────────────────────────────

test('router: unknown model returns 400 with helpful error', async () => {
  const req = new Request('http://localhost/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'nonexistent-model-xyz',
      messages: [{ role: 'user', content: 'test' }],
    })
  });

  const res = await app.fetch(req);
  assert.strictEqual(res.status, 400);

  const body = await res.json();
  assert.ok(body.error.message.includes('No provider found'), 'Error should mention no provider found');
  assert.strictEqual(body.error.type, 'provider_error');
});

test('health endpoint includes provider status', async () => {
  const req = new Request('http://localhost/health');
  const res = await app.fetch(req);
  assert.strictEqual(res.status, 200);

  const body = await res.json();
  assert.strictEqual(body.status, 'ok');
  assert.ok(body.providers, 'Health response should include providers');
  assert.ok(body.providers.deepseek, 'Should have deepseek provider status');
});

test('provider-status endpoint includes aliases and provider diagnostics', async () => {
  const req = new Request('http://localhost/v1/provider-status');
  const res = await app.fetch(req);
  assert.strictEqual(res.status, 200);

  const body = await res.json();
  assert.ok(body.providers.deepseek, 'Should include deepseek diagnostics');
  assert.ok(body.providers.zai, 'Should include zai diagnostics');
  assert.ok(body.aliases['cheap-coder'], 'Should expose default aliases');
});

test('models endpoint aggregates from all providers', async () => {
  const req = new Request('http://localhost/v1/models');
  const res = await app.fetch(req);
  assert.strictEqual(res.status, 200);

  const body = await res.json();
  assert.strictEqual(body.object, 'list');
  assert.ok(Array.isArray(body.data));
  // At minimum, DeepSeek models should be present
  assert.ok(body.data.some((m: any) => m.id === 'deepseek-v4-flash'), 'Should have deepseek-v4-flash');
  assert.ok(body.data.some((m: any) => m.id === 'deepseek-v4-flash-thinking'), 'Should have deepseek-v4-flash-thinking');
});

test('router alias fallback: deepseek retryable failure falls back to Z.ai mock', async () => {
  const restore = setupFetchMock(() => new Response('upstream unavailable', { status: 503 }));

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'cheap-coder',
        messages: [{ role: 'user', content: 'test fallback' }],
        stream: false,
      })
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('X-Provider-Used'), 'zai');
    assert.strictEqual(res.headers.get('X-Provider-Fallback'), 'true');

    const body = await res.json();
    assert.strictEqual(body.choices[0].message.content, 'mock zai response');
  } finally {
    restore();
  }
});

test('router alias fallback: bad_request does not fall back to next provider', async () => {
  const restore = setupFetchMock(() => new Response('bad request', { status: 400 }));

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'cheap-coder',
        messages: [{ role: 'user', content: 'bad request should not fallback' }],
        stream: false,
      })
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 400);

    const body = await res.json();
    assert.strictEqual(body.error.type, 'provider_error');
    assert.ok(body.error.message.includes('DeepSeek'));
  } finally {
    restore();
  }
});
