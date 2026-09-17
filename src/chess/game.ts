// Core chess game module (REQ-003, REQ-004, REQ-005, REQ-006, REQ-009).
//
// This module is the single application state owner for a chess game. It
// wraps the vendored chess.js library (apps/chess/vendor/chess.js) via a
// relative import and delegates every legality decision - move generation,
// check/king-safety, castling/en-passant eligibility, and result detection -
// to that library. No move generation or check logic is reimplemented here.
import { Chess, DEFAULT_POSITION } from '../../apps/chess/vendor/chess.js';
import type { Color, Move, Square } from '../../apps/chess/vendor/chess.js';

export type { Color, Move, Square };

/** Reason a game has ended, evaluated in this fixed precedence order. */
export type GameEndReason =
  | 'checkmate'
  | 'stalemate'
  | 'insufficient_material'
  | 'threefold_repetition'
  | 'fifty_move_rule';

/** SAN outcome string as displayed alongside the result reason. */
export type GameOutcome = '1-0' | '0-1' | '1/2-1/2';

export interface GameResult {
  over: boolean;
  reason?: GameEndReason;
  outcome?: GameOutcome;
}

/** One entry in the move-number-grouped move history used for display. */
export interface MoveHistoryEntry {
  moveNumber: number;
  white?: string;
  black?: string;
}

export interface MoveInput {
  from: string;
  to: string;
  promotion?: 'q' | 'r' | 'b' | 'n';
}

/**
 * Thrown when a requested move is rejected by the rules library (illegal,
 * exposes the mover's own king, wrong turn, malformed input, etc). Callers
 * use this to leave committed state unchanged, per REQ-002/REQ-003.
 */
export class IllegalMoveError extends Error {
  constructor(message = 'Illegal move') {
    super(message);
    this.name = 'IllegalMoveError';
  }
}

/**
 * Wraps a vendored chess.js `Chess` instance as the authoritative rules
 * engine for a single game. Every mutating method below is a thin,
 * validated pass-through to the library; this class adds no independent
 * legality logic.
 */
export class ChessGame {
  private chess: Chess;

  constructor(fen: string = DEFAULT_POSITION) {
    this.chess = new Chess(fen);
  }

  /** Resets to the standard starting position, discarding all history. */
  reset(): void {
    this.chess.reset();
  }

  /** Current side to move. */
  turn(): Color {
    return this.chess.turn();
  }

  /** Current position as FEN. */
  fen(): string {
    return this.chess.fen();
  }

  /** Full move-number counter as tracked by the rules library. */
  moveNumber(): number {
    return this.chess.moveNumber();
  }

  /** True if the side to move is in check. */
  inCheck(): boolean {
    return this.chess.isCheck();
  }

  /**
   * Legal destination squares (algebraic, e.g. "e4") for a piece on
   * `square`, or an empty array if there is none or it has no legal moves.
   * Used to render selection targets (REQ-002) without duplicating rules.
   */
  legalMovesFrom(square: string): string[] {
    const moves = this.chess.moves({ square: square as Square, verbose: true });
    return moves.map((m) => m.to);
  }

  /** All legal moves in the current position (SAN strings). */
  legalMoves(): string[] {
    return this.chess.moves();
  }

  /**
   * Applies a move described by from/to (+ optional promotion piece).
   * Throws `IllegalMoveError` and leaves state unchanged if the library
   * rejects it (including moves that would expose the mover's own king).
   */
  move(input: MoveInput): Move {
    try {
      return this.chess.move({ from: input.from, to: input.to, promotion: input.promotion });
    } catch {
      throw new IllegalMoveError(`Illegal move ${input.from}-${input.to}`);
    }
  }

  /**
   * Undoes exactly one half-move, restoring position, side to move,
   * castling rights, en passant target, and move counters to their
   * pre-move values (REQ-009). Returns the undone move, or `null` if there
   * is no move to undo.
   */
  undo(): Move | null {
    return this.chess.undo();
  }

  /** Flat SAN history of the committed main line, in play order. */
  history(): string[] {
    return this.chess.history();
  }

  /** Verbose move history, in play order. */
  historyVerbose(): Move[] {
    return this.chess.history({ verbose: true });
  }

  /**
   * SAN history grouped by move number for display (REQ-006), e.g.
   * `[{ moveNumber: 1, white: 'e4', black: 'e5' }, ...]`.
   */
  historyByMoveNumber(): MoveHistoryEntry[] {
    const san = this.history();
    const entries: MoveHistoryEntry[] = [];
    for (let i = 0; i < san.length; i += 1) {
      const moveNumber = Math.floor(i / 2) + 1;
      if (i % 2 === 0) {
        entries.push({ moveNumber, white: san[i] });
      } else {
        const last = entries[entries.length - 1];
        if (last) last.black = san[i];
      }
    }
    return entries;
  }

  /**
   * Determines game-end status using the library's history-aware
   * repetition/fifty-move counters, evaluated in the required precedence:
   * checkmate, then stalemate, insufficient material, threefold
   * repetition, then the fifty-move rule (REQ-005).
   */
  result(): GameResult {
    if (this.chess.isCheckmate()) {
      const winner: GameOutcome = this.chess.turn() === 'w' ? '0-1' : '1-0';
      return { over: true, reason: 'checkmate', outcome: winner };
    }
    if (this.chess.isStalemate()) {
      return { over: true, reason: 'stalemate', outcome: '1/2-1/2' };
    }
    if (this.chess.isInsufficientMaterial()) {
      return { over: true, reason: 'insufficient_material', outcome: '1/2-1/2' };
    }
    if (this.chess.isThreefoldRepetition()) {
      return { over: true, reason: 'threefold_repetition', outcome: '1/2-1/2' };
    }
    if (this.chess.isDrawByFiftyMoves()) {
      return { over: true, reason: 'fifty_move_rule', outcome: '1/2-1/2' };
    }
    return { over: false };
  }

  /** True once `result().over` would be true; board moves are then locked. */
  isGameOver(): boolean {
    return this.result().over;
  }
}

export function createGame(fen?: string): ChessGame {
  return new ChessGame(fen);
}
