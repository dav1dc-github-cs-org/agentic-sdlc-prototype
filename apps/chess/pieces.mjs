// Original inline SVG chess piece artwork (REQ-011): stored as trusted text
// constants, not fetched images/fonts/platform glyphs. Shapes are simple,
// deliberately original silhouettes distinguishable by outline, not merely
// by fill color, so REQ-002/REQ-011 ("distinguish ... without relying on
// color alone") holds for piece identity as well as state.
//
// Each entry is a self-contained <svg> fragment sized to fill its square.

const STROKE = 'stroke="currentColor" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"';

/** Piece body paths, keyed by chess.js PieceSymbol ('p','n','b','r','q','k'). */
const SHAPES = {
  p: `<circle cx="50" cy="38" r="16" ${STROKE}/><path d="M32 82 Q50 58 68 82 Z" ${STROKE}/>`,
  n: `<path d="M30 82 Q28 50 46 34 Q40 24 50 18 Q62 24 66 40 Q76 46 74 60 Q80 66 76 82 Z" ${STROKE}/>`,
  b: `<circle cx="50" cy="30" r="10" ${STROKE}/><path d="M28 82 Q50 48 72 82 Z" ${STROKE}/><path d="M38 66 L62 66" ${STROKE}/>`,
  r: `<path d="M32 22 L32 34 L40 34 L40 24 L48 24 L48 34 L52 34 L52 24 L60 24 L60 34 L68 34 L68 22 Z" ${STROKE}/><path d="M34 34 L34 82 L66 82 L66 34 Z" ${STROKE}/>`,
  q: `<path d="M26 34 L38 50 L50 24 L62 50 L74 34 L70 82 L30 82 Z" ${STROKE}/>`,
  k: `<path d="M46 16 L54 16 L54 26 L64 26 L64 34 L54 34 L54 44 L46 44 L46 34 L36 34 L36 26 L46 26 Z" ${STROKE}/><path d="M30 82 Q50 54 70 82 Z" ${STROKE}/>`,
};

/**
 * Returns a self-contained inline SVG markup string for `piece` ('p'|'n'|
 * 'b'|'r'|'q'|'k') and `color` ('w'|'b'). White pieces render as a light
 * fill with a dark outline; Black pieces the inverse, so identity survives
 * grayscale/print (REQ-011 "not relying on color alone").
 */
export function pieceSvg(piece, color) {
  const body = SHAPES[piece];
  if (!body) throw new RangeError(`Unknown piece symbol: ${piece}`);
  const fill = color === 'w' ? '#f5f5f0' : '#2a2a2a';
  const textColor = color === 'w' ? '#2a2a2a' : '#f5f5f0';
  return (
    `<svg viewBox="0 0 100 100" role="img" aria-hidden="true" focusable="false" ` +
    `fill="${fill}" color="${textColor}" xmlns="http://www.w3.org/2000/svg">${body}</svg>`
  );
}

/** Human-readable piece name, used for assistive-technology labels (REQ-011). */
export function pieceName(piece) {
  switch (piece) {
    case 'p':
      return 'pawn';
    case 'n':
      return 'knight';
    case 'b':
      return 'bishop';
    case 'r':
      return 'rook';
    case 'q':
      return 'queen';
    case 'k':
      return 'king';
    default:
      throw new RangeError(`Unknown piece symbol: ${piece}`);
  }
}
