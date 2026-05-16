/*
 * Local diagnostics for DeepsProxy. This intentionally avoids sending real chat
 * prompts; it checks filesystem, config, and lightweight app endpoints.
 */

import fs from 'fs';
import path from 'path';
import * as dotenv from 'dotenv';
import { chromium } from 'playwright';
import { app } from './index.ts';
import { router } from './providers/router.ts';

dotenv.config();

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

async function main() {
  process.env.TEST_MOCK_PLAYWRIGHT = process.env.DOCTOR_MOCK_PLAYWRIGHT || process.env.TEST_MOCK_PLAYWRIGHT || 'true';
  await router.initialize();

  const checks: Check[] = [];
  checks.push(checkNode());
  checks.push(await checkPlaywright());
  checks.push(checkProfile('deepseek_profile'));
  checks.push(checkProfile('zai_profile', false));
  checks.push(checkFile('zai_token.json', false));
  checks.push(await checkEndpoint('/health'));
  checks.push(await checkEndpoint('/v1/models'));
  checks.push(await checkProviderStatus());

  for (const check of checks) {
    console.log(`${check.ok ? 'OK ' : 'BAD'} ${check.name}: ${check.detail}`);
  }

  const failed = checks.filter(c => !c.ok);
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

function checkNode(): Check {
  const major = Number.parseInt(process.versions.node.split('.')[0], 10);
  return {
    name: 'node',
    ok: major >= 20,
    detail: process.version,
  };
}

async function checkPlaywright(): Promise<Check> {
  try {
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    return { name: 'playwright chromium', ok: true, detail: 'launch ok' };
  } catch (err: any) {
    return { name: 'playwright chromium', ok: false, detail: err.message };
  }
}

function checkProfile(profileName: string, required = true): Check {
  const profilePath = path.resolve(profileName);
  const exists = fs.existsSync(profilePath);
  const lockPath = path.join(profilePath, '.deepsproxy.lock');
  const locked = fs.existsSync(lockPath);
  return {
    name: profileName,
    ok: required ? exists && !locked : !locked,
    detail: `${exists ? 'exists' : 'missing'}${locked ? ', locked' : ''}`,
  };
}

function checkFile(fileName: string, required = true): Check {
  const exists = fs.existsSync(path.resolve(fileName));
  return {
    name: fileName,
    ok: required ? exists : true,
    detail: exists ? 'exists' : 'missing',
  };
}

async function checkEndpoint(endpoint: string): Promise<Check> {
  try {
    const req = new Request(`http://localhost${endpoint}`);
    const res = await app.fetch(req);
    return {
      name: endpoint,
      ok: res.status >= 200 && res.status < 500,
      detail: `HTTP ${res.status}`,
    };
  } catch (err: any) {
    return { name: endpoint, ok: false, detail: err.message };
  }
}

async function checkProviderStatus(): Promise<Check> {
  const req = new Request('http://localhost/v1/provider-status');
  const res = await app.fetch(req);
  const body = await res.json() as any;
  const providers = Object.keys(body.providers || {}).filter(k => k !== 'router');
  return {
    name: 'provider aliases',
    ok: Boolean(body.aliases?.['cheap-coder']) && providers.length > 0,
    detail: `providers=${providers.join(',')}; aliases=${Object.keys(body.aliases || {}).join(',')}`,
  };
}

main().catch(err => {
  console.error('doctor failed:', err.message);
  process.exit(1);
});
