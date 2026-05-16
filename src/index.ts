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
import { router } from './providers/router.ts';
import { closePlaywright } from './services/playwright.ts';
import { releaseAllProfileLocks } from './utils/profileLock.ts';

dotenv.config();

export const app = new Hono();

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

// Basic health check — includes provider status
app.get('/health', async (c) => {
  const providerHealth = router.getHealthStatus();
  const providerStatuses = Object.entries(providerHealth)
    .filter(([name]) => name !== 'router')
    .map(([, health]) => health.status);
  const hasHealthyProvider = providerStatuses.includes('healthy') || providerStatuses.includes('degraded');
  const hasOfflineProvider = providerStatuses.includes('offline');

  return c.json({
    status: hasHealthyProvider ? (hasOfflineProvider ? 'degraded' : 'ok') : 'offline',
    providers: providerHealth,
  });
});

app.get('/v1/provider-status', async (c) => {
  return c.json(router.getProviderStatus());
});

// OpenAI compatible routes
app.post('/v1/chat/completions', chatCompletions);

// Dynamic model listing from all providers
app.get('/v1/models', async (c) => {
  const models = await router.listAllModels();

  return c.json({
    object: 'list',
    data: models.map(m => ({
      id: m.id,
      object: 'model',
      created: m.created,
      owned_by: m.owned_by,
      permission: [],
      root: m.id,
      parent: null,
    })),
  });
});

// Initialize playwright and providers when server starts
import { fileURLToPath } from 'url';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  (async () => {
    // Initialize Playwright for DeepSeek provider
    try {
      await initPlaywright();
      console.log('Playwright initialized.');
    } catch (err: any) {
      console.warn('Playwright initialization failed (DeepSeek provider may be unavailable):', err.message);
    }

    // Initialize all providers (each independently)
    await router.initialize();

    const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;
    console.log(`Server is running on port ${port}`);

    serve({
      fetch: app.fetch,
      port
    });

    const shutdown = async (signal: string) => {
      console.log(`Received ${signal}, shutting down...`);
      try {
        await router.shutdown();
        await closePlaywright();
      } finally {
        releaseAllProfileLocks();
      }
      process.exit(0);
    };

    process.once('SIGINT', () => void shutdown('SIGINT'));
    process.once('SIGTERM', () => void shutdown('SIGTERM'));
  })().catch((err: any) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}
