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
