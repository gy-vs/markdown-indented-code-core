// Worker used by the "indented code blank line" regression tests.
// Running the lexer in a separate thread lets the main test enforce a real
// timeout: a lexer stuck in a CPU spin never resolves, so the parent
// terminates the worker and fails instead of hanging the whole suite.
import { parentPort } from 'node:worker_threads';
import { Lexer, Marked } from '../../../lib/marked.esm.js';

parentPort.on('message', ({ id, mode, md, options }) => {
  try {
    let result;
    if (mode === 'lex') {
      result = new Lexer(options).lex(md);
    } else {
      result = new Marked(options).parse(md);
    }
    parentPort.postMessage({ id, result });
  } catch(err) {
    const message = (err && err.message) ? err.message : String(err);
    parentPort.postMessage({ id, error: message });
  }
});
