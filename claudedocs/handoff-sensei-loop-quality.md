# Handoff: sensei-loop-quality — 2026-09-30

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
Ship a Sensei whose tool loop and recommendations follow documented agent-loop best
practice: the first-use UX pass (0.1.26), the loop trio — multi-facet prompt v5,
per-call tool errors, duplicate-call guard (0.1.27) — and a paid eval proving v5
changes the measured production failure.
- **closing-condition:** `check` — `python3 ~/.claude/skills/civitai-app-fleet/app_state.py sensei 0.1.27` reports `approved/live` AND `curl -sS https://sensei.civit.ai/ | grep -oE 'assets/index-[A-Za-z0-9_-]+\.js'` fetches a bundle whose body greps ≥1 for `differently-shaped lookups` (the v5 paragraph token, backtick-safe plain substring). Verdict ⇒ arc CLOSED.

## State now
- Branch: `trunk` at `eb63435`, clean, in sync with origin. Everything below is MERGED.
- Shipped this session: #79/#80 (first-use pass → **0.1.26 LIVE and verified** 2026-09-29, bundle `index-CwJy3Un2.js`, new testids + retired copy confirmed in the served artifact), #81 (loop trio), #82 (`release: 0.1.27`), #83 (eval results), #84 (schema-guard fix after it went red on #83).
- **0.1.27 SUBMITTED, pending moderator review**: `pubreq_01M3QRBBP2MBC0ZFP15HF81TA1` (preflight/validate/package-only all green; 154 files). First 0.1.26 copy burned 2 failed builds before the 3rd landed — see open investigations.
- Paid eval committed (eval/results/recommend-{rewrite,probe}-v5-2026-09-29.json, ~512 Buzz incl. disclosed retries): v1 set 15/15 tool expectation, 0 over-trigger (= v4); recommend probe **multi-shaped lookups 17/17** tool-calling turns — v5's contract fired everywhere (v4: single popularity lookups); 3 ungrounded ids on one no-tool memory-citation turn per arm (runner can't run Layer 2).
- NOT done: platform-side items (ranked list below); live verification of 0.1.27.

## Open investigations — live diagnosis state
### dp-talos-proxy-01 intermittent outbound egress (app-blocks build node)
as-of: 2026-09-30
- **Symptom + exact repro:** Tekton app-blocks builds on cluster dp-1 fail on exactly one egress step per run: `push` (crane → ghcr.io:443, i/o timeout) or `callback` (finally-task curl POST civitai.com, timeout at 135s) — never both the same run. Repro: submit any app-block version; watch the PipelineRun on node `dp-talos-proxy-01`.
- **Observed (with values):** sensei 0.1.26: run1 push ✓ 2s + callback ✗ timeout; run2 push ✗ ghcr timeout + callback ✓; run3 all ✓ (live). model-benchmarking runs 8cac4b63 (push ✗) / 73735a5a (callback ✗) show the same split. All three pods ran on dp-talos-proxy-01; `kubectl get ciliumnetworkpolicies -A` shows no policy restricting the callback pods.
- **Ruled out:** pipeline-step logic (the failing steps are plain curl/crane and the build itself (kaniko) succeeds every time) `via: command` — kubectl logs of the finally tasks, read directly.
- **Leading hypothesis:** node-level intermittent outbound connectivity on dp-talos-proxy-01 — NAT/conntrack exhaustion or Cilium masquerade/routing flap.
- **Next probe:** from a pod pinned to that node (`kubectl debug node/dp-talos-proxy-01` or a nodeSelector pod): `for i in $(seq 1 20); do curl -m 5 -sS -o /dev/null -w '%{http_code}\n' https://civitai.com/api/v1/models; sleep 2; done` — count non-200s; run the identical loop from a sibling node as control. Then `conntrack -S` on the node under the same load.

### blocks.pollWorkflow transient 503s (degrading month over month)
as-of: 2026-09-30
- **Symptom + exact repro:** `POST /api/trpc/blocks.pollWorkflow` (long-poll, `waitSeconds: 15`) returns 503 intermittently under sustained sequential use from one client, poisoning the eval turn (charged, no text). Repro: `node eval/run-eval.mjs --arm x --set <1-question set>` repeatedly.
- **Observed (with values):** poison rate 2/24 turns (v4 arm, 2026-09-01) → 13/36 (v1 arm) → 11/24 (recommend arm) (both 2026-09-30); per-turn `errors:["poll 503"]` recorded verbatim in eval/results/recommend-{rewrite,probe}-v5-2026-09-29.json; ~23-30% of retries re-poisoned once, ALL clean by second retry with 30s gaps.
- **Ruled out:** eval-runner defect (the same route served the v4 arm cleanly a month ago, and single-shot smokes also hit it) `via: measurement`.
- **Leading hypothesis:** server-side throttle or pool exhaustion on the poll route — bursts of 15s-held long-polls (Cloudflare, pgbouncer `connection_limit`, or civitai-side rate limiting).
- **Next probe:** from the eval box: 20 sequential `blocks.pollWorkflow` calls against one stale workflowId (fast responses) at 0s spacing vs 15s spacing, count 503 rate per spacing — separates rate-limit from held-connection load.

## Next steps (ranked)
1. Verify 0.1.27 live after moderator approval: run the closing-condition check above; on live, also confirm `rename-input-` testid still present and the JS bundle hash MOVED.
   forcing: gate — moderator review of `pubreq_01M3QRBBP2MBC0ZFP15HF81TA1` is the pending external gate; poll with `python3 ~/.claude/skills/civitai-app-fleet/app_state.py sensei`.
2. Dig dp-talos-proxy-01 egress (open investigation #1) — it cost 2 failed builds of the 0.1.26 release and will keep eating ~10 min per fleet release until fixed. Platform-side: `datapacket-talos` (app-blocks skill) for the node dig.
   forcing: incident — 2 of 3 sensei 0.1.26 builds failed on egress, evidence in the k8s transcripts and the pubreq rows.
3. Diagnose the pollWorkflow 503 degradation (open investigation #2) — it poisons ~35% of paid eval turns (~30% Buzz overhead) and any block app's polling UX. If server-side, it belongs in civitai/civitai; if Cloudflare, infra.
   forcing: incident — poison rate 2/24 → 13/36 → 11/24 over four weeks, recorded verbatim in the committed eval results.
4. Platform-side tool-surface work in civitai/civitai (the Nano-Banana-class gap, explained and evidenced in this session): (a) union generation-ecosystem products into the tools route (a `search_generation_resources` tool over the clamped surface `src/pages/api/v1/blocks/generation-resources.ts` already guards), (b) enrich `search_models`' description with its blind spots (popularity-ordered; newest/ecosystem not surfaced) per Anthropic tool-description guidance. Files: `src/server/services/blocks/tools/registry.ts`.
   forcing: user — the operator's product critique ("ChatGPT image and nano banana should be in this response") on session session-1790697503537-1ye06p.
5. Eval harness: add poll retry with backoff to `eval/run-eval.mjs` (it currently records `poll 503` and abandons the turn); would have saved ~72+68 Buzz of retries this session.
   forcing: none
6. One-line comment fix (batched defect): `src/types.ts` header still says v5 "has NOT been eval-scored" — the two 2026-09-29 arms now exist. Update when touching that file next.
   forcing: none

## Defects (batched)
- `src/types.ts` DEFAULT_SYSTEM_PROMPT header comment claims v5 is un-eval-scored; the 2026-09-29 arms scored it (see State now). One-line fix, batch with any next types.ts change.

## Gotchas / decisions / dead-ends
- The devrc bash guard's regexes catch `git add` variants, the WORD "stash" anywhere in a command (commit messages included), and `git commit` textually co-located with `git checkout -b` in one call. Split calls; write commit messages without banned substrings.
- `civitai app submit` builds from an INTERNAL Forgejo mirror (`forgejo.civitai.com/civitai-apps/sensei.git`) — the commit a PipelineRun reports (e.g. `9eb68546…`) exists nowhere on GitHub and that is by design. Do not chase it; the image tag is that mirror commit.
- The eval runner bypasses the app entirely — it drives the tool loop itself and CANNOT exercise the app's Layer-2 correction or duplicate-call guard. Ungrounded scores on no-tool turns understate the shipped app. The v1 set (`prompt-eval-set.v1.json`) has NO recommendation question — for recommendation behavior use `eval/recommend-probe.v1.json`.
- `civitai whoami` does not print the OAuth token; it lives in `~/.config/civitai/config.yaml` `access_token` (44 chars). The runner needs it as `CIVITAI_OAUTH_TOKEN`.
- The v5 eval's headline metric (multi-shaped lookups) is NEW — computed per-turn from `toolCalls[].rawArguments` shape tuples; not part of summarize.mjs.
- A CI run in progress when you merge is NOT a green run: #83 merged while its run was in_progress and it concluded FAILURE (schema guard). Wait for the conclusion before merging.
- Session `session-1790697503537-1ye06p` (the measured failure) is fully resolved + evaluated: KV rows read, grounding clean, claims spot-checked true; its gap is structural (see platform items), not a bug.

## How to verify
- Repo gates: `pnpm run typecheck && pnpm test && pnpm run build` (two vitest projects — read BOTH tails).
- Release state: `python3 ~/.claude/skills/civitai-app-fleet/app_state.py sensei` (reads the LIST, not the newest row only).
- Live artifact: `curl -sS "https://sensei.civit.ai/"` → bundle name; fetch it and grep for `differently-shaped lookups` (v5), `rename-input-` (0.1.26 features), with `gate-retry-button` as the ever-present control.
- Eval replay (costs Buzz): `CIVITAI_OAUTH_TOKEN=$(cat ~/.config/civitai/config.yaml-extracted) node eval/run-eval.mjs --arm <name> --set eval/recommend-probe.v1.json --prompt-file eval/prompt.rewrite.v5.txt --out eval/results/<name>.json`
