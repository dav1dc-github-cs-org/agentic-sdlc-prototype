// Weak random-legal-move computer opponent (REQ-008).
//
// This module performs no search, static evaluation, or difficulty
// selection. It uniformly selects among the legal moves reported by the
// game module's `legalMovesVerbose()`, which itself delegates entirely to
// the vendored chess.js rules library. Promotion choices are distinct
// selectable moves because the library already returns them as separate
// verbose entries (e.g. one entry per promotion piece).
import type { ChessGame } from './game.ts';
import type { Move } from '../../apps/chess/vendor/chess.js';

/**
 * Selects a legal move uniformly at random using the supplied `random`
 * value, which must be in the half-open interval `[0, 1)` (e.g. the output
 * of `Math.random()` or a seeded equivalent supplied by the caller for
 * deterministic testing).
 *
 * - `random === 0` selects the first legal move in the library's returned
 *   order.
 * - `random` just below `1` selects the last legal move.
 * - Returns `undefined` when the position is terminal (checkmate or
 *   stalemate) and there are no legal moves to select from.
 */
export function selectComputerMove(game: ChessGame, random: number): Move | undefined {
  const moves = game.legalMovesVerbose();
  if (moves.length === 0) return undefined;
  const index = Math.min(moves.length - 1, Math.floor(random * moves.length));
  return moves[index];
}
