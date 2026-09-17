// Pure board-geometry helpers (REQ-001, REQ-002, REQ-010, REQ-011).
//
// These functions contain no chess rules/legality logic - only coordinate
// math for rendering an 8x8 grid in either orientation ("w" = White at the
// bottom, the REQ-001 default; "b" = Black at the bottom, after Flip). All
// move legality remains the exclusive responsibility of the compiled
// src/chess modules; this module only maps algebraic squares to grid
// positions and back so app.js can render and interpret clicks/keys.

/** @typedef {'w' | 'b'} Orientation */

const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

/**
 * Splits an algebraic square (e.g. "e4") into a zero-based file index
 * (a=0..h=7) and a 1-based rank number.
 */
export function parseSquare(square) {
  if (typeof square !== 'string' || square.length !== 2) {
    throw new RangeError(`Invalid square: ${String(square)}`);
  }
  const file = FILES.indexOf(square[0]);
  const rank = Number(square[1]);
  if (file === -1 || !Number.isInteger(rank) || rank < 1 || rank > 8) {
    throw new RangeError(`Invalid square: ${square}`);
  }
  return { file, rank };
}

/** Builds the algebraic square name from a zero-based file and 1-based rank. */
export function toSquare(file, rank) {
  return `${FILES[file]}${rank}`;
}

/**
 * Zero-based `{ row, col }` grid position for `square` given the board
 * `orientation`. Row 0 is the visual top of the board; col 0 is the visual
 * left. White-at-bottom (the default, REQ-001) puts rank 8 at row 0 and
 * file a at col 0; flipping (REQ-010) mirrors both axes.
 */
export function squareToCoords(square, orientation) {
  const { file, rank } = parseSquare(square);
  if (orientation === 'b') {
    return { row: rank - 1, col: 7 - file };
  }
  return { row: 8 - rank, col: file };
}

/** Inverse of {@link squareToCoords}: grid position -> algebraic square. */
export function coordsToSquare(row, col, orientation) {
  if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || row > 7 || col < 0 || col > 7) {
    throw new RangeError(`Invalid board coordinates: ${row},${col}`);
  }
  if (orientation === 'b') {
    return toSquare(7 - col, row + 1);
  }
  return toSquare(col, 8 - row);
}

/**
 * True for the conventional "light" squares (REQ-011 distinguishes squares
 * without relying on color alone in the UI, but the checkerboard pattern
 * itself still needs this). `h1` is light, matching REQ-001.
 */
export function isLightSquare(square) {
  const { file, rank } = parseSquare(square);
  return (file + rank) % 2 === 0;
}

/** Ordered file letters (a..h) as displayed left-to-right for `orientation`. */
export function fileLabels(orientation) {
  return orientation === 'b' ? [...FILES].reverse() : [...FILES];
}

/** Ordered rank numbers (1..8) as displayed top-to-bottom for `orientation`. */
export function rankLabels(orientation) {
  const ranks = [8, 7, 6, 5, 4, 3, 2, 1];
  return orientation === 'b' ? [...ranks].reverse() : ranks;
}

/**
 * Visual-direction arrow-key navigation (REQ-011): given a focused square and
 * an arrow key, returns the next square to focus, staying on the board. The
 * direction is resolved relative to the current `orientation`, so "up" always
 * moves toward the top of the rendered board regardless of flip state.
 */
export function nextSquareForArrowKey(square, key, orientation) {
  const { row, col } = squareToCoords(square, orientation);
  let nextRow = row;
  let nextCol = col;
  if (key === 'ArrowUp') nextRow -= 1;
  else if (key === 'ArrowDown') nextRow += 1;
  else if (key === 'ArrowLeft') nextCol -= 1;
  else if (key === 'ArrowRight') nextCol += 1;
  else return square;
  if (nextRow < 0 || nextRow > 7 || nextCol < 0 || nextCol > 7) return square;
  return coordsToSquare(nextRow, nextCol, orientation);
}

/**
 * Parses only the piece-placement field of a FEN string into a
 * `Map<square, { type, color }>`. This is plain, well-defined FEN text
 * parsing for rendering (REQ-006 board display) - it performs no legality,
 * move-generation, or check logic; every rules decision remains the sole
 * responsibility of the compiled src/chess modules, which are the source of
 * the FEN string itself (`game.fen()`).
 */
export function boardFromFen(fen) {
  const placement = fen.split(' ')[0];
  if (!placement) throw new RangeError(`Invalid FEN: ${fen}`);
  const board = new Map();
  const ranks = placement.split('/');
  if (ranks.length !== 8) throw new RangeError(`Invalid FEN piece placement: ${placement}`);
  for (let i = 0; i < 8; i += 1) {
    const rank = 8 - i;
    let file = 0;
    for (const ch of ranks[i]) {
      if (/[1-8]/.test(ch)) {
        file += Number(ch);
        continue;
      }
      const color = ch === ch.toUpperCase() ? 'w' : 'b';
      const type = ch.toLowerCase();
      board.set(toSquare(file, rank), { type, color });
      file += 1;
    }
  }
  return board;
}
