// GUARD: The host has not yet enabled chatCompletion for block apps.
//
// What has shipped:
// - civitai/civitai#3538: kind: 'step' registry, extractOutput per entry
// - chatCompletion is registered `prepaidFixed`. 🔴 THAT IS NOT A FLAT RATE:
//   the platform reprices these models from the provider's live per-token rate,
//   so the charge moves with the model AND `maxTokens` (measured 2026-08-27:
//   2-4 Buzz across the three allowed models). See `lib/models.ts`.
// - Token maturity ceiling already handles SFW/Mature gating (red-capable
//   hosts get mature ceiling; SFW hosts get SFW; fail-closed to SFW)
//
// What we need from the host:
// - moderationPosture: 'input-audit' implemented (host-side, inside the
//   step handler, before orchestrator submission — wires auditPromptServer)
//
// Both models go through the bridge:
// - Main agent: deepseek/deepseek-chat (SFW ceiling)
// - NSFW delegate: dolphin-mistral-24b-venice-edition (mature ceiling
//   via red-capable host token)
//
// When the host ships the moderation posture, flip HOST_READY to true.
export const HOST_READY = true;
