// GUARD: The host has not yet enabled chatCompletion for block apps.
//
// What has shipped / is shipping:
// - civitai/civitai#3538 adds kind: 'step' to blockWorkflowBodySchema
//   with a step-type registry. This is scaffolding, not the chat feature.
// - Registry entries declare billingMode: timeBounded | prepaidFixed | tokenMetered.
//   chatCompletion is tokenMetered — cost scales with tokens, not wall-clock.
//
// What is NOT shipped (the actual blockers):
// 1. tokenMetered budget model — declared in types but has no money-path
//    handler; an entry declaring it fails at registry load.
// 2. Moderation posture for text output — a content-policy decision, not a
//    design decision. Steps with free-text output need a posture the existing
//    negativePrompt hook doesn't cover.
// 3. snapshotFromWorkflow must derive content/tool_calls/usage from the
//    chatCompletion step output (not submit-time extras, per #3535).
//    Source: steps[0].output.choices[0].message.{content,tool_calls}
//
// When all three land, flip HOST_READY to true.
//
// To test: try sending a message. If you see "HOST_NOT_READY" in the
// error, the host hasn't shipped chatCompletion support yet.
export const HOST_READY = false; // Flip to true when #3527 ships on the host
