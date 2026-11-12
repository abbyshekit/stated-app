import { parentPort } from 'node:worker_threads';
import { extractArticle } from './articles.mjs';
import { evidenceText } from './evidence-text.mjs';

parentPort.on('message', ({ operation, html, finalUrl, options }) => {
  try {
    const result = operation === 'article' ? extractArticle(html, finalUrl, options) : evidenceText(html, finalUrl, options);
    parentPort.postMessage({ result });
  } catch (error) {
    parentPort.postMessage({ error: error.message || 'Unable to read that page.' });
  }
});
