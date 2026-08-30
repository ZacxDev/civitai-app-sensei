import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  resolveMentions,
  buildMentionExchange,
  addPendingMention,
  mentionLabel,
  mentionUrl,
  MAX_MENTIONS,
  MENTION_TOOL_CALL_ID,
  MENTION_TOOL_NAME,
  type ResolvedResource,
} from './mentions.js';
import {
  BLOCK_GENERATION_RESOURCE,
  BLOCK_GENERATION_RESOURCE_LOCON,
} from '../test-helpers.js';

const AUTH = { token: 'block-jwt-abc' };

let originalFetch: typeof globalThis.fetch;
let requests: Array<{ url: string; auth: string }> = [];

function install(handler: (url: string) => Response) {
  originalFetch = globalThis.fetch;
  requests = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    requests.push({ url, auth: headers.Authorization ?? '' });
    return handler(url);
  }) as unknown as typeof globalThis.fetch;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  if (originalFetch) globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

const A = BLOCK_GENERATION_RESOURCE as ResolvedResource;
const B = BLOCK_GENERATION_RESOURCE_LOCON as ResolvedResource;

// ─────────────────────────────────────────────────────────────────────────────
describe('resolveMentions — the resolve endpoint, and what it is allowed to drop', () => {
  it('GETs /blocks/generation-resources with a comma id list and the block token', async () => {
    install(() => json({ items: [A, B] }));
    await resolveMentions([A.versionId, B.versionId], AUTH);

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(
      `https://civitai.com/api/v1/blocks/generation-resources?ids=${A.versionId},${B.versionId}`,
    );
    expect(requests[0].auth).toBe('Bearer block-jwt-abc');
  });

  it('🔴 an id the endpoint DROPPED is absent, never fabricated', async () => {
    // The endpoint drops any resource failing `hasAccess` or exceeding the
    // token's clamped browsing ceiling. Synthesising a placeholder for the
    // missing id would put an UNCLAMPED name in front of the viewer the clamp
    // exists to protect — so the contract is "fewer items is normal".
    install(() => json({ items: [A] }));
    const out = await resolveMentions([A.versionId, B.versionId], AUTH);

    expect(out.map((r) => r.versionId)).toEqual([A.versionId]);
    expect(out).toHaveLength(1);
  });

  it('returns items in the order asked, not the order the endpoint replied', async () => {
    install(() => json({ items: [B, A] })); // reversed on the wire
    const out = await resolveMentions([A.versionId, B.versionId], AUTH);
    expect(out.map((r) => r.versionId)).toEqual([A.versionId, B.versionId]);
  });

  it('de-dupes ids and drops junk before it reaches the wire', async () => {
    install(() => json({ items: [A] }));
    await resolveMentions([A.versionId, A.versionId, 0, -3, NaN], AUTH);
    expect(requests[0].url).toContain(`ids=${A.versionId}`);
    expect(requests[0].url).not.toContain(',');
  });

  it('makes no request at all for an empty id list', async () => {
    install(() => json({ items: [] }));
    expect(await resolveMentions([], AUTH)).toEqual([]);
    expect(requests).toHaveLength(0);
  });

  it('throws on a non-ok response rather than returning a silent empty list', async () => {
    install(() => json({ error: 'nope' }, 429));
    await expect(resolveMentions([A.versionId], AUTH)).rejects.toThrow(/429/);
  });

  it('tolerates a body with no items array', async () => {
    install(() => json({ maturity: { browsingLevel: 1, sfwOnly: true } }));
    expect(await resolveMentions([A.versionId], AUTH)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('buildMentionExchange — the wire shape the host accepts, and only that', () => {
  it('🔴 BATCHES: N mentions produce exactly ONE role:"tool" message', () => {
    // The host counts `role:'tool'` messages against MAX_TOOL_ROUNDS (3) with a
    // bare filter and NO provenance test. One batched result costs ONE slot and
    // leaves 2 real rounds; one message per mention would cost N.
    const many = [A, B, { ...A, versionId: 111 }, { ...A, versionId: 222 }];
    const out = buildMentionExchange(many);

    expect(out.filter((m) => m.role === 'tool')).toHaveLength(1);
    expect(out).toHaveLength(2);
  });

  it('🔴 ORDERS: the assistant tool_calls turn PRECEDES its tool result', () => {
    // The host builds `declaredCallIds` in ITERATION ORDER and rejects a
    // `role:'tool'` whose id is not ALREADY in the set — an ordering check, not
    // a membership one. The reverse order is a BAD_REQUEST for the whole
    // payload.
    const out = buildMentionExchange([A]);
    expect(out.map((m) => m.role)).toEqual(['assistant', 'tool']);
  });

  it('🔴 CORRELATES: the tool result carries the id the assistant turn declared', () => {
    const out = buildMentionExchange([A, B]);
    const assistant = out[0];
    const tool = out[1];
    expect(assistant.tool_calls).toHaveLength(1);
    expect(assistant.tool_calls?.[0].id).toBe(MENTION_TOOL_CALL_ID);
    expect(tool.tool_call_id).toBe(MENTION_TOOL_CALL_ID);
    expect(tool.tool_call_id).toBe(assistant.tool_calls?.[0].id);
  });

  it('🔴 the tool_call_id matches the host charset ^[a-zA-Z0-9_-]{1,64}$', () => {
    // Not a style rule: `tool_call_id` must be a MEMBER of the set of assistant
    // `tool_calls[].id`s, and THAT field is charset-bounded by the host's
    // TOOL_NAME_PATTERN at max 64. `call.1` and `call:1` are BAD_REQUEST.
    expect(MENTION_TOOL_CALL_ID).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(MENTION_TOOL_NAME).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });

  it('the synthetic call is a well-formed function call with JSON-string arguments', () => {
    const out = buildMentionExchange([A, B]);
    const call = out[0].tool_calls![0];
    expect(call.type).toBe('function');
    expect(call.function.name).toBe(MENTION_TOOL_NAME);
    expect(typeof call.function.arguments).toBe('string');
    expect(JSON.parse(call.function.arguments)).toEqual({
      versionIds: [A.versionId, B.versionId],
    });
  });

  it('the tool result is valid JSON carrying every resolved record', () => {
    const out = buildMentionExchange([A, B]);
    const parsed = JSON.parse(out[1].content) as { items: ResolvedResource[] };
    expect(parsed.items.map((r) => r.versionId)).toEqual([A.versionId, B.versionId]);
    expect(parsed.items[0].modelName).toBe(A.modelName);
    expect(parsed.items[1].baseModel).toBe(B.baseModel);
  });

  it('emits nothing at all when there is nothing resolved', () => {
    // A payload with a tool result and no mentions would burn a round slot for
    // no grounding.
    expect(buildMentionExchange([])).toEqual([]);
  });

  it('🔴 stays inside MAX_MESSAGE_CHARS (8,000) and stays parseable when it must drop', () => {
    // Bounded by the MESSAGE cap, not by the host tool registry's own
    // MAX_TOOL_RESULT_CHARS (6,000), which does not bind an app-synthesised
    // result. `boundToolResponse` drops WHOLE records, so what survives parses.
    const fat = Array.from({ length: 40 }, (_, i) => ({
      ...A,
      versionId: 1000 + i,
      modelName: 'M'.repeat(300),
      trainedWords: Array.from({ length: 20 }, (_, k) => `trigger-${i}-${k}`),
    }));
    const out = buildMentionExchange(fat);
    expect(out).toHaveLength(2);
    expect(out[1].content.length).toBeLessThanOrEqual(8_000);
    const parsed = JSON.parse(out[1].content) as { items: unknown[]; truncated: number };
    expect(Array.isArray(parsed.items)).toBe(true);
    expect(parsed.items.length).toBeGreaterThanOrEqual(1);
    expect(parsed.items.length).toBeLessThan(fat.length);
    // The count it reports is what was actually dropped — a bound that
    // misreports itself reads to the model as an exhaustive list.
    expect(parsed.truncated).toBe(fat.length - parsed.items.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the pending-mention list — one place for the cap and the de-dupe', () => {
  it('de-dupes by versionId', () => {
    const pending = addPendingMention([A], { ...A });
    expect(pending).toHaveLength(1);
  });

  it('appends a genuinely different resource', () => {
    expect(addPendingMention([A], B).map((r) => r.versionId)).toEqual([A.versionId, B.versionId]);
  });

  it('refuses to grow past MAX_MENTIONS', () => {
    const full = Array.from({ length: MAX_MENTIONS }, (_, i) => ({ ...A, versionId: 900 + i }));
    const out = addPendingMention(full, { ...A, versionId: 5 });
    expect(out).toHaveLength(MAX_MENTIONS);
    expect(out.some((r) => r.versionId === 5)).toBe(false);
  });

  it('MAX_MENTIONS stays under the endpoint’s own ids cap of 30', () => {
    expect(MAX_MENTIONS).toBeLessThanOrEqual(30);
    expect(MAX_MENTIONS).toBeGreaterThan(0);
  });
});

describe('display helpers', () => {
  it('labels a resource by model and version name', () => {
    expect(mentionLabel(A)).toBe('Test Model · v1.0');
  });
  it('links to the model page pinned to the picked version', () => {
    expect(mentionUrl(A)).toBe('https://civitai.com/models/1234?modelVersionId=5678');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 THE HOST-CHROME BOUNDARY, ASSERTED ON THE MODULE'S OWN BEHAVIOUR.
//
// The picker's whole security property is that the untrusted iframe never
// receives a list, the search API, or the catalog — only the single resource the
// viewer chose in HOST chrome. This module is the one that talks to the network
// on the mention path, so it is where a widening would show up first.
// ─────────────────────────────────────────────────────────────────────────────
describe('host-chrome boundary — the mention path never searches the catalog', () => {
  it('resolving mentions issues exactly one request, to the id-keyed rehydrate route', async () => {
    install(() => json({ items: [A, B] }));
    await resolveMentions([A.versionId, B.versionId], AUTH);

    expect(requests).toHaveLength(1);
    const { url } = requests[0];
    // Not the search endpoints, and carrying no free-text query of any kind.
    expect(url).not.toContain('/blocks/models');
    expect(url).not.toContain('/blocks/images');
    expect(url).not.toContain('query=');
    expect(url).toContain('/blocks/generation-resources?ids=');
  });

  it('sends only ids — the request URL carries no browsing-level or maturity knob', async () => {
    // The clamp is server-side and authoritative; an app-supplied knob here
    // would be the app asking to see more than its token allows.
    install(() => json({ items: [A] }));
    await resolveMentions([A.versionId], AUTH);
    const query = new URL(requests[0].url).searchParams;
    expect([...query.keys()]).toEqual(['ids']);
  });
});
