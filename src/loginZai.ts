/*
 * File: loginZai.ts
 * Project: deepsproxy
 * Z.ai Login — Opens a browser for the user to log in to chat.z.ai
 * and saves the session token for the Z.ai provider.
 */

import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { acquireProfileLock, releaseProfileLock } from './utils/profileLock.ts';

const PROFILE_PATH = path.resolve('zai_profile');
const TOKEN_FILE = path.resolve('zai_token.json');

async function main() {
  console.log('');
  console.log('═══════════════════════════════════════════════════');
  console.log('  Z.ai Login — Faça login no chat.z.ai');
  console.log('═══════════════════════════════════════════════════');
  console.log('');
  console.log('Um navegador vai abrir. Faça login na sua conta Z.ai.');
  console.log('Depois de logado, o token será salvo automaticamente.');
  console.log('');

  const lockPath = acquireProfileLock(PROFILE_PATH);
  const context = await chromium.launchPersistentContext(PROFILE_PATH, {
    headless: false,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
    ],
  });

  const page = await context.newPage();
  await page.goto('https://chat.z.ai/', { waitUntil: 'domcontentloaded' });

  console.log('Aguardando login...');
  console.log('(O script vai detectar automaticamente quando você estiver logado)');
  console.log('');

  // Poll for the token by checking the auth endpoint using cookies from the browser
  let attempts = 0;
  const maxAttempts = 120; // 2 minutes

  while (attempts < maxAttempts) {
    await new Promise(r => setTimeout(r, 2000));
    attempts++;

    try {
      // Try to extract the token from localStorage or by calling the auth API
      const tokenData = await page.evaluate(async () => {
        try {
          // Check if user is logged in by looking at localStorage
          const token = localStorage.getItem('token');
          if (token && token !== 'null' && token !== 'undefined') {
            // Verify the token by calling auth endpoint
            const res = await fetch('/api/v1/auths/', {
              headers: {
                'Authorization': `Bearer ${token}`,
                'X-FE-Version': 'prod-fe-1.0.111',
              }
            });
            if (res.ok) {
              const data = await res.json();
              if (data.role && data.role !== 'guest') {
                return { token, id: data.id, name: data.name, role: data.role, email: data.email };
              }
            }
          }

          // Also check cookies
          const cookies = document.cookie;
          const tokenMatch = cookies.match(/token=([^;]+)/);
          if (tokenMatch) {
            const cookieToken = tokenMatch[1];
            const res = await fetch('/api/v1/auths/', {
              headers: {
                'Authorization': `Bearer ${cookieToken}`,
                'X-FE-Version': 'prod-fe-1.0.111',
              }
            });
            if (res.ok) {
              const data = await res.json();
              if (data.role && data.role !== 'guest') {
                return { token: cookieToken, id: data.id, name: data.name, role: data.role, email: data.email };
              }
            }
          }
        } catch (e) {
          // not logged in yet
        }
        return null;
      });

      if (tokenData) {
        console.log('');
        console.log('✅ Login detectado!');
        console.log(`   Usuário: ${tokenData.name} (${tokenData.email})`);
        console.log(`   Role: ${tokenData.role}`);
        console.log(`   ID: ${tokenData.id}`);
        console.log('');

        // Save token
        fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokenData, null, 2));
        console.log(`Token salvo em: ${TOKEN_FILE}`);
        console.log('');
        console.log('Agora reinicie o servidor com:');
        console.log('  npm start');
        console.log('');
        
        await context.close();
        releaseProfileLock(lockPath);
        process.exit(0);
      }
    } catch (e) {
      // keep trying
    }

    if (attempts % 10 === 0) {
      console.log(`  ... ainda aguardando login (${attempts * 2}s)`);
    }
  }

  console.log('');
  console.log('⏰ Timeout — não foi possível detectar o login.');
  console.log('Tente novamente ou configure o token manualmente no .env:');
  console.log('  ZAI_TOKEN=seu_token_aqui');
  
  await context.close();
  releaseProfileLock(lockPath);
  process.exit(1);
}

main().catch(e => {
  console.error('Erro:', e.message);
  process.exit(1);
});
