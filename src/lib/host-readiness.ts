// GUARD: The host has not yet enabled chatCompletion for block apps.
//
// What has shipped:
// - civitai/civitai#3538: kind: 'step' registry, extractOutput per entry
// - chatCompletion is prepaidFixed at 1 Buzz (measured, flat rate)
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
export const HOST_READY = false;
