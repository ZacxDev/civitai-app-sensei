# Civitai Sensei — a Civitai App Block

**A complete, open-source example of a [Civitai](https://civitai.com) App Block.**
Read it to learn how a real block is wired to the host platform — chat sessions with configurable LLM models, Buzz-metered generation through the host bridge, and answers grounded in **live Civitai catalog data** retrieved client-side. All against the *published* SDK packages, with a mock host so you can run it in two commands.

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

```bash
git clone https://github.com/ZacxDev/civitai-app-sensei
cd civitai-app-sensei
npm install
npm run dev:harness      # → mock host at http://localhost:5189
```

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
`chat-completion` step) at a flat 1 Buzz per answer.

### How answers are grounded

The host exposes **no tool/function-calling surface** — its params schema is
`.strict()` over `{model, messages, maxTokens, temperature}` and its message
schema has no `'tool'` role, so a model reachable from a block can neither
request nor return a tool call. Sensei therefore retrieves *before* it asks:

1. the user's message is passed straight to `/api/v1/blocks/models` (a search
   engine handles free text — no model call is needed to write the query),
2. the results are compacted to a bounded, `urn:air:`-stripped block, and
3. injected as a `system` message immediately above the question.

One completion, one Buzz, no upstream change. The block catalog endpoints are
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
| `npm run dev` | Vite dev server (no mock host) |
| `npm run dev:harness` | Vite + SDK mock host (for local development) |
| `npm run build` | `tsc --noEmit && vite build` → `dist/` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest (node + dom projects) |
| `npm run preview` | Preview the production build |

## Build & submit (Civitai CLI)

```bash
civitai app validate      # lint block.manifest.json + the build output
civitai app submit        # build (npm run build) + upload dist/ for review
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
