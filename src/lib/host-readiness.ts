// GUARD: The host has not yet enabled chatCompletion for block apps.
//
// What has shipped:
// - civitai/civitai#3538: kind: 'step' registry, extractOutput per entry
// - chatCompletion is prepaidFixed at 1 Buzz (measured, flat rate)
// - Host needs moderationPosture: 'input-audit' implemented (small:
//   wire auditPromptServer into a new posture value)
//
// When the host ships the moderation posture, flip HOST_READY to true.
// The NSFW model (dolphin-mistral-24b-venice-edition) is intentionally
// excluded from the initial allowlist — it requires a separate, harder
// content-policy decision about NSFW-tuned models with no output moderation.
export const HOST_READY = false;
