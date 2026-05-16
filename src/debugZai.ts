/*
 * Debug script: intercept a real Z.ai chat request from the browser
 * to discover what extra headers/params are needed for the API.
 */

import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { acquireProfileLock, releaseProfileLock } from './utils/profileLock.ts';

const PROFILE_PATH = path.resolve('zai_profile');

function maskSecret(key: string, value: string): string {
  const lower = key.toLowerCase();
  if (lower.includes('authorization') || lower.includes('cookie') || lower.includes('token') || lower.includes('signature')) {
    if (!value) return value;
    return `${value.slice(0, 8)}...${value.slice(-4)}`;
  }
  return value;
}

function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key, maskSecret(key, value)])
  );
}

async function main() {
  console.log('Opening Z.ai in browser with your saved session...');
  console.log('Type a message in the chat and send it.');
  console.log('The script will capture the request details.\n');

  const lockPath = acquireProfileLock(PROFILE_PATH);
  const context = await chromium.launchPersistentContext(PROFILE_PATH, {
    headless: false,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  });

  const page = await context.newPage();

  // Intercept any chat completion request
  page.on('request', request => {
    const url = request.url();
    if (url.includes('/api/') && url.includes('chat') && url.includes('completions')) {
      console.log('\n═══ INTERCEPTED REQUEST ═══');
      console.log('URL:', url);
      console.log('\nHEADERS:');
      const headers = request.headers();
      for (const [key, value] of Object.entries(headers)) {
        // Skip standard browser headers
        if (['accept', 'accept-encoding', 'accept-language', 'connection', 'host', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site'].includes(key)) continue;
        console.log(`  ${key}: ${maskSecret(key, value).substring(0, 100)}`);
      }
      
      console.log('\nBODY:');
      const postData = request.postData();
      if (postData) {
        try {
          const body = JSON.parse(postData);
          console.log(JSON.stringify(body, null, 2));
        } catch {
          console.log(postData.substring(0, 500));
        }
      }

      // Parse query params
      const urlObj = new URL(url);
      console.log('\nQUERY PARAMS:');
      for (const [key, value] of urlObj.searchParams.entries()) {
        console.log(`  ${key}: ${value}`);
      }

      // Save to file for analysis
      fs.writeFileSync('zai_debug_request.json', JSON.stringify({
        url,
        headers: sanitizeHeaders(headers),
        body: postData ? JSON.parse(postData) : null,
        queryParams: Object.fromEntries(urlObj.searchParams.entries()),
      }, null, 2));
      console.log('\nSaved to zai_debug_request.json');
      console.log('═══════════════════════════\n');
    }
  });

  await page.goto('https://chat.z.ai/', { waitUntil: 'domcontentloaded' });

  console.log('Browser open. Type a message and send it...');
  console.log('Press Ctrl+C to exit after capturing.\n');

  // Keep alive
  process.once('SIGINT', async () => {
    await context.close().catch(() => {});
    releaseProfileLock(lockPath);
    process.exit(0);
  });

  await new Promise(() => {});
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
