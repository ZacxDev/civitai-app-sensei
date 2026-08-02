// GUARD: The host's blockWorkflowBodySchema currently only accepts
// kind: 'textToImage' | 'customComfy'. kind: 'step' (chatCompletion)
// will be rejected by the host's Zod validation until civitai/civitai#3527
// ships and the host deploys the updated schema. When that happens,
// remove this guard and this module.
//
// Host-side implementation notes (from #3527 discussion):
// 1. blockWorkflowBodySchema needs a new kind: 'step' member with
//    step: 'chatCompletion' and params: { model, messages, max_tokens, ... }
// 2. BlockWorkflowSnapshot must derive content/tool_calls/usage inside
//    snapshotFromWorkflow — NOT as submit-time extras (they vanish on poll).
//    Source: steps[0].output.choices[0].message.{content,tool_calls}
// 3. Model allowlist needed for prepaidFixed ceiling computation
//
// To test: try sending a message. If you see "HOST_NOT_READY" in the
// error, the host hasn't shipped chatCompletion support yet.
export const HOST_READY = false; // Flip to true when #3527 ships on the host
