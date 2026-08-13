# Handoff: Civitai Sensei orchestrator bridge — 2026-08-05

Supersedes the 2026-08-04 revision of this file, whose next-steps list is spent and
whose central diagnosis was wrong (see **Corrections**).

## Goal

Replace the orchestrator stub with the real host-mediated bridge, dogfood a clean AND a
flagged completion, then decide on submission.

## State now

Branch `feat/orchestrator-adapter`, PR #1 OPEN / MERGEABLE, 13 commits, all pushed.
Typecheck 0 errors · 145/145 tests in 18 files · production build clean.

**Both branches have now executed against the DEPLOYED step** — the first time any of
this code has run outside a fixture:

| branch | result |
|---|---|
| clean | `"The capital of France is Paris."` · `finish_reason: stop` · workflow `8753561-20260805150729230` |
| flagged | `TextOutputWithheldError`, reason verbatim from the host's `TEXT_OUTPUT_WITHHELD_MESSAGE` |

🔴 **Sensei is NOT submitted for mod approval, by decision** — see *The tools gap*.

## What the bridge was actually doing

It was cast through `as unknown as WorkflowBody` and had never run. Against the real
contract — `<civitai>/src/server/services/blocks/steps/chat-completion.step.ts`, whose
`paramSchema` is `.strict()` — **every field it sent was wrong**, and the read path could
never have succeeded either:

- `step: 'chatCompletion'` is the entry's internal `orchestratorType`. The wire enum is
  derived from the registry KEYS, so the id is **`'chat-completion'`** and the camelCase
  spelling is rejected fail-closed at the schema before any handler runs.
- `max_tokens`, `tools`, `tool_choice`, `response_format` are not members of the param
  schema. `.strict()` **rejects** an unknown key rather than dropping it — each was a
  `BAD_REQUEST` on its own.
- `maxTokens` is REQUIRED and capped at **4,000**; the adapter defaulted 4,096. The
  settings slider went to 8,192, so a user could drag into a guaranteed rejection.
- `messages` admits only system/user/assistant — no `'tool'` role, so tool results have
  no carrier.
- the model was unbounded; the host `z.enum`s it against three ids. `AVAILABLE_MODELS`
  offered `deepseek-r1`, `gemini-2.0-flash` and `claude-3.5-sonnet`, **none registered**.
  There is no orchestrator-side model validation behind the enum: a non-member is quoted
  1 Buzz, **CHARGED** 1 Buzz, then fails at execution with no output and no refund.
- **the read path**: a `'textOutput'` posture entry may not declare an `extractOutput`, so
  the reply reaches the block ONLY on `snapshot.textOutputs` (a refusal only on
  `textOutputWithheld`). The adapter read `steps[0].output.text` / `snap.content` /
  `snap.text` — never populated — so it would have thrown "empty response" on every success.

## Corrections — read before trusting the older doc

- 🔴 **The "cross-origin iframe clicks are synthetic, React ignores them" diagnosis is
  WRONG.** `element.click()` inside the frame fires React handlers fine — it is a real DOM
  dispatch and React does not check `isTrusted`. The click was never the blocker. What
  actually stalls is the async host storage round-trip in a THROTTLED background tab.
  Don't burn another session on trusted-click theories.
- 🔴 **A `postMessage` probe on `window.parent` cannot work** and fails SILENTLY: you
  cannot assign properties to a cross-origin Window proxy, so the patch no-ops and records
  `[]`. That empty array reads exactly like "the handler never ran". Caught only by a
  positive control (an explicit self-`postMessage` that also failed to record). Any probe
  here needs its own positive control before its zero means anything.
- 🔴 **`civitai app dev-tunnel` does not exist in the installed CLI binary.**
  `~/.local/bin/civitai` is a stale local dev build (`commit: none`). The command IS on cli
  `origin/main` (`internal/cmd/app_dev_tunnel.go`). Rebuild before use:
  `git worktree add --detach /tmp/cli-build origin/main && (cd /tmp/cli-build && go build -o civitai ./cmd/civitai)`
- 🔴 **A leftover vite from a previous session was holding port 5186**, serving pre-change
  code while reporting healthy. Check `ss -lntp | grep 5186` and kill by RESOLVED pid.

## The tools gap — why submission is on hold

The `chat-completion` step has **no tool/function-calling surface at all**, and this is
structural, not an oversight:

1. `chatCompletionParamsSchema` is `.strict()` — `tools`/`tool_choice` are `BAD_REQUEST`.
2. `chatMessageSchema` has no `'tool'` role and no `tool_call_id` — a result cannot
   round-trip, so even client-side emulation cannot use the documented message shape.
3. `extractText` deliberately does not read `message.tool_calls[]`, and a `'textOutput'`
   entry has no `extractOutput` to carry one.

So Sensei's catalog search, model lookup, image search and NSFW delegate cannot work
through this bridge. **Decision: hold submission and ask the host for tool support** rather
than ship a chat-only app or fake tools client-side.

Filed: **civitai/civitai#3637** — lays out the three blockers plus the four policy
questions the owners have to settle (scanning `tool_calls[].arguments`; widening the
`urn:air:` scan to tool names/descriptions/schemas; bounding `tools` as unpriced prefill;
what multi-round Buzz cost means for `buzzBudgetPerGen`).

The tool loop is **retained** in `App.tsx` pending that. Until it lands, the model will
claim catalog access it does not have — the reason the app is not submitted.

## The xGuard guard (#3609) — substantively closed, one residual

The old doc called the guard "derived from a type definition", implying it might be inert.
It is derived from **orchestration source**, and every cited claim is now verified against
`civitai-orchestration@origin/main`:

- `XGuardScoring.cs:226-230` — `Error` is a three-way switch: `"Step output was missing."` /
  `"Step completed without output choices."` / `null`. Healthy path is `null`, never `''`.
- `XGuardScoring.cs:357-360` — `ParseScore` returns `(0, "")` on an unreadable blob, so an
  errored label arrives `triggered: false`. **The guard is reachable, not inert.**
- `XGuardModerationModels.cs:51/64` — `ModelReason` is `required string` (hence `""`),
  `Error` is `string?` (hence `null`). The empty-string loosening is defence, not necessity.
- `XGuardModerationHandler.cs:165-183` — one `XGuardLabelResult` per resolved label with a
  synthesized fallback, so treating a populated `error` as a withhold cannot degenerate
  into withholding everything.
- Same file, `:174-180` — the max-score selection (`result.Score > bestResult.Score`) that
  discards a failed segment. This is the upstream masking path; it is real and unfixable
  host-side.

`FinishReason = choice?.FinishReason` is assigned on **every** path, healthy or not, which
confirms it cannot be read by presence.

**Residual (still open):** whether the DEPLOYED orchestrator build matches this source. Not
reachable from the block — an errored label and a policy hit produce the identical generic
message. It needs one direct call, which requires an orchestrator bearer token I could not
mint:

```
POST {{host}}/v2/consumer/workflows?wait=60
Authorization: Bearer {{accessToken}}
{"steps":[{"$type":"xGuardModeration","input":{"mode":"text","text":"A story of a cat",
  "labels":["Young","NSFW", ...TEXT_OUTPUT_SCAN_LABELS, "__BOGUS_CONTROL__"]}}]}
```
Expect 15 entries `triggered:false`; the bogus label ABSENT (positive control — without it,
"15 came back" cannot distinguish a scanner that echoes whatever it is handed). Read
`error` and `finishReason` on the same response.

## Dogfooding, repeatably

`window.__senseiDogfood.send(text[, model])` returns the real adapter's promise inside a
dev tunnel. `import.meta.env.DEV`-guarded; verified absent from the production bundle (0
occurrences against a positive control greping 2).

```bash
SENSEI=/home/zach/workspace/civit/civitai-app-sensei
# term 1
(cd "$SENSEI" && npm run dev:tunnel)          # 127.0.0.1:5186 — check nothing else holds it
# term 2 — needs a CLI rebuilt from origin/main (see Corrections)
(cd "$SENSEI" && /tmp/cli-build/civitai app dev-tunnel)
# then open https://civitai.com/apps/dev/sensei and, in the block frame:
#   window.__senseiDogfood.send("...").then(console.log).catch(console.log)
```

## Next steps (ranked)

1. **Chase civitai/civitai#3637.** It gates the tool loop, which gates submission.
2. **Probe the deployed xGuard build** (call above) — needs an orchestrator token.
3. **Merge PR #1.** The bridge is correct and verified independently of the tools question;
   leaving it unmerged just re-accumulates drift.
4. **Convert the long-poll to host-push** — `watch()` is in `blocks-react` 0.39.0, now
   pinned. One line per host file.
5. **Decide the fallback** if #3637 is declined: chat-only (drop the loop, rewrite the
   system prompt, keep the Research panel, expose Dolphin as a model choice) vs client-side
   emulation at 2+ Buzz per answer.

## Gotchas

- **Pins: a caret on `0.x` will NOT cross a minor.** `@civitai/app-sdk` was pinned EXACT at
  `0.30.0`; `blocks-react` at `^0.37.0` could never reach the published 0.39.0. Worse,
  0.37.0 peers on `app-sdk ^0.28.0`, which cannot accept 0.31.0 — **npm was silently
  overriding the peer conflict**. 0.38.0+ widened the range. Now `^0.31.0` / `^0.39.0`.
- **`textOutputs` / `textOutputWithheld` are NOT in the SDK 0.31.0 types.** The host sends
  them and the transport resolves the raw payload verbatim (`iframeTransport.js` →
  `pending.resolve(payload)`, no validation, no key-stripping), so they arrive at runtime.
  The snapshot type is widened locally in `orchestrator-bridge.ts`; delete that when the
  SDK catches up.
- **The submit reply never carries `textOutputs`** — the step submit passes no `wait`, and
  only the POLL is wrapped in `attachModeratedStepTextOutputs`. At least one poll is
  mandatory even if submit already reports terminal.
- **The old test suite was green against a bridge that could not work.** Fixtures returned
  `{content}` / `{steps:[{output:{text}}]}` / `{tool_calls}` — shapes the host never sends —
  so the fakes encoded the same wrong shape as the code and nothing could go red. The
  rewrite was verified red→green: **34 of the new assertions fail at `b78b85e`**, including
  both e2e branches. For fake-tested code, contract fidelity against the real schema is the
  load-bearing property; a green suite is not.
- **civitai deploys from `release`, not `main`.** Checked: the step, the moderation module
  and the wire schema are byte-identical on both, and #3609's `error` read is on `release`.
- 🔴 `civitai/civitai` is **PUBLIC** — no infra internals in issues, PRs or code.
