import type { ChatCompletionRequest, ChatCompletionResponse, ToolCall } from './completion-types.js';
import type { OrchestratorAdapter } from './orchestrator.js';
import { simulateStreaming } from './streaming.js';
import { buildWorkflowBody } from '@civitai/app-sdk';
import type { WorkflowBody, BlockWorkflowSnapshot } from '@civitai/app-sdk/blocks';

export type { ChatCompletionRequest, ChatCompletionResponse, ToolCall } from './completion-types.js';

/** The subset of useBuzzWorkflow's return we need. */
export interface WorkflowHelpers {
  estimate: (body: WorkflowBody) => Promise<BlockWorkflowSnapshot>;
  submit: (body: WorkflowBody) => Promise<BlockWorkflowSnapshot>;
  poll: (workflowId: string) => Promise<BlockWorkflowSnapshot>;
}

const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 60_000;

interface ChatCompletionSnapshot extends BlockWorkflowSnapshot {
  steps?: Array<{ output?: { text?: string; content?: string; tool_calls?: ToolCall[] } }>;
  content?: string;
  text?: string;
  tool_calls?: ToolCall[];
}

function extractContent(snap: ChatCompletionSnapshot): string {
  if (snap.steps?.[0]?.output?.text) return String(snap.steps[0].output.text);
  if (snap.steps?.[0]?.output?.content) return String(snap.steps[0].output.content);
  if (typeof snap.content === 'string') return snap.content;
  if (typeof snap.text === 'string') return snap.text;
  return '';
}

function extractToolCalls(snap: ChatCompletionSnapshot): ToolCall[] | undefined {
  const tc = snap.steps?.[0]?.output?.tool_calls ?? snap.tool_calls;
  if (Array.isArray(tc) && tc.length > 0) return tc;
  return undefined;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Create a bridge adapter that uses the host-mediated useBuzzWorkflow helpers
 * to communicate with the orchestrator via postMessage.
 */
export function createBridgeAdapter(workflow: WorkflowHelpers): OrchestratorAdapter {
  return {
    async submitChatCompletion(
      request: ChatCompletionRequest,
      onChunk?: (chunk: string) => void,
    ): Promise<ChatCompletionResponse> {
      const body = buildWorkflowBody({
        $type: 'chatCompletion',
        name: 'chat',
        input: {
          model: request.model,
          messages: request.messages,
          tools: request.tools,
          tool_choice: request.tool_choice,
          temperature: request.temperature,
          max_tokens: request.max_tokens,
          response_format: request.response_format,
        },
      }) as WorkflowBody;

      const estimateSnap = await workflow.estimate(body);
      const cost = estimateSnap.cost?.total ?? 0;

      if (cost <= 0) {
        throw new Error('Workflow estimate returned zero or missing cost');
      }

      const submitSnap = await workflow.submit(body);
      const workflowId = submitSnap.workflowId;

      if (!workflowId) {
        throw new Error('Workflow submit did not return a workflowId');
      }

      const deadline = Date.now() + POLL_TIMEOUT_MS;
      let snap: ChatCompletionSnapshot = submitSnap;

      while (Date.now() < deadline) {
        snap = await workflow.poll(workflowId);
        if (snap.status === 'succeeded' || snap.status === 'failed' || snap.status === 'expired' || snap.status === 'canceled') {
          break;
        }
        await delay(POLL_INTERVAL_MS);
      }

      const finalStatus = snap.status;
      if (finalStatus !== 'succeeded') {
        const errorMsg = typeof snap.error === 'string' ? snap.error : `Workflow ${finalStatus}`;
        throw new Error(errorMsg);
      }

      const content = extractContent(snap);
      const toolCalls = extractToolCalls(snap);

      if (onChunk && content) {
        await simulateStreaming(content, onChunk);
      }

      const promptTokens = request.messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
      const completionTokens = estimateTokens(content);

      return {
        id: workflowId,
        choices: [{
          index: 0,
          message: { role: 'assistant', content, tool_calls: toolCalls },
          finish_reason: toolCalls ? 'tool_calls' : 'stop',
        }],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
        },
      };
    },
  };
}
