/*
 * File: router.ts
 * Project: deepsproxy
 * Provider Router — routes model requests to the correct provider
 * with full error isolation between providers.
 */

import type {
  ChatProvider,
  ModelInfo,
  ProviderChatOptions,
  ProviderStreamEvent,
  ProviderErrorKind,
} from './types.ts';
import { ProviderError } from './types.ts';
import { DeepSeekProvider } from './deepseek.ts';
import { ZaiProvider } from './zai.ts';

// ─── Provider Registry ─────────────────────────────────────────────────────────

interface CircuitState {
  consecutiveFailures: number;
  cooldownUntil?: number;
  lastError?: string;
  lastErrorKind?: ProviderErrorKind;
  lastErrorAt?: number;
  lastSuccessAt?: number;
}

interface ModelCandidate {
  requestedModel: string;
  actualModel: string;
  isAlias: boolean;
}

const DEFAULT_ALIASES: Record<string, string[]> = {
  'cheap-coder': ['deepseek-v4-flash-thinking'],
  'fast-coder': ['deepseek-v4-flash'],
  'thinking-coder': ['deepseek-v4-pro-thinking'],
};

const MODELS_CACHE_TTL_MS = 5 * 60 * 1000;
const BASE_COOLDOWN_MS = 30 * 1000;
const MAX_COOLDOWN_MS = 5 * 60 * 1000;

class ProviderRouter {
  private providers: ChatProvider[] = [];
  private initialized = false;
  private circuits = new Map<string, CircuitState>();
  private modelsCache: { expiresAt: number; models: ModelInfo[] } | null = null;

  /**
   * Register all providers. Each initialization is independent —
   * if one provider fails to initialize, the others still work.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Register providers
    const deepseek = new DeepSeekProvider();
    const zai = new ZaiProvider();

    // Initialize each provider independently with error isolation
    const allProviders: ChatProvider[] = [deepseek, zai];

    for (const provider of allProviders) {
      try {
        await provider.initialize();
        this.providers.push(provider);
        this.ensureCircuit(provider.name);
        console.log(`[router] Provider '${provider.name}' registered (status: ${provider.health.status})`);
      } catch (err: any) {
        // Provider failed to initialize — register it anyway but in degraded state
        // so it can potentially recover later
        this.providers.push(provider);
        this.ensureCircuit(provider.name);
        this.recordFailure(provider.name, this.toProviderError(err, provider.name));
        console.warn(`[router] Provider '${provider.name}' failed to initialize: ${err.message}`);
        console.warn(`[router] Provider '${provider.name}' will be available for retry but may fail`);
      }
    }

    this.initialized = true;
    console.log(`[router] ${this.providers.length} provider(s) registered`);
  }

  /**
   * Find the provider that handles a given model.
   * @throws ProviderError if no provider handles the model
   */
  findProvider(modelId: string): ChatProvider {
    for (const provider of this.providers) {
      if (provider.handlesModel(modelId)) {
        return provider;
      }
    }

    const available = this.providers.map(p => p.name).join(', ');
    throw new ProviderError(
      'router',
      `No provider found for model '${modelId}'. Available providers: ${available}`,
      400,
      false
    );
  }

  /**
   * Aggregate models from ALL healthy providers.
   * Each provider's model listing is independent — if one fails,
   * the others still return their models.
   */
  async listAllModels(): Promise<ModelInfo[]> {
    const now = Date.now();
    if (this.modelsCache && now < this.modelsCache.expiresAt) {
      return this.modelsCache.models;
    }

    const allModels: ModelInfo[] = [];

    const results = await Promise.allSettled(
      this.providers.map(async (provider) => {
        try {
          const models = await provider.listModels();
          return { provider: provider.name, models };
        } catch (err: any) {
          console.warn(`[router] Failed to list models from '${provider.name}': ${err.message}`);
          return { provider: provider.name, models: [] };
        }
      })
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        allModels.push(...result.value.models);
      }
      // Rejected promises are already handled by the inner catch
    }

    for (const [alias, targets] of Object.entries(this.getAliases())) {
      allModels.push({
        id: alias,
        name: `${alias} (${targets.join(' -> ')})`,
        owned_by: 'router',
        created: Math.floor(Date.now() / 1000),
        supports_thinking: targets.some(t => t.toLowerCase().includes('thinking')),
      });
    }

    this.modelsCache = {
      expiresAt: now + MODELS_CACHE_TTL_MS,
      models: allModels,
    };

    return allModels;
  }

  /**
   * Create a chat stream using the correct provider for the model.
   * Provider errors are wrapped with context but NOT caught —
   * the caller (chat handler) decides how to handle them.
   */
  async createStream(options: ProviderChatOptions): Promise<{
    events: AsyncIterable<ProviderStreamEvent>;
    sessionId: string;
    promptTokens: number;
    providerName: string;
    actualModel: string;
  }> {
    const candidates = this.resolveCandidates(options.model);
    let lastError: ProviderError | null = null;

    for (const candidate of candidates) {
      let provider: ChatProvider;
      try {
        provider = this.findProvider(candidate.actualModel);
      } catch (err: any) {
        lastError = this.toProviderError(err, 'router');
        if (!candidate.isAlias) throw lastError;
        continue;
      }

      const circuit = this.ensureCircuit(provider.name);
      if (this.isCircuitOpen(provider.name, provider)) {
        lastError = new ProviderError(
          provider.name,
          `Provider '${provider.name}' is in cooldown. Last error: ${circuit.lastError || provider.health.lastError || 'unknown'}`,
          503,
          true,
          circuit.lastErrorKind || provider.health.lastErrorKind || 'unknown'
        );
        if (!candidate.isAlias) throw lastError;
        continue;
      }

      try {
        const actualOptions: ProviderChatOptions = {
          ...options,
          model: candidate.actualModel,
          enableThinking: options.enableThinking || candidate.actualModel.toLowerCase().includes('thinking'),
        };
        const result = await provider.createStream(actualOptions);
        this.recordSuccess(provider.name);

        return {
          ...result,
          providerName: provider.name,
          actualModel: candidate.actualModel,
        };
      } catch (err: any) {
        const providerError = this.toProviderError(err, provider.name);
        this.recordFailure(provider.name, providerError);
        lastError = providerError;

        const canTryNext = candidate.isAlias && this.shouldFallback(providerError);
        if (!canTryNext) {
          throw providerError;
        }

        console.warn(
          `[router] Provider '${provider.name}' failed for alias '${candidate.requestedModel}' (${providerError.kind}); trying next candidate`
        );
      }
    }

    throw lastError || new ProviderError('router', `No provider candidate available for model '${options.model}'`, 503, true);
  }

  /**
   * Get health status of all providers.
   */
  getHealthStatus(): Record<string, {
    status: string;
    errorCount: number;
    successCount: number;
    lastError?: string;
    lastErrorKind?: string;
    lastErrorAt?: number;
    lastSuccessAt?: number;
    consecutiveFailures?: number;
    cooldownUntil?: number;
    queueDepth?: number;
  }> {
    const status: Record<string, any> = {};
    for (const provider of this.providers) {
      const h = provider.health;
      const circuit = this.ensureCircuit(provider.name);
      const circuitOpen = circuit.cooldownUntil && circuit.cooldownUntil > Date.now();
      status[provider.name] = {
        status: circuitOpen ? 'offline' : h.status,
        errorCount: h.errorCount,
        successCount: h.successCount,
        lastError: circuit.lastError || h.lastError,
        lastErrorKind: circuit.lastErrorKind || h.lastErrorKind,
        lastErrorAt: circuit.lastErrorAt || h.lastErrorAt,
        lastSuccessAt: circuit.lastSuccessAt || h.lastSuccessAt,
        consecutiveFailures: circuit.consecutiveFailures || h.consecutiveFailures || 0,
        cooldownUntil: circuit.cooldownUntil,
        queueDepth: h.queueDepth,
      };
    }
    status.router = {
      status: 'healthy',
      errorCount: 0,
      successCount: 0,
      aliases: this.getAliases(),
      modelsCache: this.modelsCache ? { expiresAt: this.modelsCache.expiresAt, size: this.modelsCache.models.length } : null,
    };
    return status;
  }

  getProviderStatus() {
    return {
      generatedAt: Date.now(),
      providers: this.getHealthStatus(),
      aliases: this.getAliases(),
      modelsCache: this.modelsCache
        ? {
            expiresAt: this.modelsCache.expiresAt,
            size: this.modelsCache.models.length,
            modelIds: this.modelsCache.models.map(m => m.id),
          }
        : null,
      circuits: Object.fromEntries(this.circuits.entries()),
    };
  }

  /**
   * Shutdown all providers gracefully.
   */
  async shutdown(): Promise<void> {
    for (const provider of this.providers) {
      try {
        await provider.shutdown();
      } catch (err: any) {
        console.warn(`[router] Error shutting down '${provider.name}': ${err.message}`);
      }
    }
  }

  private getAliases(): Record<string, string[]> {
    const aliases: Record<string, string[]> = { ...DEFAULT_ALIASES };

    for (const [key, value] of Object.entries(process.env)) {
      if (!key.startsWith('MODEL_ALIAS_') || !value) continue;
      const alias = key
        .slice('MODEL_ALIAS_'.length)
        .toLowerCase()
        .replace(/_/g, '-');
      const targets = value.split(',').map(v => v.trim()).filter(Boolean);
      if (targets.length > 0) aliases[alias] = targets;
    }

    return aliases;
  }

  private resolveCandidates(modelId: string): ModelCandidate[] {
    const aliases = this.getAliases();
    const aliasTargets = aliases[modelId.toLowerCase()];
    if (!aliasTargets) {
      return [{ requestedModel: modelId, actualModel: modelId, isAlias: false }];
    }

    return aliasTargets.map(actualModel => ({
      requestedModel: modelId,
      actualModel,
      isAlias: true,
    }));
  }

  private ensureCircuit(providerName: string): CircuitState {
    let circuit = this.circuits.get(providerName);
    if (!circuit) {
      circuit = { consecutiveFailures: 0 };
      this.circuits.set(providerName, circuit);
    }
    return circuit;
  }

  private isCircuitOpen(providerName: string, provider: ChatProvider): boolean {
    const circuit = this.ensureCircuit(providerName);
    const now = Date.now();

    if (circuit.cooldownUntil && circuit.cooldownUntil > now) {
      return true;
    }

    if (circuit.cooldownUntil && circuit.cooldownUntil <= now) {
      circuit.cooldownUntil = undefined;
      return false;
    }

    return provider.health.status === 'offline';
  }

  private recordSuccess(providerName: string): void {
    const circuit = this.ensureCircuit(providerName);
    circuit.consecutiveFailures = 0;
    circuit.cooldownUntil = undefined;
    circuit.lastSuccessAt = Date.now();
  }

  private recordFailure(providerName: string, error: ProviderError): void {
    const circuit = this.ensureCircuit(providerName);
    circuit.consecutiveFailures++;
    circuit.lastError = error.message;
    circuit.lastErrorKind = error.kind;
    circuit.lastErrorAt = Date.now();

    if (circuit.consecutiveFailures >= 3 || error.kind === 'auth') {
      const multiplier = Math.max(1, circuit.consecutiveFailures - 2);
      const cooldown = Math.min(MAX_COOLDOWN_MS, BASE_COOLDOWN_MS * multiplier);
      circuit.cooldownUntil = Date.now() + cooldown;
    }
  }

  private shouldFallback(error: ProviderError): boolean {
    if (!error.retryable) return false;
    return ['auth', 'rate_limit', 'network', 'playwright', 'provider_5xx', 'timeout', 'unknown'].includes(error.kind);
  }

  private toProviderError(err: any, providerName: string): ProviderError {
    if (err instanceof ProviderError) return err;
    const message = err instanceof Error ? err.message : String(err);
    const kind = this.classifyError(message);
    return new ProviderError(providerName, message, 500, kind !== 'bad_request', kind);
  }

  private classifyError(message: string): ProviderErrorKind {
    const lower = message.toLowerCase();
    if (lower.includes('login') || lower.includes('unauthorized') || lower.includes('forbidden') || lower.includes('captcha')) {
      return 'auth';
    }
    if (lower.includes('rate') || lower.includes('429')) return 'rate_limit';
    if (lower.includes('timeout') || lower.includes('abortsignal')) return 'timeout';
    if (lower.includes('playwright') || lower.includes('browser') || lower.includes('page') || lower.includes('selector')) {
      return 'playwright';
    }
    if (lower.includes('network') || lower.includes('fetch failed') || lower.includes('econn') || lower.includes('dns')) {
      return 'network';
    }
    if (lower.includes('400') || lower.includes('bad request')) return 'bad_request';
    if (lower.includes('500') || lower.includes('502') || lower.includes('503') || lower.includes('504')) return 'provider_5xx';
    return 'unknown';
  }
}

// ─── Singleton ─────────────────────────────────────────────────────────────────

export const router = new ProviderRouter();
