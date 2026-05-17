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

    systemPrompt += `\n\n# TOOLS AVAILABLE\nYou are running inside a coding agent. You do not directly see the user's filesystem, terminal, git history, or codebase unless you call tools. The client will execute your tool calls and send tool results back.\n\nYou have access to the following tools:\n${toolsJson}\n\nTo use a tool, you MUST output a JSON object wrapped EXACTLY in these tags:\n<tool_call>\n{"name": "tool_name", "arguments": {"param_name": "value"}}\n</tool_call>\n\nRULES:\n1. If the user asks you to inspect, analyze, modify, review, or summarize a local project/codebase/repository, you MUST call the relevant filesystem/search/git tools instead of asking the user to paste files.\n2. Never say you cannot access local files while tools are available. Use tools first.\n3. You can call multiple tools by outputting multiple <tool_call> blocks consecutively.\n4. Do NOT output any other text after your <tool_call> blocks. Wait for the tool response.\n5. The JSON must be valid and accurately follow the tool's parameters.\n\n`;

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
    let bufferedToolModeContent = '';
    const shouldBufferContent = hasCallableTools(body);

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
          if (shouldBufferContent && toolCallCount === 0) {
            bufferedToolModeContent += event.content || '';
          } else {
            await writeEvent({
              id: completionId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: body.model,
              choices: [makeChoice({ content: event.content })],
            });
          }
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

    if (shouldBufferContent && toolCallCount === 0) {
      const syntheticToolCall = maybeCreateInspectionToolCall(body, bufferedToolModeContent);
      if (syntheticToolCall) {
        toolCallCount++;
        await writeEvent({
          id: completionId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [makeChoice({ tool_calls: [syntheticToolCall] })],
        });
      } else if (bufferedToolModeContent) {
        await writeEvent({
          id: completionId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [makeChoice({ content: bufferedToolModeContent })],
        });
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
  } else {
    const syntheticToolCall = maybeCreateInspectionToolCall(body, accumulatedContent);
    if (syntheticToolCall) {
      message.tool_calls = [{
        id: syntheticToolCall.id!,
        type: 'function',
        function: syntheticToolCall.function,
      }];
      message.content = null;
    }
  }

  const finishReason = message.tool_calls?.length > 0 ? 'tool_calls' : 'stop';

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

function hasCallableTools(body: OpenAIRequest): boolean {
  const tools = (body as any).tools;
  return Array.isArray(tools) && tools.length > 0 && (body as any).tool_choice !== 'none';
}

function maybeCreateInspectionToolCall(body: OpenAIRequest, content: string) {
  if (!hasCallableTools(body)) return null;

  const lower = content.toLowerCase();
  const looksLikeNoAccess =
    lower.includes('não tenho acesso') ||
    lower.includes('nao tenho acesso') ||
    lower.includes('não consigo acessar') ||
    lower.includes('nao consigo acessar') ||
    lower.includes('compartilhar o código') ||
    lower.includes('compartilhar o codigo') ||
    lower.includes('copie e cole') ||
    lower.includes('cole o resultado') ||
    lower.includes('repositório comigo') ||
    lower.includes('repositorio comigo') ||
    lower.includes('sem que você me forneça') ||
    lower.includes('sem que voce me forneca');

  const userAskedForCodebase =
    (body.messages || []).some(msg => {
      if (msg.role !== 'user' || typeof msg.content !== 'string') return false;
      const text = msg.content.toLowerCase();
      return text.includes('codebase') ||
        text.includes('code base') ||
        text.includes('pasta') ||
        text.includes('projeto') ||
        text.includes('repo') ||
        text.includes('reposit') ||
        text.includes('últimas mudanças') ||
        text.includes('ultimas mudanças') ||
        text.includes('ultimas mudancas') ||
        text.includes('verifica') ||
        text.includes('analisa');
    });

  if (!looksLikeNoAccess && !userAskedForCodebase) return null;

  const tool = chooseInspectionTool((body as any).tools);
  if (!tool) return null;

  return {
    index: 0,
    id: 'call_' + uuidv4(),
    type: 'function',
    function: {
      name: tool.name,
      arguments: JSON.stringify(tool.arguments),
    },
  };
}

function chooseInspectionTool(tools: any[]): { name: string; arguments: Record<string, unknown> } | null {
  const candidates = tools
    .filter(t => t?.type === 'function' && t.function?.name)
    .map(t => ({
      name: String(t.function.name),
      parameters: t.function.parameters || { type: 'object', properties: {}, required: [] },
    }));

  if (candidates.length === 0) return null;

  const preferred = [
    /^(bash|shell|exec|run|terminal)$/i,
    /(list|ls|glob|file|dir|tree)/i,
    /(grep|search|rg)/i,
  ];

  let selected = candidates[0];
  for (const pattern of preferred) {
    const found = candidates.find(c => pattern.test(c.name));
    if (found) {
      selected = found;
      break;
    }
  }

  return {
    name: selected.name,
    arguments: buildInspectionArgs(selected.parameters, selected.name),
  };
}

function buildInspectionArgs(parameters: any, toolName: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const properties = parameters?.properties || {};
  const required = Array.isArray(parameters?.required) ? parameters.required : Object.keys(properties);
  const lowerTool = toolName.toLowerCase();

  for (const key of required) {
    const schema = properties[key] || {};
    const lower = String(key).toLowerCase();

    if (schema.default !== undefined) {
      args[key] = schema.default;
    } else if (schema.enum && Array.isArray(schema.enum) && schema.enum.length > 0) {
      args[key] = schema.enum[0];
    } else if (schema.type === 'number' || schema.type === 'integer') {
      args[key] = lower.includes('limit') || lower.includes('max') ? 200 : 0;
    } else if (schema.type === 'boolean') {
      args[key] = false;
    } else if (lower.includes('command') || lower === 'cmd' || lowerTool.includes('bash') || lowerTool.includes('shell')) {
      args[key] = 'pwd && git status --short && find . -maxdepth 2 -type f | sed -n "1,200p"';
    } else if (lower.includes('pattern') || lower.includes('glob')) {
      args[key] = '**/*';
    } else if (lower.includes('query') || lower.includes('search')) {
      args[key] = 'package.json';
    } else if (lower.includes('path') || lower.includes('dir') || lower.includes('cwd') || lower.includes('folder')) {
      args[key] = '.';
    } else {
      args[key] = '';
    }
  }

  if (Object.keys(args).length === 0 && (lowerTool.includes('bash') || lowerTool.includes('shell'))) {
    args.command = 'pwd && git status --short && find . -maxdepth 2 -type f | sed -n "1,200p"';
  }

  return args;
}
