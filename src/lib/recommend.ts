/**
 * THE MODEL-RECOMMENDATION TOOL — `recommend_resources`, executed by this app.
 *
 * Calls Civitai's resource-intent route,
 * `POST https://civitai.com/api/v1/blocks/resource-intent`, which takes an image
 * prompt and answers with add-on resources (LoRAs, embeddings, …) — or, with
 * `kind: 'checkpoint'` and a known `baseModel`, checkpoints — that fit it. The
 * contract is mirrored from civitai/civitai `origin/main`:
 *
 *   src/pages/api/v1/blocks/resource-intent.ts   (status codes, flags, 429)
 *   src/server/schema/resource-intent.schema.ts  (input + response shape)
 *
 * 🔴 THE ROUTE WANTS AN IMAGE DESCRIPTION, NOT A QUESTION, AND THAT IS THE WHOLE
 * DESIGN OF THIS TOOL. Its first stage asks a judgment model questions ABOUT AN
 * IMAGE PROMPT ("what role would a resource play", "which style family"). Sent
 * the viewer's question verbatim ("sfw models to use for advertising
 * collateral") it has no image to judge and returned poor, generic lists. So the
 * tool's one required argument is `image_description`, and its declaration tells
 * the chat model to REWRITE the viewer's request into a concrete picture before
 * calling. The rewrite is shown to the viewer while the lookup runs
 * (`readQueryArgument` in `./tools.ts`) and echoed in the result, so a bad
 * rewrite is visible rather than silently shaping the answer.
 *
 * 🔴 WHY THIS DECLARATION IS AUTHORED HERE WHEN `./tools.ts` SAYS DECLARATIONS
 * ARE NEVER AUTHORED HERE. That rule exists because a host-executed tool's
 * schema is validated BY THE HOST, so a local copy is a contract nobody
 * enforces. This tool is not host-executed: the host's `/tools` registry does
 * not carry it, and the app itself executes it ({@link executeRecommend}),
 * translating the model's arguments into the route's body. The schema below is
 * therefore enforced by the code in this file, which is the property the rule
 * protects. What this file cannot own is the ROUTE's contract, so every route
 * rejection is classified and explained to the model rather than assumed away.
 *
 * 🔴 DEGRADED IS A FAILURE, NOT AN ANSWER. The route returns `200` with
 * `degraded: true` and EMPTY `suggestions` whenever its own pipeline fails. A
 * `200` with an empty list and `degraded: false` means something different — the
 * route judged the image needs no add-on. Collapsing the two would have the
 * model tell a viewer "no extra models needed" exactly when the service was
 * down. They are separate states here and render to opposite instructions.
 *
 * 🔴 HOSTED MODELS ARE A PROVISIONAL CONTRACT, AND EVERY WIRE NAME FOR THEM
 * LIVES IN TWO PLACES ONLY. Single-model hosted ecosystems (GPT Image, Nano
 * Banana, Seedream, …) have no add-ons, so the add-on/checkpoint lists can never
 * surface them. A civitai/civitai change NOT YET DEPLOYED adds a curated catalog
 * to the route: the request takes `needs` (capabilities), the response answers
 * `hostedModels`. Its field names may still change, so the REQUEST side is
 * spelled only in {@link ResourceIntentRequestBody} (`needs`) plus the
 * capability list {@link HOSTED_MODEL_CAPABILITIES}, and the RESPONSE side only
 * in {@link parseHostedModels}. Reconciling a rename is a change there and
 * nowhere else. Against today's deployed route the field is simply absent, and
 * absent renders NO hosted section and changes nothing else in the result.
 */
import { modelUrl } from './research.js';
import {
  BlocksHttpError,
  MAX_MESSAGE_CHARS,
  stripAirReferences,
  toolsFetch,
  type LocalToolExecutors,
  type ToolAuth,
  type ToolCallOutcome,
  type ToolDeclaration,
} from './tools.js';

/** The tool name the chat model is shown. */
export const RECOMMEND_TOOL_NAME = 'recommend_resources';

/**
 * The app-side switch for this tool.
 *
 * 🔴 THERE IS NO FEATURE-FLAG MECHANISM IN THIS APP, so this constant is the
 * gate: `false` keeps the declaration off the wire and the executor out of the
 * round, which is the whole feature. The ROUTE has its own server-side gates
 * (Flipt `resource-intent-jev`, and `resource-intent-checkpoint` for checkpoint
 * requests); while those are dark the route answers 404, or a 400 carrying a
 * plain-string reason (not a validation error), which {@link executeRecommend}
 * reports to the model as "not available" — never as an answer, and never as a
 * bad argument to retry with.
 *
 * SHIPS ON since 0.1.29 (operator decision, 2026-10-14; 0.1.28 released the
 * code dark). Turning it off again is this one line plus a release. Tests pass
 * `recommendToolEnabled` through `AppDeps` (or `enabled` to
 * {@link composeLocalTools}) to pin each state; `recommend-tool.e2e.test.tsx`
 * pins that the app AS SHIPPED declares the tool beside the host's.
 */
export const RECOMMEND_TOOL_ENABLED = true;

/** `RESOURCE_INTENT_MAX_PROMPT_LENGTH` in the route's schema — `prompt` is `.min(1).max(6000)`. */
export const MAX_IMAGE_DESCRIPTION_CHARS = 6_000;

/**
 * A base-model name longer than this is refused before any request. Real names
 * are short ("SDXL 1.0", "Illustrious"); the host's own tool registry bounds a
 * base-model filter value at 64 for the same reason. Unbounded, the name is
 * echoed into up to three notes and could push a tool message past the host's
 * 8,000-character cap — a reject of the whole next submit.
 */
export const MAX_BASE_MODEL_CHARS = 64;

/**
 * The host's bounds on ONE tool declaration and on the tools array, mirrored
 * from `chat-completion.step.ts` (`MAX_TOOL_DESCRIPTION_CHARS`,
 * `MAX_TOOL_PARAMETERS_CHARS`, `MAX_TOOLS`). Exceeding any of them is a
 * BAD_REQUEST on every submit that carries the declaration — i.e. every SFW
 * turn. The mock host does not validate them, so `recommend.test.ts` asserts the
 * declaration against these and {@link composeLocalTools} refuses to push the
 * array past the count.
 */
export const HOST_MAX_TOOL_DESCRIPTION_CHARS = 1_024;
export const HOST_MAX_TOOL_PARAMETERS_CHARS = 4_096;
export const HOST_MAX_TOOLS = 8;

/**
 * How many suggestions per kind reach the model.
 *
 * 🔴 SLICED HERE, NOT SENT AS `limit`. The route's `limit` is also its SHORTLIST
 * width — the pool its ranking stage chooses from — and its default (50) is the
 * width its offline evaluation measured. Sending `limit: 5` would rank from a
 * five-item shortlist, i.e. ask a different question. So the request omits
 * `limit` and the answer is cut to the head here.
 */
export const SHOWN_PER_KIND = 5;

/** Bounds on projected strings, so one long field cannot crowd out the rest of the result. */
const MAX_NAME_CHARS = 100;
const MAX_FIELD_CHARS = 40;
const MAX_TRIGGER_WORDS = 4;
const MAX_TRIGGER_WORD_CHARS = 40;
/** How much of the image description is echoed back in the result. The viewer saw it whole. */
const MAX_ECHO_CHARS = 300;

const BASE_MODEL_EXAMPLES = "'SD 1.5', 'SDXL 1.0', 'Pony', 'Illustrious', 'NoobAI', 'Flux.1 D'";

/**
 * The capabilities the route's hosted-model catalog is matched by — the closed
 * enum of its `needs` field (`HOSTED_MODEL_CAPABILITIES` in the civitai PR's
 * `hosted-model-catalog.constants.ts`). The route 400s any other value, which
 * would cost the add-on answer too, so {@link parseRecommendArgs} drops unknown
 * values rather than forward them.
 */
export const HOSTED_MODEL_CAPABILITIES = [
  'legible_text',
  'design_layout',
  'photoreal',
  'image_editing',
  'character_consistency',
  'high_resolution',
  'transparent_background',
  'reference_images',
] as const;
export type HostedModelCapability = (typeof HOSTED_MODEL_CAPABILITIES)[number];

/**
 * At most this many `needs` per call — the declaration's `maxItems`, and a hard
 * cut in {@link parseNeeds} (first ones kept, since the model is told to put the
 * most important first).
 *
 * 🔴 2, NOT THE ROUTE'S 8, BECAUSE OF HOW THE ROUTE RANKS. It orders hosted
 * models by how many distinct needs each covers, so every extra need favours a
 * generalist that lists many capabilities over the specialist the request
 * hinges on. Measured live on 0.1.33 (cap 4): "change my selfie's background,
 * keep my face" sent [image_editing, photoreal, reference_images,
 * high_resolution] and the route ranked HiDream O1 / MAI / Muse — Nano Banana,
 * the likeness-keeping editor, never surfaced. A request that genuinely needs a
 * third capability loses its least important one; that costs less than letting
 * breadth outrank fit.
 */
export const MAX_NEEDS = 2;

/** The route returns up to 3; this is the ceiling on what reaches the model, whatever it sends. */
export const SHOWN_HOSTED = 3;
const MAX_GOOD_AT_CHARS = 200;

/**
 * The declaration the chat model is shown.
 *
 * The description is where the rewrite instruction lives — NOT the system
 * prompt, which is eval-attributed byte-for-byte (`types.ts`) and must not be
 * edited in place. A tool's own description is the documented channel for how
 * to call it, and the host's `search_models` uses it the same way.
 *
 * 🔴 A VAGUE REQUEST IS GUESSED, NOT BOUNCED (operator decision, 0.1.33). Until
 * 0.1.32 this said "if you cannot tell what the image should show, ask the user
 * instead of calling", and "what models are best for professional content" got a
 * clarifying question and no lookup. Now the model picks one representative
 * image, calls, and offers to narrow it down — an answer the viewer can correct
 * beats a question they have to answer before seeing anything.
 */
export const RECOMMEND_TOOL_DECLARATION: ToolDeclaration = {
  type: 'function',
  function: {
    name: RECOMMEND_TOOL_NAME,
    description:
      'Recommend Civitai resources for an image the user wants to generate: add-ons (LoRAs, embeddings and similar) ' +
      'always, plus checkpoints when the base model is known. Use it when the user asks which LoRAs, add-ons or ' +
      'checkpoints to use for some kind of image. It needs a description of the IMAGE, not the user\'s question: ' +
      'before calling, turn the request into a concrete picture — subject, setting, style, lighting, mood. For ' +
      "example, for 'sfw models to use for advertising collateral' describe an image such as 'clean commercial " +
      "product photo of a perfume bottle on a white marble counter, soft studio lighting, minimal background'. " +
      'If the request is vague (for example \'models for professional content\'), do not ask first: pick one ' +
      'representative concrete image for it, call with that, and offer in your answer to narrow it down. Returns up to ' +
      `${SHOWN_PER_KIND} suggestions per kind. When a capability matters, pass needs; the result may ` +
      'then also list hosted models — single-model generators used directly, with no add-ons.',
    parameters: {
      type: 'object',
      properties: {
        image_description: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_IMAGE_DESCRIPTION_CHARS,
          description:
            'A concrete description of the image to generate, written like an image prompt: subject, setting, ' +
            "style, lighting, mood. Never the user's question itself.",
        },
        base_model: {
          type: 'string',
          description:
            'The base model (ecosystem) the user generates with, as Civitai names it — for example ' +
            `${BASE_MODEL_EXAMPLES}. Only when the user named one or it is clear from the conversation; ` +
            'otherwise omit it. When present, add-ons are matched to it and checkpoints for it are returned too.',
        },
        needs: {
          type: 'array',
          items: { type: 'string', enum: [...HOSTED_MODEL_CAPABILITIES] },
          maxItems: MAX_NEEDS,
          description:
            'Only the one or two capabilities the request hinges on, most important first — not every one that ' +
            'could apply; extras rank the wrong models ahead. Keeping a face, the same person or the same ' +
            'character is character_consistency (plus image_editing when changing their own photo). Values: ' +
            'legible_text (words or a name in the image), design_layout (logo, poster, infographic, UI mockup), ' +
            'photoreal, image_editing (changing a picture the user has), character_consistency, high_resolution ' +
            '(4K or larger), transparent_background (sticker, cutout, transparent PNG), reference_images (new ' +
            'images from supplied photos when no face or character must be kept). Omit it when nothing like ' +
            'that is implied — a style, subject or genre alone is not a need.',
        },
      },
      required: ['image_description'],
      additionalProperties: false,
    },
  },
};

// ── Arguments → request bodies ───────────────────────────────────────────────

export interface RecommendArgs {
  imageDescription: string;
  /** `null` when the model gave none — then no checkpoint request is made. */
  baseModel: string | null;
  /** Known capabilities only, de-duplicated, at most {@link MAX_NEEDS}. Empty ⇒ nothing is sent. */
  needs: HostedModelCapability[];
}

const CAPABILITY_SET: ReadonlySet<string> = new Set(HOSTED_MODEL_CAPABILITIES);

/**
 * The model's `needs`, cleaned. `undefined`/`null` is absent. Anything but an
 * array is `null` (a refusal). Unknown values are DROPPED, not refused: the
 * route 400s the whole request on one, which would cost the add-on answer for a
 * capability nobody can serve anyway.
 */
function parseNeeds(raw: unknown): HostedModelCapability[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return null;
  const out: HostedModelCapability[] = [];
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const c = v.trim();
    if (!CAPABILITY_SET.has(c) || out.includes(c as HostedModelCapability)) continue;
    out.push(c as HostedModelCapability);
    if (out.length === MAX_NEEDS) break;
  }
  return out;
}

export type ParsedRecommendArgs = { ok: true; value: RecommendArgs } | { ok: false; reason: string };

/** Validate the model's arguments. Refuses BEFORE any request, so a bad call costs no route quota. */
export function parseRecommendArgs(args: Record<string, unknown>): ParsedRecommendArgs {
  const rawDescription = args.image_description;
  if (typeof rawDescription !== 'string' || rawDescription.trim().length === 0) {
    return {
      ok: false,
      reason: 'image_description is required — describe the image the user wants to generate',
    };
  }
  const imageDescription = rawDescription.trim();
  if (imageDescription.length > MAX_IMAGE_DESCRIPTION_CHARS) {
    return {
      ok: false,
      reason: `image_description is longer than ${MAX_IMAGE_DESCRIPTION_CHARS} characters — shorten it`,
    };
  }
  const rawBase = args.base_model;
  if (rawBase !== undefined && rawBase !== null && typeof rawBase !== 'string') {
    return { ok: false, reason: 'base_model must be a string naming a base model, or omitted' };
  }
  // Blank is ABSENT: a model that emits `"base_model": ""` has not named an
  // ecosystem, and forwarding "" is a 400 from the route (`.min(1)`).
  const baseModel = typeof rawBase === 'string' && rawBase.trim().length > 0 ? rawBase.trim() : null;
  if (baseModel !== null && baseModel.length > MAX_BASE_MODEL_CHARS) {
    return {
      ok: false,
      reason: `base_model is longer than ${MAX_BASE_MODEL_CHARS} characters — give the base model's name only`,
    };
  }
  const needs = parseNeeds(args.needs);
  if (needs === null) {
    return { ok: false, reason: 'needs must be a list of capability names, or omitted' };
  }
  return { ok: true, value: { imageDescription, baseModel, needs } };
}

export type ResourceKind = 'addon' | 'checkpoint';

/** One POST body, exactly as the route's `resourceIntentInputSchema` reads it. */
export interface ResourceIntentRequestBody {
  prompt: string;
  baseModel?: string;
  kind?: 'checkpoint';
  /**
   * 🔴 PROVISIONAL WIRE NAME (see the file header) — the ONE place the request
   * side of the hosted-model contract is spelled. Sent only when non-empty, and
   * only on the add-on request.
   */
  needs?: HostedModelCapability[];
}

export interface ResourceIntentRequest {
  kind: ResourceKind;
  body: ResourceIntentRequestBody;
}

/**
 * The requests one tool call makes: add-ons always, checkpoints ONLY with a base
 * model.
 *
 * 🔴 NEVER A CHECKPOINT REQUEST WITHOUT `baseModel`. The route 400s it
 * (`baseModel is required when kind is 'checkpoint'`) at schema validation,
 * which runs before its rate limit, so the cost is not quota — it is a round
 * trip spent on an answer known in advance, and a refusal the model would then
 * have to be told to ignore. The add-on body carries NO `kind`: absent is the
 * route's add-on path, unchanged.
 *
 * `needs` rides the ADD-ON request only, and only when non-empty. The route
 * answers it the same way whatever the `kind`, so sending it on both would
 * return the same hosted list twice; the add-on request is the one always made.
 * An empty `needs` is not sent at all, so a call without one produces exactly
 * the body it produced before this field existed.
 */
export function buildResourceIntentRequests(args: RecommendArgs): ResourceIntentRequest[] {
  const addonBody: ResourceIntentRequestBody = args.baseModel
    ? { prompt: args.imageDescription, baseModel: args.baseModel }
    : { prompt: args.imageDescription };
  if (args.needs.length > 0) addonBody.needs = [...args.needs];
  const addon: ResourceIntentRequest = { kind: 'addon', body: addonBody };
  if (!args.baseModel) return [addon];
  return [
    addon,
    {
      kind: 'checkpoint',
      body: { prompt: args.imageDescription, baseModel: args.baseModel, kind: 'checkpoint' },
    },
  ];
}

// ── Route answer → classified state ──────────────────────────────────────────

/**
 * One suggestion as the model is shown it. `modelId` is what grounds a link
 * (`lib/grounding.ts`).
 *
 * 🔴 NO `versionId`. The route sends one, and it is deliberately dropped: a
 * second integer id beside `modelId` and `url` invites a model to link
 * `/models/<versionId>`, which grounding (correctly) refuses — and an
 * ungrounded link costs the viewer a billed correction round.
 */
export interface ShownSuggestion {
  modelId: number;
  name: string;
  type?: string;
  baseModel?: string;
  url: string;
  triggerWords?: string[];
}

export type KindResult =
  | { state: 'ok'; items: ShownSuggestion[]; total: number; popularityOrder: boolean }
  /**
   * 200, `degraded: false`, no suggestions. TWO different findings share this
   * shape, told apart by the route's own stage-1 verdict:
   *  - `none_needed` — the compiled `criteria.role` is `'none'`: the route judged
   *    the image needs no add-on. The ONLY reading that licenses "nothing needed".
   *  - `nothing_matched` — any other role (or none reported): the route wanted a
   *    resource and nothing survived its search, maturity clamp and hydration —
   *    e.g. an SFW-clamped viewer, or a base-model name that matches nothing.
   *    Presenting that as "no add-on needed" would be false.
   */
  | { state: 'empty'; reason: 'none_needed' | 'nothing_matched' }
  /** 200, `degraded: true` — the route's own pipeline failed. NOT an answer. */
  | { state: 'degraded' }
  | { state: 'unauthorized' }
  /** 400 with a VALIDATION error: an argument the model can fix. */
  | { state: 'invalid'; detail: string | null }
  /**
   * 404 (the route is dark for this caller), or a 400 with a plain-string
   * reason — a route-level refusal such as a dark checkpoint flag, which no
   * argument change can fix.
   */
  | { state: 'unavailable'; detail: string | null }
  | { state: 'rate_limited'; retryAfterSeconds: number | null }
  | { state: 'malformed' }
  | { state: 'error'; reason: string };

function positiveInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null;
}

function boundedString(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t ? t.slice(0, max) : undefined;
}

/** Project one route suggestion, or `null` when it carries no usable model id or name. */
function projectSuggestion(raw: unknown, kind: ResourceKind): ShownSuggestion | null {
  if (raw === null || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  const modelId = positiveInt(s.modelId);
  const name = boundedString(s.modelName, MAX_NAME_CHARS);
  if (modelId === null || !name) return null;
  const out: ShownSuggestion = { modelId, name, url: modelUrl(modelId) };
  const type = boundedString(s.modelType, MAX_FIELD_CHARS);
  if (type) out.type = type;
  const baseModel = boundedString(s.baseModel, MAX_FIELD_CHARS);
  if (baseModel) out.baseModel = baseModel;
  // Trigger words matter for ADD-ONS (a LoRA does nothing without its words);
  // a checkpoint's are not part of how it is used, so they are not shown.
  if (kind === 'addon' && Array.isArray(s.trainedWords)) {
    const words = s.trainedWords
      .map((w) => boundedString(w, MAX_TRIGGER_WORD_CHARS))
      .filter((w): w is string => !!w)
      .slice(0, MAX_TRIGGER_WORDS);
    if (words.length > 0) out.triggerWords = words;
  }
  return out;
}

/** Classify a 200 body. Exported for tests; total — never throws. */
export function classifyResourceIntentBody(body: unknown, kind: ResourceKind): KindResult {
  if (body === null || typeof body !== 'object') return { state: 'malformed' };
  const b = body as Record<string, unknown>;
  if (typeof b.degraded !== 'boolean' || !Array.isArray(b.suggestions)) return { state: 'malformed' };
  // 🔴 CHECKED BEFORE EMPTINESS, AND REGARDLESS OF IT. The route's contract is
  // that a degraded response has no suggestions; a degraded response that
  // somehow carried some is still one the route itself disowns, so it is not
  // presented.
  if (b.degraded) return { state: 'degraded' };
  if (b.suggestions.length === 0) {
    // `criteria.role` is the compiled stage-1 verdict; `intent.role.value` is the
    // same answer before compilation. Checkpoint mode reports neither (no stage
    // 1), and an absent verdict is NOT evidence that nothing is needed.
    const criteria = b.criteria as { role?: unknown } | null | undefined;
    const intent = b.intent as { role?: { value?: unknown } } | null | undefined;
    const role = criteria?.role ?? intent?.role?.value;
    return { state: 'empty', reason: role === 'none' ? 'none_needed' : 'nothing_matched' };
  }
  const projected = b.suggestions
    .map((s) => projectSuggestion(s, kind))
    .filter((s): s is ShownSuggestion => s !== null);
  // A non-empty list of which NOTHING is usable is not "nothing needed" — it is
  // a response this app cannot read.
  if (projected.length === 0) return { state: 'malformed' };
  return {
    state: 'ok',
    items: projected.slice(0, SHOWN_PER_KIND),
    total: projected.length,
    popularityOrder: b.insightFallback === true || b.coocFallback === true,
  };
}

/**
 * One hosted model as the model is shown it. `modelId` sits in an `items` array
 * in the rendered result, which is what `lib/grounding.ts` collects — so a link
 * to it is grounded exactly as an add-on's is.
 */
export interface ShownHostedModel {
  modelId: number;
  name: string;
  maker: string;
  goodAt: string;
  url: string;
  capabilities?: HostedModelCapability[];
}

/**
 * The route's hosted-model list, read defensively. `null` ⇒ the field is ABSENT
 * (or not a list) — today's deployed route — and no hosted section is rendered.
 * An array ⇒ the field is present; items that fail validation are DROPPED, so a
 * present-but-unusable list comes back as `[]`.
 *
 * 🔴 PROVISIONAL WIRE NAMES (see the file header): `hostedModels` and the item
 * fields `modelId`, `name`, `maker`, `goodAt`, `capabilities` are spelled HERE
 * and nowhere else. The item's own `url` and `key` are NOT read: the link is
 * rebuilt from `modelId` with {@link modelUrl}, so the url shown can never point
 * at an id other than the one grounding admits.
 *
 * Total — never throws. Exported for tests.
 */
export function parseHostedModels(body: unknown): ShownHostedModel[] | null {
  if (body === null || typeof body !== 'object') return null;
  const raw = (body as Record<string, unknown>).hostedModels;
  if (!Array.isArray(raw)) return null;
  const out: ShownHostedModel[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    const h = item as Record<string, unknown>;
    const modelId = positiveInt(h.modelId);
    const name = boundedString(h.name, MAX_NAME_CHARS);
    const maker = boundedString(h.maker, MAX_FIELD_CHARS);
    const goodAt = boundedString(h.goodAt, MAX_GOOD_AT_CHARS);
    if (modelId === null || !name || !maker || !goodAt) continue;
    if (out.some((o) => o.modelId === modelId)) continue;
    const shown: ShownHostedModel = { modelId, name, maker, goodAt, url: modelUrl(modelId) };
    const caps = Array.isArray(h.capabilities)
      ? HOSTED_MODEL_CAPABILITIES.filter((c) => (h.capabilities as unknown[]).includes(c))
      : [];
    if (caps.length > 0) shown.capabilities = caps;
    out.push(shown);
    if (out.length === SHOWN_HOSTED) break;
  }
  return out;
}

/** Classify a non-2xx answer. */
export function classifyHttpError(e: BlocksHttpError): KindResult {
  if (e.status === 401 || e.status === 403) return { state: 'unauthorized' };
  if (e.status === 400) {
    return e.validation ? { state: 'invalid', detail: e.detail } : { state: 'unavailable', detail: e.detail };
  }
  if (e.status === 404) return { state: 'unavailable', detail: null };
  if (e.status === 429) return { state: 'rate_limited', retryAfterSeconds: e.retryAfterSeconds };
  return { state: 'error', reason: `HTTP ${e.status}` };
}

function isAbort(e: unknown, auth: ToolAuth): boolean {
  return !!auth.signal?.aborted || (e instanceof DOMException && e.name === 'AbortError');
}

/**
 * One request's answer: the classified state, plus the hosted list when the
 * request asked for one (`null` otherwise, or when the route sent none).
 *
 * 🔴 THE HOSTED LIST IS READ INDEPENDENTLY OF THE CLASSIFICATION. The route
 * computes it in memory after its own pipeline and attaches it even to a
 * `degraded` response, so a failed add-on lookup must not discard a hosted
 * answer that did arrive.
 */
interface KindAnswer {
  kind: ResourceKind;
  result: KindResult;
  hosted: ShownHostedModel[] | null;
}

async function requestKind(req: ResourceIntentRequest, auth: ToolAuth): Promise<KindAnswer> {
  const answer = (result: KindResult, hosted: ShownHostedModel[] | null = null): KindAnswer => ({
    kind: req.kind,
    result,
    hosted,
  });
  try {
    const body = await toolsFetch(
      { path: '/resource-intent', method: 'POST', body: JSON.stringify(req.body) },
      auth,
    );
    const asked = (req.body.needs?.length ?? 0) > 0;
    return answer(classifyResourceIntentBody(body, req.kind), asked ? parseHostedModels(body) : null);
  } catch (e) {
    // 🔴 AN ABORT ENDS THE WHOLE CALL. It is re-thrown so `executeToolCall`
    // classifies it as `aborted`, which the loop discards — rendering it as a
    // per-kind failure would hand the model a "retry" for a turn the viewer
    // stopped. Checked FIRST: a Stop landing while an error body is being read
    // surfaces as a `BlocksHttpError`, and is still a Stop.
    if (isAbort(e, auth)) throw e;
    if (e instanceof BlocksHttpError) return answer(classifyHttpError(e));
    if (e instanceof DOMException && e.name === 'TimeoutError') return answer({ state: 'error', reason: 'timed out' });
    return answer({ state: 'error', reason: e instanceof Error ? e.message : 'request failed' });
  }
}

// ── Classified states → what the model reads ─────────────────────────────────

function kindLabel(kind: ResourceKind): string {
  return kind === 'addon' ? 'add-on' : 'checkpoint';
}

/** The plain-language account of a non-answer, addressed to the model. */
function failureNote(kind: ResourceKind, r: KindResult, baseModel: string | null): string {
  const label = kindLabel(kind);
  switch (r.state) {
    case 'degraded':
      return (
        `The ${label} recommendation service failed on this request and returned nothing. This is a failure, ` +
        'NOT a finding: do not tell the user that no models are needed. Say the recommendation lookup is ' +
        'unavailable right now; you may use the model search tool instead.'
      );
    case 'unauthorized':
      return (
        `Civitai rejected this app's token for ${label} recommendations. Say the recommendation lookup is ` +
        'unavailable; do not call this tool again this turn.'
      );
    case 'invalid':
      return (
        `Civitai refused the ${label} request as invalid${r.detail ? `: ${r.detail}` : ''}.` +
        (kind === 'checkpoint'
          ? ` If the base model name${baseModel ? ` "${baseModel}"` : ''} may be wrong, use Civitai's exact ` +
            'base model name or omit base_model; otherwise say checkpoint suggestions are unavailable.'
          : ' Rephrase the image description, or say the recommendation lookup failed.')
      );
    case 'unavailable':
      return (
        `${label[0].toUpperCase()}${label.slice(1)} recommendations are not available on Civitai right now` +
        `${r.detail ? ` (${r.detail})` : ''}. This is not a problem with the arguments — do not retry with a ` +
        'different base model or description. Say so; you may use the model search tool instead.'
      );
    case 'rate_limited':
      return (
        'Too many recommendation requests in a short time' +
        (r.retryAfterSeconds !== null ? `; Civitai asked to wait ${r.retryAfterSeconds} seconds` : '') +
        '. Do not call this tool again this turn; tell the user to try again shortly.'
      );
    case 'malformed':
      return `The ${label} recommendation service returned a response this app could not read. Say the lookup failed.`;
    case 'error':
      return `The ${label} recommendation request failed (${r.reason}). Say the lookup failed.`;
    case 'ok':
    case 'empty':
      return '';
  }
}

function section(kind: ResourceKind, r: KindResult, baseModel: string | null): Record<string, unknown> {
  if (r.state === 'ok') {
    return {
      status: 'ok',
      items: r.items,
      ...(r.total > r.items.length ? { notShown: r.total - r.items.length } : {}),
      ...(r.popularityOrder
        ? { note: 'Ranking data was unavailable for this request, so these are in popularity order.' }
        : {}),
    };
  }
  if (r.state === 'empty' && kind === 'addon' && r.reason === 'none_needed') {
    return {
      status: 'none_needed',
      note:
        'The recommender judged that this image needs no add-on resource — a checkpoint and a good prompt ' +
        'are enough. Tell the user that plainly.',
    };
  }
  if (r.state === 'empty') {
    // 🔴 NOTHING MATCHED IS NOT "NOTHING NEEDED". With a base model there is a
    // second reading worth naming: the add-on path does not validate `baseModel`
    // (only checkpoint mode does), so a misspelled name filters the list to
    // nothing and comes back as an ordinary empty `200` — measured live: an
    // unknown base model gave an empty, non-degraded add-on list beside a
    // checkpoint 400.
    return {
      status: 'none_found',
      note:
        `No ${kindLabel(kind)} matched this image${baseModel ? ` for base model "${baseModel}"` : ''}. ` +
        'This does not mean none is needed — say nothing suitable was found' +
        (baseModel ? ', and if the base model name may be wrong, ask the user or retry without base_model' : '') +
        '. Do not invent one.',
    };
  }
  return { status: 'failed', note: failureNote(kind, r, baseModel) };
}

const HOW_TO_PRESENT =
  'Tell the user the image description these suggestions were matched to. Then list the items per kind — name ' +
  'linked to its url, type and base model, and for add-ons their trigger words when present. Use only these ' +
  'items and their urls. A section with status "failed" is a failure to report plainly, never a sign that no ' +
  'models are needed.';

/**
 * The hosted-model section, or `undefined` when the route sent no list (which
 * keeps the serialized result byte-identical to a call made before the field
 * existed — `JSON.stringify` omits an `undefined` key).
 *
 * The list sits under `items` deliberately: that is the key `lib/grounding.ts`
 * walks for model ids, so these links are grounded like any add-on's.
 */
function hostedSection(hosted: ShownHostedModel[] | null): Record<string, unknown> | undefined {
  if (hosted === null) return undefined;
  if (hosted.length === 0) {
    return {
      status: 'none_matched',
      note: 'No hosted model matched these needs. Do not suggest one from memory.',
    };
  }
  return {
    status: 'ok',
    items: hosted,
    note:
      'These are hosted single-model ecosystems: each is one model generated with directly on Civitai, with no ' +
      'add-ons or checkpoints to pick. Present them in their own short list, separate from add-ons and ' +
      'checkpoints — name linked to its url, maker, and what it is good at — and mention the ones that fit the ' +
      'request, alongside the add-ons or instead of them when no add-on ecosystem fits.',
  };
}

/**
 * Render the classified results into the tool outcome.
 *
 * At least one kind answered (`ok` or a genuine `empty`), or a non-empty hosted
 * list arrived ⇒ a result the model presents, with any failed kind marked
 * `failed` beside it. NOTHING answered ⇒ a `failed` outcome, so it travels the
 * same error channel every other failed lookup does and grounds nothing.
 *
 * `hosted` is `null` when no hosted list was asked for or the route sent none —
 * then the result is exactly what it was before hosted models existed.
 */
export function renderRecommendation(
  args: RecommendArgs,
  results: ReadonlyArray<{ kind: ResourceKind; result: KindResult }>,
  hosted: ShownHostedModel[] | null = null,
): ToolCallOutcome {
  const answered =
    results.some((r) => r.result.state === 'ok' || r.result.state === 'empty') ||
    (hosted !== null && hosted.length > 0);
  if (!answered) {
    const [first, ...rest] = results;
    const reason =
      failureNote(first.kind, first.result, args.baseModel) +
      rest.map((r) => ` (${kindLabel(r.kind)} request: ${failureNote(r.kind, r.result, args.baseModel)})`).join('');
    return {
      ok: false,
      kind: 'failed',
      reason: `the recommendation lookup did not answer. ${reason}`,
      remedy: 'Do not present this as a recommendation and do not say that no models are needed.',
    };
  }

  const byKind = new Map(results.map((r) => [r.kind, r.result]));
  const addon = byKind.get('addon');
  const checkpoint = byKind.get('checkpoint');
  const payload: Record<string, unknown> = {
    imageDescription: args.imageDescription.slice(0, MAX_ECHO_CHARS),
    baseModel: args.baseModel,
    addons: addon ? section('addon', addon, args.baseModel) : undefined,
    checkpoints: checkpoint
      ? section('checkpoint', checkpoint, args.baseModel)
      : {
          status: 'not_requested',
          note:
            'No base model was given, so no checkpoints were requested. If the user wants checkpoint ' +
            'suggestions, ask which base model they use.',
        },
    hostedModels: hostedSection(hosted),
    howToPresent: HOW_TO_PRESENT,
  };

  // 🔴 THE FIELD BOUNDS ARE ON CHARACTERS, THE CAP IS ON THE SERIALIZED STRING,
  // and JSON escaping is the gap between them: a name of quotes or backslashes
  // doubles, a control character becomes six. Ten items at their bounds CAN
  // therefore exceed the host's cap, which is a reject of the WHOLE next request,
  // not a truncation. So the payload is shrunk in steps that each keep every
  // shown record complete — first the echo and the presentation note, then the
  // trigger words — and only then refused.
  const serialize = (p: Record<string, unknown>) => stripAirReferences(JSON.stringify(p));
  let content = serialize(payload);
  if (content.length > MAX_MESSAGE_CHARS) {
    content = serialize({ ...payload, imageDescription: undefined, howToPresent: undefined });
  }
  if (content.length > MAX_MESSAGE_CHARS) {
    const noWords = (sec: unknown) => {
      const o = sec as { items?: ShownSuggestion[] } | undefined;
      if (!o?.items) return sec;
      const hadWords = o.items.some((it) => it.triggerWords && it.triggerWords.length > 0);
      return {
        ...o,
        items: o.items.map(({ triggerWords: _drop, ...rest }) => rest),
        // Said, not silent: a LoRA without its words is half an answer, and a
        // model not told they were cut may say there are none.
        ...(hadWords ? { triggerWordsOmitted: 'Trigger words were cut to fit; tell the user to check each model page for them.' } : {}),
      };
    };
    content = serialize({
      ...payload,
      imageDescription: undefined,
      howToPresent: undefined,
      addons: noWords(payload.addons),
      checkpoints: noWords(payload.checkpoints),
    });
  }
  if (content.length > MAX_MESSAGE_CHARS) {
    return {
      ok: false,
      kind: 'failed',
      reason: 'the recommendation result was too large to include',
      remedy: 'Do not call this tool again this turn; use the model search tool instead, or say the lookup failed.',
    };
  }
  return { ok: true, content };
}

/** The executor `./tools.ts` dispatches `recommend_resources` calls to. */
export async function executeRecommend(
  args: Record<string, unknown>,
  auth: ToolAuth,
): Promise<ToolCallOutcome> {
  const parsed = parseRecommendArgs(args);
  if (!parsed.ok) return { ok: false, kind: 'arguments', reason: parsed.reason };
  const requests = buildResourceIntentRequests(parsed.value);
  // In parallel: both kinds share the route's per-block rate bucket either way,
  // and a sequential pair would double the time the viewer waits on this round.
  const answers = await Promise.all(requests.map((req) => requestKind(req, auth)));
  // Only the add-on request carries `needs`, so at most one answer has a list.
  const hosted = answers.find((a) => a.hosted !== null)?.hosted ?? null;
  return renderRecommendation(parsed.value, answers, hosted);
}

/**
 * Add this app's own tools to the host's declarations, and return the executors
 * for exactly the ones added.
 *
 * - Off ({@link RECOMMEND_TOOL_ENABLED}) ⇒ nothing added.
 * - The host served NO tools ⇒ nothing added. That is the degraded no-tools
 *   turn (`App.tsx`): the system prompt is told catalog lookup is unavailable,
 *   and a lone recommendation tool would make that notice false.
 * - The host already serves {@link HOST_MAX_TOOLS} tools ⇒ nothing added (the
 *   array would exceed the host's cap on every submit).
 * - The host already declares a tool of this name ⇒ the host's wins and the
 *   local executor is not registered, so the call goes where its contract came
 *   from.
 */
export function composeLocalTools(
  host: readonly ToolDeclaration[],
  enabled: boolean = RECOMMEND_TOOL_ENABLED,
): { declarations: ToolDeclaration[]; local: LocalToolExecutors | undefined } {
  if (
    !enabled ||
    host.length === 0 ||
    // The host caps the tools ARRAY too; pushing it past the cap would make
    // every submit carrying it a BAD_REQUEST. The host's own tools win.
    host.length >= HOST_MAX_TOOLS ||
    host.some((d) => d.function.name === RECOMMEND_TOOL_NAME)
  ) {
    return { declarations: [...host], local: undefined };
  }
  return {
    declarations: [...host, RECOMMEND_TOOL_DECLARATION],
    local: new Map([[RECOMMEND_TOOL_NAME, executeRecommend]]),
  };
}
