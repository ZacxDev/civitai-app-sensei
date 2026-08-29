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
 * The host's per-payload cap on `role:'tool'` messages.
 *
 * 🔴 THIS IS A MIRROR, NOT THE ENFORCEMENT. The host enforces it with a
 * `.superRefine` counting `role:'tool'` messages on BOTH the estimate and the
 * submit path, so exceeding it is a `BAD_REQUEST` no matter what this constant
 * says. It exists so the app can stop cleanly and tell the viewer why, rather
 * than discovering the cap as a failed request.
 *
 * 🔴 AND IT BOUNDS HISTORY DEPTH IN ONE PAYLOAD, NOT SPEND. Each round is its
 * own submit, separately quoted and separately charged; what bounds total spend
 * is the host's per-call budget gate plus its per-user, per-app and dev-session
 * caps. Reading this as a spend bound is the mistake the host's own docs had to
 * be corrected for.
 */
export const MAX_TOOL_ROUNDS = 3;

/** Host cap on a single message's content. A tool result is a message. */
const MAX_MESSAGE_CHARS = 8_000;

async function toolsFetch(init: RequestInit & { path: string }, auth: CatalogAuth): Promise<Response> {
  const { path, ...rest } = init;
  const res = await fetch(`${BLOCKS_BASE_URL}${path}`, {
    ...rest,
    headers: {
      Authorization: `Bearer ${auth.token}`,
      ...(rest.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (!res.ok) {
    throw new Error(`Civitai tools error: ${res.status} ${res.statusText}`);
  }
  return res;
}

/**
 * The tools this viewer may call, as the host declares them.
 *
 * Returns `[]` rather than throwing when the host serves nothing usable: a chat
 * app with no tools is degraded, not broken, and the model is simply never told
 * about any. Throwing here would take down the whole conversation because a
 * catalog helper was unavailable.
 */
export async function fetchToolDeclarations(auth: CatalogAuth): Promise<ToolDeclaration[]> {
  const res = await toolsFetch({ path: '/tools', method: 'GET' }, auth);
  const data: unknown = await res.json();
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
export async function callTool(call: ToolCall, auth: CatalogAuth): Promise<string> {
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
    const res = await toolsFetch(
      {
        path: '/tools',
        method: 'POST',
        body: JSON.stringify({ name: call.function.name, arguments: args }),
      },
      auth,
    );
    const body: unknown = await res.json();
    // Bounded defensively even though the host bounds its own projection: this
    // string becomes a message whose content the host caps at 8,000 chars, and
    // exceeding it is a reject of the WHOLE next request, not a truncation.
    return JSON.stringify(body).slice(0, MAX_MESSAGE_CHARS);
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
