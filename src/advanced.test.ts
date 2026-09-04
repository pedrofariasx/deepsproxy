import test from 'node:test';
import assert from 'node:assert';

process.env.TEST_MOCK_PLAYWRIGHT = 'true';

import { app } from './index.ts';

// Helper to mock the fetch global for testing empty response retry and caching logic
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

test('multiturn-thinking-tools: serializes complete OpenAI message history', async () => {
  let capturedPrompt = '';

  const restore = setupFetchMock((url, init) => {
    const bodyObj = JSON.parse(init?.body as string || '{}');
    capturedPrompt = bodyObj.prompt;
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"p":"response/content","v":"hello"}\n\n'));
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

    // Validate that the complete OpenAI history is sent to DeepSeek. Agents
    // need the original user request, assistant tool call, and tool result to
    // produce the post-tool final answer.
    assert.ok(capturedPrompt.includes('User: hello'), 'Must include original user message');
    assert.ok(capturedPrompt.includes('Assistant:'), 'Must include assistant history');
    assert.ok(capturedPrompt.includes('<think>\nthinking about hello\n</think>'), 'Must include previous thinking');
    assert.ok(capturedPrompt.includes('<tool_call>{"name": "test", "arguments": {}}</tool_call>'), 'Must include previous tool call');
    assert.ok(capturedPrompt.includes('Tool Response (test): success'), 'Must include tool response signature');
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
    
    // We expect exactly: "     hello  \n\n  "
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
    assert.strictEqual(usageBlock.prompt_tokens_details.cached_tokens, 0); // Tests caching-streaming shape!
  } finally {
    restore();
  }
});

test('matching OpenAI history reuses the DeepSeek session and sends only the new turn', async () => {
  let capturedPayloads: any[] = [];

  const restore = setupFetchMock((url, init) => {
    const bodyObj = JSON.parse(init?.body as string || '{}');
    capturedPayloads.push(bodyObj);
    
    // Simulate DeepSeek returning a message_id
    const mockMessageId = capturedPayloads.length === 1 ? 1001 : 1002;
    
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(`data: {"v":{"response":{"message_id":${mockMessageId}}}}\n\n`));
        c.enqueue(new TextEncoder().encode('data: {"p":"response/content","v":"hello"}\n\n'));
        c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        c.close();
      }
    });
    return new Response(stream, { status: 200 });
  });

  try {
    process.env.TEST_SESSION_ID = 'test-session-parent-tracking';
    // Turn 1
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
    // Consume the stream to ensure the message_id is processed
    await res1.text();

    // Turn 2
    const req2 = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-flash-thinking',
        messages: [
          { role: 'user', content: 'Turn 1' },
          { role: 'assistant', content: 'hello' },
          { role: 'user', content: 'Turn 2' }
        ]
      })
    });
    
    const res2 = await app.fetch(req2);
    assert.strictEqual(res2.status, 200);
    await res2.text();

    assert.strictEqual(capturedPayloads.length, 2);
    // In Turn 1, parent_message_id should be null (mock-session is fresh)
    assert.strictEqual(capturedPayloads[0].parent_message_id, null);
    // The second OpenAI history extends the first request, so the proxy should
    // reuse DeepSeek's server-side chat and thread from the first response.
    assert.strictEqual(capturedPayloads[1].chat_session_id, capturedPayloads[0].chat_session_id);
    assert.strictEqual(capturedPayloads[1].parent_message_id, 1001, 'Turn 2 should thread from the prior DeepSeek response');
    assert.strictEqual(
      capturedPayloads[1].prompt,
      'User: Turn 2\n\n',
      'Should send only the new turn once DeepSeek already owns the earlier history'
    );
  } finally {
    restore();
  }
});

test('explicit session_id continues a DeepSeek session without replaying history', async () => {
  const capturedPayloads: any[] = [];
  const restore = setupFetchMock((_url, init) => {
    capturedPayloads.push(JSON.parse(init?.body as string || '{}'));
    const messageId = capturedPayloads.length === 1 ? 2101 : 2102;
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: {"v":{"response":{"message_id":${messageId}}}}\n\n`));
        controller.enqueue(new TextEncoder().encode('data: {"p":"response/content","v":"ok"}\n\n'));
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        controller.close();
      }
    }), { status: 200 });
  });

  try {
    process.env.TEST_SESSION_ID = 'explicit-user-deepseek-chat';
    const first = await app.fetch(new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-pro',
        session_id: 'hermes-session-42',
        messages: [{ role: 'user', content: 'First turn' }],
        stream: false,
      })
    }));
    assert.strictEqual(first.status, 200);

    const second = await app.fetch(new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-pro',
        session_id: 'hermes-session-42',
        messages: [{ role: 'user', content: 'Second turn only' }],
        stream: false,
      })
    }));
    assert.strictEqual(second.status, 200);

    assert.strictEqual(capturedPayloads[1].chat_session_id, capturedPayloads[0].chat_session_id);
    assert.strictEqual(capturedPayloads[1].parent_message_id, 2101);
    assert.strictEqual(capturedPayloads[1].prompt, 'User: Second turn only\n\n');
  } finally {
    delete process.env.TEST_SESSION_ID;
    restore();
  }
});

test('DeepSeek Pro disables web search because Expert mode does not support it', async () => {
  let capturedPayload: any = null;
  const restore = setupFetchMock((_url, init) => {
    capturedPayload = JSON.parse(init?.body as string || '{}');
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"v":{"response":{"message_id":2201}}}\n\n'));
        controller.enqueue(new TextEncoder().encode('data: {"p":"response/content","v":"ok"}\n\n'));
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        controller.close();
      }
    }), { status: 200 });
  });

  try {
    process.env.TEST_SESSION_ID = 'expert-search-disabled';
    const response = await app.fetch(new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-pro',
        messages: [{ role: 'user', content: 'test' }],
        stream: false,
      })
    }));

    assert.strictEqual(response.status, 200);
    assert.strictEqual(capturedPayload.search_enabled, false);
  } finally {
    delete process.env.TEST_SESSION_ID;
    restore();
  }
});

test('empty retry does not advance the DeepSeek parent before a valid response', async () => {
  const capturedPayloads: any[] = [];
  const restore = setupFetchMock((_url, init) => {
    capturedPayloads.push(JSON.parse(init?.body as string || '{}'));
    const attempt = capturedPayloads.length;
    const messageId = attempt === 1 ? 3000 : attempt === 2 ? 3101 : attempt === 3 ? 3102 : 3103;
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`event: ready\ndata: {"response_message_id":${messageId}}\n\n`));
        if (attempt !== 2) {
          controller.enqueue(new TextEncoder().encode('data: {"p":"response/content","v":"ok"}\n\n'));
        }
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        controller.close();
      }
    }), { status: 200 });
  });

  const request = (content: string) => app.fetch(new Request('http://localhost/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4-pro',
      session_id: 'empty-parent-retry-key',
      messages: [{ role: 'user', content }],
      stream: false,
    })
  }));

  try {
    process.env.TEST_SESSION_ID = 'empty-parent-retry-session';
    assert.strictEqual((await request('seed')).status, 200);
    assert.strictEqual((await request('retry me')).status, 200);
    assert.strictEqual((await request('after retry')).status, 200);

    assert.strictEqual(capturedPayloads[0].parent_message_id, null);
    assert.strictEqual(capturedPayloads[1].parent_message_id, 3000);
    assert.strictEqual(
      capturedPayloads[2].parent_message_id,
      3000,
      'An empty response must retry from the original parent'
    );
    assert.strictEqual(
      capturedPayloads[3].parent_message_id,
      3102,
      'Only the successful response ID becomes the next parent'
    );
  } finally {
    delete process.env.TEST_SESSION_ID;
    restore();
  }
});

test('non-stream chat completion returns OpenAI JSON instead of SSE', async () => {
  const restore = setupFetchMock((url) => {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"p":"response/content","v":"hello"}\n\n'));
        c.enqueue(new TextEncoder().encode('data: {"p":"response/content","v":" world"}\n\n'));
        c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        c.close();
      }
    });
    return new Response(stream, { status: 200 });
  });

  try {
    process.env.TEST_SESSION_ID = 'nonstream-session-id';
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [{role: 'user', content: 'test'}], stream: false })
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('Content-Type') || '', /^application\/json/);

    const body = await res.json();
    assert.strictEqual(body.object, 'chat.completion');
    assert.strictEqual(body.choices[0].message.role, 'assistant');
    assert.strictEqual(body.choices[0].message.content, 'hello world');
    assert.strictEqual(body.choices[0].finish_reason, 'stop');
    assert.strictEqual(body.session_id, 'nonstream-session-id');
  } finally {
    delete process.env.TEST_SESSION_ID;
    restore();
  }
});


test('hermes-style XML tool calls are converted to structured OpenAI tool_calls', async () => {
  const restore = setupFetchMock((url) => {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"p":"response/content","v":"Vou executar diretamente.\\n<tool_call><parameter name=\\"command\\">powershell.exe -Command Start-Process MuMuPlayer.exe</parameter><parameter name=\\"timeout\\">30</parameter></tool_call>"}\n\n'));
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
        messages: [{ role: 'user', content: 'Abra o emulador MuMu' }],
        stream: false,
        tools: [{
          type: 'function',
          function: {
            name: 'terminal',
            description: 'Execute shell commands',
            parameters: {
              type: 'object',
              properties: { command: { type: 'string' }, timeout: { type: 'number' } },
              required: ['command']
            }
          }
        }]
      })
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.choices[0].message.content, null);
    assert.strictEqual(body.choices[0].finish_reason, 'tool_calls');
    assert.strictEqual(body.choices[0].message.tool_calls[0].function.name, 'terminal');
    const args = JSON.parse(body.choices[0].message.tool_calls[0].function.arguments);
    assert.match(args.command, /MuMuPlayer\.exe/);
    assert.strictEqual(args.timeout, 30);
  } finally {
    restore();
  }
});

test('streaming Hermes-style XML tool calls do not leak as content', async () => {
  const restore = setupFetchMock((url) => {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"p":"response/content","v":"<tool_call name=\\"terminal\\"><parameter name=\\"command\\">adb devices</parameter></tool_call>"}\n\n'));
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
        messages: [{ role: 'user', content: 'liste adb' }],
        stream: true,
        tools: [{ type: 'function', function: { name: 'terminal', parameters: { type: 'object', properties: { command: { type: 'string' } } } } }]
      })
    });

    const res = await app.fetch(req);
    const text = await res.text();
    assert.ok(!text.includes('<tool_call'), 'tool XML must not leak into SSE content');
    assert.ok(!text.includes('<parameter'), 'parameter XML must not leak into SSE content');
    assert.ok(text.includes('"tool_calls"'), 'SSE must expose structured tool_calls');
    assert.ok(text.includes('"finish_reason":"tool_calls"'));
  } finally {
    restore();
  }
});

test('unclosed Hermes XML tool call at end of stream is recovered instead of returning empty', async () => {
  const restore = setupFetchMock((url) => {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"p":"response/content","v":"<tool_call name=\\"terminal\\"><parameter name=\\"command\\">adb devices"}\n\n'));
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
        messages: [{ role: 'user', content: 'liste adb' }],
        stream: true,
        tools: [{ type: 'function', function: { name: 'terminal', parameters: { type: 'object', properties: { command: { type: 'string' } } } } }]
      })
    });

    const res = await app.fetch(req);
    const text = await res.text();
    assert.ok(!text.includes('<tool_call'), 'unclosed tool XML must not leak into SSE content');
    assert.ok(!text.includes('<parameter'), 'unclosed parameter XML must not leak into SSE content');
    assert.ok(text.includes('"tool_calls"'), 'Recoverable unclosed XML must emit structured tool_calls');
    assert.ok(text.includes('adb devices'), 'Recovered tool call must preserve argument text');
    assert.ok(text.includes('"finish_reason":"tool_calls"'));
  } finally {
    restore();
  }
});

test('malformed internal tool call with lead-in returns safe content instead of empty response', async () => {
  const restore = setupFetchMock((url) => {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"p":"response/content","v":"Não encontrei o dispositivo, vou verificar novamente.\\n<tool_call><parameter></parameter></tool_call>"}\n\n'));
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
        messages: [{ role: 'user', content: 'continue depois de erro adb' }],
        stream: true,
        tools: [{ type: 'function', function: { name: 'terminal', parameters: { type: 'object', properties: { command: { type: 'string' } } } } }]
      })
    });

    const res = await app.fetch(req);
    const text = await res.text();
    assert.ok(!text.includes('<tool_call'), 'malformed tool XML must not leak into SSE content');
    assert.ok(!text.includes('<parameter'), 'malformed parameter XML must not leak into SSE content');
    assert.ok(!text.includes('"tool_calls"'), 'unparseable tool call must not be exposed as a fake structured tool call');
    assert.ok(text.includes('Não encontrei o dispositivo'), 'lead-in content must be preserved as a non-empty fallback');
    assert.ok(text.includes('"finish_reason":"stop"'));
  } finally {
    restore();
  }
});

import { compressMessages } from './utils/compression.ts';

test('compression: compressMessages trims older conversational history', async () => {
  const serializeFn = (msgs: any[]) => {
    let prompt = '';
    let systemPrompt = '';
    for (const msg of msgs) {
      if (msg.role === 'system') {
        systemPrompt += msg.content + '\n';
      } else {
        prompt += `${msg.role}: ${msg.content}\n`;
      }
    }
    return { prompt, systemPrompt };
  };

  const messages = [
    { role: 'system', content: 'System instruction here' },
    { role: 'user', content: 'Message 1' },
    { role: 'assistant', content: 'Message 2' },
    { role: 'user', content: 'Message 3' },
    { role: 'assistant', content: 'Message 4' },
    { role: 'user', content: 'Message 5' },
  ];

  const targetLimit = 100;
  const compressed = compressMessages(messages, targetLimit, serializeFn);
  
  const systemMsg = compressed.find(m => m.role === 'system');
  assert.ok(systemMsg);
  assert.strictEqual(systemMsg.content, 'System instruction here');
  
  const lastMsg = compressed[compressed.length - 1];
  assert.strictEqual(lastMsg.role, 'user');
  assert.strictEqual(lastMsg.content, 'Message 5');

  assert.ok(compressed.length < messages.length);
});

test('oversized prompt retries with compressed context after context overflow', async () => {
  let attempts: number[] = [];
  const model = 'deepseek-v4-flash-thinking-overflow';
  const restore = setupFetchMock((url, init) => {
    const bodyObj = JSON.parse(init?.body as string || '{}');
    attempts.push(bodyObj.prompt.length);

    if (bodyObj.prompt.length > 200) {
      // Context overflow: DeepSeek rejects oversized prompts with an HTTP error
      // that names the context limit, so the retry may compress safely.
      return new Response(JSON.stringify({ error: "This model's maximum context length is 64 tokens" }), { status: 400 });
    }

    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"p":"response/content","v":"compressed success"}\n\n'));
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
        model,
        messages: [
          { role: 'system', content: 'Keep this instruction.' },
          { role: 'user', content: 'A'.repeat(300) },
        ],
        stream: false
      })
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);

    const body = await res.json();
    assert.strictEqual(body.choices[0].message.content, 'compressed success');

    assert.ok(attempts.length >= 2, 'Should have retried');
    assert.ok(attempts[1] < attempts[0], 'Second attempt prompt should be shorter due to compression');
  } finally {
    restore();
  }
});

test('transport errors do not poison the model context estimate', async () => {
  const model = 'deepseek-v4-pro-transport-error-test';
  const { getModelTelemetry, getContextLength } = await import('./services/telemetry.ts');
  const stats = getModelTelemetry(model);
  const initialCharacters = stats.detectedLimit;
  const initialTokens = getContextLength(model);
  const restore = setupFetchMock(() => {
    throw new Error('temporary network failure');
  });

  try {
    const response = await app.fetch(new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'hello' }],
        stream: false,
      })
    }));

    assert.strictEqual(response.status, 500);
    assert.strictEqual(stats.detectedLimit, initialCharacters);
    assert.strictEqual(getContextLength(model), initialTokens);
  } finally {
    restore();
  }
});

test('short empty responses do not collapse a healthy context estimate', async () => {
  const model = 'deepseek-v4-pro-short-empty-test';
  const { getModelTelemetry } = await import('./services/telemetry.ts');
  const stats = getModelTelemetry(model);
  const initialCharacters = stats.detectedLimit;
  const restore = setupFetchMock(() => new Response(new ReadableStream({
    start(controller) { controller.close(); }
  }), { status: 200 }));

  try {
    const response = await app.fetch(new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'tiny prompt' }],
        stream: false,
      })
    }));

    assert.strictEqual(response.status, 500);
    assert.strictEqual(stats.detectedLimit, initialCharacters);
  } finally {
    restore();
  }
});
