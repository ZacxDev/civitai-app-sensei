# Civitai Sensei — agent guide

A Civitai **App Block**: a full-page app served at `/apps/run/sensei` (own
origin `sensei.civit.ai`, embedded by the host) that answers questions with the
Civitai catalog in hand. The model writes its own search queries via real tool
calling; **every reply spends the viewer's Buzz**, and a question that needs a
lookup spends it *more than once* — each round is its own quoted, charged
submit. That is the part of this codebase that must never regress.

Two invariants deserve naming because a guard already exists for each and both
have been violated in a shipped release:

- **The consent copy must not understate the cost.**
  `block.manifest.json`'s `scopeJustifications["ai:write:budgeted"]` is what a
  viewer reads before granting the scope that spends their Buzz. The reachable
  ceiling is derived, not typed:
  `MAX_TOOL_RESULT_MESSAGES + 1 + MAX_CORRECTION_ROUNDS`.
  `src/manifest.test.ts` asserts the copy against that derivation rather than
  against a literal — the copy understated the ceiling from 0.1.6 to 0.1.11 and
  a literal assertion would have been green for that entire window.
- **Manifest and package versions move together.** Same file, same reason:
  `block.manifest.json` decides what the platform submits, `package.json` is
  what the build reads.

This repo is a **public OSS reference block** — block source only, no
infrastructure internals. Keep it that way. Default branch is **`trunk`**, not
`main`.

## Get a shell

`pnpm` is **not on PATH** outside the dev shell, and the `node` that is on your
PATH is whatever your profile happens to carry — not the pinned major. Use the
shell; the flake pins both:

```bash
direnv allow          # or: nix develop
pnpm install --frozen-lockfile
```

| Task | Command |
|---|---|
| The gates CI runs | `pnpm run typecheck && pnpm test && pnpm run build` |
| Types only | `pnpm run typecheck` |
| Mock host (SDK `<Harness>`) | `pnpm run dev:harness` → http://localhost:5189 |
| Dev server bound for a tunnel | `pnpm run dev:tunnel` → 127.0.0.1:5186 |
| Platform approve-time validator | `civitai app validate` (the Go CLI, installed separately — the flake does not ship it) |

**Toolchain pins.** `.nvmrc` is the single authority for the node major — the
flake reads it with `builtins.readFile`, CI via `node-version-file`. pnpm's
major is stated twice (`flake.nix`'s `pnpmMajor` and the `pnpm/action-setup`
step) because the action reads only its own input or a `packageManager` field
this repo **deliberately does not declare** — declaring one would change what
the *platform's* builder does, since `buildCommand` runs against the same
`package.json`. `src/toolchain-lockstep.test.ts` fails if those drift, or if
someone hardcodes a node version back into any workflow.

Only `x86_64-linux` is exercised; the flake also evaluates for `aarch64-linux`
and `aarch64-darwin`. `x86_64-darwin` is absent because nixpkgs-unstable dropped
it — listing it hands an Intel-Mac contributor a `throw` instead of a shell.

There IS a `pnpm-workspace.yaml`, and it is **temporary** — it exists only to
carry a `minimumReleaseAgeExclude` for two freshly-published `@civitai`
versions, and its own header names the timestamp after which it can be deleted.
Read that header before adding to it.

pnpm 11 enforces a minimum-release-age policy (~24h) on the lockfile by
default. 🔴 **The two install paths behave DIFFERENTLY, and an earlier version
of this section described only one of them:**

- **bare `pnpm install`** — **succeeds**, and silently *writes*
  `pnpm-workspace.yaml` for you with a `minimumReleaseAgeExclude` block naming
  the offending versions. It does **not** write a `packages:` key.
- **`pnpm install --frozen-lockfile`** — which is what
  `.github/workflows/ci.yml` runs, and what any reproducible build uses —
  **fails** until that exclusion is committed:

```
[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] … was published at …, within the
minimumReleaseAge cutoff
```

So the exclusion has to be **in the tree**, not just on your disk. Either commit
it, or wait for the version to age past the cutoff and commit neither.

🔴 **The `packages: ['.']` key is for the PLATFORM BUILDER, not CI — do not
repeat the sibling repos' reason for it.** `civitai-app-gen-matrix` and
`civitai-app-playable-collections` both say `actions/setup-node`'s `cache: pnpm`
errors `packages field missing or empty` without it. Measured: that command is
`pnpm store path --silent`, which returns rc=0 on pnpm 10 and 11 and errors only
on **pnpm 9**. CI pins pnpm 11, so CI does not need the key. The builder does —
it runs `corepack enable` unpinned on `node:22-alpine` (see the third-environment
table below), so pnpm 9 is in reach, and `civitai app submit` ships this file
with the tree.

⚠️ `pnpm config get minimumReleaseAge` reports `undefined`, which means "no user
override", **not** "no policy" — it is the wrong instrument for this question;
run an install and read its output. ⚠️ And read the *right* install's output:
`pnpm clean --lockfile && pnpm install` re-resolves the WHOLE tree and will
quietly upgrade unrelated devDependencies. To move one pin, edit `package.json`
and run a plain `pnpm install` against the existing lockfile.

### The third environment: the platform builder

The artifact users actually load is built by the app-blocks Tekton pipeline,
which this repo does not configure:

| | node | pnpm | pinned by |
|---|---|---|---|
| dev shell | `.nvmrc` (24) | `flake.nix` `pnpmMajor` (11) | this repo |
| CI | `.nvmrc` (24) | `pnpm/action-setup` (11) | this repo |
| **platform builder** | **`node:22-alpine`** | **`corepack enable` — unpinned** | the pipeline, not this repo |

So a green local and CI run is evidence about node 24, while the shipped bundle
is built on node 22 by an unpinned pnpm. Nothing here can guard that — the only
lever, `packageManager`, is withheld for the reason above. Treat a build failure
that reproduces nowhere locally as a node-major difference first.

## Where a change belongs

Most work that *looks* like a bug here is a gap one layer down. Canonical
checkouts live at `~/workspace/civit/<repo-name>`; sibling directories with a
suffix are topic worktrees of the same remotes, usually on someone's branch.

| The change is about | Repo | Local |
|---|---|---|
| This block's UI, chat, sessions, grounding, tool loop | **`ZacxDev/civitai-app-sensei`** (here) | — |
| A hook, a type, the mock host, the design system — anything imported from `@civitai/*` | **`civitai/civitai-app-starters`** | `civitai-app-starters` |
| Host/server behavior: the `/apps/run` page surface, block token + scope enforcement, the page money path, app storage, the block catalog + tools routes, submit/approval | **`civitai/civitai`** | `civitai` |
| `civitai app init/validate/submit`, login, dev tunnel | **`civitai/cli`** (Go) | `cli` |
| Public developer docs (developer.civitai.com) | **`civitai/civitai-developer-docs`** | `civitai-developer-docs` |

**All five `@civitai/*` packages ship from the one starters repo** —
`packages/civitai-{app-sdk,blocks-react,components,components-react,theme}`. A
missing hook, a wrong type, a mock host that doesn't simulate something: that is
a PR there, not a workaround here.

Two things this block depends on live in `civitai/civitai` and nowhere else: the
tool declarations served by `GET /api/v1/blocks/tools` (never authored here — an
authored copy would show the model a contract the route does not enforce) and
the maturity-clamped catalog path behind `/api/v1/blocks/models`.

Sibling app blocks worth reading for prior art:
`ZacxDev/civitai-app-gen-matrix`, `…-model-benchmarking`,
`…-playable-collections`, `…-custom-generators`, `…-requests`.

## Documentation sources, in authority order

1. **The installed package itself.** `node_modules/@civitai/<pkg>/dist/*.d.ts`
   and its `README.md` are the only source guaranteed to describe *the version
   this repo builds against*. Check `package.json` for that version first.
   Subpaths matter (`@civitai/app-sdk` alone exports eight), and any list of
   them written down here rots on the next bump — read the `exports` key of the
   package's own `package.json`.
2. **https://developer.civitai.com/apps/** — `guide/{quickstart,concepts,embedding,theming,text-to-image,comfy-cloud}`
   and `reference/{hooks,manifest,messages,scopes,components,generation,cli}`.
   Best for *why* and for the message-bridge contract. ⚠️ The generated pages
   carry a `sources:` front-matter naming the package version they were built
   from, and it **lags** the version here — when the page and the `.d.ts`
   disagree, the `.d.ts` wins.
3. **The starters repo** — `docs/build-your-first-app-block.md` and
   `starters/examples/*`. Real code beats prose for "how is this hook meant to
   be used".
4. **The host implementation** in `civitai/civitai` — last-resort ground truth
   for server behavior the docs don't specify (which errors the orchestrator
   returns, what a scope actually gates, what the tools route will accept).

For React 19 / Vite / Vitest specifics, use the `context7` MCP tools rather than
recalling from memory.

## Verifying a change

`pnpm test` runs **two vitest projects** and both must be read — a failure in
one is invisible in the other:

- **`node`** — `src/**/*.test.ts`, pure logic, no DOM. The orchestrator bridge,
  grounding, tools, sessions, turn records and all three lockstep guards live
  here (`toolchain-`, `civitai-dependency-` and `manifest.test.ts`). The
  dependency one reads the installed `node_modules`, so it is the one gate here
  that a stale install can make lie — `readlink -f node_modules/@civitai/*`
  before trusting it, because `pnpm install --frozen-lockfile` prints `Already up
  to date` over a tree linked to the wrong versions. ⚠️ It reads what the app can
  RESOLVE, not what is on disk: `pnpm install` never prunes orphaned
  `.pnpm/<pkg>@<oldver>` directories, so a guard that counted those went red on a
  correct tree in the ordinary review flow (check out a branch over an existing
  `node_modules`, install, test). Its header records the fix and the two-point
  measurement; do not "simplify" it back into a directory sweep.
- **`dom`** — `src/**/*.test.tsx`, jsdom + Testing Library, against the SDK mock
  host. The `*.e2e.test.tsx` files drive the real component tree through a full
  send → tool round → reply → persist cycle.

`pnpm run build` typechecks (`tsc --noEmit`) before it bundles, so a green build
is also a green typecheck; CI runs `typecheck` separately anyway so a type error
is attributed rather than buried in a build log.

**What cannot be verified here.** No local run, harness run, or test proves a
reply actually charged correctly. The real spend loop is Turnstile + auth gated
and needs a human in a real mod-gated host. Likewise the catalog and tools
routes are token-gated: the harness simulates them. Say so plainly rather than
reporting a green suite as if it covered the money path.

New guards should pin a *relationship* that cannot rot on a routine bump, and be
watched failing before they are trusted. `src/manifest.test.ts` and
`src/toolchain-lockstep.test.ts` are the pattern to copy — both explain, in the
file, the incident they exist to prevent, and both carry a self-control proving
their own extractor can fail. **Read the toolchain guard's header before writing
any guard.** It records the lesson six adversarial rounds kept producing — four
of which broke the *previous round's fix* rather than the original: a guard that
checks a WORD IS PRESENT is walked around by an edit that spells the word
somewhere harmless. Pin the value, the binding, or the whole normalised string.
One clean round is not evidence; the ladder ends when a round finds nothing.
The full mutant catalogue those rounds produced was 858 lines of hand-rolled
Nix/YAML parsing. It was normalised to the shape the sibling app-block repos
share — the assertions, the survivors and the ceiling note kept, the parsers
dropped; `git log -p -- src/toolchain-lockstep.test.ts` still has the catalogue.

That guard also documents its own ceiling, which is worth copying: its flake
assertions are text matching over a Turing-complete expression language, so they
are a **tripwire for drift, not a proof**. Its header lists five mutants that
pass it **today** — left open because each needs a real Nix/YAML parser or an
evaluator, not another regex. The proof is evaluation:
`nix flake check --all-systems` and `nix eval .#packages.<system>.nodejs.version`
against `.nvmrc`. CI does not run nix, so **nothing automated does this** — run
it by hand whenever you touch `flake.nix`, and do not read a green suite as
covering it.

`taste.json` carries the deferred-work ledger: each entry names why it was not
done and the **closing condition** that ends it. Read it before "fixing"
something that looks unfinished.

## Release protocol

- `block.manifest.json` and `package.json` versions move **together**.
  `src/manifest.test.ts` enforces it; a release that bumps one is a shippable
  defect that has actually shipped before.
- `block.manifest.json`'s `buildCommand` is **`pnpm run build`** — what the
  *platform's* builder runs to produce the live app, not something CI covers.
  `.github/` is not part of the submitted bundle, so a green CI run says nothing
  about it. The builder picks which lockfile it demands from that command's
  first word: `pnpm …` requires `pnpm-lock.yaml`, anything else requires
  `package-lock.json` — which this repo no longer has. So reverting the word
  alone hard-fails the build of the live app. It also validates the command
  against `/^(?:(?:npm|pnpm|yarn) run [\w:-]+|(?:npx )?vite build)$/` first, so
  even `pnpm  run build` (two spaces) is **rejected outright**.
  `src/toolchain-lockstep.test.ts` mirrors that regex, pins the exact string,
  checks the named script exists in `package.json`, and requires exactly one
  lockfile. Still the highest-blast-radius line in the repo.
- 🔴 **This repo deliberately sits ONE MINOR BELOW the starter's canonical
  `@civitai/app-sdk`, and that is not drift.** `civitai-app-starters`'
  `starters/civitai-block-starter/package.json` pins `^0.46.0`; this repo pins
  **`^0.45.0`**, which on a `0.x` caret hard-caps below `0.46.0`. The reason:
  `0.45.0` is the FIRST version carrying `BLOCK_MESSAGE_REJECTED` — the report
  that makes a validator-dropped bridge reply visible instead of silent — and
  it is the floor `@civitai/blocks-react@0.53.x` peers on. `0.46.0` adds nothing
  this app can use: a type-only rename on the ORCHESTRATOR surface (this app
  imports only `@civitai/app-sdk/blocks`, whose same-named union is untouched,
  and references the name zero times) plus a runtime change in `dist/cookies/`
  it never imports. **Measured: the built bundle is byte-identical between
  `0.45.0` and `0.46.0`** — same content hash on every `dist/assets/*`. So the
  cap costs nothing and avoids taking a breaking release for no benefit.
  Re-derive this before raising the pin; do not "sync to the starter" on the
  strength of the version numbers differing.
- Bumping `@civitai/*` is a **paired** change — and the pair is **four packages,
  not two**. `app-sdk` + `blocks-react` have been mismatched before:
  `blocks-react@0.37.0` peered on `^0.28.0` against an exact `app-sdk@0.30.0`
  pin and **npm silently overrode it**
  (`claudedocs/handoff-civitai-sensei-bridge.md`). pnpm does not fail on it
  either: `strict-peer-dependencies` is unset, so that exact bad pair installs
  rc=0 with only `[WARN] Issues with peer dependencies found` (measured). **A
  green install is not evidence the pair is valid** — run `pnpm peers check`.

  ⚠️ **And `pnpm peers check` is blind to the other half of the pairing.**
  `blocks-react` **exact-pins** `@civitai/theme` and `@civitai/components` in
  its own `dependencies` (at 0.49.0: `theme 0.3.1`, `components 0.4.1`), and so
  does `@civitai/components-react`. Exact pins on both sides cannot be deduped,
  so moving `blocks-react` while leaving `components-react` behind installs
  **two copies of `theme` and two of `components`** — measured, with `pnpm peers
  check` reporting `No peer dependency issues found` the whole time, because
  nothing here is a *peer* range.

  **Do not reach for `pnpm list` for this. `src/civitai-dependency-lockstep.test.ts`
  is the instrument**, and it is in the suite: it reads `blocks-react`'s own
  declared pins out of the installed manifest and requires the tree to agree,
  which is a relationship no version bump can rot. Read its header before
  reasoning about the skew — it records what the skew was measured to do, and
  what it was measured *not* to do.

  🔴 **One claim in that header is a RETRACTION, and it was in this file from
  0.1.22's bump PR: that two copies of `blocks-react` would be two class
  identities, so `orchestrator-bridge.ts`'s `instanceof WorkflowSubmitError` /
  `WorkflowEstimateError` branches would silently return false and the viewer
  would be shown the SDK's developer-facing constant.** That mechanism is
  **unreachable and was measured false** — no `@civitai` package declares a
  dependency on `@civitai/blocks-react` at all, so it is in the tree only as this
  app's *direct* dependency and cannot be duplicated; `app-sdk` likewise (its
  only in-tree declarer is `blocks-react`, as a *peer*, which resolves to the
  app's own copy). `theme` and `components` duplicate; neither exports a class
  this repo branches on. In a deliberately skewed tree all 71
  `orchestrator-bridge.test.ts` tests pass, those 16 `instanceof` guards
  included. **If you are here because you bumped `blocks-react` alone: the check
  that answers your question is the guard named above, not a duplicate count, and
  certainly not this paragraph's retracted mechanism.**

  ⚠️ **A dependency's stylesheet is injected at runtime AND is in the bundle —
  so the JS byte count is a usable signal for it, not a blind one.**
  `@civitai/components` and `@civitai/blocks-react` each inject their own
  `<style>` at boot, but the CSS they inject travels as a JS *string* —
  `blocks-react/dist/ui/styles.js` imports `componentsCss` from
  `@civitai/components` and `tokensCss` from `@civitai/theme` — so Vite inlines it
  into the JS chunk. Measured against the 0.1.22 pair-bump PR: the 31,970-byte,
  887-line `@civitai/components/styles.css` is in `dist/assets/index-*.js` head
  to tail, and `@layer civitai.components` appears **3× in the JS and 0× in
  `dist/assets/*.css`**. Targets that reproduce it, one match each: its last
  header line `See MARKUP.md for the full per-component markup + ARIA contract.`,
  its opening `@layer civitai.components {`, and its final selector
  `[data-civitai-ui='image'][data-status='error'] [data-civitai-ui-image-fallback]`.

  🔴 **But "verbatim" does NOT hold line-for-line, and the exception is exactly
  what a grep lands on.** esbuild emits `componentsCss` as a **template literal**,
  so every backtick in the sheet arrives escaped as backslash-backtick. **73 of
  the 887 lines contain a backtick, and not one of those 73 is present verbatim**
  — all 73 are comment prose, **0 CSS declarations are affected**, and each is
  present in escaped form. Measured: the header line beginning `Contract: style is
  selected by` (whose next token is a backticked `data-civitai-ui`) gets **0**
  matches against the bundle, while the same line with each backtick replaced by
  backslash-backtick gets 1. Two earlier versions of this paragraph were wrong in
  this very spot, and the trap is self-reinforcing: grep a backtick-bearing line,
  get 0, conclude the sheet is absent. **Pick a target with no backtick — every
  CSS declaration and selector qualifies.**

  Consequently the build output DOES move with a dependency CSS change, and the
  0.1.22 pair bump is the worked example — the bundle was **not** byte-identical:

  | | JS | CSS |
  |---|---|---|
  | `6fd63c0` (trunk) | `index-DjI_Rh2G.js`, 331,941 B | `index-BaQG15Xi.css`, 4,659 B |
  | `4d57c43` (the pair bump) | `index-CjPIP-BA.js`, 346,904 B | `index-DEzy6Xgc.css`, 4,772 B |

  Both hashes changed. `resource-card` went 0 → 25 occurrences in the JS and
  `data-civitai-ui` 232 → 277; the CSS asset moved because `main.tsx`'s
  `import '@civitai/theme/styles.css'` is a real CSS import and `theme` bumped
  0.2.0 → 0.3.1 — its tell is `--civitai-bp-`, 0 → 5 occurrences, which is exactly
  the five variables that release added. (If you find a note claiming a
  byte-identical bundle on the pair bump, it is a **mis-attribution of `4d00b34`**,
  the prose-only commit next to it — that one's two assets really are
  `cmp`-identical to `4d57c43`'s.)

  🔴 **So do not lean on "the CSS hash is unchanged" as evidence a change is
  confined.** `dist/assets/*.css` is 4.77 kB — the app's own CSS plus the theme
  tokens, nothing else — while the ~32 kB components sheet and `blocks-ui`'s sheet
  live inside the JS chunk. An unchanged CSS hash therefore cannot distinguish "the
  change is confined" from "the diff touched no `.css` input". The **JS** delta is
  the one that carries that claim. Still `diff` the published source stylesheets
  across the versions when you want to know *what* moved — a byte count says only
  that something did. ⚠️ **`@civitai/components/styles.css` is an export subpath,
  not a path**: `components` is transitive and pnpm does not hoist it, so
  `node_modules/@civitai/` holds only the four DIRECT deps and there is no
  `node_modules/@civitai/components` at all. The file is at
  `node_modules/.pnpm/@civitai+components@<ver>/node_modules/@civitai/components/styles.css`
  (`find node_modules/.pnpm -name styles.css -path '*components*'` finds it);
  `blocks-react` is direct, so `node_modules/@civitai/blocks-react/dist/ui/styles.js`
  resolves as written. And ⚠️ **`readlink -f` is the wrong instrument for "is this
  installed"** — it canonicalises a missing leaf, so
  `readlink -f node_modules/@civitai/components` prints a confident path that does
  not exist. Use `ls`/`find`. (It is fine for the four direct deps, where the
  symlink is real.)
- Vite bakes `VITE_*` in at build time and `.env.production` is gitignored, so
  neither of the two that matter is visible in a diff.
  - **`VITE_BLOCK_ALLOWED_PARENT_ORIGINS`** — the origin allowlist. Nothing in
    `src/` passes `allowedParentOrigins` on the embedded path; the SDK reads the
    var itself (`blocks-react/dist/internal/detector.js`), and `IframeTransport`
    **throws** on an empty list. ⚠️ **You do not own this value in production**:
    the platform builder sets it as a Docker `ENV`, which outranks any `.env`
    file, so it overrides whatever this repo commits and must mirror the per-app
    CSP `frame-ancestors`. Setting it here affects a *local* build only — never
    "fix" a blank embedded iframe by editing this repo.
  - **`VITE_DEV_HARNESS`** — `src/main.tsx` mounts `<Harness>`, the mock host,
    when this is the string `'true'`. Set in a production build, it ships a
    block that answers itself instead of talking to the host.
