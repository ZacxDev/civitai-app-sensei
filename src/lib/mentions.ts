/**
 * MENTIONED RESOURCES — the viewer attaches a catalog resource to a question and
 * the model answers grounded in it, in ONE round, without looking it up.
 *
 * ── The three boundaries this module sits between ───────────────────────────
 *
 * 1. THE PICK is made in HOST CHROME. `useResourcePicker().open()` asks the host
 *    to open its OWN modal; the viewer searches there. This iframe never
 *    receives a list, the search API, or the catalog — only the single
 *    `BlockResourceInfo` the viewer chose. Nothing in this file widens that:
 *    it takes version IDS as input and never issues a search.
 *
 * 2. THE RESOLVE goes to `GET /api/v1/blocks/generation-resources?ids=…`, which
 *    is maturity-clamped and rate-limited server-side. 🔴 IT CAN RETURN FEWER
 *    ITEMS THAN IT WAS ASKED FOR, and that is not an error: the endpoint drops
 *    any resource failing `hasAccess` or exceeding the token's clamped browsing
 *    ceiling. {@link resolveMentions} therefore returns what came BACK, in the
 *    order asked, and the caller must be able to render "this one did not
 *    resolve" rather than inventing a placeholder. Fabricating an entry here
 *    would put an unclamped name in front of a viewer the clamp exists to
 *    protect.
 *
 * 3. THE WIRE is the host's `chatMessageSchema`. See {@link buildMentionExchange}
 *    for the exact shape and why it is the only one the host accepts.
 */
import { BLOCKS_BASE_URL, type CatalogAuth } from './research.js';
import { boundToolResponse, stripAirReferences } from './tools.js';

/**
 * One resolved resource, mirroring the host's `SafeGenerationResource`
 * (civitai `src/server/schema/blocks/generation-resource-projection.ts`).
 *
 * 🔴 THE SAME PROJECTION BACKS BOTH SOURCES, and that is why this one type is
 * enough: the host builds `RESOURCE_PICKER_RESULT.selected` and this endpoint's
 * `items[]` from `projectSafeGenerationResource`, so a picked resource and a
 * rehydrated one cannot disagree about which fields are public. It carries no
 * availability / hasAccess / earlyAccess / nsfw internal, by construction on
 * the host side rather than by this app trimming anything.
 */
export interface ResolvedResource {
  versionId: number;
  modelId: number;
  modelName: string;
  versionName: string;
  baseModel: string;
  modelType: string;
  strength: number;
  minStrength: number;
  maxStrength: number;
  trainedWords: string[];
  clipSkip: number | null;
}

/**
 * The most resources one message may carry.
 *
 * 🔴 THIS IS NOT THE BINDING CONSTRAINT AND MUST NOT BE READ AS ONE. What
 * actually bounds a mention batch is `MAX_MESSAGE_CHARS` (8,000) on the single
 * `role:'tool'` message they are serialised into — see
 * {@link buildMentionExchange} — and {@link boundToolResponse} enforces that by
 * dropping whole records. This is a UI bound: a composer carrying two dozen
 * chips is unusable long before the character cap bites, and the endpoint's own
 * `ids` cap is 30, so this sits below both.
 */
export const MAX_MENTIONS = 8;

/**
 * The `tool_call_id` correlating the synthetic pair.
 *
 * 🔴 THE CHARSET IS LOAD-BEARING, NOT COSMETIC. The host validates assistant
 * `tool_calls[].id` against `TOOL_NAME_PATTERN` = `/^[a-zA-Z0-9_-]+$/` at
 * `.max(64)`, and the `role:'tool'` message's `tool_call_id` must be a MEMBER of
 * the set those ids form — so a dot or a colon (`call.1`, `call:1`) is a
 * `BAD_REQUEST` for the whole payload, losing the conversation rather than the
 * mention. `mentions.test.ts` asserts this literal against that regex.
 */
export const MENTION_TOOL_CALL_ID = 'sensei_mention_batch';

/**
 * The synthetic call's `function.name`.
 *
 * 🔴 IT DELIBERATELY NAMES NO REAL TOOL, AND THE HOST PERMITS THAT. The host's
 * `.superRefine` checks `toolChoice.function.name` against `params.tools` but
 * performs NO such check on assistant `tool_calls[].function.name`, so this name
 * need not appear in the `tools` array the same request carries.
 *
 * 🔴 AND THE PROVIDER EXECUTES IT — MEASURED, not inferred from the schema.
 * The host accepting a payload says nothing about the provider running it, and
 * this arc has already lost a release to exactly that gap (`tool_choice` vs
 * `toolChoice` in 0.1.6, asserted correct by two tests and a fixture type
 * because the contract lived in another repo). So it was probed against the live
 * orchestrator on 2026-08-30, in this exact shape — `tools` declaring only
 * `search_models` while the synthetic call names this — on `deepseek/deepseek-chat`
 * and `openai/gpt-4o-mini`: both answered from the pre-filled content in ONE
 * round, `finishReason: 'stop'`, with no re-call. The control arm (same request,
 * synthetic pair removed) was decisive rather than merely different: deepseek
 * came back `finishReason: 'tool_calls'` re-calling `search_models` — the second
 * charged round this design exists to remove — and gpt-4o-mini asked the viewer
 * to attach the resource it had just been given.
 */
export const MENTION_TOOL_NAME = 'attached_resources';

/** A `role:'tool'` / assistant pair as `lib/chat.ts`'s `ApiMessage` sees it. */
export interface MentionExchange {
  role: string;
  content: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

/**
 * Resolve picked version ids to their public projections.
 *
 * Order follows `versionIds`, and an id the endpoint dropped is simply absent —
 * see the module header, clause 2.
 */
export async function resolveMentions(
  versionIds: number[],
  auth: CatalogAuth,
): Promise<ResolvedResource[]> {
  const ids = Array.from(new Set(versionIds.filter((n) => Number.isInteger(n) && n > 0)));
  if (ids.length === 0) return [];

  const res = await fetch(`${BLOCKS_BASE_URL}/generation-resources?ids=${ids.join(',')}`, {
    headers: { Authorization: `Bearer ${auth.token}` },
  });
  if (!res.ok) {
    throw new Error(`Civitai resource lookup error: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as { items?: ResolvedResource[] };
  const items = Array.isArray(data?.items) ? data.items : [];
  const byId = new Map(items.map((r) => [r.versionId, r]));
  // Requested order, dropped ids simply absent.
  return ids.map((id) => byId.get(id)).filter((r): r is ResolvedResource => r !== undefined);
}

/**
 * Build the ONE synthetic exchange that pre-fills the model's grounding.
 *
 * 🔴 TWO MESSAGES, NEVER 2N, AND THE BATCHING IS THE POINT RATHER THAN A
 * TIDY-UP. The host counts `role:'tool'` messages in a `.superRefine` on BOTH
 * the estimate and the submit path — a bare
 * `messages.filter(m => m.role === 'tool').length` against `MAX_TOOL_ROUNDS`
 * (3), with NO provenance test, so a synthetic result is indistinguishable from
 * a real one and costs a slot. One batched result costs ONE, leaving 2 real
 * rounds; one message per mention would cost three at three mentions (silencing
 * tool calling entirely for that payload) and `BAD_REQUEST` at four — before
 * any quote, so with nothing charged and nothing to refund, but also with the
 * whole conversation refused rather than the mention.
 *
 * 🔴 THE ASSISTANT TURN MUST PHYSICALLY PRECEDE THE RESULT. The host builds its
 * `declaredCallIds` set IN ITERATION ORDER and rejects any `role:'tool'` whose
 * `tool_call_id` is not ALREADY in it — so this is an ORDERING check, not a
 * membership one, and returning the pair in the other order is a `BAD_REQUEST`.
 * A result correlating to no preceding assistant turn at all (the "just invent
 * an id" option) is rejected for the same reason. Returning both messages from
 * one function is what makes the order un-gettable-wrong at the call site.
 *
 * 🔴 BOUNDED BY `MAX_MESSAGE_CHARS` (8,000), NOT by the host tool registry's own
 * `MAX_TOOL_RESULT_CHARS` (6,000). That smaller number is the registry
 * self-capping below the message cap so a block can prepend framing to a
 * HOST-executed tool result; it does not bind a result the app synthesises.
 * `boundToolResponse` drops whole records from the tail and re-counts
 * `truncated`, so what survives is always complete, valid JSON — a record cut
 * mid-field would hand the model a truncated id in the same authoritative frame
 * as the real ones.
 *
 * 🔴 NOT COVERED, AND STATED RATHER THAN QUIETLY IMPLIED BY THE PARAGRAPH ABOVE:
 * the VIEWER is never told when a batch was clamped. A dropped record raises
 * `truncated` for the MODEL, and the fall-back
 * `{"error":"the result was too large to include"}` tells the model nothing
 * survived at all — but `MessageBubble` renders a card for every attachment
 * either way, so the transcript shows chips for resources the model was not
 * handed. Whether that is reachable at `MAX_MENTIONS` (8) is UNPROVEN: it needs
 * eight records whose author-controlled fields together exceed 8,000 chars, and
 * nobody has measured whether the endpoint's own projection permits that. Left
 * as-is deliberately; do not read this note as a claim that it is handled.
 *
 * 🔴 AND `urn:air:` IS NEUTRALISED HERE, on the same argument `tools.ts` makes
 * at its `callTool` return. The host throws `FORBIDDEN` when
 * `containsAirReference(built.input)` — a case-insensitive substring scan over
 * every string, array element, object value and object KEY — and it throws
 * BEFORE the Buzz quote, so a single literal refuses the whole submit rather
 * than the mention. Every field serialised into this message is
 * CATALOG-AUTHOR-CONTROLLED (`modelName`, `versionName`, `trainedWords[]`,
 * `baseModel`, `modelType`), which makes this the LESS trustworthy of the two
 * paths, not the more. Applied to the SERIALIZED string, after bounding, so it
 * covers keys as well as values and so the replacement's own length is inside
 * the cap it was measured against (`urn-air-` is the same 8 chars as
 * `urn:air:`, so the bound cannot be pushed over by the substitution).
 */
export function buildMentionExchange(resolved: ResolvedResource[]): MentionExchange[] {
  if (resolved.length === 0) return [];
  const versionIds = resolved.map((r) => r.versionId);
  return [
    {
      role: 'assistant',
      // Empty on purpose: this turn's entire content IS its `tool_calls`, which
      // is the one shape the host allows a contentless assistant message for.
      // `toStepMessages` omits the key rather than sending `''` (`.min(1)`).
      content: '',
      tool_calls: [
        {
          id: MENTION_TOOL_CALL_ID,
          type: 'function',
          function: {
            name: MENTION_TOOL_NAME,
            arguments: JSON.stringify({ versionIds }),
          },
        },
      ],
    },
    {
      role: 'tool',
      tool_call_id: MENTION_TOOL_CALL_ID,
      // Same treatment, same order, as `tools.ts`'s `callTool` return:
      // `stripAirReferences(boundToolResponse(...))`. Bound FIRST so the strip
      // sees the string that will actually be sent, and called with an explicit
      // single argument — never handed to `.map` — see the note in `tools.ts`.
      content: stripAirReferences(boundToolResponse({ items: resolved, truncated: 0 })),
    },
  ];
}

/** Human label for a resolved resource, used by the composer chip and the bubble. */
export function mentionLabel(r: ResolvedResource): string {
  return `${r.modelName} · ${r.versionName}`;
}

/** Canonical web URL for a mentioned resource. */
export function mentionUrl(r: ResolvedResource): string {
  return `https://civitai.com/models/${r.modelId}?modelVersionId=${r.versionId}`;
}

/**
 * Add a pick to the pending list — de-duplicated by `versionId` and capped.
 *
 * Pure so the cap and the de-dupe are testable without a React tree, and so the
 * two rules live in ONE place rather than being re-derived at the click handler.
 */
export function addPendingMention<T extends { versionId: number }>(pending: T[], pick: T): T[] {
  if (pending.some((p) => p.versionId === pick.versionId)) return pending;
  if (pending.length >= MAX_MENTIONS) return pending;
  return [...pending, pick];
}
