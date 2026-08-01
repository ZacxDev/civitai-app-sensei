# Civitai Sensei — a Civitai App Block

**A complete, open-source example of a [Civitai](https://civitai.com) App Block.**
Read it to learn how a real block is wired to the host platform — chat sessions with configurable LLM models, an NSFW agent for mature content delegation, and live Civitai catalog research via tool calls. All against the *published* SDK packages, with a mock host so you can run it in two commands.

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
| Chat sessions with LLM | `useAppStorage` (KV), orchestrator stub | `src/lib/chat.ts`, `src/lib/orchestrator-stub.ts` |
| Tool-calling loop | Orchestrator function calling, civitai public API | `src/lib/tools.ts`, `src/App.tsx` |
| Civitai catalog search | Public REST API (`/api/v1/models`) | `src/lib/research.ts` |
| NSFW agent delegation | OpenRouter model routing via orchestrator | `src/lib/nsfw-agent.ts` |
| Multi-session management | Per-user KV storage | `src/lib/sessions.ts` |
| Buzz spending | `useBuzzWorkflow` (estimate → consent → submit) | `src/App.tsx` |
| Design system | `@civitai/blocks-react/ui` components | `src/components/` |

## Architecture

The app is a single-page React application with three panels:

- **Session sidebar** — list of chat sessions with create/rename/delete
- **Chat area** — message history with streaming responses and tool call cards
- **Research panel** — collapsible right panel showing civitai search results

State is persisted per-user via `useAppStorage` (KV). The orchestrator stub
simulates chat completions and tool calls — when the real bridge ships
([civitai/civitai#3527](https://github.com/civitai/civitai/issues/3527)),
the stub will be replaced with `useBuzzWorkflow` integration.

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
