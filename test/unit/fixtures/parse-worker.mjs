// Parses the markdown it receives and posts the resulting HTML back.
// Running the parse in a worker lets the regression test enforce a timeout:
// the bug this covers is a busy loop that spins the CPU until the process is
// killed (it never throws and never returns).
import { parentPort } from 'node:worker_threads';
import { Marked } from '../../../lib/marked.esm.js';

parentPort.on('message', (markdown) => {
  parentPort.postMessage(new Marked().parse(markdown));
});
