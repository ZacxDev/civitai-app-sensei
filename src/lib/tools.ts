/**
 * Tool transport for real tool calling.
 *
 * 🔴 THE MODEL FORMS THE QUERY, NOT THIS FILE. That is the whole point of the
 * change this module lands. The predecessor was a client-side stopword stripper
 * (`deriveSearchQuery` and friends, deleted with this commit) that rewrote a
 * user's sentence into keywords, searched once, and injected the results. It was
 * brittle by construction: one shot, no feedback, and a heuristic — not the
 * model — decided the query.
 *
 * 🔴 NOT AN MCP PROXY, AND THAT IS DELIBERATE. `mcp.civitai.com` exists and its
 * browse tools work keyless, but it cannot be maturity-clamped from a block:
 * `search_models` has no maturity parameter and is `additionalProperties:false`,
 * and its results carry no maturity metadata to filter on. The host route this
 * module talks to is backed by the same clamped catalog path the app's own
 * searches use, so a SFW-domain viewer gets a SFW-clamped result set.
 *
 * 🔴 DECLARATIONS ARE FETCHED, NEVER HARDCODED. The schema handed to the model
 * must be the schema the route validates against, or the model is shown a
 * contract nobody enforces. A local copy is how those two drift, so there is no
 * local copy — {@link fetchToolDeclarations} reads them from the host.
 */
import { BLOCKS_BASE_URL, type CatalogAuth } from './research.js';

/**
 * One tool as the model is shown it. Structurally an OpenAI-style function
 * declaration, because that is what the orchestrator forwards to the provider.
 *
 * `parameters` is `Record<string, unknown>` rather than a modelled JSON-Schema
 * type on purpose: it is the HOST's object, passed to the model verbatim and
 * validated by the host on the way back. Modelling it here would create a second
 * definition that can disagree with the one actually enforced.
 */
export interface ToolDeclaration {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

/** One tool call the model emitted. `arguments` is a JSON *string*, per the provider contract. */
export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/**
 * The host's per-payload cap on `role:'tool'` MESSAGES.
 *
 * 🔴 THIS IS A MIRROR, NOT THE ENFORCEMENT. The host enforces it with a
 * `.superRefine` counting `role:'tool'` messages on BOTH the estimate and the
 * submit path, so exceeding it is a `BAD_REQUEST` no matter what this constant
 * says. It exists so the app can stop cleanly and tell the viewer why, rather
 * than discovering the cap as a failed request.
 *
 * 🔴 IT COUNTS MESSAGES, NOT ROUNDS, AND THOSE ARE DIFFERENT NUMBERS. An
 * earlier revision of this app used it as a round counter while this docstring
 * already said "messages" — so one round answering FIVE parallel tool calls put
 * five `role:'tool'` messages into a single payload and blew a mirrored cap of
 * three on the very first round, turning the next submit into a `BAD_REQUEST`
 * after the viewer had already paid for that round. A mirror that mirrors a
 * different quantity is worse than no mirror: it reads as protection.
 *
 * 🔴 AND IT BOUNDS HISTORY DEPTH IN ONE PAYLOAD, NOT SPEND. Each round is its
 * own submit, separately quoted and separately charged; what bounds total spend
 * is the host's per-call budget gate plus its per-user, per-app and dev-session
 * caps. Reading this as a spend bound is the mistake the host's own docs had to
 * be corrected for.
 */
export const MAX_TOOL_RESULT_MESSAGES = 3;

/** Host cap on a single message's content. A tool result is a message. */
const MAX_MESSAGE_CHARS = 8_000;

/**
 * Neutralise `urn:air:` so a tool result cannot bounce the next submit.
 *
 * 🔴 WHAT THIS IS AND IS NOT COVERING — established by reading `origin/trunk`
 * rather than assumed, because the obvious reading over-attributes it.
 *
 * On trunk this had exactly ONE call site: the tail of `formatCatalogContext`,
 * i.e. the retrieved catalog text the app injected itself. It never touched the
 * viewer's own words, the model's output, or anything else.
 *
 * That path's successor is the tool result, and the host now projects those
 * through `neutralizeAirLiterals` server-side before they leave
 * `/api/v1/blocks/tools`. So coverage of the path trunk protected is NOT lost.
 * This exists as defence in depth for a property the app cannot verify: if that
 * projection ever narrows, the symptom here is a hard `FORBIDDEN` on the NEXT
 * round — after the viewer has already paid for this one — with an error naming
 * nothing they typed.
 *
 * 🔴 STILL NOT COVERED, AND NOT A REGRESSION FROM THIS CHANGE: text the VIEWER
 * types. A question containing the literal (`"what does urn:air: mean?"`) is
 * rejected by the host, and was equally rejected on trunk — the strip was never
 * on that path. Stripping a viewer's own words is a product decision, not a
 * transport fix, so it is left alone and recorded here rather than silently
 * widened.
 */
export function stripAirReferences(text: string): string {
  return text.replace(/urn:air:/gi, 'urn-air-');
}

/**
 * Serialize a tool response into a message body that is bounded AND still valid
 * JSON.
 *
 * 🔴 A `slice()` ON THE SERIALIZED STRING IS THE WRONG BOUND, and the deleted
 * `formatCatalogContext` made this exact argument before it was removed: a
 * record cut mid-field hands the model a truncated URL or a name with no id,
 * presented in the same authoritative frame as the real ones. Here it is worse
 * than misleading — a string cut mid-token is not parseable JSON at all.
 *
 * So the bound is applied to the ITEM LIST and re-serialized: every record that
 * survives is complete. A response with no bounded array falls back to an
 * explicit, still-valid error rather than an unparseable fragment.
 */
export function boundToolResponse(body: unknown): string {
  const whole = JSON.stringify(body);
  if (whole !== undefined && whole.length <= MAX_MESSAGE_CHARS) return whole;

  if (body !== null && typeof body === 'object' && Array.isArray((body as { items?: unknown }).items)) {
    const record = body as { items: unknown[] };
    // Drop from the tail until the WHOLE serialized payload fits. Bounding the
    // items alone would ignore the envelope's own size.
    //
    // 🔴 STOPS AT ONE, NEVER ZERO. Emptying the array produces `{"items":[]}`,
    // which is small, valid, and a LIE: it is indistinguishable from a search
    // that legitimately found nothing, so the model would tell the viewer there
    // are no such models when the truth is that the result would not fit. An
    // explicit error is the honest answer and the model can act on it.
    // 🔴 RE-COUNT `truncated`, NEVER COPY IT. The host emits `{ items, truncated }`
    // (`boundToolResult` in its tool registry), where `truncated` is what the
    // HOST dropped. Spreading `...record` carried that number through unchanged
    // while this loop dropped more on top of it — handing the model 24 of 50
    // records alongside `"truncated": 0`, an assertion that nothing was left
    // out. That is the same lie the `keep >= 1` rule below refuses to tell in
    // its stronger form: a bound that misreports itself is worse than a bound,
    // because the model treats a complete-looking list as exhaustive.
    const maybeTruncated = (record as { truncated?: unknown }).truncated;
    const hostTruncated = typeof maybeTruncated === 'number' ? maybeTruncated : 0;
    for (let keep = record.items.length - 1; keep >= 1; keep -= 1) {
      const candidate = JSON.stringify({
        ...record,
        items: record.items.slice(0, keep),
        truncated: hostTruncated + (record.items.length - keep),
      });
      if (candidate !== undefined && candidate.length <= MAX_MESSAGE_CHARS) return candidate;
    }
  }
  return toolError('the result was too large to include');
}

/**
 * Auth plus the caller's abort signal.
 *
 * 🔴 THE SIGNAL IS NOT OPTIONAL POLISH. Without it a Stop pressed while a tool
 * POST was in flight left the request running, the loop resumed when it landed,
 * and the app issued another BILLED estimate+submit for a turn the viewer had
 * already abandoned.
 */
export interface ToolAuth extends CatalogAuth {
  signal?: AbortSignal;
}

/** How long a single tool request may hang before it is abandoned. */
const TOOL_REQUEST_TIMEOUT_MS = 15_000;

/**
 * The longest we will honour a server-supplied `Retry-After` before giving up.
 *
 * 🔴 AN UNCLAMPED `Retry-After` IS A HANG WITH A POLITE NAME. The header is
 * server-controlled; `Retry-After: 120` wedged the turn for two minutes with
 * the "Searching" state stuck on and Stop unable to end it, because the sleep
 * observed neither the caller's signal nor the request deadline.
 *
 * 🔴 THIS IS A PER-REQUEST BOUND, NOT A PER-CALL ONE — an earlier version of
 * this comment claimed the latter ("the retry can never outlive the budget a
 * single tool call was already given") and that was wrong. The retry RECURSES
 * into `toolsFetch`, which mints a FRESH `AbortSignal.timeout`, so one
 * `callTool` can span request (15 s) + sleep (≤15 s) + retry (15 s) ≈ 45 s.
 * What actually bounds a call end-to-end is the CALLER's signal, which is why
 * every entry point must pass one; the clamp only stops a hostile header from
 * being honoured verbatim.
 */
const MAX_RETRY_AFTER_MS = TOOL_REQUEST_TIMEOUT_MS;

/**
 * `AbortSignal.any`, with a fallback for runtimes that lack it.
 *
 * Returns a `dispose` alongside the signal because a combined signal OUTLIVES
 * nothing but the request it was made for, while the CALLER's signal lives for
 * the whole turn.
 *
 * 🔴 `{ once: true }` IS NOT CLEANUP, AND CROSS-REMOVING ON ABORT IS NOT EITHER
 * — that was this function's first fix and the test caught it as incomplete.
 * `once` retires only the listener that FIRED, and an abort-time cross-remove
 * only runs when something aborts. On the ORDINARY path — the request simply
 * succeeds — neither signal ever aborts, so nothing was removed and the caller
 * signal accumulated one dead listener per tool request. Measured 5 added / 0
 * removed across 5 calls with the abort-time cleanup already in place.
 *
 * So the lifetime that matters is the REQUEST's, and only `toolsFetch` knows
 * when that ends: it calls `dispose()` in a `finally`. Native `AbortSignal.any`
 * needs none of this, which is why its arm returns a no-op.
 *
 * 🔴 A HARD DEPENDENCY HERE FAILS IN THE WORST POSSIBLE DIRECTION. `tsconfig`
 * targets ES2022 and TypeScript's DOM lib declares `AbortSignal.any`, so a
 * runtime without it type-checks clean and then throws on EVERY tool request —
 * which `fetchToolDeclarations` swallows into `[]`, parking the app in the
 * degraded no-tools state permanently, with no error a viewer or we could see.
 * The feature would simply appear never to have shipped.
 *
 * 🔴 BE EXACT ABOUT WHAT THIS DETECTION COVERS — an earlier version of this
 * comment argued the hazard as a class and then closed half of it. The same
 * silent-degradation argument applies verbatim to `AbortSignal.timeout`, which
 * is a SECOND undetected dependency at the `toolsFetch` call site and is
 * evaluated as an argument BEFORE this function runs — so on a runtime lacking
 * it, this fallback never executes and detecting `any` buys nothing. Support
 * for `timeout` is strictly wider than for `any` (both shipped together in
 * every engine that has either), so no realistic runtime is exposed and no
 * detection is added for it.
 *
 * 🔴 THAT REASONING IS RECORDED AT THE CALL SITE TOO — see the comment above the
 * `combineSignals(...)` call in `toolsFetch`. An earlier revision pointed here
 * at an identifier named `timeoutSignal` that does not exist anywhere in `src/`,
 * while the call site pointed back at this comment: a circular pair, one half of
 * which named nothing. A cross-reference that cannot be followed is worse than
 * none, because it reads as though the argument lives somewhere it does not.
 */
function combineSignals(
  caller: AbortSignal | undefined,
  timeout: AbortSignal,
): { signal: AbortSignal; dispose: () => void } {
  if (!caller) return { signal: timeout, dispose: () => {} };
  const anyOf = (AbortSignal as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyOf === 'function') return { signal: anyOf([caller, timeout]), dispose: () => {} };
  const controller = new AbortController();
  const listeners: Array<[AbortSignal, () => void]> = [];
  const dispose = () => {
    for (const [signal, handler] of listeners) signal.removeEventListener('abort', handler);
    listeners.length = 0;
  };
  const forward = (s: AbortSignal) => {
    if (s.aborted) {
      dispose();
      controller.abort(s.reason);
      return;
    }
    const handler = () => {
      dispose();
      controller.abort(s.reason);
    };
    listeners.push([s, handler]);
    s.addEventListener('abort', handler, { once: true });
  };
  forward(caller);
  // `caller` may already be aborted, in which case `forward` above fired
  // synchronously and there is nothing left to register.
  if (!controller.signal.aborted) forward(timeout);
  return { signal: controller.signal, dispose };
}

/**
 * Sleep that loses the race to an abort.
 *
 * Returns `false` when the signal ended it, so the caller can stop rather than
 * proceed as if it had waited.
 */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function toolsFetch(
  init: RequestInit & { path: string },
  auth: ToolAuth,
  retries = 1,
): Promise<Response> {
  const { path, ...rest } = init;
  // 🔴 A HUNG REQUEST IS A HUNG TURN. `callTool` never throws for a tool-level
  // failure, so without a deadline a stalled POST leaves the conversation
  // in-flight indefinitely with no way out — Stop cannot reach `fetch` itself.
  // The caller's signal and this timeout are combined so either can end it.
  // `AbortSignal.timeout` is used undetected on purpose — see `combineSignals`
  // for why detecting `any` without detecting this one would be theatre.
  const { signal, dispose } = combineSignals(
    auth.signal,
    AbortSignal.timeout(TOOL_REQUEST_TIMEOUT_MS),
  );

  // 🔴 DISPOSE ON EVERY EXIT, INCLUDING THE THROWING ONES. The combined signal
  // is scoped to THIS request, but its listener sits on the caller's signal,
  // which lives for the whole turn — so anything that leaves this function
  // without disposing retains a dead listener. `finally` rather than a call
  // after the `await` because `fetch` rejects on abort and on network failure,
  // and those are exactly the paths where a leak would accumulate fastest.
  //
  // 🔴 THE BODY READ IS INSIDE THE SAME SCOPE, AND THAT IS THE POINT. A resolved
  // `fetch` means HEADERS, not the whole response — `res.json()` is a second
  // await on a stream that can stall just as long. An earlier revision returned
  // the `Response` and let each caller read the body AFTER `dispose()` had
  // already run, so on the fallback arm neither Stop nor the 15 s deadline could
  // reach a hung body: measured, the request signal read `aborted === false`
  // once `toolsFetch` returned, where the native arm read `true`. That is the
  // exact hazard the deadline exists to prevent, reintroduced by the cleanup fix
  // for a different leak. Returning the PARSED BODY keeps the request's lifetime
  // and the signal's lifetime the same thing, by construction rather than by
  // each caller remembering.
  let retryAfterMs: number | null = null;
  try {
    const res = await fetch(`${BLOCKS_BASE_URL}${path}`, {
      ...rest,
      signal,
      headers: {
        Authorization: `Bearer ${auth.token}`,
        ...(rest.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
    // 429 ONLY, and one retry — the same reasoning `fetchCatalog` documents,
    // with the same conclusion: the rate limit is keyed on this block instance
    // and clears in a known short window, so it is worth waiting out. A
    // retryable 503 is deliberately NOT retried; a lookup that fails fast lets
    // the model answer ungrounded rather than stalling the turn behind a
    // backend flap.
    //
    // The delay is computed here but SLEPT below, outside this block, so the
    // combined signal is disposed before a wait that can last 15 s.
    if (res.status === 429 && retries > 0) {
      const parsed = parseInt(res.headers.get('retry-after') ?? '2', 10);
      // Clamped AND abortable: the header is server-controlled, and a sleep
      // that ignores the caller's signal makes Stop a no-op for as long as it
      // lasts.
      retryAfterMs = Math.min(
        Number.isFinite(parsed) && parsed > 0 ? parsed * 1000 : 2000,
        MAX_RETRY_AFTER_MS,
      );
    } else {
      if (!res.ok) {
        throw new Error(`Civitai tools error: ${res.status} ${res.statusText}`);
      }
      return await res.json();
    }
  } finally {
    dispose();
  }

  // Only the 429 branch above leaves the block without returning or throwing.
  // Stated rather than asserted with a bare `!`: if a future edit adds a fourth
  // way out, this fails loudly instead of sleeping zero and retrying at once.
  if (retryAfterMs === null) {
    throw new Error('tools: unreachable — left the request block with no retry delay');
  }
  const slept = await abortableSleep(retryAfterMs, auth.signal);
  // Aborted mid-wait: fail this call rather than issuing a retry the viewer
  // has already asked us to abandon.
  if (!slept) throw new DOMException('Aborted', 'AbortError');
  return toolsFetch(init, auth, retries - 1);
}

/**
 * The tools this viewer may call, as the host declares them.
 *
 * Returns `[]` rather than throwing when the host serves nothing usable: a chat
 * app with no tools is degraded, not broken, and the model is simply never told
 * about any. Throwing here would take down the whole conversation because a
 * catalog helper was unavailable.
 */
export async function fetchToolDeclarations(auth: ToolAuth): Promise<ToolDeclaration[]> {
  // The parsed body, not a `Response` — `toolsFetch` reads it while the request
  // signal is still live. See its comment for why that scope matters.
  const data: unknown = await toolsFetch({ path: '/tools', method: 'GET' }, auth);
  const raw = (data as { tools?: unknown })?.tools;
  if (!Array.isArray(raw)) return [];
  return raw.filter((t): t is ToolDeclaration => {
    const fn = (t as ToolDeclaration | null)?.function;
    return (
      (t as ToolDeclaration)?.type === 'function' && typeof fn?.name === 'string' && fn.name.length > 0
    );
  });
}

/** A tool call that could not be executed, rendered as a result the model can read. */
function toolError(message: string): string {
  return JSON.stringify({ error: message });
}

/**
 * Execute one tool call and return the string to put in the `role:'tool'` message.
 *
 * 🔴 NEVER THROWS FOR A TOOL-LEVEL FAILURE, and that is the design. A malformed
 * `arguments` string, an unknown tool, a rate limit — each is something the
 * MODEL should see and can react to (by retrying with different arguments, or by
 * telling the viewer it could not look something up). Throwing would abort the
 * whole turn and charge the viewer for a conversation with no answer, which is
 * strictly worse than an answer that says the lookup failed.
 *
 * A transport failure is reported the same way for the same reason.
 */
export async function callTool(call: ToolCall, auth: ToolAuth): Promise<string> {
  let args: unknown;
  try {
    // The provider hands `arguments` back as a STRING; a model can emit one that
    // is not valid JSON, and that is a normal failure mode rather than a bug.
    args = JSON.parse(call.function.arguments || '{}');
  } catch {
    return toolError('arguments were not valid JSON');
  }
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return toolError('arguments must be a JSON object');
  }

  try {
    const body: unknown = await toolsFetch(
      {
        path: '/tools',
        method: 'POST',
        body: JSON.stringify({ name: call.function.name, arguments: args }),
      },
      auth,
    );
    // Bounded defensively even though the host bounds its own projection: this
    // string becomes a message whose content the host caps at 8,000 chars, and
    // exceeding it is a reject of the WHOLE next request, not a truncation.
    // Bounded at a RECORD boundary, so what survives is always valid JSON.
    // Stripped for the same class of reason — see `stripAirReferences`.
    return stripAirReferences(boundToolResponse(body));
  } catch (e) {
    return toolError(e instanceof Error ? e.message : 'tool call failed');
  }
}

/**
 * The model's own `query` argument, for display in the Research panel.
 *
 * Purely cosmetic and deliberately total: a malformed `arguments` string yields
 * `null` rather than throwing, because failing to LABEL a search must never be
 * able to fail the search. The panel shows this so a bad query is visible to the
 * viewer instead of silently shaping an answer — the same reason the heuristic's
 * derived query used to be shown.
 */
export function readQueryArgument(call: ToolCall | undefined): string | null {
  if (!call) return null;
  try {
    const args: unknown = JSON.parse(call.function.arguments || '{}');
    if (args === null || typeof args !== 'object') return null;
    const q = (args as { query?: unknown }).query;
    return typeof q === 'string' && q.trim().length > 0 ? q.trim() : null;
  } catch {
    return null;
  }
}
