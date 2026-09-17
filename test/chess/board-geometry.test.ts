import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseSquare,
  toSquare,
  squareToCoords,
  coordsToSquare,
  isLightSquare,
  fileLabels,
  rankLabels,
  nextSquareForArrowKey,
  boardFromFen,
} from '../../apps/chess/board-geometry.mjs';

test('parseSquare/toSquare round-trip for every square', () => {
  for (let file = 0; file < 8; file += 1) {
    for (let rank = 1; rank <= 8; rank += 1) {
      const square = toSquare(file, rank);
      assert.deepEqual(parseSquare(square), { file, rank });
    }
  }
});

test('parseSquare rejects malformed input', () => {
  assert.throws(() => parseSquare('z9'));
  assert.throws(() => parseSquare('a'));
  assert.throws(() => parseSquare(''));
});

test('squareToCoords/coordsToSquare are inverse for White-at-bottom orientation', () => {
  // e1 (White's king start) is bottom-center-right; row 7 in a 0-based White-bottom grid.
  assert.deepEqual(squareToCoords('e1', 'w'), { row: 7, col: 4 });
  assert.deepEqual(squareToCoords('a8', 'w'), { row: 0, col: 0 });
  assert.equal(coordsToSquare(7, 4, 'w'), 'e1');
  assert.equal(coordsToSquare(0, 0, 'w'), 'a8');
});

test('squareToCoords/coordsToSquare mirror both axes when flipped (Black at bottom)', () => {
  assert.deepEqual(squareToCoords('e1', 'b'), { row: 0, col: 3 });
  assert.deepEqual(squareToCoords('a8', 'b'), { row: 7, col: 7 });
  assert.equal(coordsToSquare(0, 3, 'b'), 'e1');
  assert.equal(coordsToSquare(7, 7, 'b'), 'a8');
});

test('coordsToSquare rejects out-of-range coordinates', () => {
  assert.throws(() => coordsToSquare(-1, 0, 'w'));
  assert.throws(() => coordsToSquare(0, 8, 'w'));
});

test('h1 is a light square (REQ-001)', () => {
  assert.equal(isLightSquare('h1'), true);
  assert.equal(isLightSquare('a1'), false);
});

test('fileLabels/rankLabels reverse under flip', () => {
  assert.deepEqual(fileLabels('w'), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  assert.deepEqual(fileLabels('b'), ['h', 'g', 'f', 'e', 'd', 'c', 'b', 'a']);
  assert.deepEqual(rankLabels('w'), [8, 7, 6, 5, 4, 3, 2, 1]);
  assert.deepEqual(rankLabels('b'), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('nextSquareForArrowKey moves visually up/down/left/right relative to orientation', () => {
  // White-at-bottom: "up" (ArrowUp) moves toward rank 8.
  assert.equal(nextSquareForArrowKey('e4', 'ArrowUp', 'w'), 'e5');
  assert.equal(nextSquareForArrowKey('e4', 'ArrowDown', 'w'), 'e3');
  assert.equal(nextSquareForArrowKey('e4', 'ArrowLeft', 'w'), 'd4');
  assert.equal(nextSquareForArrowKey('e4', 'ArrowRight', 'w'), 'f4');
  // Flipped: "up" still means toward the visual top, which is now rank 1's direction.
  assert.equal(nextSquareForArrowKey('e4', 'ArrowUp', 'b'), 'e3');
  assert.equal(nextSquareForArrowKey('e4', 'ArrowDown', 'b'), 'e5');
});

test('nextSquareForArrowKey stays on the board at the edges', () => {
  assert.equal(nextSquareForArrowKey('a1', 'ArrowLeft', 'w'), 'a1');
  assert.equal(nextSquareForArrowKey('h8', 'ArrowRight', 'w'), 'h8');
  assert.equal(nextSquareForArrowKey('a1', 'ArrowDown', 'w'), 'a1');
});

test('nextSquareForArrowKey ignores unrelated keys', () => {
  assert.equal(nextSquareForArrowKey('e4', 'Tab', 'w'), 'e4');
});

test('boardFromFen parses the standard starting position into 32 pieces', () => {
  const board = boardFromFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  assert.equal(board.size, 32);
  assert.deepEqual(board.get('e1'), { type: 'k', color: 'w' });
  assert.deepEqual(board.get('e8'), { type: 'k', color: 'b' });
  assert.deepEqual(board.get('a2'), { type: 'p', color: 'w' });
  assert.equal(board.get('e4'), undefined);
});

test('boardFromFen parses a sparse endgame FEN correctly', () => {
  const board = boardFromFen('7k/8/8/8/8/8/8/K7 w - - 0 1');
  assert.equal(board.size, 2);
  assert.deepEqual(board.get('h8'), { type: 'k', color: 'b' });
  assert.deepEqual(board.get('a1'), { type: 'k', color: 'w' });
});

test('boardFromFen rejects malformed FEN', () => {
  assert.throws(() => boardFromFen('not-a-fen'));
  assert.throws(() => boardFromFen(''));
});
