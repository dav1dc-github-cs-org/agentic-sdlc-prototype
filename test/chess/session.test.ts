import assert from 'node:assert/strict';
import test from 'node:test';

import { createSession } from '../../src/chess/session.ts';
import type { Move } from '../../src/chess/game.ts';

/** Resolves on the next microtask turn, letting queued reply promises settle. */
function flush(): Promise<void> {
  return Promise.resolve().then(() => Promise.resolve());
}

test('queues and applies a computer reply for the non-human side', async () => {
  const session = createSession({ mode: 'computer', humanColor: 'w' });
  // White (human) moves first so it becomes Black's (computer's) turn.
  session.applyHumanMove({ from: 'e2', to: 'e4' });
  assert.equal(session.isComputerTurn(), true);

  const requestId = session.queueComputerReply((game) => game.legalMovesVerbose()[0]);
  assert.ok(requestId);
  assert.equal(session.isComputerReplyPending(), true);

  await flush();

  assert.equal(session.isComputerReplyPending(), false);
  assert.equal(session.getGame().turn(), 'w');
  assert.equal(session.getGame().history().length, 2);
});

test('a stale callback invoked after the position has changed does not alter game state, even invoked twice', async () => {
  const session = createSession({ mode: 'computer', humanColor: 'w' });
  session.applyHumanMove({ from: 'e2', to: 'e4' });

  let resolveMove!: (move: Move | undefined) => void;
  const pendingMove = new Promise<Move | undefined>((resolve) => {
    resolveMove = resolve;
  });
  const chosen = session.getGame().legalMovesVerbose()[0];
  session.queueComputerReply(() => pendingMove);

  // Position changes via undo before the async selection resolves.
  session.undo();
  const fenAfterUndo = session.getGame().fen();
  assert.equal(session.isComputerReplyPending(), false);

  // The stale callback resolves late, and is invoked again with the same
  // resolved value to simulate a duplicate delivery.
  resolveMove(chosen);
  await flush();
  await flush();

  assert.equal(session.getGame().fen(), fenAfterUndo);
  assert.equal(session.getGame().history().length, 0);
});

test('undo issued while a computer reply is queued cancels that reply and restores the pre-move position; the stale callback later has no effect', async () => {
  const session = createSession({ mode: 'computer', humanColor: 'w' });
  session.applyHumanMove({ from: 'e2', to: 'e4' });
  const fenBeforeReply = session.getGame().fen();

  let resolveMove!: (move: Move | undefined) => void;
  const pendingMove = new Promise<Move | undefined>((resolve) => {
    resolveMove = resolve;
  });
  const chosen = session.getGame().legalMovesVerbose()[0];
  session.queueComputerReply(() => pendingMove);
  assert.equal(session.isComputerReplyPending(), true);

  const undone = session.undo();
  assert.ok(undone);
  assert.equal(session.isComputerReplyPending(), false);
  assert.equal(session.getGame().fen(), 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');

  resolveMove(chosen);
  await flush();

  // The undo already restored the starting position; the stale reply must
  // not resurrect the move it was queued against.
  assert.notEqual(session.getGame().fen(), fenBeforeReply);
  assert.equal(session.getGame().fen(), 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  assert.equal(session.getGame().history().length, 0);
});

test('starting a new game while an old reply is pending discards that reply without affecting the new game', async () => {
  const session = createSession({ mode: 'computer', humanColor: 'w' });
  session.applyHumanMove({ from: 'e2', to: 'e4' });

  let resolveMove!: (move: Move | undefined) => void;
  const pendingMove = new Promise<Move | undefined>((resolve) => {
    resolveMove = resolve;
  });
  const chosen = session.getGame().legalMovesVerbose()[0];
  session.queueComputerReply(() => pendingMove);
  assert.equal(session.isComputerReplyPending(), true);

  session.newGame();
  assert.equal(session.isComputerReplyPending(), false);
  assert.equal(session.getGame().fen(), 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');

  // A human move is made in the new game before the stale reply resolves.
  session.applyHumanMove({ from: 'd2', to: 'd4' });
  const fenAfterNewGameMove = session.getGame().fen();

  resolveMove(chosen);
  await flush();

  assert.equal(session.getGame().fen(), fenAfterNewGameMove);
  assert.deepEqual(session.getGame().history(), ['d4']);
});

test('no computer reply is queued or applied once the game has ended (checkmate)', async () => {
  // Fool's mate reached purely via human moves (mode starts Local so both
  // sides are human-controlled), then switched to Computer mode to confirm
  // a terminal position refuses to queue a reply regardless of whose turn
  // it would nominally be.
  const session = createSession({ mode: 'local' });
  session.applyHumanMove({ from: 'f2', to: 'f3' });
  session.applyHumanMove({ from: 'e7', to: 'e5' });
  session.applyHumanMove({ from: 'g2', to: 'g4' });
  session.applyHumanMove({ from: 'd8', to: 'h4' });
  assert.equal(session.getGame().isGameOver(), true);
  assert.equal(session.getGame().result().reason, 'checkmate');

  session.setMode('computer');
  const requestId = session.queueComputerReply((g) => g.legalMovesVerbose()[0]);
  assert.equal(requestId, null);
  assert.equal(session.isComputerReplyPending(), false);

  await flush();
  assert.equal(session.isComputerReplyPending(), false);
});

test('only one computer reply can be in-flight at a time per session instance', async () => {
  const session = createSession({ mode: 'computer', humanColor: 'w' });
  session.applyHumanMove({ from: 'e2', to: 'e4' });

  const first = session.queueComputerReply(() => new Promise(() => {})); // never resolves
  assert.ok(first);
  const second = session.queueComputerReply(() => session.getGame().legalMovesVerbose()[0]);
  assert.equal(second, null);
  assert.equal(session.isComputerReplyPending(), true);
});

test('page-hidden and dialog-open events cancel a pending reply', async () => {
  const hiddenSession = createSession({ mode: 'computer', humanColor: 'w' });
  hiddenSession.applyHumanMove({ from: 'e2', to: 'e4' });
  hiddenSession.queueComputerReply(() => new Promise(() => {}));
  assert.equal(hiddenSession.isComputerReplyPending(), true);
  hiddenSession.onPageHidden();
  assert.equal(hiddenSession.isComputerReplyPending(), false);

  const dialogSession = createSession({ mode: 'computer', humanColor: 'w' });
  dialogSession.applyHumanMove({ from: 'e2', to: 'e4' });
  dialogSession.queueComputerReply(() => new Promise(() => {}));
  assert.equal(dialogSession.isComputerReplyPending(), true);
  dialogSession.onDialogOpen();
  assert.equal(dialogSession.isComputerReplyPending(), false);
});

test('dispose cancels a pending reply and blocks future queueing', async () => {
  const session = createSession({ mode: 'computer', humanColor: 'w' });
  session.applyHumanMove({ from: 'e2', to: 'e4' });
  session.queueComputerReply(() => new Promise(() => {}));
  assert.equal(session.isComputerReplyPending(), true);

  session.dispose();
  assert.equal(session.isComputerReplyPending(), false);

  const requestId = session.queueComputerReply(() => session.getGame().legalMovesVerbose()[0]);
  assert.equal(requestId, null);
});

test('mode, human color, and revision accessors reflect session state and setters cancel a pending reply', () => {
  const session = createSession({ mode: 'local', humanColor: 'b' });
  assert.equal(session.getMode(), 'local');
  assert.equal(session.getHumanColor(), 'b');
  assert.equal(session.getRevision(), 0);

  session.applyHumanMove({ from: 'e2', to: 'e4' });
  assert.equal(session.getRevision(), 1);

  session.setMode('computer');
  assert.equal(session.getMode(), 'computer');
  session.setHumanColor('w');

  session.queueComputerReply(() => new Promise(() => {}));
  assert.equal(session.isComputerReplyPending(), true);
  session.setHumanColor('b');
  assert.equal(session.getHumanColor(), 'b');
  assert.equal(session.isComputerReplyPending(), false);
});

test('does not queue a reply in Local mode or when it is the human turn', () => {
  const localSession = createSession({ mode: 'local' });
  assert.equal(localSession.queueComputerReply(() => undefined), null);

  const computerSession = createSession({ mode: 'computer', humanColor: 'w' });
  // It is White's (human's) turn from the start; the computer plays Black.
  assert.equal(computerSession.isComputerTurn(), false);
  assert.equal(computerSession.queueComputerReply(() => undefined), null);
});

test('a resolved but no-longer-legal move is not applied even when instance and revision still match', async () => {
  const session = createSession({ mode: 'computer', humanColor: 'w' });
  session.applyHumanMove({ from: 'e2', to: 'e4' });

  let resolveMove!: (move: Move | undefined) => void;
  const pendingMove = new Promise<Move | undefined>((resolve) => {
    resolveMove = resolve;
  });
  session.queueComputerReply(() => pendingMove);

  const fenBeforeResolve = session.getGame().fen();
  // Fabricate a move object referencing squares that are not a legal
  // Black reply in this position.
  const bogusMove = { from: 'e7', to: 'e3', promotion: undefined } as unknown as Move;
  resolveMove(bogusMove);
  await flush();

  assert.equal(session.getGame().fen(), fenBeforeResolve);
  assert.equal(session.getGame().history().length, 1);
});
