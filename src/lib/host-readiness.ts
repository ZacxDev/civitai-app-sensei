// GUARD: The host has not yet enabled chatCompletion for block apps.
//
// What has shipped (civitai/civitai#3538, merged to main):
// - kind: 'step' in blockWorkflowBodySchema with step-type registry
// - extractOutput(step) required per entry, enforced at registry load
// - Both snapshotFromWorkflow and projectAppWorkflow consult the registry
//
// What is NOT shipped (the remaining blockers):
// 1. tokenMetered budget model — declared in registry types but has no
//    money-path handler; an entry declaring it fails at registry load.
// 2. Moderation posture for text output — a content-policy decision, not a
//    design decision. Steps with free-text output need a posture the existing
//    negativePrompt hook doesn't cover.
//
// When registering chatCompletion, anchor extractOutput against the generated
// ChatCompletionStep type from @civitai/client — NOT a hand-written shape.
// The load-time probe validates self-consistency of the entry's own sample,
// so it can pass while extraction is wrong about what the orchestrator returns.
//
// When both blockers land, flip HOST_READY to true.
export const HOST_READY = false;
