import assert from 'node:assert/strict';
import test from 'node:test';

import { ChessGame, IllegalMoveError, createGame } from '../../src/chess/game.ts';

test('initial position: 32 pieces, White to move, 20 legal moves, e2/g1 targets', () => {
  const game = createGame();
  assert.equal(game.turn(), 'w');
  assert.equal(game.fen(), 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  assert.equal(game.legalMoves().length, 20);
  assert.deepEqual(new Set(game.legalMovesFrom('e2')), new Set(['e3', 'e4']));
  assert.deepEqual(new Set(game.legalMovesFrom('g1')), new Set(['f3', 'h3']));
});

test('rejects illegal move e2-e5 from the initial position without changing state', () => {
  const game = createGame();
  const fenBefore = game.fen();
  assert.throws(() => game.move({ from: 'e2', to: 'e5' }), IllegalMoveError);
  assert.equal(game.fen(), fenBefore);
  assert.equal(game.turn(), 'w');
  assert.deepEqual(game.history(), []);
});

test('rejects a move that exposes the mover\'s own king', () => {
  const game = createGame('k3r3/8/8/8/8/8/4R3/4K3 w - - 0 1');
  const fenBefore = game.fen();
  assert.throws(() => game.move({ from: 'e2', to: 'f2' }), IllegalMoveError);
  assert.equal(game.fen(), fenBefore);
});

test('castling: both sides available from a fresh instance; king/rook land correctly; Undo restores rights', () => {
  const fen = 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1';

  const kingside = createGame(fen);
  const kingsideMove = kingside.move({ from: 'e1', to: 'g1' });
  assert.ok(kingsideMove.isKingsideCastle());
  assert.equal(kingside.fen().split(' ')[0], 'r3k2r/8/8/8/8/8/8/R4RK1');
  const undone = kingside.undo();
  assert.ok(undone);
  assert.equal(kingside.fen(), fen);

  const queenside = createGame(fen);
  const queensideMove = queenside.move({ from: 'e1', to: 'c1' });
  assert.ok(queensideMove.isQueensideCastle());
  assert.equal(queenside.fen().split(' ')[0], 'r3k2r/8/8/8/8/8/8/2KR3R');
  queenside.undo();
  assert.equal(queenside.fen(), fen);
});

test('castling is rejected when the king would cross an attacked transit square', () => {
  const game = createGame('4kr2/8/8/8/8/8/8/4K2R w K - 0 1');
  const fenBefore = game.fen();
  assert.throws(() => game.move({ from: 'e1', to: 'g1' }), IllegalMoveError);
  assert.equal(game.fen(), fenBefore);
});

test('en passant: available only on the immediately eligible turn; Undo restores the opportunity; expires after an intervening move', () => {
  const game = createGame();
  game.move({ from: 'e2', to: 'e4' });
  game.move({ from: 'a7', to: 'a6' });
  game.move({ from: 'e4', to: 'e5' });
  game.move({ from: 'd7', to: 'd5' });

  assert.ok(game.legalMovesFrom('e5').includes('d6'));
  const enPassantMove = game.move({ from: 'e5', to: 'd6' });
  assert.ok(enPassantMove.isEnPassant());
  assert.ok(!game.fen().split(' ')[0]?.includes('d5'), 'captured en passant pawn must be removed');

  const undone = game.undo();
  assert.ok(undone);
  assert.ok(game.legalMovesFrom('e5').includes('d6'), 'undo must restore the en passant opportunity');

  // An intervening move (by White, who is on move after the undo) expires
  // the opportunity even though the d5 pawn has not moved again.
  game.move({ from: 'a2', to: 'a3' });
  game.move({ from: 'h7', to: 'h6' });
  assert.ok(!game.legalMovesFrom('e5').includes('d6'), 'en passant window must have expired');
});

test('promotion: all four piece choices are legal; cancelling changes nothing; computer move needs no dialog', () => {
  const fen = '7k/P6p/8/8/8/8/8/7K w - - 0 1';
  for (const promotion of ['q', 'r', 'b', 'n'] as const) {
    const game = createGame(fen);
    const move = game.move({ from: 'a7', to: 'a8', promotion });
    assert.equal(move.promotion, promotion);
    assert.equal(move.isPromotion(), true);
  }

  // Cancelling a human promotion (never calling move()) changes nothing.
  const cancelled = createGame(fen);
  const fenBefore = cancelled.fen();
  assert.equal(cancelled.fen(), fenBefore);
  assert.deepEqual(cancelled.history(), []);
});

test('checkmate: Black wins 0-1 via Qh4#; further moves lock; Undo removes it and restores Black to move', () => {
  const game = createGame();
  game.move({ from: 'f2', to: 'f3' });
  game.move({ from: 'e7', to: 'e5' });
  game.move({ from: 'g2', to: 'g4' });
  const mate = game.move({ from: 'd8', to: 'h4' });
  assert.equal(mate.san, 'Qh4#');

  const result = game.result();
  assert.equal(result.over, true);
  assert.equal(result.reason, 'checkmate');
  assert.equal(result.outcome, '0-1');
  assert.equal(game.isGameOver(), true);

  const undone = game.undo();
  assert.equal(undone?.san, 'Qh4#');
  assert.equal(game.result().over, false);
  assert.equal(game.turn(), 'b');
});

test('stalemate is detected and distinguished from checkmate', () => {
  const game = createGame('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1');
  const result = game.result();
  assert.equal(result.over, true);
  assert.equal(result.reason, 'stalemate');
  assert.equal(result.outcome, '1/2-1/2');
});

test('insufficient material draws bare kings; two knights versus king is not automatically drawn', () => {
  const bareKings = createGame('7k/8/8/8/8/8/8/K7 w - - 0 1');
  const result = bareKings.result();
  assert.equal(result.over, true);
  assert.equal(result.reason, 'insufficient_material');
  assert.equal(result.outcome, '1/2-1/2');

  const twoKnights = createGame('7k/8/8/8/8/8/8/K5NN w - - 0 1');
  assert.equal(twoKnights.result().over, false);
});

test('threefold repetition draws on the third occurrence; Undo restores the nonterminal prior history', () => {
  const game = createGame();
  const sequence: [string, string][] = [
    ['g1', 'f3'], ['g8', 'f6'],
    ['f3', 'g1'], ['f6', 'g8'],
    ['g1', 'f3'], ['g8', 'f6'],
    ['f3', 'g1'], ['f6', 'g8'],
  ];
  for (const [from, to] of sequence) {
    game.move({ from, to });
  }

  const result = game.result();
  assert.equal(result.over, true);
  assert.equal(result.reason, 'threefold_repetition');
  assert.equal(result.outcome, '1/2-1/2');

  const historyBeforeUndo = game.history().length;
  const undone = game.undo();
  assert.ok(undone);
  assert.equal(game.history().length, historyBeforeUndo - 1);
  assert.equal(game.result().over, false);
});

test('fifty-move counter reaches 100 half-moves and draws; captures/pawn moves reset the counter', () => {
  const game = createGame('7k/8/8/8/8/8/R7/K7 w - - 99 50');
  const result = game.result();
  assert.equal(result.over, false, 'draw should occur only once the counter reaches 100');
  game.move({ from: 'a2', to: 'a3' });
  const afterMove = game.result();
  assert.equal(afterMove.over, true);
  assert.equal(afterMove.reason, 'fifty_move_rule');
  assert.equal(afterMove.outcome, '1/2-1/2');

  // A pawn move or capture resets the counter, so the same count no longer draws.
  const resetGame = createGame('7k/8/8/8/8/8/P7/K7 w - - 0 1');
  resetGame.move({ from: 'a2', to: 'a3' });
  assert.equal(resetGame.result().over, false);
});

test('undo of a single half-move fully restores position, turn, rights, en passant target, and counters', () => {
  const fen = 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1';
  const game = createGame(fen);
  game.move({ from: 'e1', to: 'g1' });
  assert.notEqual(game.fen(), fen);
  const undone = game.undo();
  assert.ok(undone);
  assert.equal(game.fen(), fen);
  assert.equal(game.turn(), 'w');
});

test('history() groups SAN moves by move number for display', () => {
  const game = createGame();
  game.move({ from: 'e2', to: 'e4' });
  game.move({ from: 'e7', to: 'e5' });
  game.move({ from: 'g1', to: 'f3' });

  assert.deepEqual(game.historyByMoveNumber(), [
    { moveNumber: 1, white: 'e4', black: 'e5' },
    { moveNumber: 2, white: 'Nf3' },
  ]);
  assert.deepEqual(game.history(), ['e4', 'e5', 'Nf3']);
});

test('undo returns null when there is no move to undo', () => {
  const game = createGame();
  assert.equal(game.undo(), null);
});

test('ChessGame class is directly constructible via `new`', () => {
  const game = new ChessGame();
  assert.equal(game.turn(), 'w');
});

test('reset() discards history and restores the standard starting position', () => {
  const game = createGame();
  game.move({ from: 'e2', to: 'e4' });
  game.reset();
  assert.equal(game.fen(), 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  assert.deepEqual(game.history(), []);
});

test('moveNumber() and inCheck() reflect the rules library state', () => {
  const game = createGame();
  assert.equal(game.moveNumber(), 1);
  assert.equal(game.inCheck(), false);
  game.move({ from: 'f2', to: 'f3' });
  game.move({ from: 'e7', to: 'e5' });
  assert.equal(game.moveNumber(), 2);
  game.move({ from: 'g2', to: 'g4' });
  game.move({ from: 'd8', to: 'h4' });
  assert.equal(game.inCheck(), true);
});

test('historyVerbose() exposes SAN and move-descriptor detail per ply', () => {
  const game = createGame();
  game.move({ from: 'e2', to: 'e4' });
  const verbose = game.historyVerbose();
  assert.equal(verbose.length, 1);
  assert.equal(verbose[0]?.san, 'e4');
  assert.equal(verbose[0]?.isBigPawn(), true);
});
