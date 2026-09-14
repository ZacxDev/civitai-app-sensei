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

**Merged this session** — verified by content, not by ancestry (a squash never makes the
branch head an ancestor): sensei **#71** (`1765b4b`, the four-package `@civitai/*` bump +
`WorkflowSubmitError`/`WorkflowEstimateError` migration), civitai **#4803** (`5805465b5e`,
registers `deepseek/deepseek-v4-flash-0731`), civitai **#4804** (`2803e825b1`, the per-app
CSS full-bleed ledger entry that #4812 now supersedes).

**sensei** — `trunk` @ `1765b4b`, clean. **PR #72** `zach/ui-feedback-pass` @ **`82e6c55`**,
`MERGEABLE`/`CLEAN`. The five-item feedback pass: app-owned SVG `IconButton`, bubble
alignment at `min(68ch, 92%)`, native `ResourceCard variant="row"`, an NSFW-mode toggle
replacing the model selector, and a `⋮` session-row menu carrying the chat id.
**Audit ladder CLOSED** after round 0 → round 1 → round 2 plus three fix rounds; closure
recorded as a PR comment with six OPEN items and their closing conditions. Gates re-verified
independently at that head with the instrument validated by a planted `TS2322`: typecheck
rc=0 zero output · node **429** · dom **339** · build `index-B6c7mAV3.js` **354,791 B**.

**civitai** — `main` @ `4aab099c91` (re-synced this session; it was 1 behind). **PR #4812**
`zach/app-block-full-bleed-manifest` @ **`cb8233f5`**, `MERGEABLE`. Adds `page.fullBleed`
(optional boolean, default `false`) so any app declares full bleed in its own manifest.
Round 0 + round 1 audits DONE. **Round 1's fix round was NOT dispatched** — that is next
step 1, and nothing is in flight for it.

**Not done deliberately:** sensei's version stays `0.1.22` in both `package.json` and
`block.manifest.json`. A `release:` PR is owed after #72 merges — this repo's convention is
a feature PR then a release PR, and `src/manifest.test.ts` enforces the two fields moving
together.

**A worktree is deliberately left in place** at `/home/zach/workspace/civit/civitai-fullbleed-manifest`
(branch `zach/app-block-full-bleed-manifest`, clean at `cb8233f52c`) with `node_modules` and a
generated Prisma client intact, because rebuilding that costs ~1 minute per audit round.
Remove it with `git -C $CIVITAI worktree remove` when #4812 closes.

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

## Next steps (ranked)

1. **Dispatch the fix round for #4812's round-1 findings.** F2/F3/F4 belong in the PR; F5–F8
   are prose. One seam guard over the five mounter-side forwardings closes F2 and F3 together.
   Files: `src/pages/apps/run/[slug]/[[...path]].tsx`, `src/pages/apps/dev/[blockId].tsx`,
   `src/components/Apps/ReviewBlockPreviewHost.tsx`, `src/server/services/block-registry.service.ts`,
   `docs/features/app-blocks.md`, `src/styles/globals.css`.
   IN FLIGHT: nothing.
   - forcing: gate — round 1 produced findings that must be fixed before the ladder can close,
     and `main` has **no required status checks at all**, so the audit is the only gate.
2. **Merge #72, then open the `release:` PR** bumping sensei `0.1.22 → 0.1.23` in
   `package.json` **and** `block.manifest.json` together.
   - forcing: user — the operator asked for the five feedback items; they are audit-clean and
     unreleased until the version moves.
3. **After #4812 merges: declare `page.fullBleed: true` in both ledger apps, then retire the
   CSS ledger.** Both repos are ours (`ZacxDev/civitai-app-sensei`,
   `ZacxDev/civitai-app-playable-collections`) and both manifests already carry a `page`
   object, so each is a **one-line change**. The retirement set is enumerated by name in
   `src/styles/globals.css`'s `WHAT SHOULD HAPPEN TO THIS BLOCK` note.
   - forcing: gate — the ledger's own stated retirement condition, and once an app declares the
     flag the host omits `max-width` entirely, so the dead rule's death is **unobservable**:
     two mechanisms, both green, one dead, indefinitely.
4. **Drive one real submit on `deepseek/deepseek-v4-flash-0731`** in a mod-gated host and
   reconcile `billed_usd` against `Charged`.
   - forcing: gate — `chat-completion.step.ts`'s own convention is that every registered model
     was driven to `succeeded` live; this is the first entry to break it, and it is now the
     default arm every viewer lands on.
5. **Ask OpenRouter/Venice to expose `tools` on the Venice endpoint, or to list
   `venice-uncensored-1-2`.** Venice's own API already reports `uncensored: true` **and**
   `supportsFunctionCalling: true` at 128k — it is simply not published to OpenRouter. This is
   the only route to a **grounded** NSFW mode with no code on either side.
   - forcing: none
6. **`taste.json`'s `reshoot` and `crop-rect-bottom-edge`** remain blocked on a sensei version
   > 0.1.12 being approved and live; #72's `data-testid="model-selector"` removal adds a third
   consequence (the toggle is not capturable against a green/blue domain, so a capture run sees
   neither control on that strip).
   - forcing: none

## Defects (batched)
- **#4812 F2** — replacing all five mounter-side forwardings with a literal `false` makes the
  feature **inert on all three surfaces, including the moderator preview the PR calls the gate**,
  and leaves 302 node files / 6,475 tests and 26/26 browser green. Required-ness catches an
  *omitted* prop, never a *wrong* one.
- **#4812 F3** — both dev-tunnel projections (`block-registry.service.ts:2020` owned,
  `:2153` ephemeral) read the field with no test, unlike sibling `bootSkeleton` covered at
  `block-registry.resolve-dev.test.ts:126-164`.
- **#4812 F4** — `docs/features/app-blocks.md:489-491`'s "You can check it before you submit"
  is **false for every app the migration targets**: the dev tunnel reads `ab.manifest`, written
  only on approve, and falls through to the pending manifest only when the author owns no row.
- **#4812 F5** — the retirement checklist omits `pageBlockHostMaxWidth.test.ts:618`, which goes
  red on the same edit as the listed `:473`.
- **#4812 F6** — the note says "~230 lines"; the block is `globals.css:152–468` = **317**.
  `152+230=382` lands between the two entries — exactly the stopping place the same sentence
  warns against.
- **#4812 F7** — `globals.css:272-275` asserts the mirror is "two declarations, not three".
  There are three; the retraction removed a real follow-up rather than a falsehood.
- **#4812 F8** — `manifest-full-bleed.schema-drift.test.ts:322-338` is titled "the description
  states the DEFAULT behaviour" but asserts only the substrings `omit it` and
  `/full-page run host only/i`. A meaning-**inverting** reword with every numeric token intact
  leaves it **11/11 green**.

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

## How to verify

**sensei #72** — from a clean worktree at the PR head, validating the instrument first:
```bash
cd <worktree>                       # detached at 82e6c55, git status clean
printf 'const p:number="x";\nexport default p;\n' > src/__p.ts
./node_modules/.bin/tsc -p tsconfig.json --noEmit   # MUST be rc=2 and name src/__p.ts
rm -f src/__p.ts
./node_modules/.bin/tsc -p tsconfig.json --noEmit   # rc=0, zero output
./node_modules/.bin/vitest run --project node       # 429
./node_modules/.bin/vitest run --project dom        # 339
./node_modules/.bin/vite build                     # index-B6c7mAV3.js 354,791 B
```
Both vitest projects must be read separately — a failure in one is invisible in the other.

**civitai #4812** — the drift guard's negative control is the cheap proof it reads anything:
```bash
W=/home/zach/workspace/civit/civitai-fullbleed-manifest
sed -i 's/~1905 CSS px/~1900 CSS px/' $W/public/schemas/app-block/v1.json
direnv exec $W ./node_modules/.bin/vitest run --project 'unit*' \
  src/server/services/blocks/__tests__/manifest-full-bleed.schema-drift.test.ts
# MUST be 1 failed | 10 passed
git -C $W checkout -- public/schemas/app-block/v1.json
# restored: the three guards give 3 files / 28 tests green
```
CSS integrity after any `globals.css` edit — a literal `*/` inside the ledger comment once
terminated it early and spilled prose into live CSS:
```bash
python3 -c "t=open('$W/src/styles/globals.css').read(); print(t.count('/*'), t.count('*/'))"
# must be equal (31 31)
```
