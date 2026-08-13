# Making Civitai Sensei work end to end — routes, ranked

**Date:** 2026-08-13 · **Status:** design study, read-only. Nothing was implemented, committed or submitted.

**Refs.** `civitai` `origin/main` = `fc5216ba908650fb6e88837d21409123293fb1e6`; `origin/release` = `c81cbb310eb86727ec3650ee552e7f72b694550d`. `chat-completion.step.ts` blob = `baee1cdc821a43886ac098a36a648d9571bea8d3` on **both** — re-verified identical. `civitai-app-sensei` `origin/feat/orchestrator-adapter` = `379b2cef2eaa1cb39cbb6e7b5e2d695e777797ad`. Generated client read from `civitai/node_modules/@civitai/client/dist/generated/types.gen.d.ts`.

Every claim below is labelled **VERIFIED** (read at a named ref, or a command's output quoted) or **INFERRED**. Negative claims carry their positive control.

---

## 0. The headline, stated plainly

> **civitai/civitai#3637 is NOT a blocker for shipping a genuinely-working Civitai Sensei. Sensei can search the Civitai catalog, look up model details and search images, and answer from real data — today, with zero upstream change, at the same 1 Buzz per answer it already costs.**

#3637 describes a **real** platform gap (the `chat-completion` step has no tool/function-calling surface, and that is worth fixing on its own merits). But it was mistaken for Sensei's blocker. It is not one, because tool-calling was never the only way to get catalog data into the model's context — and because Civitai already ships block-token-gated catalog endpoints built specifically to be fetched from inside a block iframe.

The decision currently sitting on a human — *"hold submission until the platform adds tools"* (`claudedocs/handoff-civitai-sensei-bridge.md:24`, `:84`, `:91-92`) — can be reversed. Sensei should ship on Route A and file #3637's fate as an independent platform question.

**Ground truth re-verified (all three blockers still present, on both `main` and `release`):**

1. `chatCompletionParamsSchema` is `.strict()` — `chat-completion.step.ts:280-313`; keys exactly `model:288`, `messages:289`, `maxTokens:304`, `temperature:311`. `tools` / `tool_choice` → `BAD_REQUEST`.
2. `chatMessageSchema:273-278` — `role: z.enum(['system','user','assistant'])` at `:275`, `.strict()` at `:278`. No `'tool'` role, no `tool_call_id`.
3. `extractText:455-472` reads only `output.choices[].message.{content,refusal}`; a `'textOutput'` entry cannot declare an `extractOutput` — `extractOutput?: never` on `TextOutputSurface`, `index.ts:976`.

Pinned shut by tests: `__tests__/chat-completion.step.test.ts:174-188` (a reject-loop over `tools`, `tool_choice`, `n`, `stop`, `seed`, `topP`, `presencePenalty`, `frequencyPenalty`, `logprobs`, `chatTemplateKwargs`, `responseFormat`, `user`) and `:240` (`role: 'tool'` → `success === false`).

All three are true. **None of them stands between Sensei and working catalog retrieval**, because `.strict()` bounds param *keys* and message *roles* — it places no constraint whatever on the *text* inside `content`.

---

## 1. Recommendation

**Route A — client-side retrieval (RAG) over the block catalog API, no upstream change.** Sensei's `src/lib/research.ts` already fetches Civitai catalog data (`research.ts:1`, `BASE_URL = 'https://civitai.com/api/v1'`) and already runs live in the ResearchPanel (`App.tsx:389`) — the retrieval half of the product exists and works; it is simply never fed to the model. The transport should be Civitai's **block catalog API** (`/api/v1/blocks/models`, `/api/v1/blocks/images`), three endpoints purpose-built to be fetched directly from an opaque-origin block iframe, token-gated with **no required scope**, and authoritatively maturity-clamped off a signed JWT claim. The block runs the retrieval, compacts the results, and injects them as a `system` message before the user's turn — a channel `.strict()` does not touch. **1 Buzz per answer, zero upstream approval, zero new moderation surface**, because chat input is already unaudited by design (`chat-completion.step.ts:49-61`) and the output scan is untouched. Every alternative buys the model's *choice of when to search* for at minimum one upstream PR and one extra Buzz per answer.

---

## 2. Ranked comparison

| # | Route | Time to working | Buzz / answer | Upstream approval | Blast radius | Moderation story | Confidence |
|---|---|---|---|---|---|---|---|
| **1** | **A — client-side RAG over `/api/v1/blocks/*`** | **hours–1 day** | **1** | **No** | Sensei only | **Adds nothing.** Input already unaudited (`chat-completion.step.ts:49-61`); output scan unchanged. Maturity clamped server-side | **Very High** |
| 2 | **E — expose `responseFormat`** *(not in the original brief)* | ~1 day + review | 2 | Yes, **tiny** | 1 schema key + 1 test-list line. No posture change | JSON returns on `message.content` → already read by `extractText:455` → already scanned. Zero new output surface | High |
| 3 | **C — new step type + new posture** | weeks | 2+ | Yes, **large** | New `StepModerationPosture` member ⇒ exhaustive edits in 6+ sites | Requires designing a two-phase posture — the thing `index.ts:~337` currently forbids | Medium |
| 4 | **D — prose-parsed tool emulation** | ~2 days | **2+**, worst case 10+ | No | Sensei only | Same as A | Medium-low |
| 5 | **B — tools on `chat-completion`** | weeks | 2+ | Yes, large | **Collapses into C** (§3.5) | Cannot scan tool arguments without a new posture | Low |

**Route F is not in this table.** It was drafted as "add a catalog-read procedure to the host bridge." It already exists in production and is therefore not a route — it is Route A's transport (§3.1).

### Why Route A's confidence is **Very High**

There are **two independent transports**, and losing either leaves the route intact:

- **Transport 1 — the public REST API.** Measured live with `Origin: null` (the opaque-origin case): `GET /api/v1/models?limit=2&query=anime` → `HTTP/2 200`, `access-control-allow-origin: *`, `access-control-allow-methods: GET`, `access-control-allow-headers: *`, `content-length: 45334`, **no API key sent**. Identical three headers on `/api/v1/models/16014`, `/api/v1/images?limit=2`, `/api/v1/model-versions/1`. Wrappers confirm no auth: `MixedAuthEndpoint` (`src/server/utils/endpoint-helpers.ts:202-240`, `session?.user` possibly-`undefined` at `:238`) for `/models`, `PublicEndpoint` (`:165-179`) for `/models/{id}` and `/images`. **Positive control for that absence:** the *same file* defines `AuthedEndpoint` at `:181-200`, which does call `getServerAuthSession` and 401s at `:197` — so an auth check in this file is greppable and present; the public wrappers genuinely have none.
- **Transport 2 — the block catalog API, pinned by a CI wiring test.** `src/tests/api/v1/blocks/catalog-cors-wiring.test.ts:57-73` asserts, for both `/api/v1/blocks/models` and `/api/v1/blocks/images`, that `opts.allowOpaqueOrigin === true` **and** `opts.requiredScope === undefined`, with the comment *"else an unverified (opaque-origin) block's direct catalog fetch 405s on the CORS preflight again."* Someone already hit the exact failure mode this route depends on avoiding, fixed it, and gated it in CI.

Plus a third, structural leg: **there is no `connect-src` CSP anywhere on the path.** Live headers from `https://panorama-360.civit.ai/` (identical on `sensei.civit.ai`, `notepad.civit.ai`) show exactly one CSP directive: `content-security-policy: frame-ancestors https://civitai.com https://*.civitai.com https://*.civitaic.com https://civitai.red https://*.civitai.red`. And there is no global CSP in the app either — `next.config.mjs:256-302` `headers()` contains exactly **one** `Content-Security-Policy` entry, at `:284-290`, scoped to `source: '/gift-cards'` and setting only `frame-src` for Kinguin. **Positive control:** the same grep over the same file returns `source: '/:path*'` at `:271` and `source: '/((?!gift-cards).*)'` at `:298` — the pattern fires. Sandbox does not restrict `fetch`.

---

## 3. Per-route detail

### 3.1 Route A — client-side retrieval over the block catalog API (RECOMMENDED)

#### The transport: three endpoints built for exactly this

**VERIFIED.** Three block-token-gated catalog endpoints exist, designed to be fetched *directly by the iframe*:

| Endpoint | Wiring | Required scope |
|---|---|---|
| `GET /api/v1/blocks/models` | `src/pages/api/v1/blocks/models.ts:201` → `withBlockScope(baseHandler, { endpoint: 'models', allowOpaqueOrigin: true })` | **none** |
| `GET /api/v1/blocks/images` | `src/pages/api/v1/blocks/images.ts:275` → same, `endpoint: 'images'` | **none** |
| `GET /api/v1/blocks/generation-resources` | `src/pages/api/v1/blocks/generation-resources.ts:136-139` → same, `endpoint: 'generation_resources'` | **none** |

`blocks/models.ts:24-56` states the intent directly: *"Returns the SAME response shape as the public `/api/v1/models` (it shares `runModelSearch`), so an in-block model selector can switch endpoints with minimal change."* Auth is *"ANY valid block token (no required scope)… Anon (no token) → 401."*

**The opaque-origin branch** — `src/server/middleware/block-scope.middleware.ts:369-386`: *"Unverified blocks run sandboxed without `allow-same-origin` → opaque origin → `Origin: null`, which can never be in the allowlist above. We echo `ACAO: null` ONLY when the endpoint opted in… the preflight is policy only, the token is the gate."* It sets `Access-Control-Allow-Origin: null`, `Vary: Origin`, `Access-Control-Allow-Headers: Authorization, Content-Type`, `Access-Control-Allow-Methods: GET, POST, OPTIONS`, and 204s the `OPTIONS`. `Access-Control-Allow-Credentials` is deliberately omitted. The `OPTIONS` handling is load-bearing: an `Authorization: Bearer` header makes this a non-simple request that always preflights.

**Why this beats the public API on three axes:**

1. **Maturity is authoritative, not incidental.** The public path is safe only by accident of the anonymous default — I measured 10/10 items from `/api/v1/images?limit=10` at `browsingLevel: 1`, `nsfw: false`, which is a fact about the *current* anonymous default, not a guarantee. The block endpoints instead clamp off the **signed `maxBrowsingLevel` JWT claim** via `resolveCatalogBrowsingLevel` (`src/server/utils/block-catalog-maturity.ts:40-58`), **fail-closed to SFW** when the claim is absent, *plus* a region-restriction clamp (`:43-53`) added specifically to close a GA-safety gap ("a red-domain block viewed from a restricted region could still surface mature catalog content"). `blocks/models.ts:64-67`: *"Maturity is intentionally ABSENT [from the query schema]: it comes ONLY from the server-side clamp, never the client."* For a `contentRating: "pg13"` app (`block.manifest.json:32`) this is the correct posture and it is not something the app can get wrong.
2. **Same response shape.** Sensei's `ModelSearchResult` type (`research.ts:42-52`) does not change.
3. **It is the sanctioned path.** Fetching the public API from a block works but is incidental; these endpoints exist *for* this, and there is a CI test keeping them that way.

**There is deliberately no `catalog:read` scope** — `src/shared/constants/block-scope.constants.ts:39-49`: *"NOTE: there is intentionally NO `catalog:read` scope… A `catalog:read` scope was briefly added (#2671) and retired the next day."* Sensei's existing token works today, unchanged.

#### Reachability — four independent legs, all VERIFIED

1. *CORS, public path* — live probe with `Origin: null`, quoted in §2.
2. *CORS, block path* — `ACAO: null` opt-in branch at `block-scope.middleware.ts:369-386`, CI-pinned at `catalog-cors-wiring.test.ts:57-73`.
3. *CSP* — `frame-ancestors` only, live-measured; no global CSP in `next.config.mjs`, with positive control (§2).
4. *Sandbox* — unverified-tier blocks get no `allow-same-origin`. `src/components/AppBlocks/sandbox.ts:9-16` `ALLOWED_SANDBOX_TOKENS` = `{allow-scripts, allow-forms, allow-popups, allow-modals, allow-pointer-lock, allow-downloads}`; `allow-same-origin` is **not** in the allowlist and can never arrive from a manifest — it is injected only for `TRUSTED_TIERS = {'internal','verified'}` (`:22`, `:41-47`). `MINIMAL_SANDBOX = ['allow-scripts']` is the fail-closed floor (`:30`). `effectiveSandboxIsOpaque()` (`:100`) drives the transport into opaque mode; applied at `PageBlockHost.tsx:719-728` and rendered at `PageBlockHost.tsx:3526` / `IframeHost.tsx:2223`. Sensei's own manifest declares `"sandbox": "allow-scripts allow-forms"` (`block.manifest.json:30`). Opaque origin ⇒ `Origin: null` ⇒ legs 1 and 2 both apply.

#### Per-tool mapping

| Sensei tool | Endpoint | Scope needed | Sensei has it? |
|---|---|---|---|
| `search_models` | `/api/v1/blocks/models` | none | ✅ **works today** |
| `search_images` | `/api/v1/blocks/images` | none | ✅ **works today** (with a param caveat, below) |
| `get_model_details` | `/api/v1/models/{id}` | **`models:read:self`** — `src/pages/api/v1/models/[id].ts:259-262`, `withBlockScope(baseHandler, { endpoint: 'model_detail', requiredScope: 'models:read:self' })` | ❌ **not declared** — `block.manifest.json:8-13` lists only `ai:write:budgeted`, `buzz:read:self`, `apps:storage:read`, `apps:storage:write` |
| `delegate_to_nsfw_agent` | second `chat-completion` call | `ai:write:budgeted` | ✅ works, but **doubles Buzz** — see §3.4 |

**Closing the `get_model_details` gap — three options, ranked:**

1. **Derive it from the search result — costs nothing.** `/api/v1/blocks/models` shares `runModelSearch` and returns the public shape, which already carries `modelVersions[]`, `stats`, `type`, `description`; Sensei's own type declares exactly those at `research.ts:42-52`. For a chat answer this is very likely sufficient. **Do this first.**
2. **Add `models:read:self` to the manifest.** It is a valid member of the canonical enum (`public/schemas/app-block/v1.json` → `properties.scopes.items.enum`, first entry) mapped to `TokenScope.ModelsRead` at `block-scope.constants.ts:38`. Cost: manifest change + a `scopeJustifications` entry + re-review + an added user consent prompt. Do this only if (1) proves thin in dogfooding.
3. **Fall back to the public `/api/v1/models/{id}`** — `ACAO: *`, no auth, verified 200. Works, but bypasses the maturity clamp, so use it only as a degraded path, never the default.

**Param caveat on `search_images` (VERIFIED).** `blockImagesSchema` (`blocks/images.ts:92-114`) accepts `limit` (max 200), `page`, `postId`, `modelId`, `modelVersionId`, `imageId`, `username`, `userId`, `period`, `sort`, `tags` (numeric IDs), `cursor`, `type`, `baseModels`, `withMeta`. **There is no free-text `query` param.** Sensei's `search_images` tool declares one (`src/lib/tools.ts:52`). So image search must be driven by `modelId` / `modelVersionId` (which is the useful case anyway — "show me examples from this model") or by tag IDs, not by prose. Same for `blockModelsSchema` (`blocks/models.ts:68-86`): it takes `query`, `types` (**plural, array**), `baseModels`, `sort` (`ModelSort` enum), `limit` (max 100, default 100), `cursor`, `supportsGeneration` — note `types` is plural and array-shaped where Sensei's tool declares a singular `type` (`tools.ts:13`).

#### The design

1. **Retrieve deterministically, per turn, with no LLM call.** Pass the user's raw message to `/api/v1/blocks/models?query=…&limit=8` with `Authorization: Bearer <block token>`. A search engine handles free text; you do not need a model to write the query. Add a cheap client-side skip for obviously non-catalog turns ("thanks", "what is CFG scale") — a miss costs one wasted HTTP request, never Buzz.
2. **Compact and inject as a `system` message** immediately before the user turn. Include `id`, `name`, `type`, `baseModel`, stats, and the canonical `civitai.com/models/{id}` URL so the answer cites real links.
3. 🔴 **Strip the literal `urn:air:` before submitting — mandatory, not optional.** `blocks.router.ts:7295` runs `containsAirReference(built.input)`, a **case-insensitive substring** scan over every string, array element, object value **and object key**, depth-capped at 128 (`index.ts:467`, `:502-508`); a hit is a hard `FORBIDDEN` *before* the quote, so it costs no Buzz but kills the turn. A retrieved model description containing that literal would bounce the whole message. The step's own header names this app-side fix (`chat-completion.step.ts:152-157`): *"`messages[].content` is assembled by the block, which can strip or escape the literal before submitting."*
4. **Ground the system prompt**: answer only from the injected results; if they do not cover the question, say so. This is what fixes the current failure mode — *"the model will claim catalog access it does not have"* (`claudedocs/handoff-civitai-sensei-bridge.md:91-92`).
5. **Follow-ups**: when a previous turn surfaced model IDs and the user references one, fetch details for that ID rather than re-searching.
6. **Delete `tools`, `tool_choice`, `stream`, `max_tokens` from the submit payload** — `App.tsx:239-241` still sends all four, and each is an independent `BAD_REQUEST` under `.strict()`.

#### The context budget — a correction to the brief's premise

**VERIFIED: `maxTokens` does not compete with injected context.** `ChatCompletionInput.maxTokens` is documented *"Maximum number of tokens to **generate**"* (`types.gen.d.ts:1070-1073`), and the step's own comment calls it *"The hard ceiling on **generated** tokens"* (`chat-completion.step.ts:213`). It bounds **output only**.

The **input** budget is separate and large: `MAX_MESSAGES = 32`, `MAX_MESSAGE_CHARS = 8_000` (`chat-completion.step.ts:248-249`, enforced at `:276` and `:289`) — i.e. **up to 256,000 characters of prefill**, roughly 32× what the brief assumed. So with `maxTokens: 4000` (≈16,000 characters of answer, per the step's own derivation at `:220-225`) you still have:

- a single 8,000-char `system` message of catalog context — comfortably ~15–25 compacted model records with descriptions truncated;
- room for a full conversation history alongside it, since each of the 32 message slots has its own 8,000-char budget;
- no trade-off against answer length at all.

The real budget question is prefill **quality and cost-of-attention**, not capacity. Practical guidance: cap injected context at ~6,000 chars/turn and truncate descriptions to ~300 chars each; that is a quality choice, not a limit.

#### What Route A gives up

The model does not choose *when* or *what* to search. For a catalog assistant, where nearly every turn is catalog-relevant and the user's own words are a serviceable query, this is a small loss. Route E is the upgrade path that buys it back for +1 Buzz, and Route A's code survives the upgrade — only the query source changes.

---

### 3.2 Route E — expose `responseFormat` (the best upstream option; not in the original brief)

**VERIFIED: the orchestrator already supports structured JSON output.** `ChatCompletionInput.responseFormat?: ChatCompletionResponseFormat` (`types.gen.d.ts:1128`), where `ChatCompletionResponseFormat = { type: string /* 'text' | 'json_object' | 'json_schema' */, jsonSchema?: ChatCompletionJsonSchema }` (`:1191-1197`), and `ChatCompletionJsonSchema = { name, description?, schema, strict? }` with OpenAI strict mode (`:1170-1177`).

**Why it dominates B/C/D for the intent problem:** the JSON arrives on `choices[0].message.content` as a plain string. The generated type says so — `ChatCompletionOutput.parsed` is documented as *"Parsed JSON content of `Choices[0].Message.Content`. Populated when the request specified a JSON-flavored `response_format`…"* (`:1177-1183`), i.e. a convenience mirror, not the primary channel. Therefore:

- `extractText:455-472` **already reads it** — no change;
- it is **already scanned** by xGuard on the output phase — **no new moderation surface**;
- no `extractOutput` needed ⇒ **MEDIA-XOR-TEXT is not reopened**;
- no `'tool'` role / `tool_call_id` ⇒ `chatMessageSchema` **unchanged**;
- no posture change ⇒ `posturePhaseRequirements`, `stepOutputShape`, `ACCEPTABLE_POSTURES_BY_TYPE` and the moderation handler table all **unchanged**.

**File-level implementation:**

| File | Change |
|---|---|
| `src/server/services/blocks/steps/chat-completion.step.ts` | Add optional `responseFormat` to `chatCompletionParamsSchema` (~`:311`) as a `.strict()` object: `{ type: z.enum(['text','json_object','json_schema']), jsonSchema: z.object({ name: z.string().max(64), description: z.string().max(512).optional(), schema: <bounded>, strict: z.boolean().optional() }).optional() }`, with a `.superRefine` requiring `jsonSchema` iff `type === 'json_schema'`. Thread through `buildChatCompletionInput` (`:355-362`) — the declared `ChatCompletionInput` return type makes a field-name error a build failure. Bound the serialized schema (`JSON.stringify(schema).length <= 4_000`); see policy §4.3. |
| `src/server/services/blocks/steps/__tests__/chat-completion.step.test.ts` | Remove `['responseFormat', { type: 'json_object' }]` from the reject-list at `:184`. Add: accepts each `type`; rejects `json_schema` without `jsonSchema`; rejects an over-cap schema; **update the exact-key-set assertion on `buildStep`** (currently pinned to `{model, messages, maxTokens, temperature?}`, referenced at `:116`). |
| `type-contract.ts` / moderation / registry / router | **No change.** |

**Migration/compat:** purely additive optional param; no existing caller changes; `canonicalParamsFor` (`:429-436`) unchanged, so registry load-time clauses re-run against the same canonical object.

**Design with E:** call 1 asks for `{"needsCatalog":bool,"query":str,"types":str[]|null,"modelIds":int[]}` at `maxTokens: 200`; the block executes retrieval; call 2 answers. **2 Buzz.** Ship behind a Sensei setting so users can trade 1 Buzz for better retrieval.

**Gotcha (VERIFIED):** `tool_choice?: null` in the generated client (`types.gen.d.ts:1122`) — the code-gen collapsed OpenAI's polymorphic value to bare `null`, making it unusable through the typed client. An independent argument against B/C; a non-issue for E.

---

### 3.3 Route C — new step type + new posture

Honest cost. A `'toolLoop'` posture requiring `{submit: true, output: true}` needs coordinated edits to: `StepModerationPosture` (`index.ts:141`), `stepOutputShape` (`:271`), `posturePhaseRequirements` (`:~337`), `postureRequiresTextExtraction` (`:~322`), `ACCEPTABLE_POSTURES_BY_TYPE` (`:649`), the null-prototype handler table (`moderation.ts:214`) with a **new submit-phase text handler** (none exists today), the type-level surface union (`index.ts:983`, `:1048-1053`), plus a new step file, `type-contract.ts` anchors, and the `step-moderation` / `step-registry` suites. Every `switch` is exhaustive so the compiler finds the sites — but each is a reviewed policy decision, not a mechanical edit.

**This is the right route if the platform wants first-class agentic blocks. It is the wrong route to unblock one app.** Roadmap item, not a Sensei dependency.

---

### 3.4 Route D — prose-parsed tool emulation

Works today with no upstream change, but strictly dominated: same 2 Buzz as Route E with *unreliable* parsing (regex-scraping intent out of prose), and no better than Route A's 1 Buzz. **VERIFIED worst case is far above the "2+" prior estimate:** `App.tsx:231` sets `maxToolRounds = 5`, and `delegate_to_nsfw_agent` (`App.tsx:277-282`) issues a *second full completion* inside a round — so one answer can reach **10+ Buzz**. "2+" is a floor, not a typical.

---

### 3.5 Route B — tools on `chat-completion` (do not pursue; it collapses into C)

Blast radius is **not** the problem, and the brief's framing here was wrong. **VERIFIED: the registry has exactly two entries** — `'convert-image'` and `'chat-completion'` (`index.ts:1431-1432`) — and `chat-completion` is the **only** `'textOutput'` adopter (`chat-completion.step.ts:418`; `convert-image.step.ts:175` is `'none'`). So B breaks nothing else.

B's real obstacle is different and worse. **The only channel from a chat step to a block is `string[]` via `extractText`** — enforced at the type level (`extractOutput?: never`, `index.ts:976`), at registry load (clauses 8/8a, `index.ts:1840`, `:1866`), and on the read path (`workflow.service.ts:134` gates `extractOutput` on `postureProducesMedia`). So `tool_calls[]` would have to be JSON-serialized into `extractText`'s return — where it is scanned as prose and where the block cannot distinguish a tool call from an answer without an out-of-band convention.

And scanning tool **arguments at submit** is structurally blocked: `posturePhaseRequirements('textOutput')` returns `{submit: false, output: true}` (`index.ts:~355`), and `assertModerationHandlerTable` (`moderation.ts:336`) makes a submit-phase handler on that posture a **module-load throw** — deliberately, because a text handler running pre-generation would scan `''` and report success. `ACCEPTABLE_POSTURES_BY_TYPE` is *"a SET, NOT A LADDER"* (`index.ts:649-656`). **So B forces a new posture ⇒ B is C.** Pursue C or E, never B.

---

## 4. The four policy positions

### 4.1 Scanning `tool_calls[].arguments` — scan them at the OUTPUT phase, via `extractText`, and nowhere else

Tool arguments are *model-generated* free text: the model writes them. That makes them **output**, not input, and the output phase is exactly where generated text is already scanned. Concretely: `extractText` returns `[...contents, ...refusals, ...toolCalls.map(tc => tc.function.arguments)]`. This needs **no new posture**, keeps the withhold contract intact (`index.ts:954-960`: what `extractText` returns is what is scanned *and* what is published — the two move together by construction, which is what makes an under-inclusive extractor a missing feature rather than a silent hole), and a trip correctly withholds the turn rather than executing a policy-violating query against the catalog. Cost: the joined content grows, still bounded by `MAX_SCANNED_CONTENT_CHARS = 50_000` (`text-output-moderation.ts:560`), memoized 5 min (`:572`).

**The counter-position — scanning arguments at submit — is wrong twice over:** they do not exist at submit, and a submit-phase handler on a `'textOutput'` posture is a module-load throw (`moderation.ts:336`).

*Moot under the recommendation: Routes A and E produce no `tool_calls` at all.*

### 4.2 Widening the `urn:air:` scan to tool names / descriptions / schemas — not a widening; already covered, and it must stay covered

`containsAirReference` (`index.ts:502-508`) recurses over every string, array element, object value **and object key** of the built input, and the request-time gate (`blocks.router.ts:7295`) runs on `built.input` wholesale. The moment `tools` or `responseFormat.jsonSchema` becomes part of that object, the scan reaches it with **zero code change**. Do not scope it out.

The asymmetry argument at `chat-completion.step.ts:144-157` — a false positive costs one bounced request, an entitlement bypass is unrecoverable — is *stronger* here than for message prose, because tool schemas are authored by the **app**, not typed by an end user, so a false positive is fixed once by the developer rather than bouncing an innocent question. One thing owed: the existing `FORBIDDEN` message (`blocks.router.ts:7296-7307`) already explains that the check is a substring scan and says "strip or escape the literal" — verify it still reads correctly when the offending string is a JSON schema rather than prose.

### 4.3 Bounding `tools` as unpriced prefill — one TOTAL input-character budget, checked in a `.superRefine`, not a second independent cap

The price is flat at **1 Buzz from 1 token to 200,000, measured** (`chat-completion.step.ts:16-19`, `:178`), so prefill is genuinely unpriced compute and a hard cap is the only lever — the same reasoning the file already uses to make `maxTokens` required rather than defaulted (`:291-303`). A *separate* `MAX_TOOLS` cap alongside the existing `32 × 8,000` message budget lets a caller stack the two.

Instead: define `MAX_TOTAL_INPUT_CHARS` and refine over `sum(messages[].content.length) + JSON.stringify(tools ?? responseFormat ?? {}).length`. Set it at the current effective ceiling (256,000) so the change is non-breaking, and add per-item sanity bounds (`MAX_TOOLS = 8`, name ≤ 64, description ≤ 512, serialized schema ≤ 4,000) so one pathological tool cannot consume the whole budget. Widening later is additive; narrowing is breaking (`:245-247`).

### 4.4 Multi-round Buzz vs `buzzBudgetPerGen` — keep it strictly per-call; bound rounds in the app and rely on the existing velocity cap

`buzzBudgetPerGen` becomes the JWT `claims.buzzBudget` and is gated per submit at `blocks.router.ts:7393`. It must **not** become a per-conversation budget, because the platform has no notion of a conversation — a multi-round exchange is N independent `submitWorkflow` calls, and the router hard-rejects anything but a single step per workflow (`blocks.router.ts:1095`, *"expected a single generation step"*).

At 1 Buzz/round, Sensei's 5-round loop is 5 Buzz against a declared budget of 50 (`block.manifest.json:24`) — so the per-call gate **provably does nothing** to bound rounds, and raising or lowering it will not change that. What *does* bound a runaway loop already exists and is the correct instrument: the per-**user** per-UTC-day aggregate `BLOCK_BUZZ_CAP_PER_DAY = 50_000` (`blocks.router.ts:~720`, deliberately keyed *without* `appBlockId` so N blocks cannot multiply it — *"A per-block key let a publisher multiply the effective cap by spinning up N blocks"*), and the per-**app** velocity cap `SHIPPED_APP_VELOCITY_MAX_GENS = 120 / 60 s` (`app-cap-limits.constants.ts:195`, `:321-324`). Both bound calls regardless of who is spending, which is what an abuse cap should do.

**So: the app declares and displays its round budget; the platform keeps the velocity cap.** If owners still want a platform-side round bound, the only honest shape is a per-`(blockInstanceId, conversationId)` counter — which requires the platform to model a conversation, a materially larger ask than it appears, and an independent reason to prefer Routes A (1 call) and E (2 calls).

---

## 5. Concrete app-side change list for Route A (sensei repo) — NOT IMPLEMENTED

Sizing against `origin/feat/orchestrator-adapter` (`379b2cef2`). **Estimate: ~250–350 net lines across 6 files, plus test updates. One focused day.** The retrieval half already exists; this is mostly deletion and rewiring.

| # | File | Change | Size |
|---|---|---|---|
| 1 | `src/lib/research.ts` | Change `BASE_URL` (`:1`) from `'https://civitai.com/api/v1'` to `'https://civitai.com/api/v1/blocks'` for the two endpoints that have block variants. Add an `Authorization: Bearer <token>` header to `fetchWithBackoff` (`:29-40`) — take the token as a parameter rather than importing a hook, so the module stays testable. **Fix the param names**: `type` → `types` (array) and map Sensei's sort labels onto the `ModelSort` enum for models; **drop the `query` param from `searchImages`** (it does not exist — `blocks/images.ts:92-114`) and drive it by `modelId` / `modelVersionId`. Keep the 5-min cache (`:8-27`) and the 429 backoff — both still correct. | ~50 lines changed |
| 2 | `src/lib/research.ts` (new export) | Add `formatCatalogContext(results): string` — compact search results into a bounded block (~6,000 chars; truncate each description to ~300), emitting `id`, `name`, `type`, `baseModel`, stats, canonical URL. **This is where the `urn:air:` strip lives** — one `replaceAll(/urn:air:/gi, 'urn-air-')` over the assembled string, with a unit test asserting the literal cannot survive. | ~60 new lines |
| 3 | `src/lib/chat.ts` | Extend `withSystemPrompt` (or add a sibling) to splice a retrieval `system` message immediately before the latest user turn, and add the grounding instruction ("answer only from the results below; if they do not cover the question, say so"). Assert the assembled array satisfies `MAX_MESSAGES = 32` and each `content` ≤ `MAX_MESSAGE_CHARS = 8_000`. | ~40 lines |
| 4 | `src/App.tsx` | **The main edit.** Delete the `while (maxToolRounds > 0)` loop (`:233-331`) and the four `tc.function.name` branches (`:277-303`). Replace with a linear flow: *(a)* cheap non-catalog skip heuristic → *(b)* `researchLib.searchModels(userText)` → *(c)* `formatCatalogContext` → *(d)* one `submitChatCompletion`. **Delete `tools: CIVITAI_TOOLS` (`:240`), `stream: true` (`:241`), and `max_tokens` (`:239`)** — the first two are `.strict()` `BAD_REQUEST`s, and the third is the wrong case (`maxTokens`). Keep `setSearchResults(...)` so the ResearchPanel still lights up with what the turn retrieved — a nice side effect: the user *sees* the grounding. Keep the `TextOutputWithheldError` handling (`:342-345`) verbatim. | ~120 lines removed, ~60 added |
| 5 | `src/lib/tools.ts` | Retire `CIVITAI_TOOLS` as a wire payload. Either delete the file or demote it to a documentation-only constant — **do not keep sending it**. `delegate_to_nsfw_agent` becomes an explicit user-facing model switch (Dolphin is already an allowlisted model, `chat-completion.step.ts:206`) rather than a hidden second Buzz charge. | ~100 lines removed |
| 6 | `src/lib/orchestrator-bridge.ts` / `completion-types.ts` | Narrow the request type so `tools` / `tool_choice` / `stream` are no longer expressible — make the wrong payload a **compile error**, not a runtime `BAD_REQUEST`. Retain the `textOutputs` / `textOutputWithheld` widening (handoff `:165-169`) until the SDK catches up. | ~30 lines |
| 7 | Tests | `research.test.ts`: block-endpoint URLs, the Authorization header, the `urn:air:` strip (with a positive control that an un-stripped fixture *would* contain it), the param-name mapping. `App.test.tsx` / `e2e.test.tsx`: replace the tool-loop assertions with retrieve-then-inject; assert the submitted payload's **exact key set** is `{model, messages, maxTokens, temperature?}` — that single assertion pins every `.strict()` blocker at once. Delete `tools.test.ts` if the file goes. 🔴 The handoff's own lesson applies (`:173-178`): the previous suite was green against a bridge that could not work, because the fakes encoded the same wrong shape as the code. **Build the new fixtures from the real schema at `chat-completion.step.ts:280-313`, and verify red→green against `HEAD` before the change.** | ~150 lines |

**Not needed:** no manifest change (all required scopes already declared — `models:read:self` only if option 2 of §3.1 is chosen), no SDK bump, no upstream PR, no re-review beyond the normal submission.

**Token plumbing (VERIFIED):** `useBlockToken` is publicly exported from `@civitai/blocks-react` — `packages/civitai-blocks-react/src/index.ts:38`, `export { useBlockToken } from './hooks/useBlockToken.js'`, and the hook returns `raw` (`src/hooks/useBlockToken.ts:30-53`). **Positive control:** `useGenerationResources` / `useCheckpointPicker` also grep as exports from the same index (2 hits) — the pattern fires. Note `blocks-react` *does* have an internal catalog client (`src/internal/catalog.ts:46`, `CATALOG_API_BASE_BLOCKS = '/api/v1/blocks/models'`) but it is **not** re-exported from the public index — it serves the `dev:live` harness — so Sensei hand-rolls the fetch, which is ~20 lines and the reason item 1 above is small.

---

## 6. What would change the recommendation

- **Owners rule that client-executed catalog reads are a policy problem** (attribution, rate-limit attribution, or wanting the picker's stricter isolation). This is the most plausible flip. It would not change the *route*, only the *transport* — and the block catalog API is already the maximally-sanctioned transport available, so the answer would be a conversation rather than a redesign.
- **Retrieval quality proves insufficient in dogfooding** — "always-retrieve on the raw user text" returns junk for a meaningful share of turns. Then → **Route E** as an incremental upgrade at +1 Buzz, not a rewrite. Route A's code stays; only the query source changes.
- **The deployed orchestrator does not honour `responseFormat`** (open unknown #4). Would not touch Route A; would kill Route E and promote Route C for the intent problem.
- **The platform decides to make agentic blocks first-class.** Then → **Route C**, on the roadmap, independent of Sensei. Sensei should not be its blocker, and #3637 should be re-scoped to say so.

Nothing found would make **Route B** the answer.

**Downgraded from the original draft:** "a live in-frame fetch fails" was listed as the single load-bearing assumption. With two independent transports — the second CI-pinned for exactly the opaque-origin case — it is no longer a single point of failure. Still worth running (open unknown #1), but a failure on one transport leaves the route standing.

---

## 7. Open unknowns I could not settle read-only

| # | Unknown | Exact command / access to settle it |
|---|---|---|
| 1 | **Does an in-frame `fetch` actually succeed?** Evidence is header-level and spec-level, not a real in-frame execution. A Cloudflare bot rule keying on `Origin: null`, or a WAF on the block subdomain, would not appear in my probes. **No longer a single point of failure** (§6). | In a dev tunnel (handoff `:137-145`), in the block frame console: `fetch('https://civitai.com/api/v1/blocks/models?query=anime&limit=1',{headers:{Authorization:'Bearer '+TOKEN}}).then(r=>[r.status,r.type]).then(console.log)` — expect `[200,'cors']`, **not** `'opaque'`. 🔴 Positive control required: the same call to a URL with no `ACAO` must reject, or a `200` proves only that `fetch` ran, not that CORS passed. |
| 2 | **Rate-limit posture at conversational volume.** **Partly resolved:** `withBlockScope` runs `checkBlockCatalogRateLimit` keyed on `blockInstanceId` (`blocks.router.ts:417`, `:3460`, `:3555`, `:3812`, `:5060`; limiter at `src/server/utils/block-catalog-rate-limit.ts`) — a known, per-install budget rather than an unknown public-IP limit. Residual: the exact numbers, and whether one search/turn fits comfortably. | Read `src/server/utils/block-catalog-rate-limit.ts` for the window and ceiling, then confirm empirically in the dev tunnel by issuing N sequential searches and reading the response codes — not just the first. |
| 3 | **`@civitai/app-sdk` request-side surface.** Enumerated the 43 host-bridge message types from `hostHandlerParity.ts`, and confirmed **no catalog-search action** exists on the bridge. Residual is only whether a convenience wrapper exists somewhere unexported. | `git -C /home/zach/workspace/civit/civitai-app-starters log --oneline -1 origin/main`, then read `packages/civitai-app-sdk/src/blocks/index.ts` and `packages/civitai-blocks-react/src/index.ts` for the exported client interface. |
| 4 | **Does the deployed orchestrator honour `responseFormat`** for the three allowlisted models? The generated type declares it; the deployed build is a separately-deployed service, and a type encodes shape, never behaviour — the same caveat `chat-completion.step.ts:144-151` raises about AIR resolution. **Gate Route E on this**; it is the one thing that could make E inert. | One direct orchestrator call (needs a bearer token the prior session also could not mint): `POST {{host}}/v2/consumer/workflows?wait=60` with `{"steps":[{"$type":"chatCompletion","input":{"model":"openai/gpt-4o-mini","messages":[{"role":"user","content":"reply with {\"ok\":true}"}],"maxTokens":50,"responseFormat":{"type":"json_object"}}}]}`. Read `choices[0].message.content` **and** `output.parsed`. 🔴 Control: the identical call *without* `responseFormat`, to confirm the difference is the field and not the prompt. |
| 5 | **Whether #3637's owners already have Route C on a roadmap** — changes whether the right move is to reply re-scoping it, or to close it. | `gh issue view 3637 --repo civitai/civitai --comments` |
| 6 | **panorama-360's deployed `trustTier`** — a DB value (`AppBlock.trustTier`), in neither repo. Decides whether its effective sandbox includes `allow-same-origin`. Immaterial to Sensei; noted for completeness. | Query `AppBlock.trustTier` for `blockId = 'panorama-360'`. |

**Two notes on anything drafted upstream.** 🔴 `civitai/civitai` is a **PUBLIC** repo — a Route E PR body or any #3637 reply must contain no infra internals (no IPs, cluster or node names, internal hostnames, service DNS, topology). And the app deploys from `release`, not `main`: the entire blocks path is byte-identical across the two (`git diff --name-only origin/release origin/main -- src/server/services/blocks/ src/server/routers/blocks.router.ts` → **empty**, against a positive control of `92 files changed` for the whole tree), so a Route E PR against `main` needs the usual promotion but carries no divergence risk today.

---

## Appendix A — Side findings

### A.1 A comment-scope tension in `PageBlockHost.tsx` (doc accuracy, not a security hole)

`src/components/AppBlocks/PageBlockHost.tsx:2861-2865` states of the resource picker: *"The untrusted iframe NEVER receives a list, the search API, or the catalog — it only ever learns about the one resource the user physically picked."*

That is **true of the bridge** and **false as a claim about the platform**: `/api/v1/blocks/models` hands the same iframe a paginated, searchable catalog with **no required scope**, over `ACAO: null` (`blocks/models.ts:201`; `block-scope.middleware.ts:369-386`). Both designs are deliberate and cite each other — the picker keeps the *bridge* narrow; the REST endpoint provides the *searchable* surface under a maturity clamp. But a maintainer reading only that comment would form a stronger isolation belief than the system provides, and a comment is a claim like any other. **Suggested amendment:** scope the sentence to the bridge — "the iframe never receives a list *through this channel*" — and cross-reference `/api/v1/blocks/models` as the sanctioned searchable surface.

### A.2 panorama-360 — a clean negative, with its positive control

The brief flagged panorama-360's live "model chips" as a strong lead, on the theory that an existing block already reads the catalog. **It does not.** Two independent traces agree:

- **Deployed bundle.** `https://panorama-360.civit.ai/assets/index--k-y_-Ca.js` (66,619 B): `grep -oE 'https://[a-z0-9.-]*civitai\.com/api/v[0-9][a-zA-Z0-9/_-]*'` → **0 matches**; `grep -oE '"[a-zA-Z.]*\.(getAll|search|getById)"'` → **0 matches**. 🔴 **Positive control:** `grep -c -o -i 'panorama'` on the same file → **15**. The pattern fires; there is simply no catalog call.
- **Source.** Over the repo's full `src/`, `api/v1|/blocks/models|/blocks/images|/api/trpc` hit only `src/setup-dev-live.ts:153` (`${origin}/api/v1/blocks/dev-token`) and its two test assertions at `src/setup-dev-live.test.ts:159,173` — again the pattern fires and simply never matches a catalog route.

**What the chips actually are:** hardcoded UI chips built from `SCENE_PRESETS` / `PANO_ENGINES` constants — `src/components/pano-controls.ts:100` (scene presets) and `:146` (engine mode labels). The one real catalog datum is a single checkpoint name, obtained through the host bridge: `src/components/pano-app.ts:210` → `session.openCheckpointPicker(...)`, `:218` → `` name: `${selected.modelName} · ${selected.versionName}` ``; transport at `src/transport.ts:82-93` (`OPEN_CHECKPOINT_PICKER` → `CHECKPOINT_PICKER_RESULT`); host reply at `PageBlockHost.tsx:3005-3014` with exactly `{versionId, modelId, modelName, versionName, baseModel}` — one resource, the one the user clicked. The **default** is a literal string: `src/panorama.ts:59-63`, `CHECKPOINT_MODEL_ID = 133005`, `CHECKPOINT_VERSION_ID = 1759168`, `CHECKPOINT_DEFAULT_NAME = 'Juggernaut XL · Ragnarok'`, rendered at `pano-controls.ts:233`. Its manifest declares one scope: `"scopes": ["ai:write:budgeted"]`.

**The lead was false — but chasing it is what surfaced the block catalog API, which is the actual answer.** Recorded here so nobody re-runs it.

Corroborating server-side negative: `grep -cE 'searchModels|modelSearch|searchCatalog|getModels:'` over `blocks.router.ts` → **0**, against a **positive control of 2 hits for `getShowcaseImages`** in the same file. There is no catalog-search *procedure* on the tRPC bridge; the REST endpoints are the surface.

### A.3 Stale skill note (not corrected — this was a read-only study)

`.claude/skills/app-blocks/reference/whats-deployed.md:92` records `civitai/app-panorama-360` as a **PRIVATE** org repo. `gh repo view` reports `"visibility":"PUBLIC"`. Worth a one-line fix in a separate pass.

---

## Appendix B — Corrections to premises carried into this investigation

1. **`maxTokens` does not compete with injected context.** It bounds *generated* tokens only (`types.gen.d.ts:1070-1073`; `chat-completion.step.ts:213`). Input budget is `32 × 8,000 = 256,000` chars (`:248-249`). ~32× more headroom than assumed. (§3.1)
2. **Route B's blast radius is not "every existing adopter."** There are two registered steps and exactly one `'textOutput'` adopter — the step being changed (`index.ts:1431-1432`). B's real obstacle is the `string[]`-only channel plus the submit-phase module-load throw. (§3.5)
3. **Route F was not a route to build.** It ships today as `/api/v1/blocks/{models,images,generation-resources}`. (§3.1)
4. **Route D's cost floor is higher than "2+".** Up to 10+ Buzz for one answer via `maxToolRounds = 5` × the nested NSFW delegation. (§3.4)
5. **A fourth upstream option existed that #3637 does not mention** — `responseFormat`, already supported by the orchestrator, requiring one optional schema key and no posture change. (§3.2)
