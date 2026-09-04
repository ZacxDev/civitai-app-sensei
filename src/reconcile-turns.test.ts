import { describe, it, expect } from 'vitest';
import { fakeAppStorage } from './test-helpers.js';
import { startTurnRecord, turnRecordKey } from './lib/turn-records.js';
// @ts-expect-error - plain .mjs with no types; that is deliberate (it must load
// under bare `node` beside the rest of the eval tooling, so it has no build
// step). Same arrangement as `eval/reply-outcome.mjs`.
import { reconcileTurns } from '../eval/reconcile-turns.mjs';

/**
 * 🔴 THE POSITIVE CONTROL FOR THE DETECTOR.
 *
 * A reconciliation that has only ever returned zero is indistinguishable from a
 * query wired to nothing. These cases build a store containing a KNOWN lost
 * answer and watch the count move, and report the zero case beside it — the
 * pair, never the zero alone.
 *
 * The production number comes from `eval/reconcile-turns.sql`; this is the same
 * predicate in JavaScript so the suite can execute it. The last case here is
 * what stops the two drifting on the shape they share: it feeds a record built
 * by the REAL writer, so a renamed field fails a test instead of silently
 * turning every future reconciliation into a zero.
 */

const OLD = 1_700_000_000_000; // comfortably outside the settle grace window
const NOW = OLD + 86_400_000;

function turnRow(v: {
  sessionId: string;
  messageId: string;
  submittedAt: number;
  workflowIds?: string[];
  outcome?: string;
}) {
  return {
    key: turnRecordKey(v),
    value: { workflowIds: [], outcome: 'pending', ...v },
    user_id: 1,
    block_instance_id: 'bi',
  };
}

function transcriptRow(sessionId: string, ids: string[]) {
  return {
    key: `sensei:messages:${sessionId}`,
    value: ids.map((id) => ({ id, role: 'assistant', content: 'x', timestamp: OLD })),
    user_id: 1,
    block_instance_id: 'bi',
  };
}

describe('reconcileTurns — the count must be able to move', () => {
  it('ZERO: every turn record has its assistant message in the transcript', () => {
    const out = reconcileTurns(
      [
        turnRow({
          sessionId: 's1',
          messageId: 'msg-a',
          submittedAt: OLD,
          workflowIds: ['wf-1'],
          outcome: 'saved',
        }),
        transcriptRow('s1', ['msg-a']),
      ],
      { now: NOW },
    );
    expect(out.turnRecords).toBe(1);
    expect(out.lostAnswers).toBe(0);
  });

  it('🔴 POSITIVE CONTROL: a charged turn with no persisted message is ONE lost answer', () => {
    const out = reconcileTurns(
      [
        turnRow({
          sessionId: 's1',
          messageId: 'msg-a',
          submittedAt: OLD,
          workflowIds: ['wf-1'],
          outcome: 'saved',
        }),
        turnRow({
          sessionId: 's1',
          messageId: 'msg-lost',
          submittedAt: OLD + 1000,
          workflowIds: ['wf-2'],
          outcome: 'pending',
        }),
        transcriptRow('s1', ['msg-a']),
      ],
      { now: NOW },
    );
    expect(out.turnRecords).toBe(2);
    expect(out.lostAnswers).toBe(1);
    expect(out.aContinuationNeverRan).toBe(1);
    expect(out.lost[0].messageId).toBe('msg-lost');
    expect(out.lost[0].workflowIds).toEqual(['wf-2']);
  });

  it('the three mechanisms are told apart by the record`s own outcome', () => {
    const out = reconcileTurns(
      [
        turnRow({
          sessionId: 's1',
          messageId: 'm-a',
          submittedAt: OLD,
          workflowIds: ['w'],
          outcome: 'pending',
        }),
        turnRow({
          sessionId: 's1',
          messageId: 'm-b',
          submittedAt: OLD,
          workflowIds: ['w'],
          outcome: 'write-failed',
        }),
        turnRow({
          sessionId: 's1',
          messageId: 'm-c',
          submittedAt: OLD,
          workflowIds: ['w'],
          outcome: 'saved',
        }),
        transcriptRow('s1', []),
      ],
      { now: NOW },
    );
    expect(out.aContinuationNeverRan).toBe(1);
    expect(out.bWriteRejected).toBe(1);
    expect(out.cOverwritten).toBe(1);
    // The decomposition adds up, which is the cheapest check a reader has.
    expect(out.aContinuationNeverRan + out.bWriteRejected + out.cOverwritten).toBe(out.lostAnswers);
  });

  it('a turn that never reached the orchestrator is NOT a lost answer — nothing was charged', () => {
    const out = reconcileTurns(
      [
        turnRow({ sessionId: 's1', messageId: 'm-x', submittedAt: OLD, workflowIds: [] }),
        transcriptRow('s1', []),
      ],
      { now: NOW },
    );
    expect(out.lostAnswers).toBe(0);
    expect(out.lostNeverSubmitted).toBe(1);
  });

  it('a reply the write-ownership gate discarded is counted apart, not as a new defect', () => {
    const out = reconcileTurns(
      [
        turnRow({
          sessionId: 's1',
          messageId: 'm-s',
          submittedAt: OLD,
          workflowIds: ['w'],
          outcome: 'discarded',
        }),
        transcriptRow('s1', []),
      ],
      { now: NOW },
    );
    expect(out.lostAnswers).toBe(0);
    expect(out.acceptedDiscarded).toBe(1);
  });

  it('a turn younger than the settle grace is still in flight and is not graded', () => {
    const out = reconcileTurns(
      [
        turnRow({ sessionId: 's1', messageId: 'm-y', submittedAt: NOW - 1000, workflowIds: ['w'] }),
        transcriptRow('s1', []),
      ],
      { now: NOW },
    );
    expect(out.turnRecords).toBe(0);
    expect(out.lostAnswers).toBe(0);
  });

  it('two viewers with the same session id are not reconciled against each other', () => {
    const mine = turnRow({
      sessionId: 's1',
      messageId: 'm-mine',
      submittedAt: OLD,
      workflowIds: ['w'],
    });
    const theirs = { ...transcriptRow('s1', ['m-mine']), user_id: 2 };
    const out = reconcileTurns([mine, theirs], { now: NOW });
    expect(out.lostAnswers).toBe(1);
  });

  it('🔴 SEAM: a record written by the REAL writer reconciles — field names agree', async () => {
    const storage = fakeAppStorage();
    const rec = startTurnRecord(storage.appStorage, {
      sessionId: 's-seam',
      messageId: 'msg-seam',
      submittedAt: OLD,
    });
    rec.workflow('wf-seam');
    // Let the chained writes land before reading the store back.
    await new Promise((r) => setTimeout(r, 0));

    const rows = [...storage.store.entries()].map(([key, value]) => ({
      key,
      value,
      user_id: 1,
      block_instance_id: 'bi',
    }));

    // 🔴 THE STORE IS READ AS-WRITTEN, not rebuilt from a fixture, so a rename
    // in `TurnRecord` shows up HERE rather than as a permanent zero in
    // production. The transcript deliberately does not contain `msg-seam`.
    const lostRun = reconcileTurns([...rows, transcriptRow('s-seam', [])], { now: NOW });
    expect(lostRun.lostAnswers).toBe(1);
    expect(lostRun.aContinuationNeverRan).toBe(1);
    expect(lostRun.lost[0].workflowIds).toEqual(['wf-seam']);

    // And the same record against a transcript that DOES hold it: zero.
    const foundRun = reconcileTurns([...rows, transcriptRow('s-seam', ['msg-seam'])], { now: NOW });
    expect(foundRun.turnRecords).toBe(1);
    expect(foundRun.lostAnswers).toBe(0);
  });
});
