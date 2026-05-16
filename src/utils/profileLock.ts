/*
 * Lightweight profile locks prevent two server processes from using the same
 * persistent browser profile at the same time.
 */

import fs from 'fs';
import path from 'path';

const ownedLocks = new Set<string>();

export function acquireProfileLock(profilePath: string): string {
  fs.mkdirSync(profilePath, { recursive: true });
  const lockPath = path.join(profilePath, '.deepsproxy.lock');
  const payload = JSON.stringify({
    pid: process.pid,
    createdAt: new Date().toISOString(),
  });

  try {
    const fd = fs.openSync(lockPath, 'wx');
    fs.writeFileSync(fd, payload);
    fs.closeSync(fd);
    ownedLocks.add(lockPath);
    return lockPath;
  } catch (err: any) {
    if (err?.code !== 'EEXIST') throw err;

    const existing = readLock(lockPath);
    if (existing?.pid && isProcessAlive(existing.pid)) {
      throw new Error(`Profile is already locked by pid ${existing.pid}: ${profilePath}`);
    }

    fs.rmSync(lockPath, { force: true });
    const fd = fs.openSync(lockPath, 'wx');
    fs.writeFileSync(fd, payload);
    fs.closeSync(fd);
    ownedLocks.add(lockPath);
    return lockPath;
  }
}

export function releaseProfileLock(lockPath: string | null | undefined): void {
  if (!lockPath || !ownedLocks.has(lockPath)) return;
  fs.rmSync(lockPath, { force: true });
  ownedLocks.delete(lockPath);
}

export function releaseAllProfileLocks(): void {
  for (const lockPath of Array.from(ownedLocks)) {
    releaseProfileLock(lockPath);
  }
}

function readLock(lockPath: string): { pid?: number } | null {
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
