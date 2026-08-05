import type { ChatCompletionRequest, ChatCompletionResponse } from './completion-types.js';
import { createBridgeAdapter, type WorkflowHelpers } from './orchestrator-bridge.js';

export interface OrchestratorAdapter {
  submitChatCompletion(
    request: ChatCompletionRequest,
    onChunk?: (chunk: string) => void,
    signal?: AbortSignal,
  ): Promise<ChatCompletionResponse>;
  cancel?(workflowId?: string): Promise<void>;
}

/**
 * Create an orchestrator adapter over the host's `useBuzzWorkflow` helpers.
 *
 * 🔴 THERE IS NO STUB FALLBACK ANY MORE, AND THAT IS THE POINT. The previous
 * `createOrchestrator(workflow?)` returned a canned-response stub when the
 * helpers were absent — but `useBuzzWorkflow()` always returns them, so the
 * fallback was unreachable in the app while remaining the ONLY path the tests
 * exercised. The result was a "Stub Mode" badge that could never light and a
 * bridge nothing executed. Requiring the helpers makes the real path the only
 * path; tests inject a fake `WorkflowHelpers` instead of a whole fake adapter,
 * so what they exercise is the body-building and snapshot-reading code that
 * actually ships.
 */
export function createOrchestrator(workflow: WorkflowHelpers): OrchestratorAdapter {
  return createBridgeAdapter(workflow);
}
