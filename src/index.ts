/*
 * File: index.ts
 * Project: deepsproxy
 * Author: Pedro Farias
 * Created: 2026-05-09
 * 
 * Last Modified: Sat May 09 2026
 * Modified By: Pedro Farias
 */

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { chatCompletions } from './routes/chat.ts';
import * as dotenv from 'dotenv';
import { initPlaywright } from './services/playwright.ts';

dotenv.config();

export const app = new Hono();

export function resolveListenHost(value?: string): string {
  return value?.trim() || '127.0.0.1';
}

export function assertSafeListenConfig(host: string, apiKey?: string): void {
  const loopbackHosts = new Set(['127.0.0.1', '::1', 'localhost']);
  if (!loopbackHosts.has(host) && !apiKey?.trim()) {
    throw new Error('API_KEY is required when HOST is not a loopback address');
  }
}

function modelEntry(id: string) {
  const contextWindow = 1_000_000;
  return {
    id,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'deepseek',
    permission: [],
    root: id,
    parent: null,
    context_length: contextWindow,
    max_context_tokens: contextWindow,
    max_input_tokens: contextWindow,
    max_output_tokens: 8_000,
  };
}

app.use('*', cors());

app.use('*', async (c, next) => {
  const apiKey = process.env.API_KEY;
  if (apiKey) {
    const authHeader = c.req.header('Authorization');
    const xApiKey = c.req.header('X-API-Key');
    const providedKey = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : xApiKey;
    if (!providedKey || providedKey !== apiKey) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
  }
  await next();
});

// Basic health check
app.get('/health', (c) => c.json({ status: 'ok' }));

// OpenAI compatible routes
app.post('/v1/chat/completions', chatCompletions);

app.get('/v1/models', (c) => {
  return c.json({
    object: 'list',
    data: [
      modelEntry('deepseek-v4-flash'),
      modelEntry('deepseek-v4-flash-thinking'),
      modelEntry('deepseek-v4-pro'),
      modelEntry('deepseek-v4-pro-thinking')
    ]
  });
});

// Initialize playwright when server starts
import { fileURLToPath } from 'url';

const handleOutputError = (error: any) => {
  if (error?.code !== 'EPIPE') throw error;
};
process.stdout?.on('error', handleOutputError);
process.stderr?.on('error', handleOutputError);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const host = resolveListenHost(process.env.HOST);
  try {
    assertSafeListenConfig(host, process.env.API_KEY);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
  initPlaywright().then(() => {
    console.log('Playwright initialized.');
    const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;
    console.log(`Server is running on port ${port}`);

    serve({
      fetch: app.fetch,
      port,
      hostname: host
    });
  }).catch((err: any) => {
    console.error('Failed to initialize playwright:', err);
    process.exit(1);
  });
}
