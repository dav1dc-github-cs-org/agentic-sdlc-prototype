// Session and computer-reply-queue controller (REQ-008, REQ-009).
//
// Owns the game-mode/human-color state around a single `ChessGame` instance
// and coordinates the *at most one* in-flight computer reply so an async
// move selection (e.g. `selectComputerMove` resolved via a timer or
// microtask) can never corrupt game state that has since moved on. Every
// queued reply is stamped with the game instance identity, the position
// revision at queue time, and a unique request id; a resolution is applied
// only if all three still match current session state, and the chosen move
// is re-validated against the live position before being committed. This
// module owns no chess rules itself - `game.move()` (backed by the vendored
// chess.js library) is the sole authority on legality.
import type { ChessGame, Color, Move } from './game.ts';
import { createGame, type MoveInput } from './game.ts';

/** Two humans sharing a device, or one human against the computer opponent. */
export type GameMode = 'local' | 'computer';

/**
 * Supplies the computer's chosen move for the current position. May resolve
 * asynchronously (e.g. a scheduled random-move selection); the session
 * re-validates the result against the live position before committing it,
 * regardless of how long the computation took.
 */
export type ComputerMoveSource = (game: ChessGame) => Move | undefined | Promise<Move | undefined>;

interface PendingReply {
  requestId: number;
  /** Identity of the `ChessGame` instance the reply was queued against. */
  instanceId: number;
  /** Position revision captured at queue time. */
  revision: number;
}

export interface SessionOptions {
  mode?: GameMode;
  /** Color the human plays in Computer mode; ignored in Local mode. Defaults to White. */
  humanColor?: Color;
  fen?: string;
}

/**
 * Manages a single chess game's mode, human color assignment, and the
 * reply-queue guard around the computer opponent. Not itself a rules
 * engine: all legality decisions are delegated to `ChessGame`.
 */
export class ChessSession {
  private game: ChessGame;
  private mode: GameMode;
  private humanColor: Color;
  private disposed = false;

  /** Bumped by every state-changing operation on the current game instance (move, undo). */
  private revision = 0;
  /** Bumped whenever the underlying `ChessGame` instance is replaced (new game). */
  private instanceId = 0;
  private requestCounter = 0;
  private pending: PendingReply | null = null;

  constructor(options: SessionOptions = {}) {
    this.game = createGame(options.fen);
    this.mode = options.mode ?? 'local';
    this.humanColor = options.humanColor ?? 'w';
  }

  /** The game instance this session currently owns. */
  getGame(): ChessGame {
    return this.game;
  }

  getMode(): GameMode {
    return this.mode;
  }

  setMode(mode: GameMode): void {
    this.cancelPendingReply();
    this.mode = mode;
  }

  getHumanColor(): Color {
    return this.humanColor;
  }

  setHumanColor(color: Color): void {
    this.cancelPendingReply();
    this.humanColor = color;
  }

  /** Position revision of the current game instance (for callers tracking staleness themselves). */
  getRevision(): number {
    return this.revision;
  }

  /** True if a computer reply has been queued and has not yet resolved or been cancelled. */
  isComputerReplyPending(): boolean {
    return this.pending !== null;
  }

  /** True in Computer mode when it is the non-human side's turn and the game is not over. */
  isComputerTurn(): boolean {
    return (
      this.mode === 'computer' && !this.game.isGameOver() && this.game.turn() !== this.humanColor
    );
  }

  /**
   * Applies a human move. Cancels any queued computer reply first: a human
   * move (e.g. moving out of turn during setup, or racing a reply) always
   * supersedes it. Throws `IllegalMoveError` (and leaves state and any
   * cancellation already performed) if the move is rejected; the position
   * itself is only mutated by the delegated, all-or-nothing `game.move()`.
   */
  applyHumanMove(input: MoveInput): Move {
    this.cancelPendingReply();
    const move = this.game.move(input);
    this.revision += 1;
    return move;
  }

  /**
   * Queues a computer reply computed by `source`. Refuses to queue (returns
   * `null`) when not in Computer mode, when it is not the computer's turn,
   * when the game has already ended, or when a reply is already in-flight
   * (only one in-flight reply per session instance, REQ-008/009). Otherwise
   * returns the request id bound to this queued reply.
   */
  queueComputerReply(source: ComputerMoveSource): number | null {
    if (this.disposed) return null;
    if (this.pending !== null) return null;
    if (!this.isComputerTurn()) return null;

    const requestId = (this.requestCounter += 1);
    const instanceId = this.instanceId;
    const revision = this.revision;
    this.pending = { requestId, instanceId, revision };

    Promise.resolve()
      .then(() => source(this.game))
      .then(
        (move) => this.resolveComputerReply(requestId, instanceId, revision, move),
        () => this.resolveComputerReply(requestId, instanceId, revision, undefined),
      );

    return requestId;
  }

  /**
   * Applied when a queued computer reply's computation completes. A stale
   * or duplicate invocation - one whose request id no longer matches the
   * current pending reply, or whose captured instance/revision no longer
   * matches current session state (because of an intervening undo, new
   * game, dispose, or another queued reply) - is a no-op, even if this
   * callback fires more than once for the same request id.
   */
  private resolveComputerReply(
    requestId: number,
    instanceId: number,
    revision: number,
    move: Move | undefined,
  ): void {
    if (this.disposed) return;
    if (this.pending === null || this.pending.requestId !== requestId) return;
    // Clear the slot before any further validation so a second callback
    // invocation for this same request id is rejected by the identity check
    // above, not by re-entering this branch.
    this.pending = null;

    if (instanceId !== this.instanceId || revision !== this.revision) return;
    if (!move) return;
    if (this.game.isGameOver()) return;

    // Revalidate against the current (unchanged, per the checks above)
    // position rather than trusting the value captured at selection time.
    try {
      // `move.promotion` is the library's own `PieceSymbol` (which includes
      // 'k' / 'p', never valid promotion targets); `game.move()` fully
      // revalidates the move regardless, rejecting anything illegal.
      this.game.move({
        from: move.from,
        to: move.to,
        promotion: move.promotion as MoveInput['promotion'],
      });
      this.revision += 1;
    } catch {
      // No longer legal (should not happen given the matching revision
      // check, but the move is re-validated rather than trusted regardless).
    }
  }

  /** Cancels any in-flight computer reply without affecting game state. */
  cancelPendingReply(): void {
    this.pending = null;
  }

  /**
   * Undoes one half-move. Cancels any queued reply first (REQ-009): the
   * reply was selected against the position being undone, so applying it
   * afterward would be invalid regardless of legality.
   */
  undo(): Move | null {
    this.cancelPendingReply();
    const undone = this.game.undo();
    if (undone) this.revision += 1;
    return undone;
  }

  /**
   * Starts a new game, discarding any queued reply and replacing the game
   * instance so a reply bound to the old instance can never be applied to
   * it, even if its captured revision happens to coincide.
   */
  newGame(fen?: string): void {
    this.cancelPendingReply();
    this.game = createGame(fen);
    this.instanceId += 1;
    this.revision = 0;
  }

  /** Cancels any queued reply in response to the page being hidden (e.g. tab switch, backgrounding). */
  onPageHidden(): void {
    this.cancelPendingReply();
  }

  /** Cancels any queued reply in response to a modal/dialog being opened over the board. */
  onDialogOpen(): void {
    this.cancelPendingReply();
  }

  /** Cancels any queued reply and marks the session unusable for further queueing. */
  dispose(): void {
    this.cancelPendingReply();
    this.disposed = true;
  }
}

export function createSession(options?: SessionOptions): ChessSession {
  return new ChessSession(options);
}
