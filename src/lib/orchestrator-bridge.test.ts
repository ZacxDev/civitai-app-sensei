import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createBridgeAdapter,
  buildChatCompletionBody,
  toStepMessages,
  extractReleasedText,
  extractToolCalls,
  isAllowedModel,
  TextOutputWithheldError,
  CHAT_COMPLETION_STEP_ID,
  CHAT_COMPLETION_MODELS,
  MAX_OUTPUT_TOKENS,
  MAX_MESSAGES,
  MAX_MESSAGE_CHARS,
  type WorkflowHelpers,
} from './orchestrator-bridge.js';
import { AVAILABLE_MODELS } from './models.js';
// 🔴 THE REAL CLASSES FROM THE INSTALLED PACKAGE, not local look-alikes. The
// adapter branches with `instanceof`, so a stand-in would silently exercise its
// generic rethrow arm and every rejection assertion below would pass while
// measuring the wrong code path.
import { WorkflowEstimateError, WorkflowSubmitError } from '@civitai/blocks-react';

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 EVERY FIXTURE HERE MIRRORS THE REAL HOST CONTRACT, and that is the whole
// point of this file rather than a style note.
//
// The previous suite was fully green against a bridge that could not work: its
// poll fixtures returned `{ content }`, `{ steps: [{ output: { text } }] }` and
// `{ tool_calls }`, none of which the host ever sends, and its requests used
// `model: 'test-model'`, which the host's `z.enum` rejects. Fakes that encode
// the same wrong shape as the code under test agree with it perfectly and prove
// nothing — the tests and the implementation were both wrong, in the same
// direction, and nothing could go red.
//
// So: released text arrives ONLY on `textOutputs`, a withhold ONLY on
// `textOutputWithheld`, and every model used below is on the real allowlist.
// ─────────────────────────────────────────────────────────────────────────────

const MODEL = 'deepseek/deepseek-chat';

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

describe('orchestrator-bridge', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('the wire body', () => {
    it('uses the registered kebab-case step id, not the orchestrator $type', () => {
      const body = buildChatCompletionBody({
        model: MODEL,
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(body.kind).toBe('step');
      expect(body.step).toBe('chat-completion');
      // The camelCase spelling is the entry's internal `orchestratorType`; it is
      // not a member of the wire enum and is rejected fail-closed at the schema.
      expect(body.step).not.toBe('chatCompletion');
    });

    it('emits EXACTLY the four keys the .strict() param schema accepts', () => {
      const body = buildChatCompletionBody({
        model: MODEL,
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0.7,
        max_tokens: 100,
      });
      expect(Object.keys(body.params).sort()).toEqual([
        'maxTokens',
        'messages',
        'model',
        'temperature',
      ]);
      expect(Object.keys(body).sort()).toEqual(['kind', 'params', 'step']);
    });

    it('omits temperature entirely when not supplied, rather than sending undefined', () => {
      const body = buildChatCompletionBody({
        model: MODEL,
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(Object.keys(body.params).sort()).toEqual(['maxTokens', 'messages', 'model']);
      expect('temperature' in body.params).toBe(false);
    });

    it('still drops the params the host rejects — and no longer drops tools', () => {
      // 🔴 THE CAST IS THE POINT, AND IT IS NOT A LOOPHOLE. `ChatCompletionRequest`
      // does not DECLARE the banned keys, so the app cannot express them — that
      // is the primary guard and it is compile-time. This test keeps the RUNTIME
      // guard honest for the inputs a type cannot police: a deserialized stored
      // request, an `any` from a future refactor, a hand-built object. Deleting
      // the cast would delete the only reachable input this assertion has.
      //
      // ⚠️ `tools` AND `tool_choice` USED TO BE ON THE BANNED LIST. The host
      // widened its schema to accept them, so banning them here would now be
      // asserting the opposite of the contract. They moved to the assertions
      // below rather than being quietly deleted from the list.
      const body = buildChatCompletionBody({
        model: MODEL,
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        response_format: { type: 'json_object' },
        modalities: ['image'],
      } as unknown as Parameters<typeof buildChatCompletionBody>[0]);
      for (const banned of ['response_format', 'stream', 'max_tokens', 'modalities']) {
        expect(banned in body.params).toBe(false);
      }
      // No tools were declared on THIS request, so neither key is emitted — an
      // empty `tools` array is a different thing from an absent one.
      expect('tools' in body.params).toBe(false);
      expect('tool_choice' in body.params).toBe(false);
    });

    it('forwards declared tools, and keeps the HOST key `toolChoice` (camelCase)', () => {
      const tools = [
        { type: 'function' as const, function: { name: 'search_models', description: 'd', parameters: {} } },
      ];
      const body = buildChatCompletionBody({
        model: MODEL,
        messages: [{ role: 'user', content: 'hi' }],
        tools,
        toolChoice: 'auto',
      });
      expect(body.params.tools).toEqual(tools);
      // 🔴 THIS TEST USED TO ASSERT THE DEFECT, AND ITS OLD COMMENT EXPLAINED
      // WHY IT WAS RIGHT TO. It read: "SNAKE_CASE ON THE WIRE … the orchestrator
      // reads `tool_choice`; an unknown key is IGNORED rather than rejected, so
      // getting this backwards would leave the feature silently inert with every
      // test still green." Both halves were wrong, and being asserted is what
      // made the mistake survive review, five audits and a release.
      //
      // The app talks to the HOST, not the orchestrator. The host's params
      // schema takes `toolChoice` and does the camel→snake mapping itself; and
      // that schema is `.strict()`, so an unknown key is a BAD_REQUEST for the
      // WHOLE request, never an ignored field. 0.1.6 shipped `tool_choice` and
      // broke EVERY send.
      expect(body.params.toolChoice).toBe('auto');
      expect('tool_choice' in body.params).toBe(false);
    });

    it('emits no tool keys for an EMPTY tools array — absent and empty differ', () => {
      const body = buildChatCompletionBody({
        model: MODEL,
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        toolChoice: 'auto',
      });
      expect('tools' in body.params).toBe(false);
      expect('tool_choice' in body.params).toBe(false);
    });

    it('rejects a model that is not on the host allowlist', () => {
      // These three shipped in AVAILABLE_MODELS and are NOT registered host-side.
      for (const bad of [
        'deepseek/deepseek-r1',
        'google/gemini-2.0-flash',
        'anthropic/claude-3.5-sonnet',
      ]) {
        expect(() =>
          buildChatCompletionBody({ model: bad, messages: [{ role: 'user', content: 'hi' }] }),
        ).toThrow(/not available/i);
      }
    });

    it('accepts every model on the allowlist', () => {
      for (const model of CHAT_COMPLETION_MODELS) {
        expect(isAllowedModel(model)).toBe(true);
        expect(() =>
          buildChatCompletionBody({ model, messages: [{ role: 'user', content: 'hi' }] }),
        ).not.toThrow();
      }
    });

    it('clamps maxTokens to the host ceiling', () => {
      const body = buildChatCompletionBody({
        model: MODEL,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 999_999,
      });
      expect(body.params.maxTokens).toBe(MAX_OUTPUT_TOKENS);
    });

    it('always sends maxTokens, because the host requires it', () => {
      const body = buildChatCompletionBody({
        model: MODEL,
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(typeof body.params.maxTokens).toBe('number');
      expect(body.params.maxTokens).toBeGreaterThanOrEqual(1);
      expect(body.params.maxTokens).toBeLessThanOrEqual(MAX_OUTPUT_TOKENS);
    });

    it('clamps temperature into the 0..2 range', () => {
      expect(
        buildChatCompletionBody({
          model: MODEL,
          messages: [{ role: 'user', content: 'hi' }],
          temperature: 9,
        }).params.temperature,
      ).toBe(2);
      expect(
        buildChatCompletionBody({
          model: MODEL,
          messages: [{ role: 'user', content: 'hi' }],
          temperature: -3,
        }).params.temperature,
      ).toBe(0);
    });

    it('throws rather than submitting an empty conversation', () => {
      expect(() => buildChatCompletionBody({ model: MODEL, messages: [] })).toThrow(/empty/i);
      expect(() =>
        buildChatCompletionBody({
          model: MODEL,
          messages: [{ role: 'tool', content: 'only a tool result' }],
        }),
      ).toThrow(/empty/i);
    });
  });

  describe('toStepMessages', () => {
    it("drops 'tool'-role messages, which the host schema has no room for", () => {
      // Legacy stored sessions still hold these; the guard must survive the
      // tool loop's removal because the DATA outlives the code that wrote it.
      const out = toStepMessages([
        { role: 'user', content: 'find me a model' },
        { role: 'tool', content: '{"items":[]}' },
        { role: 'assistant', content: 'here you go' },
      ]);
      expect(out.map((m) => m.role)).toEqual(['user', 'assistant']);
    });

    it('drops empty and whitespace-only content', () => {
      const out = toStepMessages([
        { role: 'user', content: 'real' },
        { role: 'assistant', content: '' },
        { role: 'assistant', content: '   \n  ' },
      ]);
      expect(out).toHaveLength(1);
    });

    it('truncates over-long content to the host bound', () => {
      const out = toStepMessages([{ role: 'user', content: 'x'.repeat(MAX_MESSAGE_CHARS + 500) }]);
      expect(out[0].content).toHaveLength(MAX_MESSAGE_CHARS);
    });

    it('caps the conversation at 32 messages', () => {
      const many = Array.from({ length: 60 }, (_, i) => ({
        role: 'user' as const,
        content: `m${i}`,
      }));
      expect(toStepMessages(many)).toHaveLength(MAX_MESSAGES);
    });

    it('preserves the system prompt when trimming, keeping the most recent turns', () => {
      const many = [
        { role: 'system', content: 'SYSTEM PROMPT' },
        ...Array.from({ length: 60 }, (_, i) => ({ role: 'user', content: `m${i}` })),
      ];
      const out = toStepMessages(many);
      expect(out).toHaveLength(MAX_MESSAGES);
      // Trimming from the front would have discarded it — the one message that
      // must always survive.
      expect(out[0]).toEqual({ role: 'system', content: 'SYSTEM PROMPT' });
      expect(out[out.length - 1].content).toBe('m59');
    });
  });

  describe('reading the reply', () => {
    it('reads released text off textOutputs', () => {
      expect(extractReleasedText({ textOutputs: ['the answer'] } as never)).toBe('the answer');
    });

    it('joins multiple released text steps', () => {
      expect(extractReleasedText({ textOutputs: ['one', 'two'] } as never)).toBe('one\n\ntwo');
    });

    it('returns empty for the shapes the host never sends', () => {
      // Each of these was a live read path in the previous adapter.
      expect(extractReleasedText({ content: 'nope' } as never)).toBe('');
      expect(extractReleasedText({ text: 'nope' } as never)).toBe('');
      expect(extractReleasedText({ steps: [{ output: { text: 'nope' } }] } as never)).toBe('');
      expect(extractReleasedText({} as never)).toBe('');
    });
  });

  describe('the adapter', () => {
    it('calls estimate, submit and poll, and returns the released text', async () => {
      const estimate = vi.fn().mockResolvedValue({ cost: { total: 1 } });
      const submit = vi.fn().mockResolvedValue({ workflowId: 'wf-42', status: 'pending' });
      const poll = vi.fn().mockResolvedValue(succeededSnapshot(['The answer is 42.']));
      const adapter = createBridgeAdapter({ estimate, submit, poll, cancel: vi.fn() });

      const result = await adapter.submitChatCompletion({
        model: MODEL,
        messages: [{ role: 'user', content: 'What is the answer?' }],
      });

      expect(estimate).toHaveBeenCalledOnce();
      expect(submit).toHaveBeenCalledOnce();
      expect(poll).toHaveBeenCalled();
      expect(result.id).toBe('wf-42');
      expect(result.choices[0].message.content).toBe('The answer is 42.');
      expect(result.choices[0].finish_reason).toBe('stop');
      // `tool_calls` is not merely absent at runtime — it is no longer a member
      // of the response type, so a consumer cannot branch on it at all.
      expect('tool_calls' in result.choices[0].message).toBe(false);
      expect(result.usage.total_tokens).toBeGreaterThan(0);
    });

    it('submits the same body to estimate and submit', async () => {
      const helpers = mockWorkflowHelpers();
      const adapter = createBridgeAdapter(helpers);
      await adapter.submitChatCompletion({
        model: MODEL,
        messages: [{ role: 'user', content: 'hi' }],
      });
      const estimateBody = (helpers.estimate as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const submitBody = (helpers.submit as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(estimateBody).toEqual(submitBody);
      expect(estimateBody.step).toBe(CHAT_COMPLETION_STEP_ID);
    });

    it('polls at least once even when submit already reports a terminal status', async () => {
      // The submit reply structurally cannot carry `textOutputs` — only the poll
      // is wrapped in the output-moderation scan.
      const submit = vi.fn().mockResolvedValue({ workflowId: 'wf-9', status: 'succeeded' });
      const poll = vi.fn().mockResolvedValue(succeededSnapshot(['scanned reply']));
      const adapter = createBridgeAdapter(mockWorkflowHelpers({ submit, poll }));

      const result = await adapter.submitChatCompletion({
        model: MODEL,
        messages: [{ role: 'user', content: 'hi' }],
      });

      expect(poll).toHaveBeenCalled();
      expect(result.choices[0].message.content).toBe('scanned reply');
    });

    it('polls until terminal status', async () => {
      const poll = vi
        .fn()
        .mockResolvedValueOnce({ status: 'processing' })
        .mockResolvedValueOnce({ status: 'processing' })
        .mockResolvedValueOnce(succeededSnapshot(['Done!']));
      const adapter = createBridgeAdapter(mockWorkflowHelpers({ poll }));

      const result = await adapter.submitChatCompletion({
        model: MODEL,
        messages: [{ role: 'user', content: 'hi' }],
      });

      expect(poll).toHaveBeenCalledTimes(3);
      expect(result.choices[0].message.content).toBe('Done!');
    });

    it('replays released text through onChunk', async () => {
      const adapter = createBridgeAdapter(mockWorkflowHelpers());
      const chunks: string[] = [];

      // 🔴 THE REPLAY IS AWAITED HERE, NOT BY THE CALL. `submitChatCompletion`
      // resolves as soon as the moderated reply exists and hands the typewriter
      // back on `result.replay` — see the ordering case below for why. This
      // assertion is unchanged in what it claims; only where the wait lives.
      const result = await adapter.submitChatCompletion(
        { model: MODEL, messages: [{ role: 'user', content: 'hi' }] },
        (c) => chunks.push(c),
      );
      await result.replay;

      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.join('')).toContain('Hello from the bridge!');
    });

    // ── THE ORDERING THE HIDDEN-TAB DEFECT TURNS ON. ─────────────────────────
    //
    // The reply reaching the caller used to be gated on a `setTimeout`-per-word
    // replay, which Chrome throttles in a background tab. Measured against the
    // deployed build on 2026-09-04: a reply was on screen at 23:10:44 and in
    // storage at 23:14:14. This is that gate, at its narrowest.
    it('🔴 resolves BEFORE the replay has finished typing', async () => {
      const words = Array.from({ length: 40 }, (_, i) => `w${i}`);
      const poll = vi.fn().mockResolvedValue(succeededSnapshot([words.join(' ')]));
      const adapter = createBridgeAdapter(mockWorkflowHelpers({ poll }));
      const chunks: string[] = [];

      const result = await adapter.submitChatCompletion(
        { model: MODEL, messages: [{ role: 'user', content: 'hi' }] },
        (c) => chunks.push(c),
      );

      // 40 words at 20 ms is ~800 ms of replay; resolution must not have waited
      // for it. The number is deliberately far from 40 rather than `< 40`, so a
      // resolve that waited for all but the last word still fails here.
      expect(
        chunks.length,
        `the call did not resolve until ${chunks.length} of ${words.length} words had replayed`,
      ).toBeLessThan(5);
      expect(result.choices[0].message.content).toBe(words.join(' '));

      // 🔴 POSITIVE CONTROL: the replay is real and does finish. Without this,
      // "fewer than 5 chunks" is equally satisfied by a replay that never ran.
      await result.replay;
      expect(chunks.length).toBe(words.length);
    });

    it('🔴 a throwing chunk sink neither rejects the call nor rejects the replay', async () => {
      // The caller awaits `replay` AFTER it has persisted the reply. A rejection
      // there would throw it into its error path and overwrite a reply it has
      // already stored — so the handle must swallow, and the reply must survive.
      const adapter = createBridgeAdapter(mockWorkflowHelpers());

      const result = await adapter.submitChatCompletion(
        { model: MODEL, messages: [{ role: 'user', content: 'hi' }] },
        () => {
          throw new Error('the renderer blew up');
        },
      );

      expect(result.choices[0].message.content).toBe('Hello from the bridge!');
      await expect(result.replay).resolves.toBeUndefined();
    });

    describe('a withheld reply', () => {
      const withheldSnap = {
        status: 'succeeded',
        textOutputWithheld: {
          reason: 'This response was withheld because it did not pass Civitai’s content policy.',
        },
      };

      it('throws TextOutputWithheldError carrying the host reason', async () => {
        const poll = vi.fn().mockResolvedValue(withheldSnap);
        const adapter = createBridgeAdapter(mockWorkflowHelpers({ poll }));

        await expect(
          adapter.submitChatCompletion({
            model: MODEL,
            messages: [{ role: 'user', content: 'something flagged' }],
          }),
        ).rejects.toBeInstanceOf(TextOutputWithheldError);
      });

      it('exposes the reason verbatim', async () => {
        const poll = vi.fn().mockResolvedValue(withheldSnap);
        const adapter = createBridgeAdapter(mockWorkflowHelpers({ poll }));

        await expect(
          adapter.submitChatCompletion({
            model: MODEL,
            messages: [{ role: 'user', content: 'x' }],
          }),
        ).rejects.toMatchObject({ reason: withheldSnap.textOutputWithheld.reason });
      });

      it('reports the withhold, NOT "empty response"', async () => {
        // A withhold arrives with no `textOutputs`. Checking the empty case first
        // would mislabel a working policy as a bug.
        const poll = vi.fn().mockResolvedValue(withheldSnap);
        const adapter = createBridgeAdapter(mockWorkflowHelpers({ poll }));

        await expect(
          adapter.submitChatCompletion({
            model: MODEL,
            messages: [{ role: 'user', content: 'x' }],
          }),
        ).rejects.not.toThrow(/empty response/i);
      });

      it('still reports the withhold when a sibling step released text', async () => {
        const poll = vi.fn().mockResolvedValue({ ...withheldSnap, textOutputs: ['clean sibling'] });
        const adapter = createBridgeAdapter(mockWorkflowHelpers({ poll }));

        await expect(
          adapter.submitChatCompletion({
            model: MODEL,
            messages: [{ role: 'user', content: 'x' }],
          }),
        ).rejects.toBeInstanceOf(TextOutputWithheldError);
      });
    });

    it('throws on a failed workflow', async () => {
      const poll = vi.fn().mockResolvedValue({ status: 'failed', error: 'Budget exceeded' });
      const adapter = createBridgeAdapter(mockWorkflowHelpers({ poll }));

      await expect(
        adapter.submitChatCompletion({ model: MODEL, messages: [{ role: 'user', content: 'hi' }] }),
      ).rejects.toThrow('Budget exceeded');
    });

    it('throws on an expired workflow', async () => {
      const poll = vi.fn().mockResolvedValue({ status: 'expired' });
      const adapter = createBridgeAdapter(mockWorkflowHelpers({ poll }));

      await expect(
        adapter.submitChatCompletion({ model: MODEL, messages: [{ role: 'user', content: 'hi' }] }),
      ).rejects.toThrow('Workflow expired');
    });

    it('throws on a zero cost estimate, naming the PRICE and not a missing one', async () => {
      const estimate = vi.fn().mockResolvedValue({ cost: { total: 0 } });
      const adapter = createBridgeAdapter(mockWorkflowHelpers({ estimate }));

      await expect(
        adapter.submitChatCompletion({ model: MODEL, messages: [{ role: 'user', content: 'hi' }] }),
      ).rejects.toThrow('priced this request at 0');
    });

    it('reports the ACTUAL non-positive price, not a hardcoded zero', async () => {
      // 🔴 THE FIXTURE ABOVE PRICES AT 0, WHICH IS THE LITERAL A HARDCODING
      // MUTANT EMITS — so it cannot see `${total}` being replaced by `0`, and
      // that mutation survives the whole suite. -3 is a value the constant
      // cannot equal, which is what makes the interpolation observable.
      const estimate = vi.fn().mockResolvedValue({ cost: { total: -3 } });
      const adapter = createBridgeAdapter(mockWorkflowHelpers({ estimate }));

      await expect(
        adapter.submitChatCompletion({ model: MODEL, messages: [{ role: 'user', content: 'hi' }] }),
      ).rejects.toThrow('priced this request at -3');
    });

    it('throws when submit returns no workflowId', async () => {
      const submit = vi.fn().mockResolvedValue({ status: 'pending' });
      const adapter = createBridgeAdapter(mockWorkflowHelpers({ submit }));

      await expect(
        adapter.submitChatCompletion({ model: MODEL, messages: [{ role: 'user', content: 'hi' }] }),
      ).rejects.toThrow('workflowId');
    });

    // ── A REFUSAL AT SUBMIT. Measured in production 2026-09-12. ──────────────
    //
    // A viewer set a per-app Buzz limit of 1 on this app and sent a prompt. The
    // server refused the turn, charged nothing, and built a message naming what
    // had been spent and what their own limit was. The viewer was shown
    // `Error: Not Found`.
    //
    // The refusal RESOLVES out of `submit` rather than rejecting — it quotes the
    // price it refused to charge, and `useBuzzWorkflow` rejects a failure-shaped
    // reply only when there is NO numeric cost, because blocks are meant to
    // recover from a spend cap. What comes back is a resolved snapshot carrying
    // the host contract's failure sentinel `workflowId: 'failed'`, and the poll
    // loop asked the orchestrator for a workflow by that name. The single
    // `blocks.pollWorkflow` NOT_FOUND in three days of server logs carried
    // `workflowId: 'failed'`, timestamped inside that run.
    describe('a submit-time refusal', () => {
      const REFUSAL =
        'app Buzz limit reached: 0 already spent today by this app on your behalf, ' +
        'this generation costs 4, your limit for this app is 1';

      // The real host contract for a consent-budget rejection, verbatim: a
      // RESOLVED snapshot, a numeric cost, the sentinel id, the server's words.
      const refusedSubmit = () =>
        vi.fn().mockResolvedValue({
          workflowId: 'failed',
          status: 'failed',
          cost: { total: 4 },
          error: REFUSAL,
        });

      // What the sentinel does on the wire: `blocks.pollWorkflow` asks the
      // orchestrator for a workflow called `failed`, gets a 404, and raises a
      // TRPCError whose message is exactly `Not Found`.
      const sentinelPoll = () => vi.fn().mockRejectedValue(new Error('Not Found'));

      it('🔴 surfaces the server’s own reason, not the sentinel poll’s 404', async () => {
        const helpers = mockWorkflowHelpers({ submit: refusedSubmit(), poll: sentinelPoll() });
        const adapter = createBridgeAdapter(helpers);

        await expect(
          adapter.submitChatCompletion({
            model: MODEL,
            messages: [{ role: 'user', content: 'hi' }],
          }),
        ).rejects.toThrow(REFUSAL);
      });

      it('🔴 never asks the orchestrator for the sentinel at all', async () => {
        // Stronger than the assertion above and independent of any wording: the
        // defect is a REQUEST that should never have been made. A fix that
        // caught the 404 and re-reported the reason would pass the message test
        // and still ask for a workflow named `failed` on every refusal.
        const helpers = mockWorkflowHelpers({ submit: refusedSubmit(), poll: sentinelPoll() });
        const adapter = createBridgeAdapter(helpers);

        await expect(
          adapter.submitChatCompletion({
            model: MODEL,
            messages: [{ role: 'user', content: 'hi' }],
          }),
        ).rejects.toThrow();

        expect(helpers.poll).not.toHaveBeenCalled();
      });

      it('falls back to the status when the refusal carries no words', async () => {
        // `new Error('')` renders as a bare `Error:` and names nothing — worse
        // than the status it replaced. A blank string is a string, so `typeof`
        // alone does not catch it.
        const submit = vi.fn().mockResolvedValue({
          workflowId: 'failed',
          status: 'failed',
          cost: { total: 4 },
          error: '   ',
        });
        const adapter = createBridgeAdapter(
          mockWorkflowHelpers({ submit, poll: sentinelPoll() }),
        );

        await expect(
          adapter.submitChatCompletion({
            model: MODEL,
            messages: [{ role: 'user', content: 'hi' }],
          }),
        ).rejects.toThrow('Workflow failed');
      });

      // 🔴 THE ANTI-VACUITY HALF IS NOT IN THIS BLOCK, deliberately — a guard
      // that skipped the poll on EVERY submit would satisfy all three cases
      // above and break the product. Two existing tests are the control and
      // must keep passing: `polls at least once even when submit already
      // reports a terminal status` (a `succeeded` submit, which still needs the
      // output-moderation scan the poll performs) and `polls until terminal
      // status` (a `pending` submit).

      // 🔴 THE OTHER HALF OF THE ANTI-VACUITY PAIR, AND IT BELONGS HERE BECAUSE THE
      // BUMP PUT A `catch` AROUND THE `submit` CALL ABOVE. The refusal fixtures in
      // this block RESOLVE. `blocks-react` ≥ 0.43.0 also makes `submit` REJECT on a
      // failure-shaped reply with no price, and the adapter now catches that — so a
      // handler that answered BOTH by routing everything through the rejection arm
      // would satisfy every assertion above while relabelling a priced refusal as
      // "may already have been charged", which is a different and wrong claim about
      // the viewer's money. The whole normalised string is pinned, not a substring,
      // so a prefix creeping onto the resolved path fails here.
      it('🔴 a PRICED refusal resolves — its message carries no rejection prefix', async () => {
        const helpers = mockWorkflowHelpers({ submit: refusedSubmit(), poll: sentinelPoll() });
        const adapter = createBridgeAdapter(helpers);

        let message: string | undefined;
        try {
          await adapter.submitChatCompletion({
            model: MODEL,
            messages: [{ role: 'user', content: 'hi' }],
          });
        } catch (err) {
          message = (err as Error).message;
        }

        // The server's words, and NOTHING ELSE. `toThrow` above is a substring
        // match and would pass with either rejection prefix bolted on the front.
        expect(message).toBe(REFUSAL);
      });
    });

    // ── THE `blocks-react@0.43.0` REJECTION CONTRACT. ────────────────────────
    //
    // 0.43.0 added two error classes and changed `estimate`/`submit` from resolving
    // an unusable reply to REJECTING with one. This app was pinned at
    // `blocks-react@0.39.0`, where neither class existed, until the four-package
    // pair bump; these cases are what makes the migration observable.
    //
    // 🔴 THEY USE THE REAL CLASSES, IMPORTED FROM THE INSTALLED PACKAGE. A local
    // look-alike would prove nothing: the adapter branches with `instanceof`, so a
    // hand-rolled stand-in would exercise the generic rethrow arm instead and every
    // assertion below would be measuring the wrong path. Constructing the real
    // class also means `err.message` in these tests is the real developer-facing
    // constant, which is what the "never shown to a viewer" case reads.
    //
    // 🔴 WHY THE SERVER'S WORDS AND NOT AN APP-OWNED STRING. Upstream's own guidance
    // is to derive viewer copy from `code` alone. This app deliberately does not:
    // PR #69 measured, in production, a viewer whose per-app Buzz limit refused a
    // turn being shown `Error: Not Found` instead of the server's `app Buzz limit
    // reached: … your limit for this app is 1` — a number-bearing, actionable
    // sentence the server authored precisely so the viewer could act on it. The
    // rejection arms keep that decision; `snapshotFailureMessage` is the one place
    // it is implemented, for both the resolved refusal above and the rejections here.
    describe('a submit REJECTION (blocks-react ≥ 0.43.0)', () => {
      // The moderator-review nack, which the class docs name as a non-catch
      // short-circuit that still produces the `'exception'` shape: the host
      // synthesised the reply itself, so the id is the `'failed'` sentinel and there
      // is no cost.
      const EXCEPTION_REASON = 'not available in review preview';
      // The realistic UNSANITISED fixture — upstream pins this family because
      // `snapshot.error` can carry raw Prisma/`pg` text. A real orchestrator id, so
      // the hook classifies it `'workflow-failed'` rather than `'exception'`.
      const WORKFLOW_FAILED_REASON =
        'Unique constraint failed: Key (email)=(viewer@example.test) already exists';

      const rejectingSubmit = (err: WorkflowSubmitError) => vi.fn().mockRejectedValue(err);

      const exceptionError = (error?: string) =>
        new WorkflowSubmitError(
          { workflowId: 'failed', status: 'failed', ...(error === undefined ? {} : { error }) },
          'exception',
        );

      const workflowFailedError = () =>
        new WorkflowSubmitError(
          { workflowId: 'wf_01JQZ8K3P7', status: 'failed', error: WORKFLOW_FAILED_REASON },
          'workflow-failed',
        );

      const messageFrom = async (submit: WorkflowHelpers['submit']): Promise<string> => {
        const adapter = createBridgeAdapter(mockWorkflowHelpers({ submit }));
        try {
          await adapter.submitChatCompletion({
            model: MODEL,
            messages: [{ role: 'user', content: 'hi' }],
          });
        } catch (err) {
          return (err as Error).message;
        }
        throw new Error('expected the submit rejection to reject, but it resolved');
      };

      it("🔴 code 'exception' surfaces the SERVER's words", async () => {
        expect(await messageFrom(rejectingSubmit(exceptionError(EXCEPTION_REASON)))).toBe(
          `Workflow submit returned no workflow — ${EXCEPTION_REASON}`,
        );
      });

      it("🔴 code 'workflow-failed' surfaces the SERVER's words and warns about the charge", async () => {
        expect(await messageFrom(rejectingSubmit(workflowFailedError()))).toBe(
          'Workflow submit failed, and this turn may already have been charged — ' +
            WORKFLOW_FAILED_REASON,
        );
      });

      it('🔴 the two codes are actually DISTINGUISHED, not collapsed', async () => {
        // 🔴 ONE REASON, TWO CODES — AND THAT IS THE WHOLE POINT OF THE FIXTURE.
        // Written first with each code carrying its own `snapshot.error`, this test
        // SURVIVED a mutant that collapsed the `code` branch to a single arm: the
        // two messages still differed, by the reason rather than by the code, so the
        // assertion was measuring the interpolation it shares with the two cases
        // above instead of the branch it exists to pin. Holding `error` constant
        // leaves `code` as the only thing that can move the output.
        const SHARED = 'the host declined this turn';
        const exception = await messageFrom(rejectingSubmit(exceptionError(SHARED)));
        const workflowFailed = await messageFrom(
          rejectingSubmit(
            new WorkflowSubmitError(
              { workflowId: 'wf_01JQZ8K3P7', status: 'failed', error: SHARED },
              'workflow-failed',
            ),
          ),
        );

        expect(exception).not.toBe(workflowFailed);
      });

      it('🔴 NEITHER code tells the viewer the turn was free', async () => {
        // Upstream is explicit that neither code guarantees nothing was spent:
        // `'exception'` is reachable via a lost response or an in-progress
        // idempotency conflict, and `'workflow-failed'` means the host already
        // treats the spend as committed. Every reply in this app costs Buzz, so a
        // reassurance here is a false statement about the viewer's money.
        //
        // 🔴 TWO ASSERTIONS, AND ONLY THE FIRST IS STRUCTURAL. Today's two arms are
        // pinned as WHOLE NORMALISED STRINGS — that is what actually forbids a
        // reassurance being added to either, because any added clause fails the
        // equality regardless of how it is worded. Doing it here as well as in the
        // two `surfaces the SERVER's words` cases above is deliberate: it makes
        // THIS test the one that fails when someone edits these arms, so the
        // failure names the money claim rather than reading as a copy nit.
        const exception = await messageFrom(rejectingSubmit(exceptionError(EXCEPTION_REASON)));
        const workflowFailed = await messageFrom(rejectingSubmit(workflowFailedError()));
        expect(exception).toBe(`Workflow submit returned no workflow — ${EXCEPTION_REASON}`);
        expect(workflowFailed).toBe(
          'Workflow submit failed, and this turn may already have been charged — ' +
            WORKFLOW_FAILED_REASON,
        );

        // ⚠️ AND THIS SECOND ASSERTION IS A WEAK NET — KNOWINGLY, AND IT IS ONLY
        // WORTH KEEPING BECAUSE IT IS REACHABLE. It is a WORD check, so it is walked
        // around by rewording: "your Buzz was not spent" and "this turn cost you
        // nothing" both pass it while making exactly the forbidden claim. Treat it
        // as a tripwire, never as the guarantee — the guarantee is the two
        // whole-string pins above.
        //
        // 🔴 IT IS DRIVEN OVER AN UNRECOGNISED CODE, NOT JUST THE TWO ARMS ABOVE.
        // A first draft looped over `exception` and `workflowFailed` only, which
        // made it strictly dead: the whole-string equalities fire first on any edit
        // to those arms, so the regex could never be the assertion that failed, and
        // a THIRD arm — the case it exists for — was not in the loop at all.
        // `WorkflowSubmitErrorCode` is `'exception' | 'workflow-failed'` today, so a
        // future third code lands on the cautious fall-through arm; feeding one
        // through the cast is how this net actually covers that arm before it is
        // written.
        const FUTURE_CODE = 'idempotency-conflict' as WorkflowSubmitError['code'];
        const future = await messageFrom(
          rejectingSubmit(
            new WorkflowSubmitError(
              { workflowId: 'wf_01JQZ8K3P7', status: 'failed', error: EXCEPTION_REASON },
              FUTURE_CODE,
            ),
          ),
        );
        for (const message of [exception, workflowFailed, future]) {
          expect(message).not.toMatch(/free|no charge|not charged|nothing was charged|refund/i);
        }
      });

      it('🔴 never shows the developer-facing err.message', async () => {
        // 🔴 THE EXPECTATION IS READ OFF THE REAL CLASS, NOT SPELLED. `err.message`
        // is a constant whose wording upstream says is NOT a contract, so a literal
        // copied here would rot into a vacuous pass on the next bump. Upstream
        // records two apps piping exactly this string into rendered UI on their
        // 0.43.0 migration (civitai/civitai-app-starters#253).
        const err = exceptionError(EXCEPTION_REASON);
        expect(err.message).toContain('reason on .snapshot.error'); // the instrument works
        expect(await messageFrom(rejectingSubmit(err))).not.toContain(err.message);
      });

      it('falls back to a plain no-reason line when the snapshot carries no words', async () => {
        expect(await messageFrom(rejectingSubmit(exceptionError()))).toBe(
          'Workflow submit returned no workflow — the server gave no reason',
        );
      });

      it('rethrows a NON-WorkflowSubmitError untouched', async () => {
        // The generic arm. A transport failure is not a submit rejection and must
        // not be relabelled as one — relabelling it would put "may already have been
        // charged" on a request that never left the block.
        expect(await messageFrom(vi.fn().mockRejectedValue(new Error('transport exploded')))).toBe(
          'transport exploded',
        );
      });

      it('does not poll after a submit rejection', async () => {
        // There is no workflow to poll on either arm — `'exception'` carries the
        // sentinel id and `'workflow-failed'` may carry `'whatif'`. Same defect
        // shape as the sentinel poll #69 removed, one exit over.
        const helpers = mockWorkflowHelpers({
          submit: rejectingSubmit(exceptionError(EXCEPTION_REASON)),
        });
        const adapter = createBridgeAdapter(helpers);

        await expect(
          adapter.submitChatCompletion({
            model: MODEL,
            messages: [{ role: 'user', content: 'hi' }],
          }),
        ).rejects.toThrow();

        expect(helpers.poll).not.toHaveBeenCalled();
      });
    });

    describe('an estimate REJECTION (blocks-react ≥ 0.43.0)', () => {
      const FAILED_REASON = 'chat-completion is temporarily unavailable';
      const NO_COST_REASON = 'the whatIf reply carried no price for this model';

      const estimateError = (code: 'failed' | 'no-cost', error?: string) =>
        new WorkflowEstimateError(
          {
            workflowId: code === 'failed' ? 'failed' : 'wf_01JQZ8ESTM',
            status: code === 'failed' ? 'failed' : 'pending',
            ...(error === undefined ? {} : { error }),
          },
          code,
        );

      const messageFrom = async (err: unknown): Promise<string> => {
        const helpers = mockWorkflowHelpers({ estimate: vi.fn().mockRejectedValue(err) });
        const adapter = createBridgeAdapter(helpers);
        try {
          await adapter.submitChatCompletion({
            model: MODEL,
            messages: [{ role: 'user', content: 'hi' }],
          });
        } catch (e) {
          // Nothing may be submitted when the price never landed. This is the money
          // gate, so it is asserted on every case rather than in one of its own.
          expect(helpers.submit).not.toHaveBeenCalled();
          return (e as Error).message;
        }
        throw new Error('expected the estimate rejection to reject, but it resolved');
      };

      it("🔴 code 'failed' surfaces the SERVER's words, attributed to the ESTIMATE", async () => {
        expect(await messageFrom(estimateError('failed', FAILED_REASON))).toBe(
          `Workflow estimate failed — ${FAILED_REASON}`,
        );
      });

      it("🔴 code 'no-cost' surfaces the SERVER's words and says no cost came back", async () => {
        expect(await messageFrom(estimateError('no-cost', NO_COST_REASON))).toBe(
          `Workflow estimate returned no cost — ${NO_COST_REASON}`,
        );
      });

      it("🔴 does NOT report itself as a SUBMIT failure", async () => {
        // The estimate-attribution split, preserved across the rejection arms. An
        // estimate that never priced the turn reads as a billing failure if it is
        // labelled a submit — the exact 0.1.6 misdiagnosis recorded on
        // `buildChatCompletionBody`.
        for (const code of ['failed', 'no-cost'] as const) {
          const message = await messageFrom(estimateError(code, FAILED_REASON));
          expect(message).toContain('estimate');
          expect(message).not.toContain('submit');
        }
      });

      it("keeps 'failed' and 'no-cost' distinguishable", async () => {
        // A `'failed'` reply CAN carry a numeric cost per the class docs, so calling
        // it "returned no cost" would be false. Collapsing the arms is the mutation
        // this refuses.
        expect(await messageFrom(estimateError('failed', FAILED_REASON))).not.toBe(
          await messageFrom(estimateError('no-cost', FAILED_REASON)),
        );
      });

      it("reuses the pre-0.43 unpriced wording when 'no-cost' carries no words", async () => {
        // The same fallback the RESOLVED unpriced gate uses, which is what makes the
        // two routes to "no usable price" read identically. Pinned as one string in
        // `orchestrator-bridge.contract.test.ts` for the resolved route.
        expect(await messageFrom(estimateError('no-cost'))).toBe(
          'Workflow estimate returned no cost — the request was rejected before it could be priced',
        );
      });

      it('never shows the developer-facing err.message', async () => {
        const err = estimateError('failed', FAILED_REASON);
        expect(err.message).toContain('reason on .snapshot.error'); // the instrument works
        expect(await messageFrom(err)).not.toContain(err.message);
      });

      it('rethrows a NON-WorkflowEstimateError untouched', async () => {
        expect(await messageFrom(new Error('transport exploded'))).toBe('transport exploded');
      });
    });

    it('throws when a succeeded workflow released nothing at all', async () => {
      const poll = vi.fn().mockResolvedValue({ status: 'succeeded' });
      const adapter = createBridgeAdapter(mockWorkflowHelpers({ poll }));

      await expect(
        adapter.submitChatCompletion({ model: MODEL, messages: [{ role: 'user', content: 'hi' }] }),
      ).rejects.toThrow(/empty response/i);
    });

    it('cancels the last workflow when called with no id', async () => {
      const cancel = vi.fn().mockResolvedValue({ status: 'canceled' });
      const adapter = createBridgeAdapter(mockWorkflowHelpers({ cancel }));
      await adapter.submitChatCompletion({
        model: MODEL,
        messages: [{ role: 'user', content: 'hi' }],
      });
      await adapter.cancel?.();
      expect(cancel).toHaveBeenCalledWith('wf-1');
    });
  });

  describe('seam: the UI model list and the wire allowlist', () => {
    // 🔴 A RELATIONSHIP, NOT A COMPONENT. Each list is individually plausible;
    // the defect is a model offered in settings that the wire enum rejects. This
    // fails when either side gains or loses an entry.
    it('every model the settings UI offers is on the wire allowlist', () => {
      for (const m of AVAILABLE_MODELS) {
        expect(isAllowedModel(m.id)).toBe(true);
      }
    });

    it('the two lists are the same set', () => {
      expect(AVAILABLE_MODELS.map((m) => m.id).sort()).toEqual([...CHAT_COMPLETION_MODELS].sort());
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 `extractToolCalls` HAD NO TEST AT ALL — it was exported and imported by
// nothing outside its own module, which is why a mutant deleting its
// `type === 'function'` check survived the entire suite. An exported function
// with no importer in the test tree is invisible to mutation scoring: the
// battery reports a survivor and there is no test that could ever have killed
// it.
// ─────────────────────────────────────────────────────────────────────────────
describe('extractToolCalls — a type declaration is not a runtime check', () => {
  const wellFormed = {
    id: 'call_1',
    type: 'function',
    function: { name: 'search_models', arguments: '{"query":"x"}' },
  };

  it('keeps a well-formed function call — POSITIVE CONTROL', () => {
    // Without this, every assertion below is satisfied by a function that
    // returns [] unconditionally.
    expect(extractToolCalls({ toolCalls: [wellFormed] } as never)).toEqual([wellFormed]);
  });

  it('🔴 DROPS a call whose `type` is not `function`', () => {
    // `ToolCall` DECLARES `type: 'function'`, so without the runtime check the
    // predicate narrows to a type the value does not satisfy and a call of some
    // future kind is replayed verbatim as if it were a function call.
    const other = { ...wellFormed, type: 'custom' };
    expect(extractToolCalls({ toolCalls: [other] } as never)).toEqual([]);
    // ISOLATING: the same object differing ONLY in `type` is kept, so this
    // cannot be passing because some other field failed.
    expect(extractToolCalls({ toolCalls: [{ ...other, type: 'function' }] } as never)).toHaveLength(1);
  });

  it('DROPS a call with `type` absent entirely', () => {
    const { type: _dropped, ...noType } = wellFormed;
    expect(extractToolCalls({ toolCalls: [noType] } as never)).toEqual([]);
  });

  it('drops malformed calls but keeps the well-formed ones alongside them', () => {
    const calls = [
      wellFormed,
      { ...wellFormed, id: '' },
      { ...wellFormed, type: 'custom' },
      { ...wellFormed, function: { name: 'x' } },
      { ...wellFormed, id: 'call_2' },
    ];
    const kept = extractToolCalls({ toolCalls: calls } as never);
    expect(kept.map((c) => c.id)).toEqual(['call_1', 'call_2']);
  });

  it('is total on a snapshot with no tool calls', () => {
    expect(extractToolCalls({} as never)).toEqual([]);
    expect(extractToolCalls({ toolCalls: null } as never)).toEqual([]);
    expect(extractToolCalls({ toolCalls: 'nope' } as never)).toEqual([]);
  });
});

/**
 * 🔴 THE PARAMS KEY SET THE HOST ACCEPTS — the guard 0.1.6 did not have.
 *
 * The host's `chatCompletionParamsSchema` is `.strict()`, so an unknown key is a
 * BAD_REQUEST for the WHOLE request, not a dropped field. 0.1.6 sent
 * `tool_choice` (the ORCHESTRATOR's wire spelling) where the host takes
 * `toolChoice`, and because `tools`+`toolChoice` are attached whenever tool
 * declarations are available — always, once the route is live — EVERY send
 * failed, not merely tool-calling ones. The server said:
 *
 *   invalid params for step 'chat-completion':
 *     [{ "code": "unrecognized_keys", "keys": ["tool_choice"] }]
 *
 * 🔴 THIS PINS THE WHOLE SET, NOT THE ONE KEY THAT BROKE. A test asserting
 * `toolChoice` is present would pass while some future field ships a second
 * wrong spelling; `.strict()` means any unknown key is equally fatal, so the
 * guard has to be an exact-set comparison in both directions.
 *
 * The expected set is transcribed from the host's own schema
 * (`chat-completion.step.ts` — `model`, `messages`, `maxTokens`, `temperature?`,
 * `tools?`, `toolChoice?`). It is a SECOND COPY and that is acknowledged: the
 * app cannot import from the host repo. The trade is deliberate — a copy that
 * fails loudly in CI beats a mismatch that 400s every request in production.
 */
const HOST_ACCEPTED_PARAM_KEYS = new Set([
  'model',
  'messages',
  'maxTokens',
  'temperature',
  'tools',
  'toolChoice',
]);

describe('buildChatCompletionBody — params must satisfy the host .strict() schema', () => {
  const baseRequest = {
    model: CHAT_COMPLETION_MODELS[0],
    messages: [{ role: 'user' as const, content: 'hello' }],
    max_tokens: 256,
    temperature: 0.7,
  };

  it('🔴 emits NO key the host would reject — the whole set, both directions', () => {
    const withTools = buildChatCompletionBody({
      ...baseRequest,
      tools: [
        {
          type: 'function' as const,
          function: { name: 'search_models', description: 'x', parameters: { type: 'object' } },
        },
      ],
      toolChoice: 'auto' as const,
    });

    const emitted = Object.keys(withTools.params as Record<string, unknown>);
    const unknown = emitted.filter((k) => !HOST_ACCEPTED_PARAM_KEYS.has(k));
    expect(
      unknown,
      `these keys are not in the host's .strict() schema and make the WHOLE request a ` +
        `BAD_REQUEST: ${unknown.join(', ')}`,
    ).toEqual([]);
  });

  it('🔴 spells the tool-choice key `toolChoice`, never the orchestrator wire name', () => {
    // The direct regression. The host owns the camel->snake mapping; this app
    // talks to the HOST, so sending `tool_choice` skips a layer.
    const body = buildChatCompletionBody({
      ...baseRequest,
      tools: [
        {
          type: 'function' as const,
          function: { name: 'search_models', description: 'x', parameters: { type: 'object' } },
        },
      ],
      toolChoice: 'auto' as const,
    });
    const params = body.params as Record<string, unknown>;
    expect(params.toolChoice).toBe('auto');
    expect(params).not.toHaveProperty('tool_choice');
  });

  it('positive control: a tool-less request still emits only accepted keys', () => {
    // Without this, a build that emitted NOTHING would satisfy the set check
    // above vacuously.
    const plain = buildChatCompletionBody(baseRequest);
    const emitted = Object.keys(plain.params as Record<string, unknown>);
    expect(emitted.length).toBeGreaterThan(0);
    expect(emitted.filter((k) => !HOST_ACCEPTED_PARAM_KEYS.has(k))).toEqual([]);
    expect(emitted).toContain('model');
    expect(emitted).toContain('messages');
  });
});

/**
 * 🔴 THE JSON LEAK — `textOutputs` is not "the reply".
 *
 * The host pushes every publishable tool call's raw `arguments` into
 * `textOutputs` so they pass the SAME content scan as the prose
 * (`chat-completion.step.ts`). `extractReleasedText` treated that union as the
 * message, so a viewer asking a catalog question saw
 * `{"query":"popular","limit":5}` printed above the answer.
 *
 * Filtering by the RETURNED calls is exact, not heuristic: the host documents
 * that `extractText` publishes exactly the arguments of the calls
 * `extractToolCalls` returns, so no argument string can appear without its call.
 */
describe('extractReleasedText — tool-call arguments must never render as prose', () => {
  const call = (args: string) => ({
    id: 'call_1',
    type: 'function' as const,
    function: { name: 'search_models', arguments: args },
  });

  it('🔴 drops the arguments JSON and keeps the model prose', () => {
    const args = '{"query":"popular","limit":5}';
    const text = extractReleasedText({
      textOutputs: ['Let me look that up.', args],
      toolCalls: [call(args)],
    } as never);

    expect(text).toBe('Let me look that up.');
    expect(text).not.toContain('{"query"');
  });

  it('🔴 a tool-call-only round yields NO prose rather than the raw JSON', () => {
    const args = '{"query":"anime"}';
    expect(
      extractReleasedText({ textOutputs: [args], toolCalls: [call(args)] } as never),
    ).toBe('');
  });

  it('positive control: an ordinary reply is untouched', () => {
    // Without this, a filter that dropped everything would pass both above.
    expect(
      extractReleasedText({ textOutputs: ['DreamShaper is a Checkpoint.'] } as never),
    ).toBe('DreamShaper is a Checkpoint.');
  });

  it('🔴 prose that merely LOOKS like JSON survives — the filter is exact, not shape-based', () => {
    // A blanket "starts with {" filter would eat this. The model can legitimately
    // quote JSON when answering a question about an API.
    const prose = 'The body is {"query":"x"} — pass it as JSON.';
    expect(
      extractReleasedText({ textOutputs: [prose], toolCalls: [] } as never),
    ).toBe(prose);
  });
});
