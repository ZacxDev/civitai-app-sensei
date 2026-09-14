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

🔴 **THE `page.fullBleed` MANIFEST FIELD IS DEAD — OPERATOR DECISION, NOT AN AUDIT FINDING.**
"This should be managed by styling, not a manifest field." civitai **#4812 is CLOSED UNMERGED**
(`closedAt 2026-09-14T21:23:18Z`, `mergedAt: null`, branch `zach/app-block-full-bleed-manifest`
preserved). The CSS ledger in `src/styles/globals.css` is now the permanent mechanism, not a
transitional one. **Do not rebuild the field**; read #4812's closing comment first if tempted.

That call is the lesson of this arc. Three audit rounds asked *"is this change correct?"* and the
answer kept coming back yes — thirteen findings, all fixed, ladder closed cleanly on the attribution
gate. **No round could ask "should this exist?"**, which is the only question that closes a PR. One
sentence from the operator ended it.

**sensei — SHIPPED.** `trunk` @ `30909d1`, clean.
- **#72 MERGED** (`mergedAt 2026-09-14T21:18:03Z`, merge commit `68b6641`) — the five-item UI
  feedback pass: app-owned SVG `IconButton`, bubble alignment at `min(68ch, 92%)`, native
  `ResourceCard variant="row"`, an NSFW-mode toggle, a `⋮` session-row menu. Its audit ladder closed
  after **round 0 → round 1 → round 2 plus three fix rounds**, with closure recorded as a PR comment
  carrying six OPEN items and their closing conditions — that comment is the record, not this doc.
  Verified by CONTENT, not ancestry (a squash never makes the head an ancestor).
- **#73 MERGED** (`30909d17`) — `release: 0.1.23`. Both `package.json` and `block.manifest.json`
  read `0.1.23` on trunk, read back from the files rather than inferred from the merge. Gates before
  merge: typecheck rc=0 · node **429** · dom **339** (run SEPARATELY — the combined summary does not
  label tiers and this repo's gate requires reading both) · build rc=0 `index-BhrJSPg5.js` 354,840 B
  · `src/manifest.test.ts` 3/3.

**civitai #4838 — OPEN, audited, awaiting a merge decision.** `zach/stale-cross-references` @
**`6e4e0a80bf`**, `MERGEABLE`, +43/−20 across 3 files, **comment and docs only**. It de-lines six
stale cross-references to symbol/branch citations and retracts the false SDK-pin justification in
`globals.css`. Full audit returned 1 🟡 + 2 🟢, **all three in the new prose** — the predicted failure
mode. Fixed in `6e4e0a80bf` by **cutting the block rather than redrafting it**, because every sentence
is a claim that can rot and this block has now been wrong twice.

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

## Next steps (ranked)

1. **Decide civitai#4838** — merge or close. Comment/docs-only, audited, 69 files / 1125 tests green
   at its head, the `globals.css` guard re-validated ON that tree (a planted `*/` reds
   `ledgerSelectorSurvivesProdStrip` + `pageBlockHostMaxWidth`, 2 failed / 14 passed; restored 16/16,
   balance 31/31). **A delta round on `6e4e0a80bf` was NOT run** — see the stop reasoning in Gotchas.
   Anyone uncomfortable with that should run `/audit-pr 4838 --round 2`; the round-1 claims are not
   posted as a block, so that would need one first.
   IN FLIGHT: nothing.
   - forcing: user — it is open on the operator's account and merges nothing on its own.
2. **Drive one real submit on `deepseek/deepseek-v4-flash-0731`** in a mod-gated host and reconcile
   `billed_usd` against `Charged`. It is sensei's DEFAULT model, now shipped in 0.1.23, and has never
   been driven to `succeeded` live.
   - forcing: gate — `chat-completion.step.ts`'s own convention is that every registered model was
     driven to `succeeded` live; this is the first entry to break it, and every viewer lands on it.
3. **Ask OpenRouter/Venice to expose `tools` on the Venice endpoint, or to list
   `venice-uncensored-1-2`.** Venice's own API already reports `uncensored: true` **and**
   `supportsFunctionCalling: true` at 128k — it is simply not published to OpenRouter. The only route
   to a **grounded** NSFW mode with no code on either side.
   - forcing: none
4. **`taste.json`'s `reshoot` and `crop-rect-bottom-edge`** remain blocked on a sensei version
   > 0.1.12 being approved and live. **0.1.23 is now on trunk**, so the blocker moves to approval
   rather than to the version existing.
   - forcing: none

## Defects (batched)

- 🔴 **The CSS ledger's membership does not match the need, and nothing will force the question
  again now that the ledger is permanent.** The census in `PageBlockHost.tsx` (self-described as a
  stale cross-repo reading that nothing asserts) finds 11 first-party page apps: **nine cap
  themselves at 640–1100px**, so the 1600px cap is a no-op for their layout; **two genuinely stretch
  — Notepad and Sensei.** The ledger's members are **`playable-collections` and `sensei`**. It
  EXCLUDES an app that needs it and INCLUDES one for which it is cosmetically inert. Was going to be
  dissolved by the manifest field; now it is a standing question for whoever owns the ledger.
  **Closing condition:** the ledger's membership is reconciled against a re-taken census (recording
  refs), or the owner dismisses the asymmetry in writing.
- **#4838's audit findings — all three FIXED in `6e4e0a80bf`**, and all three were in prose the PR
  itself had just written: an unmeasured "and it is strict" about the mirrors; a re-vendor cost
  attributed to all three copies when only the CLI was ever measured to block; and an
  `its`-clause bound to `BlockManifest`, which has no docblock (the quoted line belongs to the
  BLOCK_INIT payload type).
- **Pre-existing citation rot beyond #4838's scope:** `block-effective-scopes.ts:126` is 105 chars
  against `printWidth: 100` (prettier does not reflow comments, so CI is green).

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
