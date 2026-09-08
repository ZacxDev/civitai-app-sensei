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

`pnpm` and `node` are **not on PATH** outside the dev shell. The flake pins the
toolchain:

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
flake reads it with `builtins.readFile`, and CI reads it via
`actions/setup-node`'s `node-version-file`. pnpm's major is stated twice
(`flake.nix`'s `pnpmMajor` and the `pnpm/action-setup` step) because the action
reads only its own input or a `packageManager` field this repo **deliberately
does not declare** — adding one would change what the *platform's* builder does,
since `block.manifest.json`'s `buildCommand: pnpm run build` runs against the
same `package.json`. `src/toolchain-lockstep.test.ts` fails if those two drift,
or if someone hardcodes a node version back into the workflow.

Only `x86_64-linux` is exercised. The flake evaluates for `aarch64-linux` and
`aarch64-darwin` too; `x86_64-darwin` is absent because nixpkgs-unstable dropped
it.

This repo has **no `pnpm-workspace.yaml`**. It needs none: there is no
`minimumReleaseAge` gate configured, and `pnpm store path` (what setup-node's
`cache: pnpm` calls) resolves without one. If you ever add the file, it must
declare `packages: ['.']` — a workspace file with no `packages` key errors where
no file at all does not.

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
   Subpaths matter: `@civitai/app-sdk` exports `./blocks`, `./scopes`,
   `./orchestrator`, `./schemas/app-block/v1.json`; `@civitai/blocks-react`
   exports `./ui` and `./testing`.
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
file, the incident they exist to prevent.

`taste.json` carries the deferred-work ledger: each entry names why it was not
done and the **closing condition** that ends it. Read it before "fixing"
something that looks unfinished.

## Release protocol

- `block.manifest.json` and `package.json` versions move **together**.
  `src/manifest.test.ts` enforces it; a release that bumps one is a shippable
  defect that has actually shipped before.
- `block.manifest.json`'s `buildCommand` is **`pnpm run build`** — this is what
  the *platform's* builder runs to produce the live app, not something CI covers.
  `.github/` is not part of the submitted bundle, so a green CI run says nothing
  about it. Changing that line is the highest-blast-radius edit in this repo.
- Bumping `@civitai/app-sdk` and `@civitai/blocks-react` is a **paired** change:
  the peer range is real and the two have been mismatched silently before.
- Vite bakes `VITE_*` into the bundle at build time, and two of them decide
  whether a release works at all. `.env.production` is untracked and gitignored,
  so neither is visible in a diff — check the build environment, not the repo.
  - **`VITE_BLOCK_ALLOWED_PARENT_ORIGINS`** — the origin allowlist. Nothing in
    `src/` passes `allowedParentOrigins` on the embedded path; the SDK reads
    this var itself (`blocks-react/dist/internal/detector.js`,
    `readAllowedOriginsFromEnv()`), and `IframeTransport` **throws** when the
    resulting list is empty (`allowedParentOrigins must contain at least one
    entry`). Unset or wrong ⇒ the transport never mounts, or drops every host
    message, and the iframe renders blank.
  - **`VITE_DEV_HARNESS`** — `src/main.tsx` mounts `<Harness>`, the mock host,
    when this is the string `'true'`. Set in a production build, it ships a
    block that answers itself instead of talking to the host.
