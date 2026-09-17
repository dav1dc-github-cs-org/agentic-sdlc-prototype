import assert from 'node:assert/strict';
import test from 'node:test';

import { pieceSvg, pieceName } from '../../apps/chess/pieces.mjs';

const PIECES = ['p', 'n', 'b', 'r', 'q', 'k'];

test('pieceSvg returns self-contained inline SVG markup for every piece/color combination', () => {
  for (const piece of PIECES) {
    for (const color of ['w', 'b']) {
      const svg = pieceSvg(piece, color);
      assert.match(svg, /^<svg /);
      assert.match(svg, /<\/svg>$/);
      assert.doesNotMatch(svg, /<image/, 'must not reference an external image');
      assert.doesNotMatch(svg, /href=/, 'must not reference an external resource');
    }
  }
});

test('pieceSvg differentiates White and Black fills', () => {
  const white = pieceSvg('k', 'w');
  const black = pieceSvg('k', 'b');
  assert.notEqual(white, black);
});

test('pieceSvg rejects unknown piece symbols', () => {
  assert.throws(() => pieceSvg('x', 'w'));
});

test('pieceName labels every piece symbol', () => {
  assert.equal(pieceName('p'), 'pawn');
  assert.equal(pieceName('n'), 'knight');
  assert.equal(pieceName('b'), 'bishop');
  assert.equal(pieceName('r'), 'rook');
  assert.equal(pieceName('q'), 'queen');
  assert.equal(pieceName('k'), 'king');
  assert.throws(() => pieceName('x'));
});
