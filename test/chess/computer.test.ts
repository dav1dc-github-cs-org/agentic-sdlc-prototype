import assert from 'node:assert/strict';
import test from 'node:test';

import { createGame } from '../../src/chess/game.ts';
import { selectComputerMove } from '../../src/chess/computer.ts';

test('selects the first legal move (in library order) when random is 0', () => {
  const game = createGame();
  const moves = game.legalMovesVerbose();
  const selected = selectComputerMove(game, 0);
  assert.ok(selected);
  assert.deepEqual(selected, moves[0]);
});

test('selects the last legal move when random is just below 1', () => {
  const game = createGame();
  const moves = game.legalMovesVerbose();
  const selected = selectComputerMove(game, 0.999999999999);
  assert.ok(selected);
  assert.deepEqual(selected, moves[moves.length - 1]);
});

test('treats distinct promotion piece choices as separate selectable moves', () => {
  // White pawn on a7 can promote to N, B, R, or Q; king moves are the only
  // other legal options, so the promotion moves occupy the first entries.
  const game = createGame('8/P7/8/8/8/8/8/k6K w - - 0 1');
  const moves = game.legalMovesVerbose();
  const promotionMoves = moves.filter((m) => m.from === 'a7' && m.to === 'a8');
  assert.equal(promotionMoves.length, 4);
  const promotionPieces = new Set(promotionMoves.map((m) => m.promotion));
  assert.deepEqual(promotionPieces, new Set(['n', 'b', 'r', 'q']));

  // Selecting index 0 (random = 0) must land on the first promotion move,
  // confirming promotion choices are individually addressable, not merged.
  const first = selectComputerMove(game, 0);
  assert.ok(first);
  assert.equal(first.from, 'a7');
  assert.equal(first.to, 'a8');
  assert.equal(first.promotion, promotionMoves[0]?.promotion);
});

test('returns undefined (no move selected) on a checkmated position', () => {
  const game = createGame();
  game.move({ from: 'f2', to: 'f3' });
  game.move({ from: 'e7', to: 'e5' });
  game.move({ from: 'g2', to: 'g4' });
  game.move({ from: 'd8', to: 'h4' });
  assert.equal(game.isGameOver(), true);
  assert.equal(game.result().reason, 'checkmate');
  assert.equal(selectComputerMove(game, 0), undefined);
  assert.equal(selectComputerMove(game, 0.5), undefined);
});

test('returns undefined (no move selected) on a stalemated position', () => {
  const game = createGame('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1');
  assert.equal(game.isGameOver(), true);
  assert.equal(game.result().reason, 'stalemate');
  assert.equal(selectComputerMove(game, 0), undefined);
  assert.equal(selectComputerMove(game, 0.999), undefined);
});

test('random values across [0, 1) select an index within legal move bounds', () => {
  const game = createGame();
  const moves = game.legalMovesVerbose();
  for (const random of [0, 0.1, 0.25, 0.5, 0.75, 0.999]) {
    const selected = selectComputerMove(game, random);
    assert.ok(selected);
    assert.ok(moves.some((m) => m.from === selected.from && m.to === selected.to && m.promotion === selected.promotion));
  }
});
