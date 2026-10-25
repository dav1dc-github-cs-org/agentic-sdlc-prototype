import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const html = readFileSync('apps/turtle-graphics/index.html', 'utf8');
const script = readFileSync('apps/turtle-graphics/app.js', 'utf8');

const BUTTON_LABELS = [
  'Pen Up',
  'Pen Down',
  'Move Forward',
  'Move Backwards',
  'Turn Left 90 degrees',
  'Turn Right 90 degrees',
];

// RFC 3986 URI-scheme grammar, anchored to the start of the string. Any
// reference beginning with a scheme (e.g. "https:", "javascript:") is not a
// same-origin relative path. Anchoring at the start (rather than searching
// for "://" anywhere in the string) avoids the CodeQL
// js/incomplete-url-substring-sanitization pattern: an unanchored substring
// check like `ref.includes('://')` can be fooled by, or fail to reject,
// values that carry a scheme without a literal "://" substring (e.g.
// "javascript:alert(1)") or that embed "://" later in a path segment
// without actually being absolute. Parsing the leading token exactly once
// is precise instead of approximate.
const SCHEME_PREFIX = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

function isSameOriginReference(ref: string): boolean {
  if (SCHEME_PREFIX.test(ref)) return false;
  if (ref.startsWith('//')) return false;
  return ref.startsWith('./') || ref.startsWith('../') || !ref.includes('/');
}

test('the page renders exactly one board, one turtle glyph, and an aria-live pen indicator', () => {
  const boardMatches = html.match(/<(svg|canvas)\b[^>]*\bid="board"/g) ?? [];
  assert.equal(boardMatches.length, 1, 'exactly one board element (svg or canvas) with id="board"');
  const turtleMatches = html.match(/id="turtle"/g) ?? [];
  assert.equal(turtleMatches.length, 1, 'exactly one turtle glyph element');
  const indicatorMatches = html.match(/id="pen-indicator"[^>]*aria-live="polite"/g) ?? [];
  assert.equal(indicatorMatches.length, 1, 'exactly one aria-live="polite" pen indicator');
});

test('exactly six labelled buttons are present with a data-command wiring hook', () => {
  const buttonTags = html.match(/<button\b[^>]*data-command="[a-zA-Z]+"[^>]*>[^<]*<\/button>/g) ?? [];
  assert.equal(buttonTags.length, 6, 'exactly six command buttons');
  for (const label of BUTTON_LABELS) {
    assert.ok(
      buttonTags.some(tag => tag.includes(`>${label}<`)),
      `missing button labelled "${label}"`,
    );
  }
  const commands = buttonTags.map(tag => tag.match(/data-command="([a-zA-Z]+)"/)![1]);
  assert.deepEqual(
    [...commands].sort(),
    ['backward', 'forward', 'penDown', 'penUp', 'turnLeft', 'turnRight'].sort(),
    'each button maps to a distinct engine command',
  );
});

test('buttons are sized at least 56x56 CSS px and have a visible focus-visible outline', () => {
  const buttonRule = html.match(/\bbutton\s*\{([^}]*)\}/);
  assert.ok(buttonRule, 'a button style rule must exist');
  const body = buttonRule![1] ?? '';
  const minWidth = Number(body.match(/min-width:\s*(\d+)px/)?.[1] ?? 0);
  const minHeight = Number(body.match(/min-height:\s*(\d+)px/)?.[1] ?? 0);
  assert.ok(minWidth >= 56, `button min-width must be at least 56px, got ${minWidth}`);
  assert.ok(minHeight >= 56, `button min-height must be at least 56px, got ${minHeight}`);

  const focusRule = html.match(/button:focus-visible\s*\{([^}]*)\}/);
  assert.ok(focusRule, 'a button:focus-visible rule must exist');
  const outline = (focusRule![1] ?? '').match(/outline:\s*([^;]+);/)?.[1] ?? '';
  assert.doesNotMatch(outline.trim(), /^none$/i, 'the focus-visible outline must not be "none"');
  assert.match(outline, /\d/, 'the focus-visible outline must declare a nonzero width');
});

test('the layout is fluid so it can fit narrow and wide viewports without fixed overflow-causing widths', () => {
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1"\s*\/>/);
  // The board and control regions must scale with the viewport (percentage
  // width capped by max-width) rather than using a fixed pixel width, so
  // they can shrink below 400px on narrow viewports like 320px.
  const boardWrapperRule = html.match(/#board-wrapper\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(boardWrapperRule, /width:\s*100%/, 'board wrapper must use a fluid width');
  assert.match(boardWrapperRule, /max-width:\s*400px/, 'board wrapper must cap its width');
  const boardRule = html.match(/#board\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(boardRule, /width:\s*100%/, 'board must use a fluid width');
  const controlsRule = html.match(/#controls\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(controlsRule, /width:\s*100%/, 'controls must use a fluid width');
  assert.match(
    controlsRule,
    /grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(min\(\d+px,\s*100%\),\s*1fr\)\)/,
    'controls must reflow to fewer columns instead of overflowing at narrow widths or high zoom',
  );
});

test('no eval, Function, or dynamic innerHTML assignment appears in the UI code', () => {
  assert.doesNotMatch(script, /\beval\s*\(/);
  assert.doesNotMatch(script, /\bnew\s+Function\s*\(/);
  assert.doesNotMatch(script, /\.innerHTML\s*=/);
  assert.doesNotMatch(html, /\bon[a-z]+\s*=\s*"/i, 'no inline event-handler attributes');
});

test('no external script, font, or analytics resources are referenced', () => {
  const srcRefs = [...html.matchAll(/\s(?:src|href)="([^"]+)"/g)].map(m => m[1] ?? '');
  for (const ref of srcRefs) {
    assert.ok(
      isSameOriginReference(ref),
      `reference "${ref}" must be a same-origin relative asset`,
    );
  }
  // Enumerate every http(s) URL literal in the script and require each one to be
  // an exact match for the inert SVG namespace URI. A negative-lookahead prefix
  // check (e.g. `https?:\/\/(?!www\.w3\.org\/2000\/svg)`) is not anchored to the
  // end of the URL, so a crafted value such as
  // "https://www.w3.org/2000/svg.evil.example" would satisfy the lookahead
  // (CodeQL js/regex/missing-regexp-anchor) while still pointing at an external
  // host. Matching the full URL token and comparing it for strict equality
  // closes that gap.
  const ALLOWED_SVG_NAMESPACE_URI = 'http://www.w3.org/2000/svg';
  const urlLiterals = [...script.matchAll(/https?:\/\/[^\s'"`]*/g)].map(m => m[0]);
  for (const url of urlLiterals) {
    assert.equal(url, ALLOWED_SVG_NAMESPACE_URI, `unexpected external URL "${url}" referenced in script`);
  }
  assert.doesNotMatch(script, /\bfetch\s*\(|XMLHttpRequest/);
});

test('every button wires exactly one click handler and no touchstart handler', () => {
  const listenerCalls = [...script.matchAll(/addEventListener\('([a-z]+)'/g)].map(m => m[1]);
  assert.deepEqual(listenerCalls, ['click'], 'only a single click listener attachment site should exist');
  assert.doesNotMatch(script, /touchstart/, 'no separate touchstart handler that could double-fire with click');
});

test('every command triggers a full re-render of segments, turtle position, and the pen indicator', () => {
  const renderBody = script.match(/function render\(\)\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(renderBody, /renderSegments\(\)/);
  assert.match(renderBody, /renderTurtle\(\)/);
  assert.match(renderBody, /renderPenIndicator\(\)/);
  // The turtle glyph must be re-appended last so it renders above artwork.
  const appendIndex = renderBody.indexOf('appendChild(turtleGlyph)');
  const segmentsIndex = renderBody.indexOf('renderSegments()');
  assert.ok(appendIndex > segmentsIndex, 'the turtle glyph must be moved above the artwork after segments render');

  const handlerBody = script.match(/function handleCommand\(command\)\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(handlerBody, /applyCommand\(state, command\)/);
  assert.match(handlerBody, /render\(\)/);
});

test('the pen indicator text differs for each pen state so state is not conveyed by color alone', () => {
  const penLabelBlock = script.match(/const PEN_LABEL = \{([^}]*)\}/)?.[1] ?? '';
  const up = penLabelBlock.match(/up:\s*'([^']*)'/)?.[1];
  const down = penLabelBlock.match(/down:\s*'([^']*)'/)?.[1];
  assert.ok(up && down && up !== down, 'pen up/down states must have distinct textual labels');
});

test('same-origin reference validation uses an anchored scheme check, not an unanchored substring search', () => {
  // Regression guard for the CodeQL js/incomplete-url-substring-sanitization
  // finding: absolute/external references and protocol-relative references
  // must be rejected, while relative references (including a bare filename
  // with no path separator) must be accepted.
  assert.equal(isSameOriginReference('./app.js'), true);
  assert.equal(isSameOriginReference('../shared/app.js'), true);
  assert.equal(isSameOriginReference('app.js'), true);
  assert.equal(isSameOriginReference('https://example.com/app.js'), false);
  assert.equal(isSameOriginReference('http://example.com/app.js'), false);
  assert.equal(isSameOriginReference('//example.com/app.js'), false);
  assert.equal(isSameOriginReference('javascript:alert(1)'), false);
});
