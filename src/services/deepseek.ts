/*
 * File: deepseek.ts
 * Project: deepsproxy
 * Author: Pedro Farias
 * Created: 2026-05-09
 * 
 * Last Modified: Sat May 09 2026
 * Modified By: Pedro Farias
 */

import { getDeepSeekHeaders } from './playwright.ts';

function upstreamTimeoutMs(): number {
  const configured = Number(process.env.DEEPSPROXY_UPSTREAM_TIMEOUT_MS || '300000');
  return Number.isFinite(configured) && configured > 0 ? configured : 300000;
}

function timeoutError(): Error & { upstreamStatus: number } {
  const error = new Error('DeepSeek upstream stream timed out') as Error & { upstreamStatus: number };
  error.upstreamStatus = 504;
  return error;
}

function withStreamDeadline(
  stream: ReadableStream,
  abortController: AbortController,
  timeoutMs: number
): ReadableStream {
  const reader = stream.getReader();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    const error = timeoutError();
    abortController.abort(error);
    void reader.cancel(error).catch(() => {});
  }, timeoutMs);

  const clear = () => clearTimeout(timer);
  return new ReadableStream({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (timedOut) {
          clear();
          controller.error(timeoutError());
        } else if (next.done) {
          clear();
          controller.close();
        } else {
          controller.enqueue(next.value);
        }
      } catch (error) {
        clear();
        controller.error(timedOut ? timeoutError() : error);
      }
    },
    async cancel(reason) {
      clear();
      abortController.abort(reason);
      await reader.cancel(reason).catch(() => {});
    }
  });
}

interface SessionParentState {
  parentId: number | null;
  updatedAt: number;
}

const MAX_SESSION_STATES = 2_000;
const SESSION_STATE_TTL_MS = 24 * 60 * 60 * 1000;
const sessionStates: Map<string, SessionParentState> =
  (globalThis as any)._deepsSessionStatesV2 || new Map<string, SessionParentState>();
(globalThis as any)._deepsSessionStatesV2 = sessionStates;

function pruneSessionStates(): void {
  const cutoff = Date.now() - SESSION_STATE_TTL_MS;
  for (const [sessionId, state] of sessionStates) {
    if (state.updatedAt < cutoff) sessionStates.delete(sessionId);
  }
  if (sessionStates.size < MAX_SESSION_STATES) return;
  const oldest = [...sessionStates.entries()]
    .sort(([, a], [, b]) => a.updatedAt - b.updatedAt)
    .slice(0, sessionStates.size - MAX_SESSION_STATES + 1);
  for (const [sessionId] of oldest) sessionStates.delete(sessionId);
}

export function updateSessionParent(sessionId: string, parentId: number | null) {
  if (sessionId) {
    pruneSessionStates();
    sessionStates.set(sessionId, { parentId, updatedAt: Date.now() });
  }
}

export interface DeepSeekPayload {
  chat_session_id?: string;
  parent_message_id?: number | null;
  model_type: string | null;
  prompt: string;
  ref_file_ids: string[];
  thinking_enabled: boolean;
  search_enabled: boolean;
  preempt: boolean;
}

export async function createDeepSeekStream(
  prompt: string,
  enableThinking: boolean,
  isProModel: boolean = false,
  forcedParentId?: number | null,
  existingChatSessionId?: string
): Promise<{ stream: ReadableStream, headers: Record<string, string>, uiSessionId: string }> {
  // Obtain fresh auth/PoW headers from Playwright. A continuation keeps the
  // DeepSeek chat id supplied by the caller instead of minting a new chat.
  const captured = await getDeepSeekHeaders(!existingChatSessionId && forcedParentId === null);
  const { headers, parentMessageId } = captured;
  const chatSessionId = existingChatSessionId || captured.chatSessionId;

  // Determine the actual parent ID:
  // 1. If forcedParentId is provided (even if null), use it.
  // 2. If tracked parent ID is available for this session, use it.
  // 3. Fallback to Playwright's state.
  let actualParentId: number | null = parentMessageId;
  
  if (forcedParentId !== undefined) {
    actualParentId = forcedParentId;
  } else if (chatSessionId) {
    const tracked = sessionStates.get(chatSessionId);
    if (tracked && Date.now() - tracked.updatedAt <= SESSION_STATE_TTL_MS) {
      tracked.updatedAt = Date.now();
      actualParentId = tracked.parentId;
    } else if (tracked) {
      sessionStates.delete(chatSessionId);
    }
  }

  const payload: DeepSeekPayload = {
    chat_session_id: chatSessionId || undefined,
    parent_message_id: actualParentId,
    model_type: isProModel ? 'expert' : null,
    prompt: prompt,
    ref_file_ids: [],
    thinking_enabled: enableThinking,
    // DeepSeek Web's Expert/Pro mode does not support web search. Sending
    // search_enabled=true with model_type=expert eventually yields empty turns.
    search_enabled: !isProModel,
    preempt: false
  };

  const requestTimeoutMs = upstreamTimeoutMs();
  const abortController = new AbortController();
  const fetchTimer = setTimeout(() => abortController.abort(timeoutError()), requestTimeoutMs);
  let response: Response;
  try {
    response = await fetch('https://chat.deepseek.com/api/v0/chat/completion', {
      method: 'POST',
      signal: abortController.signal,
      headers: {
      'accept': '*/*',
      'accept-language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
      'authorization': headers['authorization'],
      'content-type': 'application/json',
      'origin': 'https://chat.deepseek.com',
      'x-ds-pow-response': headers['x-ds-pow-response'],
      'x-hif-dliq': headers['x-hif-dliq'],
      'x-hif-leim': headers['x-hif-leim'],
      'x-app-version': '2.0.0',
      'x-client-locale': 'pt_BR',
      'x-client-platform': 'web',
      'x-client-version': '2.0.0'
      },
      body: JSON.stringify(payload)
    });
  } catch (error) {
    if (abortController.signal.aborted) throw timeoutError();
    throw error;
  } finally {
    clearTimeout(fetchTimer);
  }

  if (!response.ok || !response.body) {
    const errText = await response.text().catch(() => '');
    const error: any = new Error(`Failed to fetch from DeepSeek: ${response.status} ${response.statusText} - ${errText}`);
    error.upstreamStatus = response.status;
    error.upstreamBody = errText;
    throw error;
  }

  return {
    stream: withStreamDeadline(response.body, abortController, requestTimeoutMs),
    headers,
    uiSessionId: chatSessionId
  };
}
