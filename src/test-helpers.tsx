import type { UseAppStorage } from '@civitai/blocks-react';

export function fakeAppStorage(seed: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(seed));
  const sets: Array<{ key: string; value: unknown }> = [];
  const appStorage: UseAppStorage = {
    async get<T = unknown>(key: string) {
      return (store.has(key) ? (store.get(key) as T) : null) as T | null;
    },
    async set<T = unknown>(key: string, value: T) {
      store.set(key, value);
      sets.push({ key, value });
      return { ok: true as const };
    },
    async delete(key: string) {
      const deleted = store.delete(key);
      return { ok: true as const, deleted };
    },
    async list(opts?: { prefix?: string; limit?: number; cursor?: string }) {
      const prefix = opts?.prefix;
      const keys = [...store.keys()].filter((k) => !prefix || k.startsWith(prefix));
      return { keys: keys.map((key) => ({ key, updatedAt: new Date() })) };
    },
    async getQuota() {
      return { usedBytes: 0, rowCount: store.size, limitBytes: 50_000_000, limitRows: 1_000_000 };
    },
  };
  return { appStorage, sets, store };
}

export function fakeOrchestrator() {
  const calls: Array<{ url: string; body: unknown }> = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = init?.body ? JSON.parse(init.body as string) : null;
    calls.push({ url, body });

    return new Response(
      JSON.stringify({
        id: 'stub-response-1',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: 'This is a stubbed response from the orchestrator.',
          },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };

  return {
    calls,
    restore: () => { globalThis.fetch = originalFetch; },
  };
}

export function fakePublicApi() {
  const calls: Array<{ url: string }> = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url });

    if (url.includes('/api/v1/models/')) {
      return new Response(
        JSON.stringify({
          id: 1234,
          name: 'Test Model',
          description: 'A test model.',
          type: 'Checkpoint',
          tags: ['test'],
          stats: { downloads: 1000, rating: 4.5, favorites: 100 },
          modelVersions: [{ id: 5678, name: 'v1.0', baseModel: 'SDXL 1.0' }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    if (url.includes('/api/v1/models')) {
      return new Response(
        JSON.stringify({
          items: [
            { id: 1234, name: 'Test Model', type: 'Checkpoint', stats: { downloads: 1000, rating: 4.5 } },
          ],
          nextCursor: null,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    if (url.includes('/api/v1/images')) {
      return new Response(
        JSON.stringify({
          items: [{ id: 9999, url: 'https://image.civitai.com/test.jpeg', width: 1024, height: 1024 }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    return originalFetch(input);
  };

  return {
    calls,
    restore: () => { globalThis.fetch = originalFetch; },
  };
}
