// Hand-authored plain JavaScript entry point.
//
// This file is intentionally NOT compiled by the protected root
// tsconfig.json (apps/**/*.ts is not part of its `include` globs, and
// tsconfig.json itself must not be edited). It imports the pure engine
// logic from the tsc-built output so behavior stays identical to the
// tested TypeScript module in src/turtle-graphics/engine.ts.
//
// Build the engine first with `npm run build` (see README), which emits
// dist/src/turtle-graphics/engine.js, then serve this apps/ directory
// with any static file server.
import { applyCommand, createInitialState } from '../../dist/src/turtle-graphics/engine.js';

/** @type {Record<string, number>} Rotation in degrees for each heading, 0deg = up. */
const HEADING_ROTATION = {
  up: 0,
  right: 90,
  down: 180,
  left: 270,
};

const PEN_LABEL = {
  up: 'Pen is up: moving will not draw.',
  down: 'Pen is down: moving will draw a line.',
};

const board = document.getElementById('board');
const segmentsGroup = document.getElementById('segments');
const turtleGlyph = document.getElementById('turtle');
const penIndicator = document.getElementById('pen-indicator');

let state = createInitialState();

function renderSegments() {
  // Rebuild the segments group from the full state so the turtle glyph can
  // always be re-appended above the artwork afterwards.
  segmentsGroup.textContent = '';
  for (const segment of state.segments) {
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', String(segment.from.x));
    line.setAttribute('y1', String(segment.from.y));
    line.setAttribute('x2', String(segment.to.x));
    line.setAttribute('y2', String(segment.to.y));
    line.setAttribute('class', 'ink');
    segmentsGroup.appendChild(line);
  }
}

function renderTurtle() {
  const rotation = HEADING_ROTATION[state.heading];
  turtleGlyph.setAttribute(
    'transform',
    `translate(${state.position.x} ${state.position.y}) rotate(${rotation})`,
  );
}

function renderPenIndicator() {
  penIndicator.textContent = PEN_LABEL[state.pen];
}

function render() {
  renderSegments();
  renderTurtle();
  renderPenIndicator();
  // Turtle glyph must stay visually above the artwork: re-append it as the
  // SVG's last child on every render so later segments never cover it.
  board.appendChild(turtleGlyph);
}

/** @param {import('../../src/turtle-graphics/engine.ts').Command} command */
function handleCommand(command) {
  state = applyCommand(state, command);
  render();
}

document.querySelectorAll('button[data-command]').forEach((button) => {
  const command = button.getAttribute('data-command');
  button.addEventListener('click', () => handleCommand(command));
});

render();
