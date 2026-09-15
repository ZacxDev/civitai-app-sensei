# Handoff: sensei-ui-feedback-pass — 2026-09-14

## Run this first — the index, one command
```bash
cairn recall --repo /home/zach/workspace/civit/civitai-app-sensei
```
Terse pointers this doc does not carry, curated by past sessions and outliving it.
🔴 RECALL, NOT LIVE OBSERVATION — every line is a pointer to VERIFY, never a current
reading, and it may describe a gotcha already fixed. `scope-absent`/`scope-empty` means
nothing is recorded yet: ordinary, not an error, and not a clean bill of health.
Non-blocking: if it exits non-zero, print the stderr line and carry on.

## Goal
Act on the operator's UI/UX feedback on the **Civitai Sensei** app block, plus the upstream
platform changes that feedback turned out to require.
- **closing-condition:** `check` — `gh pr view 72 --json mergedAt` (sensei) and
  `gh pr view 4812 --repo civitai/civitai --json mergedAt` both report a timestamp.

## State now

🔴 **THE ORIGINAL ARC IS CLOSED — its frozen closing-condition was answered two updates ago
(ADDRESSED ⇒ CLOSED; #72 merged, #4812 deliberately closed unmerged so its `mergedAt` is `null`
forever).** Everything below descends from that arc's own ranked item "drive one real submit on
`deepseek/deepseek-v4-flash-0731` and reconcile", so it is recorded here rather than in a new doc —
but it has grown into a **cost-telemetry thread in a third repo** and the next session may
legitimately split it out.

**All four original PRs terminal**, verified by CONTENT not ancestry: sensei **#72** MERGED
(`68b6641`), sensei **#73** MERGED (`0.1.23` in both version fields on trunk), civitai **#4812**
CLOSED UNMERGED (operator: *"drop the field, this should be managed by styling not a manifest
field"*), civitai **#4838** MERGED (`26b47fa9`). **#4812's branch
`zach/app-block-full-bleed-manifest` is PRESERVED on the remote at `89b9dc5d9b`** — the seam guard,
the host plumbing and the dev-tunnel resolver tests all live there if any of it is ever wanted.

⚠️ **A stale leftover worktree that is NOT this arc's:**
`/home/zach/workspace/civit/civitai-sensei-fullbleed` on `zach/sensei-full-bleed` @ `a2ed370451` —
that is **PR #4804's branch, MERGED 2026-09-13**, so it is leftover, not work in flight. Left alone
deliberately: removing another session's checkout is a cross-session write. Whoever owns it can drop it.

**sensei is SHIPPED AND LIVE.** `civitai app status sensei` → version **0.1.23**, status `approved`,
deploy state `live`, source commit `30abeeba`, publish request `pubreq_01M2HCZ5C36P5G6Y1T3G5HST9C`
(submitted 21:05 CDT, reviewed 21:07, live by ~21:14). The served bundle is
`index-CdACwkKG.js` and carries `deepseek/deepseek-v4-flash-0731` **4×** (control string: 0).

🔴 **THE MODEL EXECUTES — the arc's last open question, now settled server-side.** One real charged
send returned `pong`. Prod ClickHouse `orchestration.workflowSteps` holds **exactly one** row of type
`chat/deepseek/deepseek-v4-flash-0731` in 24h, at `2026-09-15 02:30:03` UTC:
`status succeeded · jobs 1 · charged 1 · cost 0 · billedUsd NULL · jobDuration 2.436s`.
The step type NAMES the model, so this is platform-side confirmation. `browser activate` was never
invoked — the operator's screen was never taken.

**The ONE open thread: `civitai/civitai-spine-controller` PR #259** @ **`d287c91e`**, OPEN,
`MERGEABLE`, **assigned to `koenbeuk`**, 3 files +391/−11. It makes chat provider cost observable by
reading `usage.cost` inline. Round-1 audit returned 1 🔴 + 3 🟡 + 1 🟢; all fixed in `d287c91e`, which
**shrank** the PR — the entire request-side half was deleted. Verified independently:
`OpenAIChatCompletionRequest.cs`, `OpenAIChatCompletionJsonSerializerContext.cs` and
`OpenAIChatCompletionRequestTests.cs` are **byte-identical to `origin/main`**, and `BuildRequest`'s
signature is back to its original shape — so the outbound request is provably untouched.
**No delta re-audit was run on `d287c91e`**, and CI has not run on it either; all gates were local
(10 deterministic failures, all pre-existing environment: 8 `ffmpeg`-missing + 2 comfy image-pin).

**Worktree deliberately left in place:** `/home/zach/workspace/civit/spine-inline-usage`
(branch `zach/openrouter-inline-usage-cost` @ `d287c91e`), for PR iteration. Remove with
`git -C /home/zach/workspace/civit/civitai-spine-controller worktree remove /home/zach/workspace/civit/spine-inline-usage`
when #259 closes.

**No clawgate task recorded** — `clawgate_handoff.sh resolve` returned rc=5, 0 tasks for this
session, with its own positive control proving the board was reachable. That is not a clean bill of
health: an unknown session id also answers 200 with an empty array.

## Open investigations — live diagnosis state

### Can an app author actually declare `page.fullBleed` today? No — the released CLI rejects it
- as-of: 2026-09-14
- **Symptom + exact repro:** follow `docs/features/app-blocks.md:430-445` on #4812's branch,
  add `"fullBleed": true` under `page` in a block manifest, run `civitai app validate` /
  `civitai app submit`.
- **Observed (with values):** against the installed `civitai 0.1.101` —
  `validate` on the same fixture **without** the key → `✓ … is valid`, rc 0 (control);
  **with** the key → `✗ page: additional properties 'fullBleed' not allowed`, rc 1;
  `submit` → `✗ validation failed (1 error(s)) — fix before submitting, or pass --skip-validate`,
  and it refuses **before any network call** (`cli/internal/cmd/app_submit.go:390` gates on
  `validate.Dir(dir)` / `res.OK()`). The CLI vendors its own copy at
  `cli/schema/app-block.manifest.schema.json` with `page.additionalProperties: false` and
  props `path, title, icon, buzzBudgetPerGen` — same on the live remote default branch via
  `gh api repos/civitai/cli/contents/…`, so not a stale clone.
- **Ruled out:** *"the mirror is two declarations, so only the CLI lags"* — there are **three**:
  `@civitai/app-sdk` also vendors `schemas/app-block/v1.json`, publicly exported, lacking
  `fullBleed`, sourced from `civitai-app-starters`; and this repo's own
  `src/pages/api/blocks/manifest-schema.ts:13` says "vendored byte-identically by the SDK +
  Go CLI". `via: code`
- **Ruled out:** *"a Go change is needed in the CLI"* — no: the vendored schema's own
  `type: boolean` does the work, so re-vendoring alone suffices. `via: code`
- **Leading hypothesis:** the window opens at **release-cut, not at merge to `main`**. Both
  mirrors carry `scripts/check-canonical-schema.sh` plus a 6-hourly auto-revendor
  (`cli/.github/workflows/revendor-canonical-schema.yml` and the starters equivalent), and
  that check compares against the **live** canonical, which is served from `release` rather
  than `main`. So merging #4812 is safe; **announcing the field to authors before a release
  cuts and the mirrors re-vendor is what breaks.** #4812 names only the SDK *types*
  follow-up and no schema-mirror follow-up at all.
- **Next probe:** after a release cuts, re-run the same pair verbatim —
  `civitai app validate <fixture-with-fullBleed>` must go rc 0. Until then, check the mirror
  directly: `gh api repos/civitai/cli/contents/schema/app-block.manifest.schema.json --jq '.content' | base64 -d | python3 -c 'import json,sys; print(list(json.load(sys.stdin)["properties"]["page"]["properties"]))'`

### Does `deepseek/deepseek-v4-flash-0731` actually execute? Never driven to `succeeded` live
as-of: 2026-09-13
- **Symptom + exact repro:** it is now sensei's **default** model (`DEFAULT_SETTINGS.model`)
  on PR #72, and it has never completed a real submit. Repro is simply: send one message in
  a real mod-gated host and read whether a reply arrives and what was charged.
- **Observed (with values):** 28 OpenRouter endpoints, `tools` + `tool_choice` on **28/28**,
  `seed` on **17/28**. Advertised `0.04/0.08` per 1M matched by exactly **1 of 28** (Relace);
  dearest three are `0.44/1.32` = **11× / 16.5×**. Quote formula verified against orchestrator
  source: `costUsd * 1000 * 1.3`, `Math.Max(1, …)`, then `(int)Math.Ceiling` at
  `WorkflowStepManager.cs:649`. Reference conversation → **0.274 raw Buzz → charged 1**.
- **Ruled out:** *"a dropped `seed` on an endpoint lacking it reintroduces result reuse"* —
  no: the input hash is `hashBuilder.AddComplex(workflowStep.Input)` in
  `ChatCompletionHandler.InitializeAsync`, computed **before any provider is chosen**, and the
  step's own docstring says the seed "IS NOT A DETERMINISM FEATURE". `via: code`
- **Ruled out:** *"a de-listed id could charge unboundedly"* — no: a pricing miss degrades to
  `Math.Max(1, 0)`, so exposure is **1 Buzz per attempt, unrefunded**. `via: code`
- **Leading hypothesis:** it executes fine; the risk is platform margin rather than function.
  The quote derives from OpenRouter's **top-level (union)** pricing record and a succeeded
  non-server-tool step is **never re-priced** (`HasPostBilling => ServerToolCallCount > 0`,
  false for app-block function tools), so on the dear endpoints the platform pays more than it
  collects. Crossing point is **large-context**, not long replies:
  `inputTokens + 2*maxTokens > ~19,000`.
- **Next probe:** one real send in a mod-gated host, then reconcile — `openrouter_cost_usd`
  **does** reach ClickHouse as `billed_usd` beside `Charged` (`WorkflowStepManager.cs:1633`,
  `:1650-1658`), so the quote-vs-actual gap is measurable today without new instrumentation.

### The `page.fullBleed` schema mirror is THREE strict copies, and the SDK one is pinned in this very repo
- as-of: 2026-09-14
- **Symptom + exact repro:** `globals.css:272-275` asserts "The mirror is also two declarations, not
  three: the published schema is canonical and the Go CLI MIRRORS it." That retraction is false, and
  it deleted a real schema-mirror follow-up. Repro: read the installed SDK's own vendored schema.
- **Observed (with values):** measured from **this worktree's own `node_modules`** —
  `node_modules/.pnpm/@civitai+app-sdk@0.14.0/node_modules/@civitai/app-sdk/schemas/app-block/v1.json`
  exists; `@civitai/app-sdk@0.14.0` is the exact version this host pins (`package.json` → `^0.14.0`);
  it is a **public export subpath** (`"./schemas/app-block/v1.json"` appears verbatim in that
  package's `exports`); and its `page` node reads
  `properties = ['path','title','icon','buzzBudgetPerGen']`, `additionalProperties = false`.
  **No `fullBleed`.** So the third copy is not hypothetical and not remote — it is installed here.
- **Ruled out:** *"only the Go CLI lags, so a CLI re-vendor is the whole follow-up"* — no: the SDK
  copy is equally stale and equally strict, and being an export subpath it is reachable by any app
  author's tooling. `via: measurement`
- **Ruled out:** *"the SDK pin makes a new field untyped where the host reads it"* — still false, and
  that half of the original argument stands: `block-manifest-validator.service.ts` has no
  `@civitai/app-sdk` import and `src/components/AppBlocks/types.ts` declares the host's own
  `BlockManifest`. The SDK type is not in the host's chain. `via: code`
- **Leading hypothesis:** unchanged from the earlier block — the window opens at **release-cut, not
  at merge to `main`**, because both mirrors' auto-revendor compares against the live canonical
  served from `release`. What the measurement changes is the SIZE of the follow-up: it is three
  copies to re-vendor, not two, and #4812 currently names neither.
- **Next probe:** after a release cuts, re-read BOTH mirrors, not just the CLI:
  `python3 -c "import json;print(list(json.load(open('<sdk>/schemas/app-block/v1.json'))['properties']['page']['properties']))"`
  and the `gh api repos/civitai/cli/contents/...` one-liner already recorded above. Both must list
  `fullBleed` before the docs may tell an author to declare it.

### "The manifest schema is three mirrors that must move in lockstep" is WRONG, and I asserted it too
- as-of: 2026-09-14
- **Symptom + exact repro:** this doc, #4812's body, and `globals.css` all stated or implied that a
  new manifest key needs all three schema copies to re-vendor before an author can use it. Repro:
  compare the canonical against the two mirrors and ask what actually consumes each.
- **Observed (with values):** measured first-hand from this worktree's `node_modules` —
  canonical `public/schemas/app-block/v1.json` has **22** top-level properties;
  `@civitai/app-sdk@0.14.0`'s vendored copy has **17**, missing exactly `bootSkeleton`, `category`,
  `repository`, `scopeJustifications`, `tagline`. The Go CLI copy is missing `bootSkeleton`. So the
  mirrors are **drifted right now**, and that drift has been sitting there blocking nothing.
  At the `page` level they DO agree: all three declare `additionalProperties: false` with the same
  four keys. The released CLI `0.1.101` is the only measured gate — with an undeclared `page` key
  `civitai app validate` exits **1** (`page: additional properties 'fullBleed' not allowed`); without
  it, rc **0**.
- **Ruled out:** *"the SDK's vendored copy gates an author"* — no. All eight `schemas/app-block`
  references in `@civitai/app-sdk@0.14.0`'s `dist/` are the canonical **URL** as a string constant
  (`EXPECTED_SCHEMA_URL`) or prose saying the TS types mirror the file; nothing loads the JSON, and
  no validator-shaped identifier (`ajv`, `addSchema`, `compileSchema`) appears anywhere in `dist`.
  A manifest's `$schema` names the canonical URL, so an editor validates against the served
  canonical. `via: measurement`
- **Ruled out:** *"the host reads the manifest through an SDK type, so the `^0.14.0` pin is a cost"* —
  no, and this was the false premise `globals.css` gave for years.
  `block-manifest-validator.service.ts` imports nothing from `@civitai/app-sdk`, and
  `src/components/AppBlocks/types.ts` declares the host's own `BlockManifest` and **has no imports at
  all**. `via: code`
- **Leading hypothesis:** the real cost of any future manifest key is **one** repo — the Go CLI —
  plus a release cut. Not three.
- **Next probe:** before quoting a lockstep cost again, diff the three copies' top-level property
  sets and ask which one a tool actually LOADS. The drift above is the standing control: if a copy
  can be five fields behind and block nothing, it is not a gate.

### The deepseek live-submit test is BLOCKED ON APPROVAL, and driving the live app today measures the WRONG model
- as-of: 2026-09-14
- **Symptom + exact repro:** next-step 1 is "send one message in a real mod-gated host on
  `deepseek/deepseek-v4-flash-0731` and reconcile `billed_usd` against `Charged`". Doing that against
  `https://sensei.civit.ai` right now spends real Buzz on a DIFFERENT model and cannot answer it.
- **Observed (with values):** `civitai app status` reports live sensei is **0.1.22, built from
  `6fd63c0`** — a commit that PREDATES #72. Measured against that tree: `deepseek-v4-flash-0731`
  appears **0 times** in `src/lib/models.ts` (positive control: **2** at trunk, so the search works),
  and `6fd63c0`'s `DEFAULT_SETTINGS.model` is **`deepseek/deepseek-chat`** — a different model.
  `SFW_MODEL_ID` was introduced by `68b6641` (#72). The model is not in 0.1.22's list at all, so the
  Settings selector cannot reach it either.
- **Ruled out:** *"pick the model manually in the live app's Settings to avoid waiting for a
  release"* — impossible: the id does not exist in the shipped 0.1.22 bundle. `via: measurement`
- **Ruled out:** *"the CLI account lacks the scopes to spend Buzz, so the test needs a different
  login"* — no: `civitai whoami` reports `Read Buzz balance: yes` / `Spend Buzz (AI Services): yes`.
  And the browser run spends through the VIEWER's own session in the live app, not through the CLI,
  so CLI scopes do not gate it regardless. `via: command`
- **Leading hypothesis:** the test is simply gated on 0.1.23 going live. **0.1.23 IS NOW SUBMITTED** —
  `pubreq_01M2HCZ5C36P5G6Y1T3G5HST9C`, status `pending`, source commit `30abeeba` — awaiting a
  MODERATOR, which is a human gate no agent here can drive.
- 🔴 **A second trap waiting on the other side of approval:** `DEFAULT_SETTINGS` applies only to a
  viewer with NO persisted settings, and `sensei:settings` has been written by this account since
  0.1.0. So a stored `model` may pin the old id even after 0.1.23 ships. **The browser run must READ
  the model the UI actually shows before sending**, never assume the default took effect.
- **Next probe:** `civitai app status sensei` until `Status: approved` / `Deploy state: live`; then
  confirm the live bundle carries the id (`curl -s https://sensei.civit.ai/assets/index-*.js | grep -c
  deepseek-v4-flash-0731`, with a positive control), THEN one message, then reconcile.

### RESOLVED: `deepseek/deepseek-v4-flash-0731` DOES execute live — first completed reply, 2026-09-14
- as-of: 2026-09-14
- **Symptom + exact repro:** the model became sensei's default (`SFW_MODEL_ID`) in #72 and had never
  been driven to `succeeded`. Repro: send one message in the embedded app at
  `https://civitai.com/apps/run/sensei` and read whether a reply arrives.
- **Observed (with values):** on 0.1.23 live (deploy `live`, bundle `index-CdACwkKG.js`, the model id
  present 4x in the served JS), one charged send of `Reply with exactly the word pong and nothing
  else.` at **21:29 CDT returned exactly `pong`**. Driven through the operator's real logged-in
  browser via the bridge; `browser activate` was NEVER invoked, so no screen was taken.
- **The model was identified by DEDUCTION from the UI's own rendering rule, not by a server read.**
  `SessionList.tsx:179-186` labels a session row with a model name ONLY when
  `session.model !== currentModel && isModelOfferable(...)`. The OLD rows render `· DeepSeek V3`
  (⇒ `deepseek-chat !== currentModel`); the NEW row renders **no model name** (⇒ its model EQUALS
  `currentModel`); and `createSessionRecord(model)` stamps the model at creation, which happened
  after `Reset Defaults` → `Save` set `settings.model = SFW_MODEL_ID`. Hence v4-flash.
- **Ruled out:** *"the missing model label on the new row is a regression #72 introduced"* — no, it is
  deliberate: the comment at `SessionList.tsx:20-38` says a row names its model only when it differs
  from the current one, because "a column whose every cell is identical is noise with a line of
  height". `via: code`
- **Ruled out:** *"this viewer's persisted settings pinned `deepseek/deepseek-chat`, so a send would
  use the old model"* — **FALSE, and it was disprovable BEFORE the reset**: in the first probe run,
  taken before any settings change, the old rows ALREADY rendered `· DeepSeek V3`, which by the rule
  above means `currentModel` was already not `deepseek-chat`. The `Reset Defaults` performed on that
  premise was almost certainly unnecessary. It was harmless — every visible field already held its
  default — but the reasoning was wrong. `via: measurement`
- 🔴 **Still NOT answered — the margin question, which was the other half of this investigation.**
  The Buzz balance read `197.8K` before and after: at that display precision a ~1 Buzz charge is
  invisible, so this is NOT evidence of what was charged. The quote-vs-actual gap still needs the
  server-side read — `openrouter_cost_usd` lands in ClickHouse as `billed_usd` beside `Charged`
  (`WorkflowStepManager.cs:1633`, `:1650-1658`).
- **Next probe:** query ClickHouse for the step at 2026-09-14 21:29 CDT on this account and compare
  `billed_usd` against `Charged`. That is the only remaining unknown; execution is settled.

### RECONCILED server-side: the send SUCCEEDED and charged 1 Buzz — but the MARGIN question is not answerable as this doc claimed
- as-of: 2026-09-14
- **Symptom + exact repro:** this doc's standing next-probe said `openrouter_cost_usd` "does reach
  ClickHouse as `billed_usd` beside `Charged`, so the quote-vs-actual gap is measurable today without
  new instrumentation." Repro: read `orchestration.workflowSteps` for the step this session created.
- **Observed (with values):** prod ClickHouse Cloud, reached read-only via the kubeconfig at
  `civit/datapacket-talos/prod-kubeconfig` → secret `clickhouse-tracker-env` in ns
  `civitai-clickhouse-tracker`. Server 26.2.1.641. **Exactly ONE row of type
  `chat/deepseek/deepseek-v4-flash-0731` exists in 24h**, at `2026-09-15 02:30:03` UTC
  (= 21:30 CDT, the send): `status succeeded · jobs 1 · charged 1 · cost 0 · billedUsd NULL ·
  jobDuration 2.436s · failureClass empty`.
- 🔴 **The step type NAMES the model**, so this is a server-side confirmation of which model ran —
  strictly stronger than the UI deduction recorded in the previous entry, and it agrees with it.
- 🔴 **`billedUsd` IS NULL FOR EVERY CHAT STEP, NOT JUST THIS ONE.** Measured across 24h: all 11
  `chat/%` types, 60 steps total, **0 with a non-null `billedUsd`** — `deepseek-chat-v3-0324` (29),
  `gpt-4o-mini` (12), `deepseek-v4-pro-0813` (10), and eight others. **The column is not dead
  globally**: 12,371 of 20,634,136 rows in the same window carry a value, so it populates for other
  step families (GPU work) and simply never for chat. **So the recorded next-probe was based on a
  false premise and cannot be run as written.**
- **Ruled out:** *"`cost` carries the quote, so `Math.Max(1, cost…)` explains the 1 Buzz"* — no:
  `cost` is **0 for every chat type**, while `charged` ranges 1 → 54 across them
  (`deepseek-v4-pro-0813` avg 21.3, `openai/gpt-4o` 54). Whatever sets `charged` for chat, this
  table's `cost` is not it. `via: measurement`
- **Leading hypothesis:** chat/completion steps do not write a provider cost into this table at all,
  so quote-vs-actual margin is NOT observable from `orchestration.workflowSteps`. Answering it needs
  either a different sink (the orchestrator's own logs/metrics) or new instrumentation — which is
  exactly what this doc asserted was unnecessary.
- **Next probe:** find where `openrouter_cost_usd` is actually written, starting from
  `WorkflowStepManager.cs:1633`/`:1650-1658` in `civitai/civitai` — read whether that write is
  conditional on a step family that excludes chat. Until that is known, do NOT quote a margin figure.
- ⚠️ **Access note for whoever runs this next:** read-only was enforced server-side with
  `?readonly=1` and PROVEN — a `CREATE TABLE` probe returned `Code: 164 … Cannot execute query in
  readonly mode`. Credentials were passed via a `curl -K` config file (mode 600, shredded after) so
  they never entered argv. Do the same; the connection string is a ClickHouse Cloud admin user.

### TRACED: why `billedUsd` is null for chat — and the margin hypothesis has ONE measured instance, which CONFIRMS it
- as-of: 2026-09-14
- **Symptom + exact repro:** every chat step reads `billedUsd NULL`, so quote-vs-actual could not be
  computed for this session's send. Repro: read `orchestration.workflowSteps` filtered to `chat/%`.
- **The orchestrator-side chain is INTACT and NOT gated by step family** — read from `origin/main`,
  not from a working tree (the local `orch-workflow-authz` checkout is on
  `zach/fix-workflow-owner-authz` and differs from main by **733 lines** in these two files, so
  reasoning from it would have been reasoning about undeployed code).
  `ChatCompletionHandler.OnJobEventAsync` (`origin/main:196-209`) writes
  `workflowStep.Metadata["openrouter_cost_usd"]` **only if `jobEvent.Context` already contains that
  key**; `WorkflowStepManager:1633` — the exact line this doc cites — then folds it into `billedUsd`
  unconditionally. So the orchestrator is READY to record it and the producer upstream (the worker's
  job-event context) is what almost never supplies it.
- **Observed (with values), 30 days, platform-wide:** **32,571 chat steps, 8 with a non-null
  `billedUsd`** — 0.025%. In the last 24h the non-null rows are `image` 9,600 · `video` 2,748 ·
  `3d` 28 · `model` 1, and **no `chat` at all**. So the path is not chat-excluded by construction; it
  just essentially never fires for chat.
- 🔴 **THE MARGIN HYPOTHESIS IS CONFIRMED BY ONE REAL ROW.** Of those 8, comparing `charged` (Buzz)
  against `billedUsd * 1000 * 1.3` (the documented markup):
  `2026-09-10 16:40:14 · chat/z-ai/glm-5.3-flash:nitro · succeeded · charged 1 · billedUsd
  0.00473686 · implied 6.158 Buzz` — **the platform collected 1 and the markup implies 6.16, an
  under-collection of ~6x on a single send.** The other 7 over-collect, some grossly
  (`gpt-4o-mini` charged 4 against an implied 0.009). So the exposure this doc hypothesised is real,
  and it is the PRE-EXECUTION ESTIMATE that is charged.
- **Ruled out:** *"charged 1 is the `Math.Max(1, …)` floor doing its job"* — no. A floor RAISES to 1;
  it cannot cap at 1. `glm-5.3-flash:nitro` charged exactly 1 while its own recorded actual implies
  6.16, so `charged` came from the pre-execution estimate and the post-execution re-price never
  ran — consistent with `HasPostBilling => ServerToolCallCount > 0` being false for app-block
  function tools. `via: measurement`
- **Ruled out:** *"the quote-vs-actual gap is measurable today without new instrumentation"* — this
  doc's own standing claim, now **FALSE**: it is measurable for 0.025% of chat steps, and was not
  measurable for this session's send. `via: measurement`
- **This session's own send remains uncomputable for margin:** `chat/deepseek/deepseek-v4-flash-0731`
  at `2026-09-15 02:30:03` UTC — `succeeded · charged 1 · cost 0 · billedUsd NULL · 2.436s`.
  Execution is settled; its margin is not, and no query can settle it after the fact.
- **Next probe:** find what puts `openrouter_cost_usd` into a job event's Context — that is in the
  WORKER, not in this orchestrator repo, and it is the single change that would make chat margin
  observable. The 8 rows above are the positive control that the sink works end to end when the
  worker does supply it; `qwen3.7-flash`, `xiaomi/mimo-v2.5`, `gpt-4o-mini` and
  `z-ai/glm-5.3-flash:nitro` are the models seen doing so.

### SOLVED: the cost producer is in a THIRD repo, and it loses a race ~99.95% of the time
- as-of: 2026-09-14
- **The producer is NOT in `civitai-orchestration`.** It is `civitai/civitai-spine-controller`
  (read at `origin/main` `2135908a`),
  `src/Civitai.SpineController/Services/Integrations/Middleware/BuiltIn/OpenAIChatCompletion/OpenAIChatCompletionMiddleware.cs`
  — two write sites, `:123-128` (non-streaming) and `:290-297` (streaming), both gated on
  `TryGetGenerationCostAsync` (`:453-496`). That helper does a **one-shot `GET
  {base}/api/v1/generation?id={responseId}` with zero delay and zero retry**, returning null silently
  four ways; **404 is not in the retry set** (`Services/Integrations/ServiceCollectionExtensions.cs:298-309`).
  Landed 2026-03-12 (`bcce87bb`), materially unchanged.
  `IsOpenRouterRequest` (`:443-447`) is NOT a model check — it means "not routed to a local vLLM
  container". Transport onward is intact: `UploadBlobsMiddleware.cs:1229-1244` → `X-Claim-Context`
  header → orchestration `BlobController.cs:287-294` → `JobEvent.Context` →
  `ChatCompletionHandler.cs:196-210` → `WorkflowStepManager.cs:1631-1636` → `BilledUsd`.
- 🔴 **MEASURED DISCRIMINATOR — every per-model and per-route hypothesis is DEAD.** 30-day
  denominators for the only models ever seen recording a cost:
  `qwen3.7-flash` **3 / 6,296 = 0.048%** · `z-ai/glm-5.3-flash:nitro` **1 / 1,858 = 0.054%** ·
  `gpt-4o-mini` **1 / 1,660 = 0.06%** · `openai/gpt-4o-mini` **1 / 348 = 0.287%** ·
  `xiaomi/mimo-v2.5` **2 / 191 = 1.05%**. Uniform near-zero across every model, `:nitro` included.
  That is the signature of a RACE against OpenRouter's eventually-consistent generation index, not a
  property of any model, route or provider.
- **Ruled out by reading source, not by absence:** `usage: {include:true}` is not the current
  mechanism (`OpenAIChatCompletionRequest` has no `usage` field, `OpenAIChatUsage` no `Cost`);
  streaming vs non-streaming (both call the same helper); `ServerToolsEnabled` (selects
  accumulate-vs-overwrite in the CONSUMER only); a shipped-at-some-point code path (producer predates
  the window by six months and the 8 dates do not cluster); `total_cost == 0` for free models (would
  store `0.0`, i.e. NON-null — the rows are NULL, so the key is genuinely absent). `via: code`
- **Ruled out:** *"a different worker serves most chat"* — largely, by construction:
  `ChatCompletionJob.GetWorkerSupport` requires `Capabilities.ChatCompletion != null` AND
  `SupportsAdditionalResources == false` for any non-AIR model, matching only `openai-managed.json`.
  Not fully eliminated. `via: code`
- **The one rival not killed, and the probe that separates it:** "spine-controller ran and the GET
  failed" vs "something else produced the job". The middleware writes sibling keys
  UNCONDITIONALLY — `integration_duration_ms`, `integration_status_code`, `openai_response_id`,
  `openai_model`, `openai_prompt_tokens` (`:97-98`, `:379-398`). They are not in ClickHouse but ARE
  in the job-event record: `GET /v1/producer/jobs/{jobId}/events`. For the sensei job at
  `2026-09-15 02:30:03`: `openai_*` present + `openrouter_cost_usd` absent ⇒ race confirmed; all
  absent ⇒ different producer. (dpprod Loki carries no spine-controller logs, so the middleware's
  three distinguishing warnings could not be read.)
- 🔴 **SCOPE CAVEAT THAT MATTERS MORE THAN THE FIX: this is TELEMETRY, NOT BILLING.**
  `ChatCompletionHandler.HasPostBilling` (`:84-85`) is false unless server tool calls ran, and
  `WorkflowStepManager.cs:1261-1271` therefore never recomputes cost for a succeeded plain chat step
  — its own comment says so. The actual-cost branch at `ChatCompletionHandler.cs:127-138` is
  **effectively dead for plain chat**. So chat is billed **entirely** on
  `EstimateOpenRouterCostAsync` (`:149-172`) **with no reconciliation of any kind**, and the one
  observed actual (`glm-5.3-flash:nitro`, charged 1 vs implied 6.16) under-collected ~6x.
- **Minimal fix — all worker-side in `civitai-spine-controller`, no orchestrator change:** add
  `usage: {include: true}` to the request (`OpenAIChatCompletionRequest.cs` + its
  `JsonSerializerContext`), add `Cost` to `OpenAIChatUsage`, set it only when
  `IsOpenRouterRequest(claim)` in `BuildRequest` (`:498-527`) so vLLM requests stay byte-identical,
  and read it in both process paths, keeping `TryGetGenerationCostAsync` as fallback. This REMOVES
  the round trip rather than racing it; `stream_options.include_usage = true` is already sent
  (`:521`) so the streaming path is covered. The inferior alternative — delay+retry inside the
  helper — holds the worker claim open and still races.
- 🔴 **NOTHING TESTS THE PRODUCER**, verified with positive controls: `TryGetGenerationCost|total_cost|openrouter_cost|IsOpenRouterRequest`
  over spine-controller `tests/` at `origin/main` → rc=1, no matches (control `BuildRequest` matches
  in 4 test files). In orchestration the only hit is incidental filler in
  `JobFailureClassTests.cs:75,80`. Neither the accumulation nor the `billedUsd` fold has a test.
  A guard belongs in `OpenAIChatCompletionRequestTests.cs`, which already string-asserts serialised
  `BuildRequest` output.
- **Not verified:** the actual prod failure mode (404 vs 200-with-null vs timeout); whether the
  deployed spine-controller image matches `origin/main`.

### UNSIZED: how much money moves if #259 merges
- as-of: 2026-09-15
- **Symptom + exact repro:** #259 makes `openrouter_cost_usd` arrive on ~every chat job instead of
  0.025% of them. On two step classes that value is PREFERRED over the estimate when pricing, so
  those steps change price. Nobody has measured by how much.
- **Observed (with values):** `WorkflowStepManager.cs:1255` (civitai-orchestration `origin/main`)
  re-prices when `@event.Status is not WorkflowStatus.Succeeded || handler.HasPostBilling(step)`.
  `HasPostBilling` is `ServerToolCallCount > 0` (`ChatCompletionHandler.cs:84-85`). On those paths
  `ChatCompletionHandler.cs:127-138` uses `actual × 1000 × 1.3` when the key is present, else
  `EstimateOpenRouterCostAsync`. The only real actual ever recorded for a chat step —
  `z-ai/glm-5.3-flash:nitro`, 2026-09-10 — was `charged 1` against `billedUsd 0.00473686`, i.e. an
  implied **6.16 Buzz at 1.3×: a ~6× UNDER-collection**.
- **Ruled out:** *"it is telemetry only, nothing changes price"* — I asserted this repeatedly and
  wrote it into the PR body; it is FALSE, and retracted. It reasoned from `HasPostBilling` being
  false for a *succeeded* plain chat step (true) and dropped the `is not Succeeded` disjunct and the
  server-tool case entirely. `via: code`
- **Ruled out:** *"`charged: 1` is the `Math.Max(1, …)` floor"* — no. A floor RAISES to 1; it cannot
  cap at 1. `glm-5.3-flash:nitro` charged exactly 1 while its own recorded actual implies 6.16, so
  `charged` came from the pre-execution estimate and the post-execution re-price never ran.
  `via: measurement`
- **Leading hypothesis:** direction is probably user-favourable (actual < estimate for most short
  completions — 7 of the 8 recorded rows OVER-collect, some grossly: `gpt-4o-mini` charged 4 against
  an implied 0.009), but the tail is the risk and nobody has sized it.
- **Next probe:** count chat steps with `ServerToolCallCount > 0` and non-`Succeeded` chat steps over
  30 days, then apply `actual × 1.3` vs the recorded `charged` to the 8 rows that carry a cost.
  ClickHouse access recipe is in the entry below.

### The cost producer: found, and it loses a race ~99.95% of the time
- as-of: 2026-09-15
- **Producer is in a THIRD repo** — `civitai/civitai-spine-controller` (`origin/main` `2135908a`),
  `…/Middleware/BuiltIn/OpenAIChatCompletion/OpenAIChatCompletionMiddleware.cs`, write sites
  `:123-128` (non-streaming) and `:290-297` (streaming), both gated on `TryGetGenerationCostAsync`
  (`:453-496`) — a **one-shot `GET /api/v1/generation?id=` with zero delay and zero retry**; 404 is
  not in the retry set. Landed 2026-03-12 (`bcce87bb`).
- 🔴 **MEASURED DISCRIMINATOR — every per-model and per-route hypothesis is DEAD.** 30-day
  denominators: `qwen3.7-flash` **3/6,296** · `glm-5.3-flash:nitro` **1/1,858** · `gpt-4o-mini`
  **1/1,660** · `openai/gpt-4o-mini` **1/348** · `xiaomi/mimo-v2.5` **2/191**. Uniform near-zero
  across every model, `:nitro` included — the signature of a race, not a model property.
- 🔴 **Ruled out:** *"`usage: {include: true}` is what makes OpenRouter return the cost"* — **FALSE,
  and I reported the opposite after "verifying" it.** OpenRouter's own docs, one paragraph ABOVE the
  response-shape example I quoted: *"The `usage: { include: true }` and `stream_options:
  { include_usage: true }` parameters are deprecated and have no effect. Full usage details are now
  always included automatically in every response."* `usage.cost` was always on the response; the
  middleware simply never read it. `via: doc`
- **Ruled out:** streaming-vs-non-streaming (both call the same helper); `ServerToolsEnabled` (selects
  accumulate-vs-overwrite in the CONSUMER only); `total_cost == 0` for free models (would store a
  NON-null `0.0`). `via: code`
- **The rival not killed, and the probe that separates it:** "spine-controller ran and the GET
  failed" vs "something else produced the job". The middleware writes sibling keys UNCONDITIONALLY —
  `integration_duration_ms`, `integration_status_code`, `openai_response_id`, `openai_model`,
  `openai_prompt_tokens`. Not in ClickHouse, but in the job-event record:
  `GET /v1/producer/jobs/{jobId}/events`. For the sensei job at `2026-09-15 02:30:03`: `openai_*`
  present + `openrouter_cost_usd` absent ⇒ race confirmed. (dpprod Loki carries no spine-controller
  logs, so the middleware's three distinguishing warnings could not be read.)
- **Next probe:** that job-events read. #259 fixes the mechanism regardless of which rival is true.

## Next steps (ranked)

1. 🔴 **ROTATE THE COMMITTED CREDENTIALS IN `civitai-spine-controller`.** Independently verified
   present on `origin/main` at `2135908a`: a **live-format `sk-or-v1-…` OpenRouter key (73 chars)** in
   `src/Civitai.SpineController/profiles/optional/openai-managed.json`, and a 37-char orchestration
   `AccessToken` in `src/Civitai.SpineController/appsettings.json`. Values were never printed or
   copied anywhere. They predate PR #259 by several commits and are unrelated to it. Rotation also
   needs history scrubbing or acceptance that the old key is burned.
   IN FLIGHT: nothing.
   - forcing: security — a live provider key in a repo's default branch, spending real money.
2. **Review and merge `civitai-spine-controller#259`** (assigned `koenbeuk`). 🔴 **Do not merge on the
   old promise:** an earlier PR body claimed "telemetry only — does not change what anyone is
   charged"; that was FALSE and is retracted in the body and in two PR comments. Before merging,
   SIZE THE BILLING DELTA — see the open investigation below. A delta re-audit of `d287c91e` was not
   run; the round-1 fixes were verified but the ladder is not formally closed.
   IN FLIGHT: `civitai/civitai-spine-controller#259`.
   - forcing: user — it is assigned to a named reviewer and blocks nothing else until they act.
3. **Ask OpenRouter/Venice to expose `tools` on the Venice endpoint, or to list
   `venice-uncensored-1-2`.** Venice's own API already reports `uncensored: true` **and**
   `supportsFunctionCalling: true` at 128k — it is simply not published to OpenRouter. The only route
   to a **grounded** NSFW mode with no code on either side.
   - forcing: none
4. **`taste.json`'s `reshoot` and `crop-rect-bottom-edge`.** **0.1.23 is now approved and LIVE**, so
   the long-standing blocker ("a version > 0.1.12 must be approved and live") is GONE. These are
   now actually runnable.
   - forcing: none

## Defects (batched)

- 🔴 **The CSS ledger's membership does not match the need, and nothing forces the question now.**
  The census in `PageBlockHost.tsx` (self-described as a stale cross-repo reading that nothing
  asserts) finds 11 first-party page apps: **nine cap themselves at 640–1100px**, so the 1600px cap
  is a no-op for their layout; **two genuinely stretch — Notepad and Sensei.** The ledger holds
  **`playable-collections` and `sensei`**: it EXCLUDES one that needs it and INCLUDES one where it is
  cosmetically inert. The manifest field would have dissolved this; with the ledger permanent,
  nothing will raise it again. **Closing condition:** the membership is reconciled against a re-taken
  census (recording refs), or the owner dismisses the asymmetry in writing.
- **Pre-existing, out of scope, left alone:** `block-effective-scopes.ts:126` is 105 chars against
  `printWidth: 100` (prettier does not reflow comments, so CI is green).

## Gotchas / decisions / dead-ends

**Instrument traps — each cost real time this session, each measured.**
- `pnpm run <script>` in a fresh non-TTY worktree aborts with
  `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` and a long stack trace that reads exactly like a
  gate failure. It is pnpm declining to purge `node_modules`. `CI=true` gets past it.
- **Piping a gate through `tail` makes `$?` the pipe's status** — printed a reassuring `rc=0`
  over a real failure, twice. Capture streams separately and read the content.
- `grep` here wraps **ugrep** and honours `.gitignore`. Worse, a
  `find … -print0 | xargs -0 command grep -ln` pipeline returned **empty for a string known to
  exist** — four false zeros before a positive control caught it. `rg --no-ignore` works.
  **Run a positive control before quoting any zero.**
- `readlink -f node_modules/@civitai/components` prints a path that **does not exist** — that
  package is transitive and pnpm does not hoist it, and `readlink -f` canonicalises a missing
  leaf. Use `ls`/`find`. (It is fine for the four direct deps.)
- `civitai`'s `scripts/typecheck.mjs` spawns `tsc` with **no `cwd`**, inheriting the shell's —
  run from elsewhere it typechecks a **different repository** and prints `OK — 0 type errors`
  with a planted error present. Use `pnpm -C <worktree> run typecheck`.
- **Playwright/Chromium:** the repo pin is **1200**; the nix-store
  `playwright-browsers/chromium-1228` works via `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`; the
  `~/.cache/ms-playwright` build at **1234** is a generic dynamically-linked binary and
  **unusable on NixOS** — exit 127, **zero tests collected**, which reads as a harness failure.
  Never bump the pin. **A zero count means the tier never ran.**
- **`WebFetch` confabulates.** On the OpenRouter endpoints URL it reported **34** endpoints and
  volunteered *"entries 29-34 are not visible … but are confirmed to exist"*; two parsers over
  the raw JSON both say **28**. Separately it returned paraphrase that read like verbatim
  HuggingFace card text. `curl` + a real parser for any figure that lands in a commit.
- **zsh does not word-split** — hit three times: an unquoted multi-line `$VAR` reached a command
  as one argument and produced a confident wrong answer each time. Brace or use an array.
- **`civitai`'s `main` has NO required status checks** (`…/branches/main/protection/required_status_checks`
  → `404 Required status checks not enabled`). `lint.yml:405` and `:830` are
  `continue-on-error` on `pull_request`, `:789` says `component IS STILL UNGATED`. Every guard
  these PRs add is **report-only**; the audit is the gate.

**Decisions, with why.**
- **`page.fullBleed`, not `iframe.fullBleed`** — the cap exists on the full-page run surface
  only, `page` already holds the other page-only knob `buzzBudgetPerGen`, and the SSR resolver
  early-returns on `!manifestDeclaresPage(manifest)` so the field is guaranteed reachable.
- **Keep the 1600px default** — but on the **long-tail** argument (`blocks-react` exports no
  Container and the starters carry zero width declarations, so a new app inherits whatever the
  host gives it), **not** the fleet argument. The fleet argument is **false**: nine of eleven
  page apps cap themselves at 640–1100px and the cap is "a no-op for their layout".
- **NSFW toggle gates on `useDomainMaturity().isLevelAllowed(BrowsingLevel.X)`**, not the
  `domain` string — the SDK documents `domain` as informational and `maxBrowsingLevel` is
  per-domain. `X` not `R` because an uncensored reply is not bounded at R, so an R-capped viewer
  would be charged for a reply the scan withholds. The ask was "only on .red, not on .com"; the
  ceiling predicate satisfies it because blue projects a SFW ceiling by an explicit upstream
  product decision (`blocks.router.ts:483-501`, `buzz-helpers.ts:130-138`) — recorded in
  `src/lib/maturity.ts` as a cross-repo reading nothing asserts.
- **Dolphin kept for the NSFW arm** despite its tool gap. It has the best measured willingness
  in the UGI set (**W/10 7.8**), its *weights* implement Mistral tool calling, and the gap is its
  sole OpenRouter endpoint (Venice) not exposing them — a **serving-config** gap, not a model
  one. Aion models are absent from the leaderboard entirely, so the alternatives have no
  independent willingness measurement.
- **Dead ends:** `sao10k/l3.1-euryale-70b` rejected on four independent grounds (no endpoint
  offers tools *and* long context together — tools-capable one is **8,192**; no tool template at
  all; `cc-by-nc-4.0` non-commercial; and its card *undercuts* permissiveness). Providers serving
  permissive finetunes largely do not enable tool calling, which is why that search came up short.
- **`claudedocs/sensei-end-to-end-routes-2026-08-13.md` is superseded** — its premise is that
  `.strict()` forbids `tools`. The platform shipped tool calling; `orchestrator-bridge.ts` says
  so in terms. Do not act on its §5 change list.

**Standing limitations** — true regardless of how green anything looks: no local run, harness run
or test proves a reply **charged** correctly (Turnstile + auth gated); the catalog and tools routes
are token-gated and the harness simulates them; jsdom computes no geometry and never loads
`src/index.css`, so line length, opacity and visual order are readings not measurements; and the
shipped bundle is built by the platform on `node:22-alpine` with an unpinned pnpm while every
figure here is node 24.

**Measured this session, and repo-wide rather than specific to this PR.**
- 🔴 **`src/**/__tests__/**` is EXCLUDED from `civitai`'s `tsconfig.json`** — a planted type error in
  a file there yields `OK — 0 type errors`, while the same error outside it fails with `TS2322`
  (both halves measured). So **every guard living in a `__tests__` directory ships untypechecked**,
  `block-registry.resolve-dev.test.ts` included. That is why the new seam guard was deliberately
  placed at `src/components/AppBlocks/fullBleedMounterSeam.test.ts`, OUTSIDE `__tests__`. When a new
  guard's correctness depends on its types, put it outside that directory or the typecheck is blind
  to it.
- A repo lint-rule guard (`featureFlagsMockCompleteness.test.ts`) rejected a wholesale
  `FeatureFlagsProvider` mock that omitted `useOptionalFeatureFlags`; the fix is `vi.hoisted`. The
  fix agent correctly re-ran its ENTIRE mutation matrix afterwards rather than trusting the earlier
  run — an audit fix resets the gate.
- `eslint` reports one **pre-existing** error in `ReviewBlockPreviewHost.browser.test.tsx`
  (`local-rules/no-wholesale-module-mock` on the `~/utils/trpc` factory, ~line 135). Confirmed to
  fire identically on the pre-change version of the file — not introduced by `b073d37d1b`.

**Process decisions, with why.**
- **The two fix rounds were SEQUENCED, not parallelised**, because both would have touched the same
  checkout and two file-modifying agents in one working directory clobber each other. A worktree
  isolates a directory, not a second agent pointed at that same directory.
- **The dispatching session re-verified the subagent's work rather than shipping on its report** —
  and states the scope of what it actually re-ran (1 of 14 mutants) instead of inheriting the
  agent's "14/14" as its own claim.

**Instrument traps measured this session — both are "the tool ran against the wrong thing and said
something that reads like a normal failure".**
- 🔴 **The shell cwd RESETS between tool calls, so a relative `./node_modules/.bin/vitest` runs the
  WRONG REPO'S vitest.** Measured: a verification run intended for the civitai worktree executed
  sensei's binary against sensei's config and failed with `Error: No projects matched the filter
  "unit*"` — which reads as a config or flag error, not as "you are in the wrong repository". The
  earlier mutant run in the same pair was correct only because it happened to carry `cd $W` in the
  same compound command. **Use an absolute path to the binary** (`$W/node_modules/.bin/vitest`), and
  treat "no projects matched" as a wrong-repo tell. Same family as the known
  `scripts/typecheck.mjs`-inherits-the-shell's-cwd trap, different tool.
- 🔴 **Piping a `handoff_doc.py --confirm --push` through `head` KILLED THE WRITER MID-RUN.** The
  broken pipe ended the process before it committed; the visible output looked like a normal
  proposal. Nothing was written, and the only reason it was caught was checking `git log` afterwards
  rather than reading the truncated output. The standing "never pipe a gate through `tail`/`head`"
  rule is usually stated as *`$?` becomes the pipe's status*; this is the **other** failure mode —
  the pipe does not just mis-report the result, it can prevent the result.
- ⚠️ **The `src/**/__tests__/**` tsconfig exclusion is NOT a new finding** — the subsystem index
  already carried it three times before this session, including on `civitai/blocks` itself, with a
  richer remedy than was re-derived here (`tsconfig.tests.json` / `scripts/ci/typecheck-tests-gate.mjs`,
  and the fact that gate is red on `main` for pre-existing reasons). Search the index before
  recording a "new" tooling gotcha.

**Process decisions, with why.**
- **The two fix rounds were SEQUENCED, not parallelised** — both touch one checkout, and two
  file-modifying agents in one working directory clobber each other. A worktree isolates a directory,
  not a second agent pointed at that same directory.
- **`849b9abc76` exists because the fix agent caught its own over-wide claim** — a comment in
  `c5c35e1883` said "nothing else in the node tier moves" on the strength of a 10-file / 152-test
  run. The comment now states its denominator and what it structurally could not see. Worth copying:
  a measurement's SCOPE belongs in the sentence that quotes it.

**Measured this session — a rule I had already read, and hit anyway.**
- 🔴 **A `count=1` replace used as a POSITIVE CONTROL silently mutated the wrong occurrence, and the
  control then reported PASS-shaped garbage.** Checking whether round 2's edits were comment-only, the
  control mutated `--app-page-max-width: none;` — which occurs **3× raw, 2× after comment-stripping**.
  `.replace(..., 1)` hit the first, which is INSIDE the ledger comment, so the stripper deleted the
  mutation and the control returned "no difference detected" — i.e. it claimed the instrument was
  blind when the instrument was fine. **The tell was that the control returned the value it MUST NOT
  return**; had it been written to "expect no difference" the run would have looked clean. Fix:
  count occurrences before mutating, mutate one that provably survives the transform under test, and
  run the control in the SAME invocation as the measurement. This is `claude/RULES.md`'s
  count=1-replace hazard and its positive-control rule landing together.
- 🔴 **An agent that dies on an API limit may have done far MORE than its result field shows.** A
  terminated audit reported only `"I'll start by reading the brief in full."` — but disk held a
  populated worktree at the right sha, its `refs/audit/` ref, and ~20 artefacts including two FULL
  node-tier runs. Resuming it recovered all of that. **Check the artefacts before concluding a failed
  agent did nothing**, and resume rather than restart.

**Process decisions, with why.**
- **The ladder was stopped by the attribution gate, deliberately, while findings were still
  available.** A findings-keyed stop would have run round 3, 4, … indefinitely: every round's
  findings were about prose the previous round's fix had written. Recording WHY it stopped is what
  makes this distinguishable from a converging ladder — those two look identical in the findings list.
- **Both claims blocks were posted as ISSUE comments, not review comments** —
  `gh pr view --json comments` returns issue comments only, so a block posted as a review is
  invisible to `audit-dispatch.py` and the next round silently becomes a blind full audit.
- **Rounds 0 and 1 had recorded their findings off-PR**, so the round-2 delta was REFUSED by
  `audit-dispatch.py` until a claims block was reconstructed and posted. Correct refusal: without one
  a "delta" audit silently widens into a full audit that then reads as covered. Post the block in the
  round that produces it.

**Why #4838's ladder stopped at one round, stated explicitly because a gate-stop and a converged
stop look identical in a findings list.** The attribution gate CANNOT fire here — this PR's payload
IS prose, so every round changes payload lines by construction. The prose criterion is what applies:
no 🔴; blast radius is "a comment contains a false sentence"; and the recurring SHAPE was swept at
every site rather than at the one reported — all three findings were **deleted, not reworded**, and
the two claims the replacement does assert (the five-field SDK drift; that nothing loads the vendored
copy) were re-measured first-hand rather than inherited from the auditor. What is NOT claimed: that a
round 2 would be clean. It was not run.

**Instrument traps measured this session — three, all "the tool answered about something other than
what I asked".**
- 🔴 **A `count=1` replace used as a POSITIVE CONTROL mutated the wrong occurrence and reported
  PASS-shaped garbage.** Checking whether edits were comment-only, the control mutated
  `--app-page-max-width: none;` — **3× raw, 2× after comment-stripping**. `.replace(…, 1)` hit the
  first, which is INSIDE a comment, so the stripper deleted the mutation and the control reported
  "no difference detected" — claiming the instrument was blind when it was fine. The tell was that
  the control returned the value it MUST NOT return; written to expect "no difference", the run would
  have looked clean. **Count occurrences before mutating, mutate one that provably survives the
  transform under test, and run the control in the SAME invocation as the measurement.**
- 🔴 **Piping `handoff_doc.py --confirm --push` through `head` KILLED THE WRITER MID-RUN.** The broken
  pipe ended the process before it committed; the visible output looked like a normal proposal, and
  only `git log` revealed nothing had landed. The standing rule is usually stated as *`$?` becomes
  the pipe's status* — this is the OTHER failure: the pipe does not mis-report the result, it
  PREVENTS it.
- 🔴 **The shell cwd RESETS between tool calls, so a relative `./node_modules/.bin/vitest` runs the
  WRONG REPO'S vitest** and dies with `Error: No projects matched the filter "unit*"` — which reads
  as a flag or config error, not as "wrong repository". Use absolute binary paths. Related, measured
  by a subagent: `--root` fixes vitest's CONFIG resolution but **not `process.cwd()`**, which then
  spuriously fails cwd-walking tests; that test's own positive control caught it (99 files, not
  >3000).

**An agent that dies on an API limit may have done far MORE than its result field shows.** A
terminated audit reported only `"I'll start by reading the brief in full."` while disk held a
populated worktree at the right sha, its `refs/audit/` ref, and ~20 artefacts including two FULL
node-tier runs. **Check the artefacts before concluding a failed agent did nothing**, and resume
rather than restart — resuming recovered all of it.

**Process decisions, with why.**
- **Both audit-claims blocks were posted as ISSUE comments** — `gh pr view --json comments` returns
  issue comments only, so a block posted as a REVIEW is invisible to `audit-dispatch.py` and the next
  round silently becomes a blind full audit. `audit-dispatch.py` correctly REFUSED a delta round
  until a block existed.
- **The #4838 tightening was done in-session rather than dispatched.** The failure mode being fixed
  is an agent's instinct to draft a replacement justification; the fix was deletion, and handing a
  deletion to a drafter invites a fourth draft.
- **#4812's PR body was corrected PUBLICLY** (a comment, not a silent body edit) — it still claimed
  "the mirror is two declarations, not three", and anyone who read it earlier read the wrong version.

**A grep across a WRAPPED line returns a false zero, and it reads as "the text is gone".** Verifying
#4838 landed, a contiguous search for the retracted quote `would be UNTYPED at exactly the point`
returned **0** — because the sentence wraps mid-phrase in the source. Flattening whitespace first
(`re.sub(r'\s+',' ',text)`) returns **1**. The tell was that the zero was the answer I wanted
("the false premise is gone"), when the text was in fact deliberately RETAINED as a quoted
retraction. **Normalise whitespace before grepping prose you expect to span lines, and be most
suspicious of a zero that confirms your hypothesis.**

**`git worktree remove` REFUSES a tree containing submodules** — `fatal: working trees containing
submodules cannot be moved or removed`, rc 128, which reads like a safety stop about uncommitted
work and is not. `--force` is the answer, but only AFTER proving there is nothing to lose: `git
status -s` empty AND `git log @{u}..` empty (all commits pushed). Both, not either.

🔴 **THE DECISION THAT ENDED THIS ARC, IN THE OPERATOR'S OWN WORDS — the author of record for
`page.fullBleed` being dead:**

> "drop the field, this should be managed by styling not a manifest field"

Said on 2026-09-14, after civitai#4812 had passed three audit rounds and thirteen fixed findings.
Kept verbatim because a paraphrase invites re-litigation and this is the whole justification: not a
defect, not a measurement, not an audit finding — a product call about where a layout decision
belongs. Anyone tempted to rebuild the manifest field is arguing with this sentence, and should say
so out loud before starting.

🔴 **TWO ERRORS I MADE THIS SESSION, BOTH CAUGHT BY AN ADVERSARIAL AUDIT RATHER THAN BY ME.**
Recorded because the *shape* of each recurs, not the specifics.

1. **I reasoned from a guard being false in the common case to "it never fires."**
   `HasPostBilling` is false for a succeeded plain chat step, so I wrote "telemetry only, nothing
   changes price" — into my report, the handoff AND a PR body as a 🔴 promise a reviewer would have
   approved on. The enclosing condition was `status is not Succeeded || HasPostBilling(step)`. **I
   read the guard and not the disjunction around it.** Ask what ELSE reaches the branch.
2. 🔴 **I "verified" a premise by searching for confirmation and stopping when I found it.** Asked to
   check that OpenRouter returns `usage.cost` when sent `usage: {include: true}`, I fetched the docs,
   grepped for `cost`, found the response example, and reported the premise confirmed. **The sentence
   declaring that parameter deprecated and inert was one paragraph above the block I quoted.**
   Searching for support finds support. Search for the CONTRADICTION — grep `deprecated`, `no effect`,
   `always` — before reporting a premise confirmed.

**A command reporting success is a claim about the COMMAND, not the outcome.**
`gh pr edit 259 --add-assignee koenb` exited **0**, printed the PR URL, wrote nothing to stderr — and
assigned nobody, because GitHub silently drops assignees who are not assignable on the repo. `koenb`
is a real GitHub user but returns **404** from
`repos/civitai/civitai-spine-controller/assignees/koenb`; the assignable one is **`koenbeuk`**.
**Read the assignment back** (`gh pr view --json assignees`) rather than trusting the exit code —
which was itself the pipe's status, not `gh`'s, because the call was piped through `tail`.

**ClickHouse prod access, read-only — the recipe, for the probes above.** Creds are a ClickHouse
Cloud admin connection string in k8s secret `clickhouse-tracker-env`, ns `civitai-clickhouse-tracker`,
key `ClickhouseConsumer__ConnectionString`, reachable with the kubeconfig at
`civit/datapacket-talos/prod-kubeconfig` (`$KC_DPPROD`). **Pass the password via a `curl -K` config
file (mode 600, shred after) so it never enters argv**, and append `?readonly=1` — which is ENFORCED,
proven: a `CREATE TABLE` probe returns `Code: 164 … Cannot execute query in readonly mode`.
⚠️ **`rg -c` counts matching LINES, and a minified bundle is a handful of enormous lines** — use
`str.count()` for occurrences, or every count is wrong by an order of magnitude.

⚠️ **A grep across a WRAPPED line returns a false zero that reads as "the text is gone".** Verifying
#4838 landed, a contiguous search for the retracted quote returned **0** because the sentence wraps
mid-phrase; flattening whitespace first returns **1**. The tell was that the zero was the answer I
WANTED. Be most suspicious of a zero that confirms your hypothesis.

## How to verify

**civitai #4812 — the new seam guard**, from the worktree, instrument validated first:
```bash
W=/home/zach/workspace/civit/civitai-fullbleed-manifest
# 1. instrument: a planted error MUST be caught (this file is outside `__tests__`)
printf '\nconst __probe: number = "not a number";\nexport default __probe;\n' \
  >> $W/src/components/AppBlocks/fullBleedMounterSeam.test.ts
CI=true direnv exec $W pnpm -C $W run typecheck    # MUST be rc=2 and name TS2322
git -C $W checkout -- src/components/AppBlocks/fullBleedMounterSeam.test.ts
CI=true direnv exec $W pnpm -C $W run typecheck    # rc=0, "OK — 0 type errors"

# 2. positive control: the tier really runs — MUST report 12 tests, never 0
direnv exec $W ./node_modules/.bin/vitest run --project 'unit*' \
  src/components/AppBlocks/fullBleedMounterSeam.test.ts

# 3. the mutant the guard exists for: site 1 -> a literal, MUST go red
#    (edit `fullBleed: page.fullBleed,` -> `fullBleed: false,` in
#     src/pages/apps/run/[slug]/[[...path]].tsx, then re-run step 2)
#    EXPECT: 2 failed | 10 passed — the structural pin AND the behavioural case.
#    Restore with: git -C $W checkout -- 'src/pages/apps/run/[slug]/[[...path]].tsx'
```
🔴 Never pipe these through `tail`/`head` — `$?` becomes the pipe's status and has printed a
reassuring `rc=0` over a real failure on this branch twice. Redirect each stream to its own file.

Browser tier needs the nix chromium, never the `~/.cache/ms-playwright` one:
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/nix/store/wv98g96qwd1vcr5h9dbgpbfh2gvcy1qr-playwright-browsers/chromium-1228/chrome-linux64/chrome`
**A zero test count means the tier never ran**, never that it passed.

**CSS integrity after any `globals.css` edit** — a literal `*/` inside the ledger comment once
terminated it early and spilled prose into live CSS:
```bash
python3 -c "t=open('$W/src/styles/globals.css').read(); print(t.count('/*'), t.count('*/'))"
# must be equal (31 31 as of b073d37d1b)
```

**The drift guard's negative control** — the cheap proof it reads anything:
```bash
sed -i 's/~1905 CSS px/~1900 CSS px/' $W/public/schemas/app-block/v1.json
direnv exec $W ./node_modules/.bin/vitest run --project 'unit*' \
  src/server/services/blocks/__tests__/manifest-full-bleed.schema-drift.test.ts
# MUST be 1 failed | 10 passed
git -C $W checkout -- public/schemas/app-block/v1.json
```

**sensei #72** — unchanged this session; the recorded matrix at `82e6c55` is typecheck rc=0 zero
output · node **429** · dom **339** · build `index-B6c7mAV3.js` **354,791 B**. Both vitest projects
must be read separately — a failure in one is invisible in the other.
