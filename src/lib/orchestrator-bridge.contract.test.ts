import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createBridgeAdapter,
  buildChatCompletionBody,
  toStepMessages,
  extractReleasedText,
  TextOutputWithheldError,
  MAX_OUTPUT_TOKENS,
  type WorkflowHelpers,
} from './orchestrator-bridge.js';
import { HOST_READY } from './host-readiness.js';

// ─────────────────────────────────────────────────────────────────────────────
// The lifecycle half of the bridge contract.
//
// `orchestrator-bridge.test.ts` pins the WIRE BODY and the HAPPY READ — the
// shapes the host accepts and the one channel it releases text on. This file
// pins what happens around them: abort, cancel, the money gate, the poll
// deadline, and the coercions whose edges decide whether a value reaches the
// host at all.
//
// 🔴 SAME FIXTURE DISCIPLINE, AND FOR THE SAME REASON. Released text arrives
// ONLY on `textOutputs`, a withhold ONLY on `textOutputWithheld`, every model is
// on the real allowlist, and every status string is one the host actually sends
// (`pending` / `processing` / `succeeded` / `failed` / `expired` / `canceled`).
// The suite this replaced was green against a bridge that could not work,
// because its fakes encoded the same wrong shape as the code. A fixture the host
// schema cannot produce makes a test worse than absent.
// ─────────────────────────────────────────────────────────────────────────────

const MODEL = 'deepseek/deepseek-chat';
const ONE_MESSAGE = [{ role: 'user', content: 'hi' }];

function succeededSnapshot(texts: string[]) {
  return { status: 'succeeded', textOutputs: texts };
}

function mockWorkflowHelpers(overrides?: Partial<WorkflowHelpers>): WorkflowHelpers {
  return {
    estimate: vi.fn().mockResolvedValue({ cost: { total: 1 } }),
    submit: vi.fn().mockResolvedValue({ workflowId: 'wf-1', status: 'pending' }),
    poll: vi.fn().mockResolvedValue(succeededSnapshot(['Hello from the bridge!'])),
    cancel: vi.fn().mockResolvedValue({ status: 'canceled' }),
    ...overrides,
  } as WorkflowHelpers;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('orchestrator-bridge — lifecycle contract', () => {
  describe('abort', () => {
    it('throws before reaching the host when the signal is already aborted', async () => {
      const helpers = mockWorkflowHelpers();
      const adapter = createBridgeAdapter(helpers);

      await expect(
        adapter.submitChatCompletion(
          { model: MODEL, messages: ONE_MESSAGE },
          undefined,
          AbortSignal.abort(),
        ),
      ).rejects.toThrow('Aborted');

      // The abort is checked at the TOP of the poll loop, so an already-aborted
      // call must never poll. (estimate/submit have already run by then — the
      // Buzz is committed at submit, which is why the stop button also cancels
      // server-side; see the cancel block below.)
      expect(helpers.poll).not.toHaveBeenCalled();
    });

    it('stops polling once the signal aborts mid-generation', async () => {
      vi.useFakeTimers();
      const controller = new AbortController();
      // The user hits stop while the workflow is still processing.
      const poll = vi.fn().mockImplementation(async () => {
        controller.abort();
        return { status: 'processing' };
      });
      const adapter = createBridgeAdapter(mockWorkflowHelpers({ poll }));

      const pending = adapter.submitChatCompletion(
        { model: MODEL, messages: ONE_MESSAGE },
        undefined,
        controller.signal,
      );
      const settled = expect(pending).rejects.toThrow('Aborted');
      await vi.advanceTimersByTimeAsync(1000);
      await settled;

      // It polled once, then the next loop entry saw the abort — it did not keep
      // polling to the 60s deadline.
      expect(poll).toHaveBeenCalledTimes(1);
    });

    it('CONTROL: a signal that never aborts completes normally', async () => {
      // 🔴 The control arm for the two tests above. Without it, "it threw" is not
      // attributable to the SIGNAL — a bridge that threw on any supplied signal
      // would pass both abort tests. This is the arm that must stay green.
      const controller = new AbortController();
      const adapter = createBridgeAdapter(mockWorkflowHelpers());

      const result = await adapter.submitChatCompletion(
        { model: MODEL, messages: ONE_MESSAGE },
        undefined,
        controller.signal,
      );

      expect(result.choices[0].message.content).toBe('Hello from the bridge!');
    });
  });

  describe('server-side cancel', () => {
    it('cancels the id it is given, in preference to the remembered one', async () => {
      const helpers = mockWorkflowHelpers();
      const adapter = createBridgeAdapter(helpers);
      await adapter.submitChatCompletion({ model: MODEL, messages: ONE_MESSAGE });

      await adapter.cancel?.('wf-explicit');

      expect(helpers.cancel).toHaveBeenCalledWith('wf-explicit');
      expect(helpers.cancel).not.toHaveBeenCalledWith('wf-1');
    });

    it('does not call the host when there is no workflow to cancel', async () => {
      // A stop pressed before anything was submitted must not send a cancel for
      // `undefined` — the host would reject it, and the error would surface as a
      // failure of a user action that actually succeeded in doing nothing.
      const helpers = mockWorkflowHelpers();
      const adapter = createBridgeAdapter(helpers);

      await adapter.cancel?.();

      expect(helpers.cancel).not.toHaveBeenCalled();
    });

    it('forgets the workflow after cancelling it, so a second cancel is a no-op', async () => {
      const helpers = mockWorkflowHelpers();
      const adapter = createBridgeAdapter(helpers);
      await adapter.submitChatCompletion({ model: MODEL, messages: ONE_MESSAGE });

      await adapter.cancel?.();
      await adapter.cancel?.();

      // Not twice: the second press has nothing left to cancel.
      expect(helpers.cancel).toHaveBeenCalledTimes(1);
      expect(helpers.cancel).toHaveBeenCalledWith('wf-1');
    });

    it('surfaces a canceled workflow as an error, not as an empty reply', async () => {
      // `canceled` is a terminal status that breaks the poll loop — it must then
      // be reported as the cancel it was, not mislabelled "empty response".
      const poll = vi.fn().mockResolvedValue({ status: 'canceled' });
      const adapter = createBridgeAdapter(mockWorkflowHelpers({ poll }));

      await expect(
        adapter.submitChatCompletion({ model: MODEL, messages: ONE_MESSAGE }),
      ).rejects.toThrow('Workflow canceled');
    });
  });

  describe('the money gate is fail-closed', () => {
    it('does NOT submit when the estimate comes back at zero cost', async () => {
      // The throw is already pinned elsewhere; what matters here is that no
      // workflow is CREATED — a submit is what spends the viewer's Buzz.
      const estimate = vi.fn().mockResolvedValue({ cost: { total: 0 } });
      const helpers = mockWorkflowHelpers({ estimate });
      const adapter = createBridgeAdapter(helpers);

      await expect(
        adapter.submitChatCompletion({ model: MODEL, messages: ONE_MESSAGE }),
      ).rejects.toThrow(/zero or missing cost/i);

      expect(helpers.submit).not.toHaveBeenCalled();
    });

    it('does NOT submit when the estimate carries no cost at all', async () => {
      // A snapshot with no `cost` object is the shape a failed estimate returns.
      // It must read as zero, not as "unknown, proceed anyway".
      const estimate = vi.fn().mockResolvedValue({ status: 'pending' });
      const helpers = mockWorkflowHelpers({ estimate });
      const adapter = createBridgeAdapter(helpers);

      await expect(
        adapter.submitChatCompletion({ model: MODEL, messages: ONE_MESSAGE }),
      ).rejects.toThrow(/zero or missing cost/i);

      expect(helpers.submit).not.toHaveBeenCalled();
    });
  });

  describe('a withheld reply', () => {
    it('streams nothing through onChunk, even when a sibling step released text', async () => {
      // 🔴 The reason the withhold check sits BEFORE the streaming replay. Text
      // the host refused to release must not reach the UI one word at a time.
      //
      // 🔴 THE SIBLING TEXT IS LOAD-BEARING IN THIS FIXTURE, not decoration. With
      // a bare withhold there is nothing to stream — `simulateStreaming` returns
      // immediately on empty text — so the test passed even with the withhold
      // check moved AFTER the replay. It was green for the wrong reason and
      // could not have caught the leak it exists to catch. A withhold arriving
      // alongside a released sibling is a real host shape (the workflow may
      // carry more than one text step), and it is the only shape where the
      // ordering is observable.
      const poll = vi.fn().mockResolvedValue({
        status: 'succeeded',
        textOutputs: ['text a sibling step released'],
        textOutputWithheld: { reason: 'withheld by policy' },
      });
      const adapter = createBridgeAdapter(mockWorkflowHelpers({ poll }));
      const onChunk = vi.fn();

      await expect(
        adapter.submitChatCompletion({ model: MODEL, messages: ONE_MESSAGE }, onChunk),
      ).rejects.toBeInstanceOf(TextOutputWithheldError);

      expect(onChunk).not.toHaveBeenCalled();
    });
  });

  describe('reading textOutputs', () => {
    it('drops blank and non-string entries rather than joining them in', () => {
      // The host releases per-step; a step that released nothing contributes an
      // empty entry, which must not become leading/trailing blank paragraphs.
      expect(
        extractReleasedText({ textOutputs: ['first', '', '   ', 'second'] } as never),
      ).toBe('first\n\nsecond');
      expect(extractReleasedText({ textOutputs: [null, 'only real', 42] } as never)).toBe(
        'only real',
      );
    });

    it('INVARIANT GUARD: reads an empty textOutputs array as no text', () => {
      // 🔴 LABELLED, BECAUSE IT IS NOT REGRESSION COVERAGE. The `texts.length === 0`
      // clause in `extractReleasedText` is REDUNDANT — `[].filter(…).join('\n\n')`
      // is already `''` — so deleting that clause leaves this test green. It was
      // mutation-checked and the mutant SURVIVED. What it does pin is the
      // OBSERVABLE contract (an empty release reads as no text) against a future
      // rewrite of the function body; it does not defend the early return.
      expect(extractReleasedText({ textOutputs: [] } as never)).toBe('');
    });

    it('reports an all-blank release as an empty response through the adapter', async () => {
      const poll = vi.fn().mockResolvedValue(succeededSnapshot(['   ', '']));
      const adapter = createBridgeAdapter(mockWorkflowHelpers({ poll }));

      await expect(
        adapter.submitChatCompletion({ model: MODEL, messages: ONE_MESSAGE }),
      ).rejects.toThrow(/empty response/i);
    });
  });

  describe('clamping, at the edges that decide what reaches the host', () => {
    function paramsFor(request: Partial<Parameters<typeof buildChatCompletionBody>[0]>) {
      return buildChatCompletionBody({ model: MODEL, messages: ONE_MESSAGE, ...request }).params;
    }

    it('raises a zero or negative maxTokens to the host minimum of 1', () => {
      // The host bound is `.min(1)`; a 0 would be a BAD_REQUEST at parse.
      expect(paramsFor({ max_tokens: 0 }).maxTokens).toBe(1);
      expect(paramsFor({ max_tokens: -5 }).maxTokens).toBe(1);
    });

    it('floors a fractional maxTokens, because the host bound is .int()', () => {
      expect(paramsFor({ max_tokens: 100.9 }).maxTokens).toBe(100);
    });

    it('falls back to the 1024 default when maxTokens is not a finite number', () => {
      // Infinity is NOT clamped to the ceiling — it takes the default, because it
      // signals "no meaningful value" rather than "as much as possible".
      expect(paramsFor({ max_tokens: Infinity }).maxTokens).toBe(1024);
      expect(paramsFor({ max_tokens: NaN }).maxTokens).toBe(1024);
    });

    it('preserves an explicit temperature of 0 instead of dropping it as falsy', () => {
      // 0 is a legal, meaningful temperature (fully deterministic sampling). A
      // truthiness test here would silently fall back to the provider default.
      const params = paramsFor({ temperature: 0 });
      expect('temperature' in params).toBe(true);
      expect(params.temperature).toBe(0);
    });

    it('omits a non-finite temperature rather than sending NaN to the host', () => {
      // `.strict()` would not save us here — `temperature` is a KNOWN key, so a
      // NaN reaches the number bound and fails the request.
      expect('temperature' in paramsFor({ temperature: NaN })).toBe(false);
      expect('temperature' in paramsFor({ temperature: Infinity })).toBe(false);
    });
  });

  describe('the poll path', () => {
    it('polls the workflowId that submit returned', async () => {
      const submit = vi.fn().mockResolvedValue({ workflowId: 'wf-from-submit', status: 'pending' });
      const poll = vi.fn().mockResolvedValue(succeededSnapshot(['ok']));
      const adapter = createBridgeAdapter(mockWorkflowHelpers({ submit, poll }));

      const result = await adapter.submitChatCompletion({ model: MODEL, messages: ONE_MESSAGE });

      expect(poll).toHaveBeenCalledWith('wf-from-submit');
      // The response id is the workflow id, which is what cancel and the UI key off.
      expect(result.id).toBe('wf-from-submit');
    });

    it('reports a deadline reached before the first poll as a timeout', async () => {
      // Distinct from "workflow failed": nothing was ever read back, so the
      // status is unknown rather than bad.
      let call = 0;
      const base = 1_700_000_000_000;
      vi.spyOn(Date, 'now').mockImplementation(() => (call++ === 0 ? base : base + 60_001));

      const helpers = mockWorkflowHelpers();
      const adapter = createBridgeAdapter(helpers);

      await expect(
        adapter.submitChatCompletion({ model: MODEL, messages: ONE_MESSAGE }),
      ).rejects.toThrow(/timed out before the first poll/i);

      expect(helpers.poll).not.toHaveBeenCalled();
    });

    it('falls back to a status-named error when the host error is not a string', async () => {
      const poll = vi.fn().mockResolvedValue({ status: 'failed', error: { code: 500 } });
      const adapter = createBridgeAdapter(mockWorkflowHelpers({ poll }));

      await expect(
        adapter.submitChatCompletion({ model: MODEL, messages: ONE_MESSAGE }),
      ).rejects.toThrow('Workflow failed');
    });
  });

  describe('message coercion', () => {
    it('treats a null content as empty and drops the message', () => {
      const out = toStepMessages([
        { role: 'user', content: null as unknown as string },
        { role: 'user', content: 'real' },
      ]);
      expect(out).toEqual([{ role: 'user', content: 'real' }]);
    });
  });

  describe('usage accounting', () => {
    it('counts prompt tokens over the FULL request and completion tokens over the released text', async () => {
      // 🔴 Literal expected values, derived from the contract rather than from the
      // implementation: tokens are estimated at 4 characters each, rounded up.
      //   prompt     = ceil(8/4) + ceil(4/4) = 2 + 1 = 3
      //   completion = ceil(4/4)             = 1
      // The 'tool' message is counted even though it is DROPPED from the wire
      // body — usage describes what the user's conversation cost, not what the
      // host was sent.
      const poll = vi.fn().mockResolvedValue(succeededSnapshot(['abcd']));
      const adapter = createBridgeAdapter(mockWorkflowHelpers({ poll }));

      const result = await adapter.submitChatCompletion({
        model: MODEL,
        messages: [
          { role: 'user', content: '12345678' },
          { role: 'tool', content: '1234' },
        ],
      });

      expect(result.usage.prompt_tokens).toBe(3);
      expect(result.usage.completion_tokens).toBe(1);
      expect(result.usage.total_tokens).toBe(4);
    });
  });
});

describe('host-readiness', () => {
  it('INVARIANT GUARD: the host bridge is enabled', () => {
    // Not regression coverage — no bug ever flipped this. It pins the flag so
    // that turning the bridge off becomes a deliberate, visible edit: with
    // HOST_READY false the app renders its not-ready state and no chat works.
    expect(HOST_READY).toBe(true);
  });
});

describe('the exported host bounds match the step schema', () => {
  it('INVARIANT GUARD: maxTokens ceiling is the host constant', () => {
    // Mirrored from civitai's `CHAT_COMPLETION_MAX_OUTPUT_TOKENS`, itself derived
    // from the 50,000-char output scan cap. Pinned literally so a local edit
    // cannot drift it silently — the host rejects anything above this at parse.
    expect(MAX_OUTPUT_TOKENS).toBe(4000);
  });
});
