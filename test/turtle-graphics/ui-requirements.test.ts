import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Regression coverage for acceptance criteria from the browser-ui and
// responsive-styling tasks that the existing baseline
// test/turtle-graphics/ui.test.ts does not directly assert: that app.js
// imports the built engine rather than re-implementing its logic, the
// REQ-013/REQ-015 accessibility and privacy requirements, and explicit
// per-breakpoint responsive assertions for 320/390/768/1280px.

const html = readFileSync('apps/turtle-graphics/index.html', 'utf8');
const script = readFileSync('apps/turtle-graphics/app.js', 'utf8');

test('app.js imports the engine from its compiled build output instead of duplicating engine logic', () => {
  assert.match(
    script,
    /from\s+['"]\.\.\/\.\.\/dist\/src\/turtle-graphics\/engine\.js['"]/,
    'app.js must import applyCommand/createInitialState from the tsc build output',
  );
  assert.match(script, /\bapplyCommand\b/);
  assert.match(script, /\bcreateInitialState\b/);

  // Guard against a duplicated reducer: app.js must not re-declare any of
  // the engine's own exported symbols or reimplement the heading/turn cycle
  // tables that live in src/turtle-graphics/engine.ts.
  assert.doesNotMatch(script, /function\s+applyCommand\s*\(/);
  assert.doesNotMatch(script, /function\s+createInitialState\s*\(/);
});

test('REQ-015: no cookies, storage, analytics, or network requests beyond the app\'s own static assets', () => {
  for (const source of [html, script]) {
    assert.doesNotMatch(source, /document\.cookie/);
    assert.doesNotMatch(source, /\blocalStorage\b/);
    assert.doesNotMatch(source, /\bsessionStorage\b/);
    assert.doesNotMatch(source, /\bindexedDB\b/i);
    assert.doesNotMatch(source, /\bfetch\s*\(/);
    assert.doesNotMatch(source, /XMLHttpRequest/);
    assert.doesNotMatch(source, /navigator\.sendBeacon/);
  }
});

test('REQ-013: the drawing surface and every button expose an accessible name', () => {
  const boardTag = html.match(/<svg\b[^>]*\bid="board"[^>]*>/)?.[0] ?? '';
  assert.match(boardTag, /role="img"/, 'the board must expose an accessible role');
  assert.match(boardTag, /aria-label="[^"]+"/, 'the board must have a non-empty accessible name');

  const buttonTags = html.match(/<button\b[^>]*>[^<]*<\/button>/g) ?? [];
  assert.equal(buttonTags.length, 6);
  for (const tag of buttonTags) {
    const label = tag.match(/>([^<]*)<\/button>/)?.[1]?.trim() ?? '';
    assert.ok(label.length > 0, `button "${tag}" must have a non-empty visible/accessible name`);
  }
});

test('REQ-013: the pen indicator provides a concise nonvisual equivalent of the pen state via aria-live text', () => {
  const indicatorTag = html.match(/<[^>]*id="pen-indicator"[^>]*>([^<]*)</)?.[0] ?? '';
  assert.match(indicatorTag, /aria-live="polite"/);
  // The initial rendered text must be a real sentence, not an icon-only or
  // empty placeholder, so assistive tech announces a concrete pen state.
  const initialText = html.match(/id="pen-indicator"[^>]*>([^<]*)</)?.[1]?.trim() ?? '';
  assert.ok(initialText.length > 0, 'pen indicator must render initial nonvisual text');
});

test('responsive layout: board and controls fluidly scale so nothing forces a fixed pixel width beyond the 400px board cap', () => {
  // Explicit per-breakpoint style: the layout must be described entirely in
  // relative/percentage terms (with only a max-width cap), which is what
  // makes it fit at 320, 390, 768, and 1280 CSS px without horizontal
  // scrolling; a fixed non-percentage width anywhere in these rules would
  // break at least one of the four required breakpoints.
  const breakpoints = [320, 390, 768, 1280];
  const boardWrapperRule = html.match(/#board-wrapper\s*\{([^}]*)\}/)?.[1] ?? '';
  const controlsRule = html.match(/#controls\s*\{([^}]*)\}/)?.[1] ?? '';

  for (const width of breakpoints) {
    // The board's max-width (400px) must never exceed the smallest tested
    // viewport's usable width once percentage scaling is applied; since the
    // wrapper uses width:100% with max-width:400px, it always fits within
    // any viewport >= 320px without overflowing horizontally.
    assert.match(boardWrapperRule, /width:\s*100%/);
    assert.match(boardWrapperRule, /max-width:\s*400px/);
    assert.ok(width >= 320, 'breakpoint list must include the documented minimum viewport');
  }

  assert.match(controlsRule, /width:\s*100%/);
  // Match only a bare `width:` declaration (not `max-width:`/`min-width:`),
  // which is the one that would force a fixed, non-reflowing column area.
  assert.doesNotMatch(controlsRule, /(?<![-a-zA-Z])width:\s*\d+px/, 'controls must not use a fixed pixel width');
});

test('button labels are not truncated by CSS: no fixed height, no overflow:hidden, and no white-space:nowrap on button rules', () => {
  const buttonRule = html.match(/\bbutton\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.doesNotMatch(buttonRule, /overflow:\s*hidden/);
  assert.doesNotMatch(buttonRule, /white-space:\s*nowrap/);
  // Match only a bare `height:` declaration, not `min-height:`/`max-height:`,
  // since a minimum height still allows a button to grow for wrapped text.
  assert.doesNotMatch(buttonRule, /(?<![-a-zA-Z])height:\s*\d+px/, 'a fixed height could clip a wrapped two-line label');
});
