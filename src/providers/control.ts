/*
 * Provider execution controls: small FIFO limiter with max concurrency,
 * minimum interval, queue timeout, and observable queue depth.
 */

export interface ProviderLimiterOptions {
  maxConcurrent: number;
  minIntervalMs: number;
  queueTimeoutMs: number;
}

interface QueuedTask<T> {
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  timer: NodeJS.Timeout;
}

export class ProviderLimiter {
  private active = 0;
  private lastStartAt = 0;
  private queue: QueuedTask<unknown>[] = [];

  constructor(private readonly options: ProviderLimiterOptions) {}

  get queueDepth(): number {
    return this.queue.length;
  }

  get activeCount(): number {
    return this.active;
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const queued: QueuedTask<T> = {
        run: task,
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.queue.indexOf(queued as QueuedTask<unknown>);
          if (index !== -1) {
            this.queue.splice(index, 1);
            reject(new Error('Provider queue timeout'));
          }
        }, this.options.queueTimeoutMs),
      };

      this.queue.push(queued as QueuedTask<unknown>);
      this.drain();
    });
  }

  private drain(): void {
    if (this.active >= this.options.maxConcurrent) return;
    const next = this.queue.shift();
    if (!next) return;

    clearTimeout(next.timer);
    const minIntervalMs = process.env.TEST_MOCK_PLAYWRIGHT ? 0 : this.options.minIntervalMs;
    const delay = Math.max(0, minIntervalMs - (Date.now() - this.lastStartAt));

    setTimeout(async () => {
      this.active++;
      this.lastStartAt = Date.now();
      try {
        const result = await next.run();
        next.resolve(result);
      } catch (err) {
        next.reject(err);
      } finally {
        this.active--;
        this.drain();
      }
    }, delay);
  }
}

export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
