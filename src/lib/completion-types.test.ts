import { describe, it, expectTypeOf } from 'vitest';
import type { ChatCompletionRequest, ChatCompletionResponse } from './completion-types.js';

describe('completion-types', () => {
  it('ChatCompletionRequest is exported', () => {
    expectTypeOf<ChatCompletionRequest>().toMatchTypeOf<{
      model: string;
      messages: Array<{ role: string; content: string }>;
    }>();
  });

  it('ChatCompletionResponse is exported', () => {
    expectTypeOf<ChatCompletionResponse>().toMatchTypeOf<{
      id: string;
      choices: Array<{
        index: number;
        message: { role: string; content: string };
        finish_reason: string;
      }>;
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    }>();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 🔴 THESE ARE THE `.strict()` BLOCKERS, PINNED AT THE TYPE LEVEL.
  //
  // `chatCompletionParamsSchema` is `.strict()`, so any key it does not name is
  // a BAD_REQUEST for the WHOLE request. Making a rejected key INEXPRESSIBLE
  // turns a runtime failure — which costs a round trip and surfaces generically
  // — into a compile error at the call site.
  //
  // ⚠️ THE ACCEPTED SET GREW, AND THIS COMMENT USED TO SAY IT COULD NOT. It
  // read "`.strict()` over exactly `{ model, messages, maxTokens, temperature }`
  // and `chatMessageSchema` has no `'tool'` role and no `tool_call_id`". That
  // was true when written and is now false: the host added `tools`,
  // `tool_choice`, a `'tool'` role and `tool_call_id`. The pins below are the
  // NEW boundary — they still fail on a key the host does not accept.
  //
  // `toMatchTypeOf` is deliberately NOT used here: it is structural and would
  // pass for a type that merely happens to be assignable. `keyof` enumerates
  // the actual members, so a re-added key fails this test.
  // ───────────────────────────────────────────────────────────────────────────
  it('ChatCompletionRequest cannot express a param the host rejects', () => {
    expectTypeOf<keyof ChatCompletionRequest>().toEqualTypeOf<
      'model' | 'messages' | 'max_tokens' | 'temperature' | 'tools' | 'toolChoice'
    >();
  });

  it('a request message carries exactly the tool-correlation fields, and no more', () => {
    // `tool_call_id` and `tool_calls` are now EXPRESSIBLE because the host
    // accepts them — this pin's job changed from forbidding them to bounding
    // the set they joined.
    expectTypeOf<keyof ChatCompletionRequest['messages'][number]>().toEqualTypeOf<
      'role' | 'content' | 'tool_call_id' | 'tool_calls'
    >();
  });

  it('a response message cannot carry tool_calls', () => {
    // No `extractOutput` is permitted on a 'textOutput' posture entry, so there
    // is no channel a tool call could arrive on. A declared-but-never-populated
    // field reads as a capability; it is a dead branch.
    expectTypeOf<
      keyof ChatCompletionResponse['choices'][number]['message']
    >().toEqualTypeOf<'role' | 'content'>();
  });
});
