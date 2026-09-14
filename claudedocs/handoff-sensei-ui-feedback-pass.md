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

**sensei** — `trunk` @ `457ea86`, clean. **PR #72** `zach/ui-feedback-pass` @ **`82e6c55`**,
`MERGEABLE`/`CLEAN`. The five-item feedback pass: app-owned SVG `IconButton`, bubble alignment at
`min(68ch, 92%)`, native `ResourceCard variant="row"`, an NSFW-mode toggle replacing the model
selector, and a `⋮` session-row menu carrying the chat id. **Audit ladder CLOSED** after round 0 →
round 1 → round 2 plus three fix rounds; **closure recorded as a PR comment with six OPEN items and
their closing conditions** — that comment is the record, not this doc. Unchanged this session;
version deliberately still `0.1.22` in both `package.json` and `block.manifest.json`, so a
`release:` PR is owed after #72 merges. Recorded matrix at `82e6c55`: typecheck rc=0 zero output ·
node **429** · dom **339** · build `index-B6c7mAV3.js` **354,791 B**.

**civitai PR #4812** `zach/app-block-full-bleed-manifest` @ **`849b9abc76`**, `MERGEABLE`, OPEN.
🔴 **The ENTIRE round-1 fix round (F2–F8) is now LANDED** — seven commits on top of `cb8233f52c`:

| commit | finding |
|---|---|
| `b073d37d1b` | F2 + F3 — the mounter seam guard and the two dev-tunnel resolver tests |
| `f5473054da` | F6 — the ledger's "~230 lines" |
| `c5c35e1883` | F5 — the two cap-inlining casualties filed in the list they go red in |
| `11af474ffb` | F7 — un-retract the mirror count |
| `b838bab8c1` | F4 — the dev tunnel reads the APPROVED manifest |
| `a1d4b067a9` | F8 — pin the published description WHOLE |
| `849b9abc76` | scope correction to `c5c35e1883`'s own comment |

**What the dispatching session re-verified directly** (as opposed to reading in an agent's report) —
an audit fix resets the gate, and a subagent's self-reported mutation matrix is the exact claim that
gets asserted without being run:
- **F2** — typecheck instrument validated (planted `TS2322` at the seam file, caught; restored rc=0),
  12-test positive control, and mutant site 1 (`fullBleed: page.fullBleed` → `false`) → **2 failed |
  10 passed**, killed by BOTH its own assertions. **1 of 14 mutants re-run here**; the other 13 rest
  on the agent's report.
- **F8** — the mandatory mutation, re-run independently and constructed fresh: inverted
  `OUT of` → `INTO` and inverted the default sentence, with an assertion in the mutating script that
  **both old substrings (`omit it`, `full-page run host only`) and the entire numeric multiset
  survive**. Result **1 failed | 10 passed**, killed by the new whole-string pin; restored → **11/11**.
  That is the decisive control: the mutant is precisely the one the old substring guard passed.
- **F5** — confirmed only that the entries landed in the **cap-inlining** section (`globals.css:246`
  and `:252`), with an explicit in-file note that an earlier checklist version filed it under the
  ledger step. The **red-set measurement itself was not re-run here.**
- tree clean at `849b9abc76`; CSS comment balance **31 31**.

🔴 **The recorded F5 attribution in this doc was WRONG and is now corrected by measurement.** It said
`pageBlockHostMaxWidth.test.ts:618` goes red on the same edit as the listed `:473` (the ledger
retirement). Measured by performing each edit, running, and reverting — baseline 10 files / 152
tests: deleting the ledger reds **5** tests and `:618` stays **GREEN**; inlining the cap reds **4**,
`:618` among them. So it belongs to the cap-inlining step. The same measurement found a **second**
unlisted casualty, `:542` ('the cap sits on `app-page-content`…'), added with a RE-POINT-don't-delete
note because its containment claim survives the inlining.

**Scope widened beyond the five findings, flagged for a decision:** `b838bab8c1` also adds a tooling
caveat next to the "declare it in your manifest" snippet in `docs/features/app-blocks.md`, on the
grounds that F7 establishes an author following that snippet is refused by the CLI before any network
call. It carries its own staleness test ("if `civitai app validate` exits 0 for you, delete this
note"). **Nobody asked for it** — keep or drop is an open call.

**civitai base clone** `/home/zach/workspace/civit/civitai` is `main` @ `4daf83e288`, **behind 1**.
Left alone deliberately: #4812 has not merged, so the re-sync is not due yet.

**The worktree at `/home/zach/workspace/civit/civitai-fullbleed-manifest` is still deliberately in
place** with `node_modules` and a generated Prisma client intact. Remove it with
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

1. **Re-audit the DELTA on #4812** — the seven commits `b073d37d1b..849b9abc76`. An audit/review fix
   RESETS the verification gate: every delta audit round on this effort so far has found something
   the previous round's fix introduced, and this delta is a whole fix round that has never been
   audited. The ladder ends on the first round that finds NOTHING — set by findings, never by a
   count, and a clean round must not be re-run to confirm it.
   Files in the delta: `src/components/AppBlocks/fullBleedMounterSeam.test.ts`,
   `src/server/services/__tests__/block-registry.resolve-dev.test.ts`,
   `src/components/Apps/ReviewBlockPreviewHost.browser.test.tsx`, `src/styles/globals.css`,
   `docs/features/app-blocks.md`,
   `src/server/services/blocks/__tests__/manifest-full-bleed.schema-drift.test.ts`.
   Two specific things to put in front of the auditor: the **unasked-for docs addition** in
   `b838bab8c1` (above), and the fact that **neither the full node tier nor the full browser tier was
   run** — only the files the edits reach.
   IN FLIGHT: nothing.
   - forcing: gate — `civitai`'s `main` has no required status checks at all, so the audit is the
     only gate, and a whole unaudited fix round now sits on the PR.
2. **Merge #72, then open the `release:` PR** bumping sensei `0.1.22 → 0.1.23` in `package.json`
   **and** `block.manifest.json` together.
   - forcing: user — the operator asked for the five feedback items; they are audit-clean and
     unreleased until the version moves.
3. **After #4812 merges: declare `page.fullBleed: true` in both ledger apps, then retire the CSS
   ledger.** Each is a one-line manifest change. 🔴 **Blocked on the schema mirrors, not on the
   merge** — all three copies reject the key today, so the normal `civitai app submit` path refuses
   before any network call. Measured nuance: `--skip-validate` bypasses the CLI and the **server
   validator already accepts the field**, so "cannot declare" is scoped to the normal path.
   - forcing: gate — the ledger's own stated retirement condition, and once an app declares the flag
     the host omits `max-width` entirely, so the dead rule's death is unobservable.
4. **Drive one real submit on `deepseek/deepseek-v4-flash-0731`** in a mod-gated host and reconcile
   `billed_usd` against `Charged`.
   - forcing: gate — `chat-completion.step.ts`'s own convention is that every registered model was
     driven to `succeeded` live; this is the first entry to break it, and it is now the default arm
     every viewer lands on.
5. **Ask OpenRouter/Venice to expose `tools` on the Venice endpoint, or to list
   `venice-uncensored-1-2`.** Venice's own API already reports `uncensored: true` **and**
   `supportsFunctionCalling: true` at 128k — it is simply not published to OpenRouter. The only route
   to a **grounded** NSFW mode with no code on either side.
   - forcing: none
6. **`taste.json`'s `reshoot` and `crop-rect-bottom-edge`** remain blocked on a sensei version
   > 0.1.12 being approved and live; #72's `data-testid="model-selector"` removal adds a third
   consequence.
   - forcing: none

## Defects (batched)

**All eight round-1 findings on #4812 are FIXED** (`b073d37d1b..849b9abc76`). The delta itself is
unaudited — that is rank 1. Kept here because the *lesson* in each outlives the fix:

- **F2** — FIXED `b073d37d1b`, re-verified here on 1 of 14 mutants. A `REQUIRED` prop catches an
  OMITTED prop, never a WRONG one: all five mounter-side forwardings could be replaced by a literal
  `false`, making the feature inert on all three surfaces including the moderator preview, with
  6,475 node tests and 26/26 browser tests green.
- **F3** — FIXED `b073d37d1b` (agent-reported). Both dev-tunnel projections were untested.
- **F4** — FIXED `b838bab8c1`. "You can check it before you submit" was false for every app the
  migration targets. `ab.manifest` is written in exactly one place — `approveRequest` in
  `publish-request.service.ts` — so the tunnel serves the **last approved** manifest; the pending
  manifest is read only on the ephemeral fallback, reached when the author owns no `app_blocks` row.
- **F5** — FIXED `c5c35e1883` + `849b9abc76`. Attribution corrected by measurement (see State now);
  a second unlisted casualty `:542` found in the same pass.
- **F6** — FIXED `f5473054da`. The count was removed rather than corrected: the named boundaries
  already carry the instruction and cannot rot silently, which a line number does.
- **F7** — FIXED `11af474ffb`. Three copies, confirmed live: canonical (has `fullBleed`), `civitai/cli`
  (no), `@civitai/app-sdk@0.14.0` (no). CLI `0.1.101`: with the key → rc **1**
  `page: additional properties 'fullBleed' not allowed`; without → rc **0** (positive control).
- **F8** — FIXED `a1d4b067a9`, re-verified independently here. The substring guard passed a
  meaning-inverting reword 11/11; the whole-string pin kills it. A whitespace-only reflow still
  passes, which proves the normalisation is real rather than decorative.

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
