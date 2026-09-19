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
      ).rejects.toThrow(/priced this request at 0/i);

      expect(helpers.submit).not.toHaveBeenCalled();
    });

    it('does NOT submit when a FAILED estimate came back carrying a price', async () => {
      // 🔴 THE ONE DIMENSION THE GATE NEVER CHECKED, AND THE ONLY ONE THAT CAN SPEND
      // BUZZ. `WorkflowEstimateError.code`'s docs are explicit that a `'failed'`
      // estimate CAN carry a numeric cost — a whatIf the orchestrator itself reports
      // as failed maps to `'failed'` through the server's `ORCH_STATUS_MAP` — so a
      // finite positive number is not evidence the request was priced. Measured
      // before the fix: this exact snapshot walked both cost gates and the adapter
      // SUBMITTED (`submit.mock.calls.length === 1`), completing the turn against a
      // price the server had already disowned.
      //
      // 🔴 IT WAS NOT UNREACHABLE — IT WAS GUARDED SOMEWHERE ELSE. In production
      // `useBuzzWorkflow` rejects this shape before the adapter sees it, so the only
      // thing standing between this snapshot and a charge was the INSTALLED HOOK
      // VERSION. Every test in this repo injects its own `WorkflowHelpers`, and so
      // may any other consumer of `createBridgeAdapter`. The invariant belongs to the
      // adapter, which is what this pins.
      //
      // The fixture is the host's real failure shape: the sentinel `workflowId`, the
      // server's own prose, and a cost that is unambiguously usable-looking.
      const estimate = vi.fn().mockResolvedValue({
        workflowId: 'failed',
        status: 'failed',
        error: 'orchestrator whatIf failed',
        cost: { total: 500 },
      });
      const helpers = mockWorkflowHelpers({ estimate });
      const adapter = createBridgeAdapter(helpers);

      let message: string | undefined;
      try {
        await adapter.submitChatCompletion({ model: MODEL, messages: ONE_MESSAGE });
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message, 'the estimate gate resolved a FAILED estimate').toBeTypeOf('string');

      // 🔴 THE MONEY ASSERTION. Everything else here is about wording; this is the
      // one the finding was about.
      expect(helpers.submit, 'submitted against a FAILED estimate').not.toHaveBeenCalled();

      // Attributed to the ESTIMATE, and carrying the server's own words — the same
      // derivation `estimateRejectionMessage`'s `'failed'` arm uses, which is what
      // makes the resolved and rejected routes read alike. The whole string, because
      // it is also what refuses the three wrong labels for this state in one
      // assertion: "returned no cost" (false — a number DID come back), "priced this
      // request at 500" (false — the server disowned that number), and anything
      // naming the SUBMIT (the 0.1.6 misdiagnosis). Spelled-out `not.toContain`
      // checks for those alongside this line could never execute.
      expect(message).toBe('Workflow estimate failed — orchestrator whatIf failed');
    });

    it('does NOT submit when a PRICED estimate came back on any status but a usable one', async () => {
      // 🔴 THE SIBLINGS THE FIRST VERSION OF THAT GATE LET THROUGH. It tested
      // `status === 'failed'` and nothing else, so the three other ways an estimate
      // can arrive already decided still spent Buzz. Measured at `7de41a8` with this
      // exact fixture, one status at a time:
      //
      //     failed      submits=0   (the case above; the gate worked)
      //     canceled    submits=1   ← turn completed, Buzz spent
      //     expired     submits=1   ← same
      //     unassigned  submits=1   ← same
      //
      // 🔴 REACHABLE THROUGH THE INSTALLED HOOK, WHICH IS WHY IT IS NOT MERELY
      // DEFENSIVE. `useBuzzWorkflow.estimate`'s guard is `status === 'failed'` OR "no
      // numeric `cost.total`"; `{status:'canceled', cost:{total:500}}` satisfies
      // neither clause and RESOLVES out of the hook into this adapter. Upstream's own
      // comment says `canceled`/`expired` "are covered by the same clause (they carry
      // no cost)" — an assertion about what the server sends today, not an invariant
      // anything enforces.
      //
      // 🔴 `unassigned` IS THE DELIBERATE DEPARTURE FROM THIS FILE'S FIXTURE
      // DISCIPLINE, and it is chosen rather than invented. `BlockWorkflowSnapshot`'s
      // own docs say the union "omits orchestrator-internal states like
      // `unassigned`" and that the HOST is responsible for mapping such a state onto
      // one of the six — i.e. the union is a host-maintained mapping, and a value
      // outside it reaching this adapter is a host bug or a status added after this
      // build. A textbook `'frobnicated'` would test the same branch while proving
      // nothing about a shape the stack can produce. It reaches the adapter only
      // because `mockResolvedValue` is untyped — which is the hazard restated: the
      // union is a compile-time claim, and nothing enforces it at runtime.
      //
      // 🔴 THE ASSERTIONS ARE ORDERED SO THE RED NAMES THE STATUS. Written with
      // `rejects.toThrow` first, a narrow predicate failed on "promise resolved
      // instead of rejecting" — true, but it names no status, so the one red line
      // could not say WHICH sibling leaked. Capturing the outcome and asserting the
      // MONEY first puts the status in every message, which is also the file's own
      // order of importance: the wording is secondary to whether Buzz moved.
      const NOT_USABLE = ['failed', 'canceled', 'expired', 'unassigned'] as const;

      for (const status of NOT_USABLE) {
        const estimate = vi.fn().mockResolvedValue({
          workflowId: 'failed',
          status,
          error: 'orchestrator whatIf failed',
          cost: { total: 500 },
        });
        const helpers = mockWorkflowHelpers({ estimate });
        const adapter = createBridgeAdapter(helpers);

        let message: string | undefined;
        try {
          await adapter.submitChatCompletion({ model: MODEL, messages: ONE_MESSAGE });
        } catch (err) {
          message = (err as Error).message;
        }

        // 🔴 THE MONEY ASSERTION, per status, naming the status.
        expect(helpers.submit, `submitted against a ${status} estimate`).not.toHaveBeenCalled();
        expect(
          message,
          `a ${status} estimate carrying a price was accepted as a quote`,
        ).toBe('Workflow estimate failed — orchestrator whatIf failed');
      }
    });

    it('still submits when a usable estimate carries a price — the status gate is not merely closed', async () => {
      // Positive control for the two cases above, and specifically for the STATUS
      // half: a gate that refused every snapshot carrying a `status` would satisfy
      // both and break every turn. Each entry kills a distinct mutant of
      // `isTerminalWithoutSuccess`, which is why this is a list and not one fixture:
      //
      //   - `pending`    — the status a real priced whatIf comes back with. Drop it
      //     from `IN_FLIGHT_STATUSES` and every turn dies.
      //   - `processing` — the other in-flight status. Nothing else in the suite
      //     exercises it on the ESTIMATE, so without it `IN_FLIGHT_STATUSES` can be
      //     narrowed to `['pending']` and stay green.
      //   - `succeeded`  — kills the mutant that drops the `!== 'succeeded'` clause,
      //     which would otherwise refuse an estimate that reported success.
      //   - `undefined`  — no `status` field at all, which is what the mock host and
      //     every other fixture in this repo produce. Kills the mutant that drops
      //     the `status !== undefined` clause and refuses the happy path.
      const USABLE = ['pending', 'processing', 'succeeded', undefined] as const;

      for (const status of USABLE) {
        const estimate = vi.fn().mockResolvedValue({
          workflowId: 'wf_01JQZ8ESTM',
          ...(status === undefined ? {} : { status }),
          cost: { total: 500 },
        });
        const helpers = mockWorkflowHelpers({ estimate });
        const adapter = createBridgeAdapter(helpers);

        await adapter.submitChatCompletion({ model: MODEL, messages: ONE_MESSAGE });

        expect(
          helpers.submit,
          `refused to submit against an estimate whose status was ${String(status)}`,
        ).toHaveBeenCalledTimes(1);
      }
    });

    it('does NOT submit when the estimate carries no cost at all', async () => {
      // A snapshot with no `cost` object is the shape a failed estimate returns.
      // It must read as zero, not as "unknown, proceed anyway".
      const estimate = vi.fn().mockResolvedValue({ status: 'pending' });
      const helpers = mockWorkflowHelpers({ estimate });
      const adapter = createBridgeAdapter(helpers);

      await expect(
        adapter.submitChatCompletion({ model: MODEL, messages: ONE_MESSAGE }),
      ).rejects.toThrow(/returned no cost/i);

      expect(helpers.submit).not.toHaveBeenCalled();
    });
  });

  describe('an estimate failure is not reported as a billing failure', () => {
    // 🔴 THE REGRESSION THIS SUITE EXISTS FOR. Both states below used to throw
    // the single string "Workflow estimate returned zero or missing cost", so a
    // request the host never PRICED was indistinguishable on screen from one it
    // priced at nothing — and the first reads as "you have no Buzz". That cost a
    // real diagnosis once (see `buildChatCompletionBody`'s 0.1.6 note).
    //
    // 🔴 WHAT PINS THE SPLIT IS THE WORDING ASSERTIONS, NOT THE INEQUALITY —
    // an earlier version of this comment claimed the opposite and was measured
    // false. A collapsed single-template implementation interpolating the value
    // (`…zero or missing cost (undefined)` vs `…(0)`) PASSES `not.toBe`, because
    // two different renderings of one message are still two different strings.
    // So `not.toBe` is necessary and nowhere near sufficient. Two things carry
    // the guarantee instead, and they are NOT interchangeable — an earlier
    // version of this paragraph listed them as if they were, and said both
    // "must survive a reword", which is false of the first by definition:
    //   - the `toThrow(/…/)` assertions above KILL the collapse but are SPELLED:
    //     reword either message and they must be rewritten. They are a pin on
    //     today's wording, not an invariant.
    //   - `the unpriced message is not the priced TEMPLATE with the price left
    //     out`, below, is the wording-INDEPENDENT half: it derives the template
    //     from the implementation's own two priced outputs and enumerates no
    //     spelling, so a reword carries it along unchanged.
    // 🔴 AND NEITHER IS COMPLETE — an earlier version of this line said "relax
    // the regexes and the template test still holds the line", which claims a
    // completeness the template test does not have. It catches a collapse only
    // where every byte outside the price slot is identical; a collapse whose
    // empty slot reads as WORDS is measured to walk past it. So the two halves
    // are complements with a gap between them, not a belt and braces: relaxing
    // the regexes really does lose coverage, and the template test is what
    // survives a reword, not a replacement for them.

    type Estimate = WorkflowHelpers['estimate'];

    const unpricedEstimate = (): Estimate => vi.fn().mockResolvedValue({ status: 'failed' });
    const pricedAt = (total: number): Estimate => vi.fn().mockResolvedValue({ cost: { total } });
    const zeroPriceEstimate = (): Estimate => pricedAt(0);

    const commonPrefix = (a: string, b: string): string => {
      let i = 0;
      while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
      return a.slice(0, i);
    };
    const commonSuffix = (a: string, b: string): string => {
      let i = 0;
      while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i += 1;
      return a.slice(a.length - i);
    };

    const messageFrom = async (estimate: Estimate): Promise<string> => {
      const adapter = createBridgeAdapter(mockWorkflowHelpers({ estimate }));
      try {
        await adapter.submitChatCompletion({ model: MODEL, messages: ONE_MESSAGE });
      } catch (err) {
        return (err as Error).message;
      }
      throw new Error('expected the estimate gate to reject, but it resolved');
    };

    it('estimate-gate-rejects-every-value-that-is-not-a-finite-number', async () => {
      // 🔴 THIS IS THE MONEY GATE, AND IT USED TO LEAK. The old test was
      // `(cost?.total ?? 0) > 0`. `NaN` slips past `<= 0` because every NaN
      // comparison is false; `Infinity > 0` is true; `"5" > 0` coerces. All three
      // therefore SUBMITTED — real Buzz spent on a request that was never priced.
      // Without this case the `typeof`/`Number.isFinite` half of the guard can be
      // deleted and the whole suite stays green, so the leak returns silently.
      //
      // 🔴 SCOPE: this pins the REJECTIONS only. The name used to say "admits only a
      // finite positive price", which was wider than the body on both halves — it
      // asserts no admission (that is the positive control below) and never
      // exercises 0 or a negative (that is the `total <= 0` branch, pinned in
      // `orchestrator-bridge.test.ts`). Deleting the `total <= 0` branch leaves
      // this test green.
      const notPrices = [NaN, Infinity, -Infinity, '5' as unknown as number, null, undefined];

      for (const value of notPrices) {
        const estimate: Estimate = vi.fn().mockResolvedValue({ cost: { total: value } });
        const helpers = mockWorkflowHelpers({ estimate });
        const adapter = createBridgeAdapter(helpers);

        await expect(
          adapter.submitChatCompletion({ model: MODEL, messages: ONE_MESSAGE }),
        ).rejects.toThrow(/returned no cost/i);

        expect(helpers.submit, `submitted on cost.total = ${String(value)}`).not.toHaveBeenCalled();
      }
    });

    it('still submits on a legitimate positive price — the gate is not merely closed', async () => {
      // Positive control for the case above: a guard that rejected EVERYTHING
      // would satisfy every assertion in this describe block and be useless.
      const estimate: Estimate = vi.fn().mockResolvedValue({ cost: { total: 4 } });
      const helpers = mockWorkflowHelpers({ estimate });
      const adapter = createBridgeAdapter(helpers);

      await adapter.submitChatCompletion({ model: MODEL, messages: ONE_MESSAGE });

      expect(helpers.submit).toHaveBeenCalled();
    });

    it('gives an UNPRICED estimate and a ZERO-PRICED one different messages', async () => {
      const unpriced = await messageFrom(unpricedEstimate());
      const zeroPriced = await messageFrom(zeroPriceEstimate());

      expect(unpriced).not.toBe(zeroPriced);
    });

    it('surfaces the host’s own reason when the snapshot carries one', async () => {
      // The reason was always on the snapshot; the old guard threw it away and
      // invented a message about cost instead.
      const estimate: Estimate = vi.fn().mockResolvedValue({
        status: 'failed',
        error: "invalid params for step 'chat-completion': unrecognized_keys",
      });

      await expect(messageFrom(estimate)).resolves.toContain('unrecognized_keys');
    });

    it('the unpriced message is not the priced TEMPLATE with the price left out', async () => {
      // 🔴 THIS DERIVES THE TEMPLATE FROM THE IMPLEMENTATION'S OWN OUTPUT AND
      // ENUMERATES NO SPELLING — which is what the previous version of this test
      // got wrong. It asserted the message contained none of `undefined`/`NaN`/
      // `null`/`()`, called itself "wording-independent BY CONSTRUCTION", and was
      // then walked straight past by a collapsed implementation that rendered the
      // missing price as an em-dash. A hardcoded list of four spellings is a
      // SPELLED guard; the hazard has infinitely many spellings.
      //
      // The real invariant has no spelling at all: two PRICED messages differ ONLY
      // where the number goes, so their common prefix and suffix ARE the priced
      // template. If the unpriced message also matches that template, both branches
      // are one message and the split is gone — whatever the prose says, and
      // whatever it renders in the empty slot.
      //
      // 🔴 WHAT IT DOES NOT CATCH, STATED SO NOBODY READS IT AS COMPLETE. It sees
      // a collapse only where every byte OUTSIDE the slot is identical. A collapse
      // that renders the empty slot as WORDS rather than a symbol perturbs bytes
      // next to the slot and walks past — measured, a single-template throw whose
      // slot reads `without any price at all` keeps the suite green. So this is a
      // wording-INDEPENDENT guard, not a collapse-COMPLETE one; the two are
      // different claims and only the first is made here.
      const zero = await messageFrom(zeroPriceEstimate());
      const negative = await messageFrom(pricedAt(-3));
      const unpriced = await messageFrom(unpricedEstimate());

      const prefix = commonPrefix(zero, negative);
      const suffix = commonSuffix(zero, negative);

      // 🔴 GUARD THE GUARD — and on the right quantity. A SUM was measured to
      // admit both degenerate modes it was meant to exclude, because it passes
      // when either anchor alone is non-empty:
      //   - shared EVERYTHING: if the two priced messages are byte-identical
      //     (e.g. the price stops being interpolated) both anchors span the whole
      //     string, the sum double-counts, and the assertion silently decays into
      //     `unpriced !== zero` — the very inequality this block calls "nowhere
      //     near sufficient". Silent, so nothing would ever report it.
      //   - ONE-SIDED: with the number at the end, `suffix` is empty,
      //     `endsWith('')` is always true, and the test reduces to a prefix
      //     comparison — which then FALSE-ACCUSES a genuinely split implementation
      //     that merely shares a lead-in. That is how a good guard gets deleted.
      // Requiring both anchors non-empty AND a real slot between them makes the
      // test say "I cannot judge this message family" instead of either.
      expect(zero, 'the two priced messages must differ for a template to exist').not.toBe(
        negative,
      );
      expect(prefix.length, 'no shared lead-in: cannot derive a template').toBeGreaterThan(0);
      expect(suffix.length, 'no shared tail: cannot derive a template').toBeGreaterThan(0);
      expect(
        prefix.length + suffix.length,
        'the anchors leave no slot between them: cannot derive a template',
      ).toBeLessThan(Math.min(zero.length, negative.length));

      expect(
        unpriced.startsWith(prefix) && unpriced.endsWith(suffix),
        `unpriced message is the priced template with an empty slot: ${unpriced}`,
      ).toBe(false);
    });

    it('does not claim a reason it was not given, nor a rejection that did not happen', async () => {
      // Negative control for the test above: with no `error` on the snapshot the
      // message must fall back, not fabricate. Without this, a hardcoded string
      // containing "unrecognized_keys" would pass the previous test.
      //
      // 🔴 AND THE FALLBACK ITSELF WAS A FABRICATION UNTIL THIS ROUND. It read `the
      // request was rejected before it could be priced`, which this test then pinned
      // — so the suite was ENFORCING the false claim. Its sibling route, the
      // `'no-cost'` rejection arm, is documented as *a NON-FAILED reply with no
      // numeric cost*: nothing is rejected there, and it usually carries no
      // `snapshot.error`, so the invented sentence was what fired most often.
      //
      // 🔴 ONE ASSERTION, DELIBERATELY. This was `not.toContain('unrecognized_keys')`
      // plus `toMatch(/rejected before it could be priced/i)` — the second of which
      // meant the suite was ENFORCING the false claim. The whole-string pin is
      // strictly stronger than both, refuses the fabricated reason AND the fabricated
      // rejection, and fails if either is reinstated under any spelling or constant
      // name; keeping the two spelled checks beside it would be two assertions that
      // can never execute.
      const message = await messageFrom(unpricedEstimate());

      expect(message).toBe('Workflow estimate returned no cost — the server gave no reason');
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
      return buildChatCompletionBody({ model: MODEL, messages: ONE_MESSAGE, ...request }).input;
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

    it('stops on a status it does not recognise, rather than polling to the deadline', async () => {
      // 🔴 WHAT PINS THE SECOND HALF OF THE CONSOLIDATION. The estimate gate and this
      // loop now share `isTerminalWithoutSuccess`; without this case the loop can be
      // reverted to its old open-coded `succeeded || failed || expired || canceled`
      // enumeration and the whole suite stays green — i.e. the two spellings this
      // round merged would be free to diverge again, silently, on the money path.
      //
      // The behaviour it pins is the fail-closed direction of that merge. Before it,
      // an unrecognised status read as in-flight: the loop kept going for the full
      // 60 s deadline and then reported `timed out before the first poll`'s sibling
      // timeout — throwing away the server's own words, which were in hand on the
      // first poll. `unassigned` is the same realistic out-of-union value the estimate
      // case above uses, for the same reason.
      //
      // 🔴 THE BUZZ IS ALREADY SPENT BY THE TIME THIS LOOP RUNS, AND THAT IS WHY THE
      // SECOND POLL REPLY IS IN THE FIXTURE. What the consolidation costs on this
      // path is not only which sentence the viewer gets: the pre-fix loop would have
      // polled again and RESOLVED with `a late answer`, a reply the viewer had
      // already paid for. Accepting that is a judgement, argued at the loop itself —
      // fail-closed on a spent path, bounded by the 60 s deadline, and unreachable
      // unless the host breaks its own documented status-mapping contract.
      //
      // 🔴 ITS RED IS AN ASSERTION, NOT A TIMEOUT, AND THE TWO-ELEMENT QUEUE IS WHAT
      // BUYS THAT. Watched against the pre-consolidation loop (the open-coded
      // `succeeded || failed || expired || canceled` enumeration this replaced):
      // `AssertionError: promise resolved "{ id: 'wf-1', replay: Promise{…}, …(2) }"
      // instead of rejecting`, in 1,015 ms. An earlier version of this comment
      // claimed a timeout was UNAVOIDABLE here because the call never settles. That
      // is true only of a queue that answers `unassigned` forever — re-measured with
      // the fixture reduced to a single `mockResolvedValue`: `Error: Test timed out
      // in 5000ms.`, 5,009 ms — and false of this one, which settles on the second
      // poll. ~5× cheaper, it names what actually went wrong, and it is the variant
      // that exhibits the discarded answer above. Green at head, on the first poll.
      const poll = vi
        .fn()
        .mockResolvedValueOnce({ status: 'unassigned', error: 'orchestrator dropped the workflow' })
        .mockResolvedValueOnce(succeededSnapshot(['a late answer']));
      const helpers = mockWorkflowHelpers({ poll });
      const adapter = createBridgeAdapter(helpers);

      await expect(
        adapter.submitChatCompletion({ model: MODEL, messages: ONE_MESSAGE }),
      ).rejects.toThrow('orchestrator dropped the workflow');

      // ONE poll, not sixty: the loop broke on the first reply rather than treating
      // an unknown status as "still working".
      expect(helpers.poll, 'kept polling a workflow that had already stopped').toHaveBeenCalledTimes(
        1,
      );
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
