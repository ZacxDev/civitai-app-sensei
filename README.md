# Civitai Sensei — a Civitai App Block

**A complete, open-source example of a [Civitai](https://civitai.com) App Block.**
Read it to learn how a real block is wired to the host platform — chat sessions with configurable LLM models, Buzz-metered generation through the host bridge, and answers grounded in **live Civitai catalog data** the model looks up itself via real tool calling. All against the *published* SDK packages, with a mock host so you can run it in two commands.

🔗 **Live:** [sensei.civit.ai](https://sensei.civit.ai) ·
[civitai.com/apps/run/sensei](https://civitai.com/apps/run/sensei)

> The app is served from its own origin (`sensei.civit.ai`) purely to be
> **embedded** by the Civitai page host — open it via the `/apps/run/…` link above, not
> the bare subdomain. See [Handling direct traffic](#handling-direct-traffic).

> **This is a reference/example, not the canonical deployment.** It demonstrates
> the App Blocks platform seams; the production app is deployed separately. An App
> Block holds **no credentials and no infrastructure** — it's a static SPA the
> host embeds; the viewer identity + a scoped token are injected at runtime.

## New to App Blocks?

An [App Block](https://developer.civitai.com) is a self-contained web app that runs
inside the Civitai platform. The host (`civitai.com`) embeds the block in an iframe,
injects a scoped JWT token, and provides hooks for generation, storage, and billing.
The block never has direct access to the viewer's session — it receives a token at
mount time and communicates via `postMessage`.

## Quickstart

The toolchain is pinned by a nix flake, so `pnpm` comes from the shell rather
than your machine — node's major from `.nvmrc`, pnpm's from `flake.nix`:

```bash
git clone https://github.com/ZacxDev/civitai-app-sensei
cd civitai-app-sensei
nix develop              # or: direnv allow (needs nix-direnv)
pnpm install --frozen-lockfile
pnpm run dev:harness     # → mock host at http://localhost:5189
```

No nix? Read those two files for the versions and bring your own node + pnpm.

## What this demonstrates → where to look

| Capability | Hooks / modules | Files |
|---|---|---|
| Chat sessions with LLM | `useAppStorage` (KV), `useBuzzWorkflow` bridge | `src/lib/chat.ts`, `src/lib/orchestrator-bridge.ts` |
| Retrieval-grounded answers | Search → compact → inject as a `system` message | `src/lib/research.ts`, `src/App.tsx` |
| Civitai catalog search | Block catalog API (`/api/v1/blocks/models`), `useBlockToken` | `src/lib/research.ts` |
| Uncensored model | Selected explicitly in Settings, not delegated behind your back | `src/lib/models.ts` |
| Multi-session management | Per-user KV storage | `src/lib/sessions.ts` |
| Buzz spending | `useBuzzWorkflow` (estimate → consent → submit) | `src/App.tsx` |
| Design system | `@civitai/blocks-react/ui` components | `src/components/` |

## Architecture

The app is a single-page React application with three panels:

- **Session sidebar** — list of chat sessions with create/rename/delete
- **Chat area** — message history with replayed streaming responses
- **Research panel** — collapsible right panel showing civitai search results

State is persisted per-user via `useAppStorage` (KV). Chat completions go
through the real host bridge (`useBuzzWorkflow` → the orchestrator's
`chat-completion` step). A reply costs Buzz at the model's live rate, and a
question that needs a catalog lookup spends it once per round — see below.

### How answers are grounded

The host exposes a **tool/function-calling surface**: its params schema accepts
`tools` + `tool_choice`, its message schema is a discriminated union that
includes a `'tool'` role with `tool_call_id`, and a `tool_calls` reply reaches
the block on a verdict-gated snapshot field. So the MODEL writes the query:

1. the tool declarations are FETCHED from `GET /api/v1/blocks/tools` — never
   authored here, or the model would be shown a contract the route does not
   enforce,
2. the model emits a `tool_calls` reply; the app POSTs each call to the same
   route, which is backed by the maturity-clamped catalog path,
3. each result goes back as a `role:'tool'` message and the app resubmits.

One tool is declared and executed differently from steps 1 and 2: **`recommend_resources`**
(`src/lib/recommend.ts`) is declared and executed by the app itself, beside the
host's tools. It asks Civitai's recommendation route
(`POST /api/v1/blocks/resource-intent`) for add-ons — and, when a base model is
known, checkpoints — that fit an image. That route ranks for an *image prompt*,
so the model is told to rewrite the viewer's question into a concrete image
description first, and the viewer sees that description (cut to one line) while
the lookup runs. Its schema is enforced by the app's own executor, so authoring
it here does not break the reasoning behind step 1. A degraded (failed) answer from the route is
reported as a failure, never as "no models needed".
It ships **on** since 0.1.31 (0.1.28 released it off; 0.1.30 briefly turned it off again
while an unrelated upstream outage was misattributed to it): `RECOMMEND_TOOL_ENABLED` in
`src/lib/recommend.ts` is the switch, and turning it off is that one line plus a release.
Since 0.1.32 the default system prompt routes "which models / LoRAs / checkpoints
for this kind of image" questions to `recommend_resources` first — conditionally,
since the tool is not on every turn's wire — and keeps `search_models` for named
models, stats and explicit rankings. That routing was measured only by a
first-round tool-choice probe (`eval/tool-choice-probe.mjs`), not by the live
eval; the comment on `DEFAULT_SYSTEM_PROMPT` in `src/types.ts` has the numbers.
Since 0.1.33 the tool also takes an optional `needs` list (legible text, layout,
photorealism, editing, character consistency, high resolution, transparent
background, reference images) and, when the route answers one, presents
**hosted models** — single-model generators such as GPT Image or Seedream, which
have no add-ons — in their own section. That half comes from civitai/civitai
#6015; against a route without it the field is absent and the result is exactly
what it was before. The wire names live in one type and one parse function in
`src/lib/recommend.ts`. Since 0.1.34 `needs` carries at most the two capabilities
a request hinges on: the route ranks hosted models by how many needs each
covers, so a longer list surfaces generalists over the right specialist.

**Each round is its own submit, separately quoted and separately charged**, so a
question needing a lookup costs more than one completion. The loop is bounded by
the host's cap on `role:'tool'` messages per payload (mirrored locally as
`MAX_TOOL_RESULT_MESSAGES`), and stops with a user-visible message rather than
silently.

This replaced a client-side stopword heuristic that rewrote the user's sentence
into keywords, searched once, and injected the results — one shot, no feedback,
and a heuristic rather than the model deciding the query.

The block catalog endpoints are
token-gated with **no required scope** and clamp maturity server-side off the
token's signed claim, failing closed to SFW — so a `pg13` block cannot surface
mature catalog content whatever it asks for.

## Handling direct traffic

If someone opens `sensei.civit.ai` directly (not via `civitai.com/apps/run/sensei`),
the block shows an "Open on Civitai" landing page. This is the `BlockGate` component
from `@civitai/blocks-react/ui` — it detects the absence of `BLOCK_INIT` (the
postMessage that signals an embedded session) and renders a redirect link.

## UI — the @civitai/blocks-react/ui component pack

This block uses the following pack components:

- `Button`, `Group`, `Stack` — layout and actions
- `Badge`, `Alert` — status indicators
- `Select`, `Slider`, `TextInput`, `Textarea` — form controls
- `Modal` — settings dialog
- `Loader` — loading states
- `BlockGate` — direct-traffic landing

No hand-rolled presentational components — all styling uses `token.*` and `radius.*`
from `@civitai/theme`.

## Develop

### Scripts

| Command | What it does |
|---|---|
| `pnpm run dev` | Vite dev server (no mock host) |
| `pnpm run dev:harness` | Vite + SDK mock host (for local development) |
| `pnpm run build` | `tsc --noEmit && vite build` → `dist/` |
| `pnpm run typecheck` | `tsc --noEmit` |
| `pnpm test` | Vitest (node + dom projects) |
| `pnpm run preview` | Preview the production build |

## Build & submit (Civitai CLI)

```bash
civitai app validate      # lint block.manifest.json + the build output
civitai app submit        # build (pnpm run build) + upload dist/ for review
```

## Links

- Developer docs — [developer.civitai.com](https://developer.civitai.com)
- Live app — [sensei.civit.ai](https://sensei.civit.ai)
- SDK contract — [`@civitai/app-sdk`](https://www.npmjs.com/package/@civitai/app-sdk)
- React hooks + UI pack — [`@civitai/blocks-react`](https://www.npmjs.com/package/@civitai/blocks-react)
- CLI — [`github.com/civitai/cli`](https://github.com/civitai/cli)
- Sibling reference block — [`civitai-app-custom-generators`](https://github.com/ZacxDev/civitai-app-custom-generators)

## License

[Apache-2.0](LICENSE) © 2026 Zach Lowden.
