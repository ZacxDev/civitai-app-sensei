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

**Merged in earlier sessions** — verified by content, not by ancestry (a squash never makes the
branch head an ancestor): sensei **#71** (`1765b4b`), civitai **#4803** (`5805465b5e`), civitai
**#4804** (`2803e825b1`).

**sensei** — `trunk` @ `ddfb40f`, clean. **PR #72** `zach/ui-feedback-pass` @ **`82e6c55`**,
`MERGEABLE`/`CLEAN`. The five-item feedback pass: app-owned SVG `IconButton`, bubble alignment at
`min(68ch, 92%)`, native `ResourceCard variant="row"`, an NSFW-mode toggle replacing the model
selector, and a `⋮` session-row menu carrying the chat id. **Audit ladder CLOSED** after round 0 →
round 1 → round 2 plus three fix rounds; **closure recorded as a PR comment with six OPEN items and
their closing conditions** — that comment is the record, not this doc. Unchanged this session;
version deliberately still `0.1.22` in both `package.json` and `block.manifest.json`, so a
`release:` PR is owed after #72 merges.

**civitai PR #4812** `zach/app-block-full-bleed-manifest` @ **`b073d37d1b`**, `MERGEABLE`, OPEN.
Round-1 finding **F2/F3 fix round LANDED** this session as `b073d37d1b`
(`test(app-blocks): close the two seams that let \`page.fullBleed\` be made inert with every gate green`):

- new `src/components/AppBlocks/fullBleedMounterSeam.test.ts` (12 tests) — a **ledger** of the five
  mounter-side forwardings that fails when the set GROWS or SHRINKS, plus a behavioural two-point
  case per surface. That is what closes F2: the pre-existing `pageBlockHostMaxWidth.test.ts:712`
  guard catches an OMITTED prop and never a WRONG one.
- `(fb1)`–`(fb4)` in `src/server/services/__tests__/block-registry.resolve-dev.test.ts` cover the two
  previously-untested dev-tunnel projections (owned `:2020`, ephemeral `:2154`/`:2183`) — F3.
- `src/components/Apps/ReviewBlockPreviewHost.browser.test.tsx` — the stub now surfaces
  `data-full-bleed`, with a declaring/non-declaring two-point case.
- Agent-reported: 14/14 mutants killed; typecheck rc=0; node `unit*` 307 files / 6,661 tests;
  `component` 130 files / 1,842 tests; `geometry` 5/65; `test:lint-rules` 38/530.
- Correction the agent made to the brief: `:1917` (the approved/resolve-page read) was ALREADY
  covered at `block-registry.resolve-page.test.ts:163-218`, so nothing was added there; and the mint
  test lives at `src/server/services/blocks/__tests__/publish-request.mintReviewToken.test.ts`, not
  `src/server/services/__tests__/`.

🔴 **Independently re-verified by the dispatching session, because an audit fix resets the gate and a
subagent's self-reported mutation matrix is exactly the claim that gets asserted without being run.**
Scope stated honestly: **1 of the 14 mutants was re-run here**, the other 13 rest on the agent's
report. What was measured directly:
- typecheck instrument validated — a planted `const __probe: number = "not a number"` appended to
  the new seam file gave `rc=2` + `TS2322` at line 752; restored → `rc=0`, `OK — 0 type errors in 23s`.
  That planted error ALSO proves the seam file sits outside the untypechecked `__tests__` set.
- positive control — the seam file collects **12** per-test lines, so the tier really ran.
- mutant site 1 (`fullBleed: page.fullBleed` → `false` in `src/pages/apps/run/[slug]/[[...path]].tsx`)
  → **2 failed | 10 passed**, killed by BOTH its own assertions: the structural pin
  (`expected 'false' to be 'page.fullBleed'`) and the behavioural one ("the declaration dies in
  `getServerSideProps` and the app renders capped on the PUBLIC surface, with nothing failing").
  Restored → 12/12 green, `git status` clean.

**IN FLIGHT: the F4–F8 prose round**, dispatched to a subagent against the same worktree, not yet
returned at the time of writing. Scope: F4 (the false "You can check it before you submit"
paragraph), F5 (the retirement checklist's missing test entry — it is to settle EMPIRICALLY which
retirement edit turns `pageBlockHostMaxWidth.test.ts:618` red, since the recorded finding says the
ledger edit and inspection suggests the cap-inlining edit, and those belong in different lists),
F6, F7, F8. If that agent did not land, its work is lost and F4–F8 are still open — check
`git -C <worktree> log --oneline` against `b073d37d1b` before assuming.

**Two file-modifying agents were deliberately never run concurrently in that worktree** — the F2/F3
round and the F4–F8 round were sequenced for this reason.

**civitai base clone** `/home/zach/workspace/civit/civitai` is `main` @ `4daf83e288`, **behind 1**.
Left alone deliberately: #4812 has not merged, so the re-sync the rules call for is not due yet.

**The worktree at `/home/zach/workspace/civit/civitai-fullbleed-manifest` is still deliberately in
place** (branch `zach/app-block-full-bleed-manifest`) with `node_modules` and a generated Prisma
client intact — rebuilding costs ~1 minute per audit round. Remove it with
`git -C $CIVITAI worktree remove` when #4812 closes.

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

## Next steps (ranked)

1. **Re-audit the DELTA on #4812** — `b073d37d1b` plus whatever the F4–F8 round landed. An audit/review
   fix RESETS the verification gate: every delta audit round on this effort so far has found something
   the previous round's fix introduced. The ladder ends on the first round that finds NOTHING — that is
   set by findings, never by a count, and a clean round must not be re-run to confirm it.
   Files most likely in the delta: `src/components/AppBlocks/fullBleedMounterSeam.test.ts`,
   `src/server/services/__tests__/block-registry.resolve-dev.test.ts`,
   `src/components/Apps/ReviewBlockPreviewHost.browser.test.tsx`, `src/styles/globals.css`,
   `docs/features/app-blocks.md`,
   `src/server/services/blocks/__tests__/manifest-full-bleed.schema-drift.test.ts`.
   IN FLIGHT: nothing (the F4–F8 FIX agent is separate from this AUDIT).
   - forcing: gate — `civitai`'s `main` has no required status checks at all, so the audit is the
     only gate, and the previous round's fix is itself unaudited.
2. **Merge #72, then open the `release:` PR** bumping sensei `0.1.22 → 0.1.23` in `package.json`
   **and** `block.manifest.json` together.
   - forcing: user — the operator asked for the five feedback items; they are audit-clean and
     unreleased until the version moves.
3. **After #4812 merges: declare `page.fullBleed: true` in both ledger apps, then retire the CSS
   ledger.** Both repos are ours and both manifests already carry a `page` object, so each is a
   one-line change. 🔴 **Blocked on the schema mirrors, not on the merge** — see the investigation
   above: all three copies reject the key today, so an author (including us) cannot declare it until
   a release cuts and the CLI *and* SDK re-vendor. The retirement set is enumerated by name in
   `src/styles/globals.css`'s `WHAT SHOULD HAPPEN TO THIS BLOCK` note.
   - forcing: gate — the ledger's own stated retirement condition, and once an app declares the flag
     the host omits `max-width` entirely, so the dead rule's death is unobservable: two mechanisms,
     both green, one dead, indefinitely.
4. **Drive one real submit on `deepseek/deepseek-v4-flash-0731`** in a mod-gated host and reconcile
   `billed_usd` against `Charged`.
   - forcing: gate — `chat-completion.step.ts`'s own convention is that every registered model was
     driven to `succeeded` live; this is the first entry to break it, and it is now the default arm
     every viewer lands on.
5. **Ask OpenRouter/Venice to expose `tools` on the Venice endpoint, or to list
   `venice-uncensored-1-2`.** Venice's own API already reports `uncensored: true` **and**
   `supportsFunctionCalling: true` at 128k — it is simply not published to OpenRouter. This is the
   only route to a **grounded** NSFW mode with no code on either side.
   - forcing: none
6. **`taste.json`'s `reshoot` and `crop-rect-bottom-edge`** remain blocked on a sensei version
   > 0.1.12 being approved and live; #72's `data-testid="model-selector"` removal adds a third
   consequence (the toggle is not capturable against a green/blue domain, so a capture run sees
   neither control on that strip).
   - forcing: none

## Defects (batched)

Round-1 findings on #4812. **F2 and F3 are FIXED** in `b073d37d1b` (F2 re-verified independently
here on 1 of 14 mutants; F3 on the agent's report only). **F4–F8 were dispatched as one fix round
and were still in flight when this doc was written** — re-check `git log` before treating any as done.

- **#4812 F2** — FIXED. Replacing all five mounter-side forwardings with a literal `false` made the
  feature inert on all three surfaces, including the moderator preview the PR calls the gate, and
  left 302 node files / 6,475 tests and 26/26 browser green. Required-ness catches an *omitted* prop,
  never a *wrong* one.
- **#4812 F3** — FIXED. Both dev-tunnel projections (`block-registry.service.ts:2020` owned,
  `:2154`/`:2183` ephemeral) read the field with no test, unlike sibling `bootSkeleton`.
- **#4812 F4** — `docs/features/app-blocks.md:489-491`'s "You can check it before you submit" is
  **false for every app the migration targets**: the dev tunnel reads `ab.manifest`, written only on
  approve, and falls through to the pending manifest only when the author owns no row.
- **#4812 F5** — the retirement checklist omits `pageBlockHostMaxWidth.test.ts:618` ("pins the content
  wrapper's box model"), whose verbatim expected string carries the
  `maxWidth: fullBleed ? 'none' : var(--app-page-max-width, …)` expression. 🔴 **Which retirement edit
  turns it red is UNSETTLED** — the finding says the ledger edit (alongside the listed `:473`),
  inspection suggests the cap-INLINING edit (alongside the listed `:506`). Those are different
  sections of the checklist. Settle it by performing each edit and reading the red set, not by
  reasoning.
- **#4812 F6** — the note says "~230 lines"; **measured independently this session**: the block is
  `globals.css:152` (the `FULL-BLEED CSS LEDGER` header) to `:468` (closing brace of the
  `[data-app-page-frame][data-block-id='sensei']` rule) = **317**. `152+230=382` lands between the
  `playable-collections` rule (`:381`) and the `sensei` rule (`:466`) — exactly the intermediate
  terminator the same sentence warns a reader not to stop at.
- **#4812 F7** — `globals.css:272-275` asserts the mirror is "two declarations, not three". There are
  three; **confirmed with version-exact values this session** — see the Open investigations block.
  The retraction removed a real follow-up rather than a falsehood.
- **#4812 F8** — `manifest-full-bleed.schema-drift.test.ts:322-338` is titled "the description states
  the DEFAULT behaviour" but asserts only the substrings `omit it` and `/full-page run host only/i`.
  A meaning-**inverting** reword with every numeric token intact leaves it **11/11 green**.

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
