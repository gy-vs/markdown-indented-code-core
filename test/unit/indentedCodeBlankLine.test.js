import { Lexer } from '../../lib/marked.esm.js';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const workerFile = join(__dirname, 'fixtures', 'parse-worker.mjs');

// Before the fix these inputs made the block lexer produce indented-code
// tokens whose raw length was zero, so src never shrank; parsing spun the CPU
// forever (in practice until OOM) instead of returning. The parse runs in a
// worker with a hard timeout so a regression fails the test quickly instead
// of hanging the whole suite.
function parseWithTimeout(markdown, ms = 2000) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerFile);
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error(`parser timed out after ${ms}ms`));
    }, ms);
    worker.once('message', (html) => {
      clearTimeout(timer);
      worker.terminate();
      resolve(html);
    });
    worker.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    worker.postMessage(markdown);
  });
}

// Cumulative source offsets of the top-level tokens; used to assert where the
// block following an indented code block starts, independent of whitespace
// line endings (the lexer normalizes CRLF to LF).
function topLevelStarts(markdown) {
  const tokens = new Lexer().lex(markdown);
  const starts = [];
  let offset = 0;
  for (const token of tokens) {
    starts.push({ type: token.type, start: offset, raw: token.raw });
    offset += token.raw.length;
  }
  return { starts, total: offset };
}

describe('indented code blank line regression', () => {
  it('parses code, an indented blank line, then a paragraph (LF)', async() => {
    const md = '    code line\n    \npara\n';
    const html = await parseWithTimeout(md);
    assert.strictEqual(html, '<pre><code>code line\n</code></pre>\n<p>para</p>\n');

    const { starts } = topLevelStarts(md);
    assert.deepEqual(starts.map(s => ({ type: s.type, start: s.start })), [
      { type: 'code', start: 0 },
      { type: 'space', start: 13 },
      { type: 'paragraph', start: 19 },
    ]);
    assert.strictEqual(starts[0].raw, '    code line');
    assert.strictEqual(starts[2].raw, 'para\n');
  });

  it('parses code, an indented blank line, then a paragraph (CRLF)', async() => {
    const md = '    code line\r\n    \r\npara\r\n';
    const html = await parseWithTimeout(md);
    assert.strictEqual(html, '<pre><code>code line\n</code></pre>\n<p>para</p>\n');

    const { starts } = topLevelStarts(md);
    assert.deepEqual(starts.map(s => ({ type: s.type, start: s.start })), [
      { type: 'code', start: 0 },
      { type: 'space', start: 13 },
      { type: 'paragraph', start: 19 },
    ]);
  });

  it('consumes several indented blank lines after the code', async() => {
    const md = '    code\n    \n    \n    \nnext\n';
    const html = await parseWithTimeout(md);
    assert.strictEqual(html, '<pre><code>code\n</code></pre>\n<p>next</p>\n');

    const { starts, total } = topLevelStarts(md);
    assert.deepEqual(starts.map(s => ({ type: s.type, start: s.start })), [
      { type: 'code', start: 0 },
      { type: 'space', start: 8 },
      { type: 'paragraph', start: 24 },
    ]);
    assert.strictEqual(starts[1].raw, '\n    \n    \n    \n');
    assert.strictEqual(total, md.length);
  });

  it('keeps a blank line inside the code block', async() => {
    const md = '    a\n\n    b\n    \n';
    const html = await parseWithTimeout(md);
    assert.strictEqual(html, '<pre><code>a\n\nb\n</code></pre>\n');

    const { starts, total } = topLevelStarts(md);
    assert.deepEqual(starts.map(s => ({ type: s.type, start: s.start })), [
      { type: 'code', start: 0 },
      { type: 'space', start: 12 },
    ]);
    assert.strictEqual(starts[0].raw, '    a\n\n    b');
    assert.strictEqual(total, md.length);
  });

  it('lexes indented code inside a list item with an indented blank line', async() => {
    const md = '- item\n\n      code\n      \nnext\n';
    const html = await parseWithTimeout(md);
    assert.strictEqual(html, '<ul>\n<li><p>item</p>\n<pre><code>code\n</code></pre>\n</li>\n</ul>\n<p>next</p>\n');

    const tokens = new Lexer().lex(md);
    assert.strictEqual(tokens[0].type, 'list');
    assert.strictEqual(tokens[0].items[0].tokens.at(-1).type, 'code');
    assert.strictEqual(tokens[0].items[0].tokens.at(-1).raw, '    code');

    // following block starts right after the list and its trailing blank line
    const { starts } = topLevelStarts(md);
    assert.deepEqual(starts.map(s => ({ type: s.type, start: s.start })), [
      { type: 'list', start: 0 },
      { type: 'space', start: 18 },
      { type: 'paragraph', start: 26 },
    ]);
  });

  it('handles the same list shape with CRLF line endings', async() => {
    const md = '- item\r\n\r\n      code\r\n      \r\nnext\r\n';
    const html = await parseWithTimeout(md);
    assert.strictEqual(html, '<ul>\n<li><p>item</p>\n<pre><code>code\n</code></pre>\n</li>\n</ul>\n<p>next</p>\n');
  });

  it('does not let indented code interrupt a paragraph', async() => {
    const md = 'para\n    code\n    \n';
    const html = await parseWithTimeout(md);
    assert.strictEqual(html, '<p>para\n    code</p>\n');

    const { starts, total } = topLevelStarts(md);
    assert.deepEqual(starts.map(s => ({ type: s.type, start: s.start })), [
      { type: 'paragraph', start: 0 },
      { type: 'space', start: 13 },
    ]);
    assert.strictEqual(starts[0].raw, 'para\n    code');
    assert.strictEqual(total, md.length);
  });
});

describe('indented code on whitespace-only non-blank lines', () => {
  // String.prototype.trim() treats vertical tab (and form feed, ...) as blank,
  // but CommonMark blank lines contain spaces and tabs only. Treating such a
  // line as blank produced a zero-length indented-code token and stalled.
  it('returns the CommonMark code block for tab + vertical tab (LF)', async() => {
    const md = '\t\v\n';
    const html = await parseWithTimeout(md);
    assert.strictEqual(html, '<pre><code>\v\n</code></pre>\n');

    const { starts, total } = topLevelStarts(md);
    assert.deepEqual(starts, [
      { type: 'code', start: 0, raw: '\t\v\n' },
    ]);
    assert.strictEqual(total, md.length);
  });

  it('returns the CommonMark code block for tab + vertical tab (CRLF)', async() => {
    const md = '\t\v\r\n';
    const html = await parseWithTimeout(md);
    assert.strictEqual(html, '<pre><code>\v\n</code></pre>\n');

    // CRLF is normalized to LF during preprocessing, so the single token
    // covers the whole normalized document.
    const { starts, total } = topLevelStarts(md);
    assert.deepEqual(starts, [
      { type: 'code', start: 0, raw: '\t\v\n' },
    ]);
    assert.strictEqual(total, md.replace(/\r\n/g, '\n').length);
  });

  it('handles four-space indentation with a vertical tab', async() => {
    const md = '    \v\n';
    const html = await parseWithTimeout(md);
    assert.strictEqual(html, '<pre><code>\v\n</code></pre>\n');
  });

  it('keeps the vertical-tab line attached to the preceding code', async() => {
    const md = '    code\n    \v\npara\n';
    const html = await parseWithTimeout(md);
    assert.strictEqual(html, '<pre><code>code\n\v\n</code></pre>\n<p>para</p>\n');

    const { starts } = topLevelStarts(md);
    assert.strictEqual(starts[0].raw, '    code\n    \v\n');
    assert.deepEqual(starts.map(s => ({ type: s.type, start: s.start })), [
      { type: 'code', start: 0 },
      { type: 'paragraph', start: 15 },
    ]);
  });

  it('handles two consecutive vertical-tab lines', async() => {
    const md = '    \v\n    \v\n';
    const html = await parseWithTimeout(md);
    assert.strictEqual(html, '<pre><code>\v\n\v\n</code></pre>\n');
  });
});

describe('block lexer progress condition', () => {
  it('skips a block extension that returns a zero-length raw token', () => {
    const lexer = new Lexer({
      gfm: true,
      extensions: {
        block: [() => ({ type: 'emptyBlock', raw: '' })],
      },
    });

    // must terminate and fall through to the built-in rules instead of looping
    const tokens = lexer.lex('para\n');
    assert(tokens.some(t => t.type === 'paragraph'));
    assert(tokens.every(t => t.type !== 'emptyBlock'));
  });

  it('skips an inline extension that returns a zero-length raw token', () => {
    const lexer = new Lexer({
      gfm: true,
      extensions: {
        inline: [() => ({ type: 'emptyInline', raw: '' })],
      },
    });

    const tokens = [];
    lexer.inlineTokens('x', tokens);
    assert(tokens.some(t => t.type === 'text'));
    assert(tokens.every(t => t.type !== 'emptyInline'));
  });

  it('still honors a block extension that consumes input', () => {
    const lexer = new Lexer({
      gfm: true,
      extensions: {
        block: [(src) => {
          const match = /^!\n?/.exec(src);
          if (match) {
            return { type: 'bang', raw: match[0] };
          }
        }],
      },
    });

    const tokens = lexer.lex('!\n');
    assert(tokens.some(t => t.type === 'bang'));
  });
});
