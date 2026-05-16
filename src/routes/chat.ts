/*
 * File: chat.ts
 * Project: deepsproxy
 * Author: Pedro Farias
 * Created: 2026-05-09
 * 
 * Last Modified: Sat May 09 2026
 * Modified By: Pedro Farias
 */

import { Context } from 'hono';
import { stream as honoStream } from 'hono/streaming';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';
import { OpenAIRequest, Message } from '../utils/types.ts';
import { router } from '../providers/router.ts';
import { ProviderError } from '../providers/types.ts';
import type { ProviderStreamEvent } from '../providers/types.ts';

const RESPONSE_CACHE_TTL_MS = process.env.RESPONSE_CACHE_TTL_MS
  ? Number.parseInt(process.env.RESPONSE_CACHE_TTL_MS, 10)
  : 60_000;

const responseCache = new Map<string, { expiresAt: number; payload: any }>();
const inFlightNonStreaming = new Map<string, Promise<any>>();

// ─── Prompt Builder ────────────────────────────────────────────────────────────

function buildPrompt(body: OpenAIRequest): { prompt: string; messages: Message[] } {
  let prompt = '';
  const messages = body.messages || [];
  let systemPrompt = '';

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    let contentStr = '';
    if (Array.isArray(msg.content)) {
      contentStr = msg.content.map((c: any) => c.text || JSON.stringify(c)).join('\n');
    } else if (typeof msg.content === 'object' && msg.content !== null) {
      contentStr = JSON.stringify(msg.content);
    } else {
      contentStr = msg.content || '';
    }

    if (msg.role === 'system') {
      systemPrompt += contentStr + '\n\n';
    } else if (i === messages.length - 1) {
      if (msg.role === 'user') {
        prompt += `User: ${contentStr}\n\n`;
      } else if (msg.role === 'assistant') {
        let assistantContent = contentStr;
        if ((msg as any).reasoning_content) {
          assistantContent = `<think>\n${(msg as any).reasoning_content}\n</think>\n${assistantContent}`;
        }
        if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
          for (const tc of msg.tool_calls) {
            let args = tc.function?.arguments || '{}';
            if (typeof args !== 'string') args = JSON.stringify(args);
            assistantContent += `\n<tool_call>{"name": "${tc.function?.name}", "arguments": ${args}}</tool_call>`;
          }
        }
        prompt += `Assistant: ${assistantContent.trim()}\n\n`;
      } else if (msg.role === 'tool' || msg.role === 'function') {
        prompt += `Tool Response (${msg.name || 'tool'}): ${contentStr}\n\n`;
      }
    }
  }

  // Inject tools instructions
  const bodyAny = body as any;
  const hasTools = bodyAny.tools && Array.isArray(bodyAny.tools) && bodyAny.tools.length > 0;
  const toolChoice = bodyAny.tool_choice;
  if (hasTools && toolChoice !== 'none') {
    const formattedTools = bodyAny.tools.map((t: any) => {
      if (t.type === 'function') {
        return {
          name: t.function.name,
          description: t.function.description || '',
          parameters: t.function.parameters,
        };
      }
      return t;
    });
    const toolsJson = JSON.stringify(formattedTools, null, 2);

    systemPrompt += `\n\n# TOOLS AVAILABLE\nYou have access to the following tools:\n${toolsJson}\n\nTo use a tool, you MUST output a JSON object wrapped EXACTLY in these tags:\n<tool_call>\n{"name": "tool_name", "arguments": {"param_name": "value"}}\n</tool_call>\n\nRULES:\n1. You can call multiple tools by outputting multiple <tool_call> blocks consecutively.\n2. Do NOT output any other text after your <tool_call> blocks. Wait for the user to provide the tool response.\n3. The JSON must be valid and accurately follow the tool's parameters.\n\n`;

    if (bodyAny.tool_choice && typeof bodyAny.tool_choice === 'object' && bodyAny.tool_choice.function) {
      const forcedTool = bodyAny.tool_choice.function.name;
      systemPrompt += `CRITICAL: You MUST call the tool "${forcedTool}" in this response.\n\n`;
    } else if (toolChoice === 'required') {
      systemPrompt += `CRITICAL: You MUST call one of the available tools in this response.\n\n`;
    }
  }

  const finalPrompt = systemPrompt ? `${systemPrompt}\n${prompt}` : prompt;
  return { prompt: finalPrompt, messages };
}

// ─── Streaming Response (SSE) ──────────────────────────────────────────────────

async function handleStreamingResponse(
  c: Context,
  body: OpenAIRequest,
  events: AsyncIterable<ProviderStreamEvent>,
  completionId: string,
  promptTokens: number,
  providerInfo?: { providerName: string; actualModel: string }
) {
  c.header('Content-Type', 'text/event-stream');
  c.header('Cache-Control', 'no-cache');
  c.header('Connection', 'keep-alive');
  setProviderHeaders(c, body.model, providerInfo);

  return honoStream(c, async (streamWriter: any) => {
    const writeEvent = async (data: any) => {
      await streamWriter.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const makeChoice = (delta: any, finishReason: string | null = null) => ({
      index: 0,
      delta,
      logprobs: null,
      finish_reason: finishReason,
    });

    // Send initial chunk
    await writeEvent({
      id: completionId,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: body.model,
      choices: [makeChoice({ role: 'assistant', content: '' })],
    });

    let completionTokens = 0;
    let toolCallCount = 0;

    for await (const event of events) {
      switch (event.type) {
        case 'done':
          break;
        case 'reasoning':
          await writeEvent({
            id: completionId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: body.model,
            choices: [makeChoice({ reasoning_content: event.content })],
          });
          break;
        case 'content':
          await writeEvent({
            id: completionId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: body.model,
            choices: [makeChoice({ content: event.content })],
          });
          break;
        case 'tool_call':
          toolCallCount++;
          await writeEvent({
            id: completionId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: body.model,
            choices: [makeChoice({ tool_calls: [event.toolCall] })],
          });
          break;
        case 'tool_call_error':
          await writeEvent({
            id: completionId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: body.model,
            choices: [makeChoice({ content: event.rawText })],
          });
          break;
      }
      if (event.completionTokens) {
        completionTokens = event.completionTokens;
      }
    }

    // Send finish chunk with usage
    const usage = {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
      prompt_tokens_details: { cached_tokens: 0 },
    };

    const finalFinishReason = toolCallCount > 0 ? 'tool_calls' : 'stop';

    await writeEvent({
      id: completionId,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: body.model,
      choices: [makeChoice({}, finalFinishReason)],
      usage,
    });
    await streamWriter.write('data: [DONE]\n\n');
  });
}

// ─── Non-Streaming Response (JSON) ────────────────────────────────────────────

async function buildNonStreamingPayload(
  body: OpenAIRequest,
  events: AsyncIterable<ProviderStreamEvent>,
  completionId: string,
  promptTokens: number
) {
  let accumulatedContent = '';
  let reasoningBuffer = '';
  let completionTokens = 0;
  const toolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = [];

  for await (const event of events) {
    switch (event.type) {
      case 'content':
        accumulatedContent += event.content || '';
        break;
      case 'reasoning':
        reasoningBuffer += event.content || '';
        break;
      case 'tool_call':
        if (event.toolCall) {
          toolCalls.push({
            id: event.toolCall.id,
            type: 'function',
            function: event.toolCall.function,
          });
        }
        break;
      case 'tool_call_error':
        accumulatedContent += event.rawText || '';
        break;
    }
    if (event.completionTokens) {
      completionTokens = event.completionTokens;
    }
  }

  // Build the complete message
  const message: Record<string, any> = {
    role: 'assistant',
    content: accumulatedContent || null,
  };

  if (reasoningBuffer) {
    message.reasoning_content = reasoningBuffer;
  }

  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
    if (!accumulatedContent) {
      message.content = null;
    }
  }

  const finishReason = toolCalls.length > 0 ? 'tool_calls' : 'stop';

  return {
    id: completionId,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: body.model,
    choices: [
      {
        index: 0,
        message,
        logprobs: null,
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
      prompt_tokens_details: { cached_tokens: 0 },
    },
  };
}

async function handleNonStreamingResponse(
  c: Context,
  body: OpenAIRequest,
  events: AsyncIterable<ProviderStreamEvent>,
  completionId: string,
  promptTokens: number,
  providerInfo?: { providerName: string; actualModel: string }
) {
  setProviderHeaders(c, body.model, providerInfo);
  return c.json(await buildNonStreamingPayload(body, events, completionId, promptTokens));
}

// ─── Main Handler ──────────────────────────────────────────────────────────────

export async function chatCompletions(c: Context) {
  try {
    const body: OpenAIRequest = await c.req.json();
    const isStream = body.stream ?? false;

    const { prompt, messages } = buildPrompt(body);
    const isNewSession = !messages.some(m => m.role === 'assistant');

    if (!isStream) {
      const cacheKey = makeRequestCacheKey(body);
      const cached = responseCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        setProviderHeaders(c, body.model, cached.payload._provider);
        const responsePayload = stripInternalFields({
          ...cached.payload,
          id: 'chatcmpl-' + uuidv4(),
          created: Math.floor(Date.now() / 1000),
        });
        return c.json(responsePayload);
      }

      let pending = inFlightNonStreaming.get(cacheKey);
      if (!pending) {
        pending = createNonStreamingPayload(body, prompt, messages, isNewSession);
        inFlightNonStreaming.set(cacheKey, pending);
        pending.finally(() => inFlightNonStreaming.delete(cacheKey)).catch(() => {});
      }

      const payload = await pending;
      if (isCacheablePayload(payload)) {
        responseCache.set(cacheKey, {
          expiresAt: Date.now() + RESPONSE_CACHE_TTL_MS,
          payload: { ...payload },
        });
      }

      setProviderHeaders(c, body.model, payload._provider);
      return c.json(stripInternalFields(payload));
    }

    const streamResult = await createStreamWithRetries(body, prompt, messages, isNewSession);
    const completionId = 'chatcmpl-' + uuidv4();
    return handleStreamingResponse(c, body, streamResult.events, completionId, streamResult.promptTokens, streamResult);
  } catch (err: any) {
    console.error('Error in chatCompletions:', err);

    // Return structured error with provider context
    const statusCode = err instanceof ProviderError ? err.statusCode : 500;
    const providerInfo = err instanceof ProviderError ? ` (provider: ${err.provider})` : '';

    return c.json({
      error: {
        message: err.message + providerInfo,
        type: err instanceof ProviderError ? 'provider_error' : 'internal_error',
        code: statusCode,
      },
    }, statusCode as any);
  }
}

async function createStreamWithRetries(
  body: OpenAIRequest,
  prompt: string,
  messages: Message[],
  isNewSession: boolean
) {
  let streamResult;
  let retries = 3;
  while (retries > 0) {
      try {
        streamResult = await router.createStream({
          model: body.model,
          prompt,
          enableThinking: body.model.includes('thinking'),
          isNewSession,
          messages,
          tools: (body as any).tools,
          toolChoice: (body as any).tool_choice,
        });
        break;
      } catch (err: any) {
        retries--;
        if (retries === 0) throw err;
        // Only retry on retryable errors
        if (err instanceof ProviderError && !err.retryable) throw err;
        await new Promise(r => setTimeout(r, 1000));
      }
    }

  if (!streamResult) {
    throw new Error('Failed to create stream after retries');
  }

  return streamResult;
}

async function createNonStreamingPayload(
  body: OpenAIRequest,
  prompt: string,
  messages: Message[],
  isNewSession: boolean
) {
  const streamResult = await createStreamWithRetries(body, prompt, messages, isNewSession);
  const completionId = 'chatcmpl-' + uuidv4();
  const payload = await buildNonStreamingPayload(body, streamResult.events, completionId, streamResult.promptTokens);
  return {
    ...payload,
    _provider: {
      providerName: streamResult.providerName,
      actualModel: streamResult.actualModel,
    },
  };
}

function makeRequestCacheKey(body: OpenAIRequest): string {
  return createHash('sha256').update(JSON.stringify({
    model: body.model,
    messages: body.messages,
    tools: (body as any).tools,
    tool_choice: (body as any).tool_choice,
    stream: false,
  })).digest('hex');
}

function isCacheablePayload(payload: any): boolean {
  if (RESPONSE_CACHE_TTL_MS <= 0) return false;
  const choice = payload?.choices?.[0];
  return choice?.finish_reason === 'stop' && !choice?.message?.tool_calls;
}

function setProviderHeaders(
  c: Context,
  requestedModel: string,
  providerInfo?: { providerName: string; actualModel: string }
) {
  if (!providerInfo) return;
  c.header('X-Provider-Used', providerInfo.providerName);
  c.header('X-Provider-Model', providerInfo.actualModel);
  c.header('X-Provider-Requested-Model', requestedModel);
  c.header('X-Provider-Fallback', providerInfo.actualModel === requestedModel ? 'false' : 'true');
}

function stripInternalFields<T extends Record<string, any>>(payload: T): Omit<T, '_provider'> {
  const { _provider, ...rest } = payload;
  return rest;
}
