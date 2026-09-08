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

No `pnpm-workspace.yaml` — **but do not read that as "there is no freshness
gate".** pnpm 11 enforces a minimum-release-age policy on the lockfile by
default; `pnpm install` here prints `✓ Lockfile passes supply-chain policies`
because the pinned `@civitai/*` versions are simply old enough. Bump any of
them to a release younger than the cutoff (~24h) and the install **fails**:

```
[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] … was published at …, within the
minimumReleaseAge cutoff
```

The fix then is a `pnpm-workspace.yaml` with `packages: ['.']` and a
`minimumReleaseAgeExclude` naming those exact versions — `civitai-app-gen-matrix`
and `civitai-app-playable-collections` both carry one for this reason. Until
then the file buys nothing. ⚠️ `pnpm config get minimumReleaseAge` reports
`undefined`, which means "no user override", **not** "no policy" — it is the
wrong instrument for this question; run an install and read its output.

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
  grounding, tools, sessions, turn records and both lockstep guards live here.
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
any guard.** It catalogues every mutant that guard was watched going **green**
on across four adversarial rounds — three of which broke the *previous round's
fix* rather than the original. The recurring failure is always the same: a guard
that checks a WORD IS PRESENT is walked around by an edit that spells the word
somewhere harmless. Pin the value, the binding, or the whole normalised string.
One clean round is not evidence; the ladder ends when a round finds nothing.

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
- Bumping `@civitai/app-sdk` and `@civitai/blocks-react` is a **paired** change.
  They have been mismatched before — `blocks-react@0.37.0` peered on `^0.28.0`
  against an exact `app-sdk@0.30.0` pin and **npm silently overrode it**
  (`claudedocs/handoff-civitai-sensei-bridge.md`). pnpm does not fail on it
  either: `strict-peer-dependencies` is unset, so that exact bad pair installs
  rc=0 with only `[WARN] Issues with peer dependencies found` (measured). **A
  green install is not evidence the pair is valid** — run `pnpm peers check`.
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
