import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createBridgeAdapter,
  buildChatCompletionBody,
  toStepMessages,
  extractReleasedText,
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

    it('NEVER forwards tools, tool_choice, response_format or stream', () => {
      const body = buildChatCompletionBody({
        model: MODEL,
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        tool_choice: 'auto',
        response_format: { type: 'json_object' },
        tools: [
          {
            type: 'function',
            function: { name: 'search_models', description: 'd', parameters: {} },
          },
        ],
      });
      for (const banned of [
        'tools',
        'tool_choice',
        'response_format',
        'stream',
        'max_tokens',
        'modalities',
      ]) {
        expect(banned in body.params).toBe(false);
      }
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
      const out = toStepMessages([
        { role: 'user', content: 'find me a model' },
        { role: 'tool', content: '{"items":[]}', tool_call_id: 'tc-1' },
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
      expect(result.choices[0].message.tool_calls).toBeUndefined();
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

      await adapter.submitChatCompletion(
        { model: MODEL, messages: [{ role: 'user', content: 'hi' }] },
        (c) => chunks.push(c),
      );

      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.join('')).toContain('Hello from the bridge!');
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

    it('throws on a zero cost estimate', async () => {
      const estimate = vi.fn().mockResolvedValue({ cost: { total: 0 } });
      const adapter = createBridgeAdapter(mockWorkflowHelpers({ estimate }));

      await expect(
        adapter.submitChatCompletion({ model: MODEL, messages: [{ role: 'user', content: 'hi' }] }),
      ).rejects.toThrow('zero or missing cost');
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
