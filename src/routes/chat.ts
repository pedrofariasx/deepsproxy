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
import { v4 as uuidv4 } from 'uuid';
import { createDeepSeekStream, updateSessionParent } from '../services/deepseek.ts';
import { OpenAIRequest, ChoiceDelta, Message, ToolCall, Usage } from '../utils/types.ts';
import { robustParseJSON } from '../utils/json.ts';
import { getModelTelemetry, recordSuccess, recordFailure, isContextOverflowError } from '../services/telemetry.ts';
import { compressMessages } from '../utils/compression.ts';
import {
  acquireSessionLease,
  findExplicitSession,
  findLineageSession,
  incrementalMessages,
  registerExplicitSession,
  registerLineageSession,
  unregisterExplicitSession,
} from '../services/hybrid-sessions.ts';

const TOOL_START = '<tool_call>';
const TOOL_END = '</tool_call>';
const TOOL_OPEN_RE = /<tool_call\b[^>]*>/i;

type EmitChunk = (data: any) => Promise<void>;

interface ParsedCompletion {
  content: string;
  reasoningContent: string;
  toolCalls: ToolCall[];
  finishReason: string;
  usage: Usage;
  responseMessageId: number | null;
}

function messageContentToString(content: any): string {
  if (Array.isArray(content)) {
    return content.map((c: any) => c.text || JSON.stringify(c)).join('\n');
  }
  if (typeof content === 'object' && content !== null) {
    return JSON.stringify(content);
  }
  return content || '';
}

function serializeOpenAIMessages(messages: Message[]) {
  let prompt = '';
  let systemPrompt = '';

  for (const msg of messages) {
    const contentStr = messageContentToString(msg.content);

    if (msg.role === 'system') {
      systemPrompt += contentStr + '\n\n';
      continue;
    }

    if (msg.role === 'user') {
      prompt += `User: ${contentStr}\n\n`;
      continue;
    }

    if (msg.role === 'assistant') {
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
      continue;
    }

    if (msg.role === 'tool' || msg.role === 'function') {
      prompt += `Tool Response (${msg.name || msg.tool_call_id || 'tool'}): ${contentStr}\n\n`;
      continue;
    }

    prompt += `${msg.role}: ${contentStr}\n\n`;
  }

  return { prompt, systemPrompt };
}

function appendToolInstructions(systemPrompt: string, body: OpenAIRequest): string {
  const bodyAny = body as any;
  if (!bodyAny.tools || !Array.isArray(bodyAny.tools) || bodyAny.tools.length === 0) {
    return systemPrompt;
  }

  const formattedTools = bodyAny.tools.map((t: any) => {
    if (t.type === 'function') {
      return {
        name: t.function.name,
        description: t.function.description || '',
        parameters: t.function.parameters
      };
    }
    return t;
  });
  const toolsJson = JSON.stringify(formattedTools, null, 2);

  systemPrompt += `\n\n# TOOLS AVAILABLE\nYou have access to the following tools:\n${toolsJson}\n\nTo use a tool, you MUST output a JSON object wrapped EXACTLY in these tags:\n<tool_call>\n{"name": "tool_name", "arguments": {"param_name": "value"}}\n</tool_call>\n\nRULES:\n1. You can call multiple tools by outputting multiple <tool_call> blocks consecutively.\n2. Do NOT output any other text after your <tool_call> blocks. Wait for the user to provide the tool response.\n3. The JSON must be valid and accurately follow the tool's parameters.\n\n`;

  if (bodyAny.tool_choice && typeof bodyAny.tool_choice === 'object' && bodyAny.tool_choice.function) {
    const forcedTool = bodyAny.tool_choice.function.name;
    systemPrompt += `CRITICAL: You MUST call the tool "${forcedTool}" in this response.\n\n`;
  }

  return systemPrompt;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function coerceParameterValue(rawValue: string): unknown {
  const value = decodeXmlEntities(rawValue.trim());
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith('{') && value.endsWith('}')) || (value.startsWith('[') && value.endsWith(']'))) {
    try { return JSON.parse(value); } catch {}
  }
  return value;
}

function extractToolName(openTag: string, block: string): string {
  const combined = `${openTag}\n${block}`;
  const attrMatch = combined.match(/<tool_call\b[^>]*\bname\s*=\s*["']([^"']+)["']/i);
  if (attrMatch) return attrMatch[1];

  const nameTagMatch = block.match(/<name>([\s\S]*?)<\/name>/i);
  if (nameTagMatch) return decodeXmlEntities(nameTagMatch[1].trim());

  return '';
}

function inferToolNameFromParameters(args: Record<string, unknown>, tools: any[]): string {
  const argKeys = Object.keys(args);
  if (argKeys.length === 0 || !Array.isArray(tools)) return '';

  const matches = tools.filter((tool: any) => {
    const fn = tool?.type === 'function' ? tool.function : tool?.function;
    const properties = fn?.parameters?.properties || {};
    return argKeys.every(k => Object.prototype.hasOwnProperty.call(properties, k));
  });

  if (matches.length === 1) {
    const fn = matches[0]?.type === 'function' ? matches[0].function : matches[0]?.function;
    return fn?.name || '';
  }

  return '';
}

function parseXmlParameterToolCall(block: string, openTag: string, tools: any[]): any | null {
  const args: Record<string, unknown> = {};
  const parameterRe = /<parameter\b[^>]*\bname\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/parameter>/gi;
  let match: RegExpExecArray | null;
  while ((match = parameterRe.exec(block)) !== null) {
    args[match[1]] = coerceParameterValue(match[2]);
  }

  if (Object.keys(args).length === 0) return null;

  const toolName = extractToolName(openTag, block) || inferToolNameFromParameters(args, tools);
  if (!toolName) return null;

  return { name: toolName, arguments: args };
}

function parseToolCallBlock(block: string, openTag: string, tools: any[]): any {
  const parsedXml = parseXmlParameterToolCall(block, openTag, tools);
  if (parsedXml) return parsedXml;

  const parsedJson = robustParseJSON(block);
  if (!parsedJson) throw new Error('Empty tool call');

  const attrToolName = extractToolName(openTag, block);
  if (attrToolName && !parsedJson.name) parsedJson.name = attrToolName;

  return parsedJson;
}

function findToolOpen(buffer: string): { startIdx: number; endIdx: number; openTag: string } | null {
  const match = buffer.match(TOOL_OPEN_RE);
  if (!match || match.index === undefined) return null;
  return {
    startIdx: match.index,
    endIdx: match.index + match[0].length,
    openTag: match[0]
  };
}

function findPartialToolOpenIndex(buffer: string): number {
  const lower = buffer.toLowerCase();
  const idx = lower.lastIndexOf('<tool_call');
  if (idx !== -1 && lower.indexOf('>', idx) === -1) return idx;

  for (let i = 1; i < TOOL_START.length; i++) {
    if (lower.endsWith(TOOL_START.substring(0, i))) return buffer.length - i;
  }
  return -1;
}

function makeChoice(delta: any, finishReason: string | null = null) {
  return {
    index: 0,
    delta,
    logprobs: null,
    finish_reason: finishReason
  };
}

function makeChunk(completionId: string, model: string, delta: any, finishReason: string | null = null, usage?: Usage) {
  const chunk: any = {
    id: completionId,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [makeChoice(delta, finishReason)]
  };
  if (usage) chunk.usage = usage;
  return chunk;
}

async function parseDeepSeekStreamToOpenAI(
  deepSeekStream: ReadableStream,
  completionId: string,
  model: string,
  promptTokens: number,
  _uiSessionId: string,
  tools: any[] = [],
  emit?: EmitChunk,
  existingReader?: ReadableStreamDefaultReader<any>
): Promise<ParsedCompletion> {
  const reader = existingReader || deepSeekStream.getReader();
  const decoder = new TextDecoder();

  let currentAppendPath = '';
  let currentFragmentType = '';
  let reasoningContent = '';
  let content = '';
  let contentEmitBuffer = '';
  let insideTool = false;
  let currentToolOpenTag = TOOL_START;
  let emittedToolCallCount = 0;
  let completionTokens = 0;
  const toolCalls: ToolCall[] = [];
  let buffer = '';
  let pendingToolLeadIn = '';
  let responseMessageId: number | null = null;

  const emitContent = async (text: string) => {
    if (!text || emittedToolCallCount > 0) return;
    content += text;
    if (emit) await emit(makeChunk(completionId, model, { content: text }));
  };

  const parseRecoverableToolCallBlock = (block: string, openTag: string): any => {
    try {
      return parseToolCallBlock(block, openTag, tools);
    } catch {}

    const args: Record<string, unknown> = {};
    const closedParameterRe = /<parameter\b[^>]*\bname\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/parameter>/gi;
    let match: RegExpExecArray | null;
    let lastClosedEnd = 0;
    while ((match = closedParameterRe.exec(block)) !== null) {
      args[match[1]] = coerceParameterValue(match[2]);
      lastClosedEnd = closedParameterRe.lastIndex;
    }

    const tail = block.substring(lastClosedEnd);
    const unclosedParameterMatch = tail.match(/<parameter\b[^>]*\bname\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*)$/i);
    if (unclosedParameterMatch) {
      args[unclosedParameterMatch[1]] = coerceParameterValue(unclosedParameterMatch[2]);
    }

    if (Object.keys(args).length === 0) throw new Error('Unrecoverable tool call');
    const toolName = extractToolName(openTag, block) || inferToolNameFromParameters(args, tools);
    if (!toolName) throw new Error('Recoverable tool call missing name');
    return { name: toolName, arguments: args };
  };

  const emitToolCallFromBlock = async (toolBlock: string, openTag: string) => {
    const toolCallObj = parseRecoverableToolCallBlock(toolBlock, openTag);
    const toolName = toolCallObj.name || '';

    let toolArgs: Record<string, unknown> = {};
    if (toolCallObj.arguments && typeof toolCallObj.arguments === 'object') {
      toolArgs = toolCallObj.arguments;
    } else {
      const keys = Object.keys(toolCallObj).filter(k => k !== 'name');
      for (const k of keys) toolArgs[k] = toolCallObj[k];
    }

    if (!toolName) throw new Error('Tool call missing name');

    const toolId = 'call_' + uuidv4();
    const toolCall: ToolCall = {
      index: emittedToolCallCount,
      id: toolId,
      type: 'function',
      function: { name: toolName, arguments: JSON.stringify(toolArgs) }
    };
    toolCalls.push(toolCall);
    if (emit) await emit(makeChunk(completionId, model, { tool_calls: [toolCall] }));
    emittedToolCallCount++;
  };

  const processResponseText = async (text: string, fragmentType?: string) => {
    if (!text || text === 'FINISHED') return;
    const isThinking = fragmentType === 'THINK' || (
      fragmentType === undefined && (
        currentAppendPath.includes('thinking_content') ||
        currentAppendPath.includes('THINK') ||
        (currentAppendPath.includes('fragments/-1/content') && currentFragmentType === 'THINK')
      )
    );

    if (isThinking) {
      reasoningContent += text;
      const delta: ChoiceDelta = { reasoning_content: text };
      if (emit) await emit(makeChunk(completionId, model, delta));
      return;
    }

    contentEmitBuffer += text;
    while (contentEmitBuffer.length > 0) {
      if (!insideTool) {
        const toolOpen = findToolOpen(contentEmitBuffer);
        if (toolOpen) {
          pendingToolLeadIn += contentEmitBuffer.substring(0, toolOpen.startIdx);
          insideTool = true;
          currentToolOpenTag = toolOpen.openTag;
          contentEmitBuffer = contentEmitBuffer.substring(toolOpen.endIdx);
          continue;
        }

        const partialStartIdx = findPartialToolOpenIndex(contentEmitBuffer);
        const flushIndex = partialStartIdx === -1 ? contentEmitBuffer.length : partialStartIdx;
        const textToEmit = contentEmitBuffer.substring(0, flushIndex);
        await emitContent(textToEmit);
        contentEmitBuffer = contentEmitBuffer.substring(flushIndex);
        break;
      }

      const lowerBuffer = contentEmitBuffer.toLowerCase();
      const endIdx = lowerBuffer.indexOf(TOOL_END);
      if (endIdx === -1) break;

      const toolBlock = contentEmitBuffer.substring(0, endIdx).trim();
      try {
        await emitToolCallFromBlock(toolBlock, currentToolOpenTag);
        pendingToolLeadIn = '';
      } catch (error) {
        console.warn('[chat] Dropping malformed tool call block:', error);
        if (emittedToolCallCount === 0 && pendingToolLeadIn.trim().length > 0) {
          await emitContent(pendingToolLeadIn);
        }
        pendingToolLeadIn = '';
      }

      insideTool = false;
      currentToolOpenTag = TOOL_START;
      contentEmitBuffer = contentEmitBuffer.substring(endIdx + TOOL_END.length);
    }
  };

  try {
    while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) continue;

      const dataStr = trimmed.slice(6);
      if (dataStr === '[DONE]') continue;

      try {
        const chunk = JSON.parse(dataStr);
        let dsMessageId: any = null;
        if (chunk.response_message_id) {
          dsMessageId = chunk.response_message_id;
        } else if (chunk.v && typeof chunk.v === 'object') {
          if (chunk.v.response && chunk.v.response.message_id) {
            dsMessageId = chunk.v.response.message_id;
          } else if (chunk.v.message_id) {
            dsMessageId = chunk.v.message_id;
          }
        } else if (chunk.message_id) {
          dsMessageId = chunk.message_id;
        }

        // Do not commit the parent here. DeepSeek can emit a message ID for an
        // empty/failed generation; committing it would make retries continue
        // from a broken turn instead of branching from the last valid parent.
        if (typeof dsMessageId === 'number') responseMessageId = dsMessageId;

        if (typeof chunk.p === 'string') {
          currentAppendPath = chunk.p;
          if (chunk.p === 'response/accumulated_token_usage' && typeof chunk.v === 'number') {
            completionTokens = chunk.v;
          }
        }

        const fragments = Array.isArray(chunk.v)
          ? chunk.v
          : (Array.isArray(chunk.v?.response?.fragments) ? chunk.v.response.fragments : null);
        if (fragments) {
          const lastFragment = fragments[fragments.length - 1];
          if (lastFragment?.type) currentFragmentType = lastFragment.type;
          for (const fragment of fragments) {
            if (typeof fragment?.content === 'string') {
              await processResponseText(fragment.content, fragment.type);
            }
          }
        } else if (typeof chunk.v === 'string') {
          await processResponseText(chunk.v);
        }
      } catch (e) {
        // Ignore partial or malformed DeepSeek chunks.
      }
    }
  }

  if (insideTool && contentEmitBuffer.trim().length > 0) {
    try {
      await emitToolCallFromBlock(contentEmitBuffer.trim(), currentToolOpenTag);
      pendingToolLeadIn = '';
    } catch (e) {
      console.warn('[chat] Dropping unclosed malformed tool call at end of stream:', e);
      if (emittedToolCallCount === 0 && pendingToolLeadIn.trim().length > 0) {
        await emitContent(pendingToolLeadIn);
      }
      pendingToolLeadIn = '';
    }
  }

  if (!insideTool && contentEmitBuffer.length > 0 && emittedToolCallCount === 0) {
    await emitContent(contentEmitBuffer);
  }

  const usage: Usage = {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    prompt_tokens_details: { cached_tokens: 0 }
  };

  return {
    content,
    reasoningContent,
    toolCalls,
    finishReason: emittedToolCallCount > 0 ? 'tool_calls' : 'stop',
    usage,
    responseMessageId
  };
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

function hasSemanticDeepSeekEvent(data: any, state: { path: string }): boolean {
  if (typeof data?.p === 'string') state.path = data.p;
  const value = data?.v;
  if (typeof value === 'string') {
    if (!value || value === 'FINISHED') return false;
    return state.path.includes('content') || data?.o === 'APPEND';
  }
  const fragments = value?.response?.fragments;
  if (Array.isArray(fragments)) {
    return fragments.some((fragment: any) => typeof fragment?.content === 'string' && fragment.content.length > 0);
  }
  if (Array.isArray(value)) {
    return value.some((fragment: any) => typeof fragment?.content === 'string' && fragment.content.length > 0);
  }
  return false;
}

async function peekStream(stream: ReadableStream): Promise<{ isEmpty: boolean; peekedStream: ReadableStream }> {
  const reader = stream.getReader();
  const bufferedChunks: Uint8Array[] = [];
  const decoder = new TextDecoder();
  const state = { path: '' };
  let lineBuffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        reader.releaseLock();
        return { isEmpty: true, peekedStream: new ReadableStream({ start(controller) { controller.close(); } }) };
      }

      bufferedChunks.push(value);
      lineBuffer += decoder.decode(value, { stream: true });
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() || '';
      let semantic = false;
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;
        const raw = trimmed.slice(6);
        if (raw === '[DONE]') continue;
        try {
          if (hasSemanticDeepSeekEvent(JSON.parse(raw), state)) {
            semantic = true;
            break;
          }
        } catch {}
      }

      if (!semantic) continue;
      const peekedStream = new ReadableStream({
        async start(controller) {
          for (const chunk of bufferedChunks) controller.enqueue(chunk);
          try {
            while (true) {
              const next = await reader.read();
              if (next.done) {
                controller.close();
                break;
              }
              controller.enqueue(next.value);
            }
          } catch (error) {
            controller.error(error);
          }
        },
        async cancel(reason) {
          await reader.cancel(reason);
        }
      });
      return { isEmpty: false, peekedStream };
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    try { reader.releaseLock(); } catch {}
    throw error;
  }
}

export async function chatCompletions(c: Context) {
  try {
    const body: OpenAIRequest = await c.req.json();
    const isStream = body.stream ?? false;
    const messages = body.messages || [];
    const bodyAny = body as any;
    const explicitSessionKey = (
      typeof bodyAny.session_id === 'string' && bodyAny.session_id.trim()
        ? bodyAny.session_id.trim()
        : (c.req.header('x-deeps-session') || c.req.header('x-session-id') || undefined)
    );
    const initialSession = findExplicitSession(explicitSessionKey) || findLineageSession(messages);
    let hybridSession = initialSession;
    let releaseBootstrapLock: (() => void) | undefined;
    let releaseSessionLock: (() => void) | undefined;
    let heldCanonicalSessionId: string | undefined;
    let lockTransferredToStream = false;

    try {
      // Unknown explicit keys serialize their bootstrap. Once the first request
      // registers a chat, queued requests migrate to that chat's canonical lock.
      if (!hybridSession && explicitSessionKey) {
        releaseBootstrapLock = await acquireSessionLease(`explicit:${explicitSessionKey}`);
        if (!releaseBootstrapLock) {
          c.header('Retry-After', '1');
          return c.json({ error: { message: 'Timed out waiting for the conversation session', type: 'rate_limit_exceeded', code: 'session_busy' } }, 429);
        }
        hybridSession = findExplicitSession(explicitSessionKey) || findLineageSession(messages);
      }

      if (hybridSession) {
        releaseSessionLock = await acquireSessionLease(`chat:${hybridSession.chatSessionId}`);
        if (!releaseSessionLock) {
          c.header('Retry-After', '1');
          return c.json({ error: { message: 'Timed out waiting for the conversation session', type: 'rate_limit_exceeded', code: 'session_busy' } }, 429);
        }
        heldCanonicalSessionId = hybridSession.chatSessionId;
        releaseBootstrapLock?.();
        releaseBootstrapLock = undefined;
        // Re-read after waiting: an earlier request may have advanced the chat.
        hybridSession = findExplicitSession(explicitSessionKey) || findLineageSession(messages);
      } else {
        releaseSessionLock = releaseBootstrapLock;
        releaseBootstrapLock = undefined;
      }

      const outboundMessages = hybridSession
        ? (hybridSession.matchedLength !== undefined
            ? messages.slice(hybridSession.matchedLength)
            : incrementalMessages(messages))
        : messages;
      const response = await chatCompletionsHybrid(
        c, body, messages, outboundMessages,
        hybridSession, explicitSessionKey,
        isStream ? releaseSessionLock : undefined,
        isStream ? heldCanonicalSessionId : undefined
      );
      lockTransferredToStream = isStream && !!releaseSessionLock;
      return response;
    } finally {
      releaseBootstrapLock?.();
      if (!lockTransferredToStream) releaseSessionLock?.();
    }
  } catch (err: any) {
    console.error('Error in chatCompletions dispatch:', err);
    const message = err?.message || String(err);
    const upstreamStatus = Number(err?.upstreamStatus);
    let status = err?.upstreamStatus === undefined
      ? 500
      : (Number.isInteger(upstreamStatus) && upstreamStatus >= 400 && upstreamStatus <= 599 ? upstreamStatus : 502);
    let code = status === 429 ? 'rate_limit_exceeded' : 'upstream_error';
    if (/account is suspended/i.test(message)) {
      status = 403;
      code = 'deepseek_account_suspended';
    } else if (/login is required/i.test(message)) {
      status = 401;
      code = 'deepseek_login_required';
    } else if (/chat input unavailable|Timeout waiting for chat input/i.test(message)) {
      status = 409;
      code = 'deepseek_chat_unavailable';
    }
    return c.json({ error: { message, type: code, code } }, status as any);
  }
}

function isNonRetryableFailure(error: any): boolean {
  const status = error?.upstreamStatus;
  const message = error?.message || String(error);
  return status === 401 || status === 403 || status === 429 || status === 503 || status === 504 ||
    /account is suspended|login is required|chat input unavailable|Timeout waiting for chat input/i.test(message);
}

async function chatCompletionsHybrid(
  c: Context,
  body: OpenAIRequest,
  messages: any[],
  outboundMessages: any[],
  hybridSession: { chatSessionId: string; parentMessageId: number | null; matchedLength?: number } | undefined,
  explicitSessionKey: string | undefined,
  releaseSessionLock?: () => void,
  heldCanonicalSessionId?: string
) {
  const isStream = body.stream ?? false;
  const canPublishLineage = !hybridSession || hybridSession.matchedLength !== undefined;

    const isThinkingModel = body.model.includes('thinking');
    const isProModel = body.model.includes('pro');
    const completionId = 'chatcmpl-' + uuidv4();

    if (!isStream) {
      let attempt = 0;
      const maxAttempts = 3;
      let lastError: any = null;
      let parsedResult: ParsedCompletion | null = null;
      let finalUiSessionId = '';

      while (attempt < maxAttempts) {
        attempt++;
        const telemetry = getModelTelemetry(body.model);
        const currentTargetLimit = telemetry.detectedLimit;
        
        const compressed = compressMessages(outboundMessages, currentTargetLimit, serializeOpenAIMessages);
        const serialized = serializeOpenAIMessages(compressed);
        const systemPrompt = appendToolInstructions(serialized.systemPrompt, body);
        const finalPrompt = systemPrompt ? `${systemPrompt}\n${serialized.prompt}` : serialized.prompt;
        const promptSize = finalPrompt.length;
        const promptTokens = Math.ceil(promptSize / 3.5);

        try {
          console.log(`[Chat] Attempt ${attempt}/${maxAttempts} (non-stream) with prompt length ${promptSize} chars.`);
          const result = await createDeepSeekStream(
            finalPrompt,
            isThinkingModel,
            isProModel,
            hybridSession ? hybridSession.parentMessageId : null,
            hybridSession?.chatSessionId
          );
          
          const parsed = await parseDeepSeekStreamToOpenAI(
            result.stream,
            completionId,
            body.model,
            promptTokens,
            result.uiSessionId,
            (body as any).tools || []
          );

          if (parsed.content === '' && parsed.reasoningContent === '' && parsed.toolCalls.length === 0) {
            console.warn(`[Chat] Attempt ${attempt} (non-stream) response was empty.`);
            if (attempt >= maxAttempts) {
              lastError = new Error("Failed to get a non-empty response from DeepSeek after multiple attempts.");
              break;
            }
            continue;
          }

          // Success!
          if (parsed.responseMessageId !== null) {
            updateSessionParent(result.uiSessionId, parsed.responseMessageId);
          }
          recordSuccess(body.model, promptSize);
          parsedResult = parsed;
          finalUiSessionId = result.uiSessionId;
          break;
        } catch (err: any) {
          console.error(`[Chat] Attempt ${attempt} (non-stream) failed:`, err.message);
          lastError = err;
          if (isContextOverflowError(err)) {
            recordFailure(body.model, promptSize);
          }
          if (isNonRetryableFailure(err) || attempt >= maxAttempts) {
            break;
          }
          await new Promise(r => setTimeout(r, 1000));
        }
      }

      if (!parsedResult) {
        throw lastError || new Error("Failed to get a non-empty response from DeepSeek after multiple attempts.");
      }

      const message: any = {
        role: 'assistant',
        content: parsedResult.toolCalls.length > 0 ? null : parsedResult.content
      };
      if (parsedResult.reasoningContent) message.reasoning_content = parsedResult.reasoningContent;
      if (parsedResult.toolCalls.length > 0) message.tool_calls = parsedResult.toolCalls;
      if (parsedResult.responseMessageId !== null) {
        if (canPublishLineage) registerLineageSession([...messages, message], finalUiSessionId, parsedResult.responseMessageId);
        registerExplicitSession(explicitSessionKey, finalUiSessionId, parsedResult.responseMessageId);
        registerExplicitSession(finalUiSessionId, finalUiSessionId, parsedResult.responseMessageId);
      }

      return c.json({
        id: completionId,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        session_id: finalUiSessionId,
        choices: [{
          index: 0,
          message,
          logprobs: null,
          finish_reason: parsedResult.finishReason
        }],
        usage: parsedResult.usage
      });
    }

    // Streaming mode
    let deepSeekStream: ReadableStream | null = null;
    let uiSessionId = '';
    let attempt = 0;
    const maxAttempts = 3;
    let lastError: any = null;
    let promptSizeUsed = 0;
    let releaseCanonicalStreamLock: (() => void) | undefined;
    let provisionalSessionPublished = false;

    while (attempt < maxAttempts) {
      attempt++;
      const telemetry = getModelTelemetry(body.model);
      const currentTargetLimit = telemetry.detectedLimit;
      
      const compressed = compressMessages(outboundMessages, currentTargetLimit, serializeOpenAIMessages);
      const serialized = serializeOpenAIMessages(compressed);
      const systemPrompt = appendToolInstructions(serialized.systemPrompt, body);
      const finalPrompt = systemPrompt ? `${systemPrompt}\n${serialized.prompt}` : serialized.prompt;
      promptSizeUsed = finalPrompt.length;

      try {
        console.log(`[Chat] Attempt ${attempt}/${maxAttempts} (stream) with prompt length ${promptSizeUsed} chars.`);
        const result = await createDeepSeekStream(
            finalPrompt,
            isThinkingModel,
            isProModel,
            hybridSession ? hybridSession.parentMessageId : null,
            hybridSession?.chatSessionId
          );
        
        // Peek the stream to verify it has content
        const { isEmpty, peekedStream } = await peekStream(result.stream);
        if (isEmpty) {
          console.warn(`[Chat] Attempt ${attempt} (stream) peeked stream was empty.`);
          if (attempt >= maxAttempts) {
            lastError = new Error("Failed to get a valid stream from DeepSeek after multiple attempts.");
            break;
          }
          continue;
        }

        // Success!
        recordSuccess(body.model, promptSizeUsed);
        deepSeekStream = peekedStream;
        uiSessionId = result.uiSessionId;
        break;
      } catch (err: any) {
        console.error(`[Chat] Attempt ${attempt} (stream) failed:`, err.message);
        lastError = err;
        if (isContextOverflowError(err)) {
          recordFailure(body.model, promptSizeUsed);
        }
        if (isNonRetryableFailure(err) || attempt >= maxAttempts) {
          break;
        }
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    if (!deepSeekStream) {
      throw lastError || new Error("Failed to get a valid stream from DeepSeek after multiple attempts.");
    }

    // A bootstrap initially owns explicit:<key>. Acquire the canonical chat lock
    // before the chat can be registered under lineage/other aliases, and hold
    // both leases until the client stream completes or is cancelled.
    if (!hybridSession && uiSessionId) {
      if (heldCanonicalSessionId !== uiSessionId) {
        releaseCanonicalStreamLock = await acquireSessionLease(`chat:${uiSessionId}`);
        if (!releaseCanonicalStreamLock) {
          await deepSeekStream.cancel(new Error('Timed out waiting for the canonical session lease')).catch(() => {});
          const error: any = new Error('Timed out waiting for the conversation session');
          error.upstreamStatus = 429;
          throw error;
        }
      }
      registerExplicitSession(uiSessionId, uiSessionId, null);
      provisionalSessionPublished = true;
    }

    c.header('Content-Type', 'text/event-stream');
    c.header('Cache-Control', 'no-cache');
    c.header('Connection', 'keep-alive');
    c.header('x-deeps-session', uiSessionId);
    c.header('Access-Control-Expose-Headers', 'x-deeps-session');

    const promptTokens = Math.ceil(promptSizeUsed / 3.5);

    const downstreamAbort = new AbortController();
    const deepSeekReader = deepSeekStream.getReader();
    let cleanupPromise: Promise<void> | undefined;
    const cleanup = (reason: any = new Error('Proxy stream closed')): Promise<void> => {
      if (!cleanupPromise) {
        cleanupPromise = (async () => {
          if (!downstreamAbort.signal.aborted) downstreamAbort.abort(reason);
          await deepSeekReader.cancel(reason).catch(() => {});
          if (provisionalSessionPublished) {
            unregisterExplicitSession(uiSessionId, uiSessionId, true);
          }
          releaseSessionLock?.();
          releaseCanonicalStreamLock?.();
        })();
      }
      return cleanupPromise;
    };
    const encoder = new TextEncoder();
    const responseStream = new ReadableStream<Uint8Array>({
      start(controller) {
        const writeEvent = async (data: any) => {
          if (downstreamAbort.signal.aborted) throw downstreamAbort.signal.reason;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        };
        void (async () => {
          try {
            await writeEvent(makeChunk(completionId, body.model, { role: 'assistant', content: '' }));

            const parsed = await parseDeepSeekStreamToOpenAI(
              deepSeekStream!,
              completionId,
              body.model,
              promptTokens,
              uiSessionId,
              (body as any).tools || [],
              writeEvent,
              deepSeekReader
            );

            if (
              !downstreamAbort.signal.aborted &&
              parsed.responseMessageId !== null &&
              (parsed.content !== '' || parsed.reasoningContent !== '' || parsed.toolCalls.length > 0)
            ) {
              updateSessionParent(uiSessionId, parsed.responseMessageId);
              const assistantMessage: any = {
                role: 'assistant',
                content: parsed.toolCalls.length > 0 ? null : parsed.content,
              };
              if (parsed.reasoningContent) assistantMessage.reasoning_content = parsed.reasoningContent;
              if (parsed.toolCalls.length > 0) assistantMessage.tool_calls = parsed.toolCalls;
              if (canPublishLineage) registerLineageSession([...messages, assistantMessage], uiSessionId, parsed.responseMessageId);
              registerExplicitSession(explicitSessionKey, uiSessionId, parsed.responseMessageId);
              registerExplicitSession(uiSessionId, uiSessionId, parsed.responseMessageId);
            }

            await writeEvent(makeChunk(completionId, body.model, {}, parsed.finishReason, parsed.usage));
            if (!downstreamAbort.signal.aborted) {
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              controller.close();
            }
          } catch (error: any) {
            if (!downstreamAbort.signal.aborted) {
              const code = error?.upstreamStatus === 504 ? 'upstream_timeout' : 'upstream_stream_error';
              try {
                await writeEvent({
                  error: {
                    message: error?.message || String(error),
                    type: code,
                    code,
                  }
                });
                controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                controller.close();
              } catch {}
            }
          } finally {
            await cleanup();
          }
        })();
      },
      async cancel(reason) {
        await cleanup(reason || new Error('Downstream client disconnected'));
      }
    });

    return c.body(responseStream as any);
}
