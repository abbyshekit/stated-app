// The jury's models as people see them: the maker's logo and a short model name.
import { readFileSync } from 'node:fs';
import { html } from './html.mjs';
import { face } from './certificate.mjs';

export const MODEL_LOGOS = new Map(['qwen', 'deepseek', 'zai'].map(family => [family,
  readFileSync(new URL(`../public/models/${family}.svg`, import.meta.url))]));
export const modelFace = (id) => {
  const family = id.startsWith('Qwen/') ? 'qwen' : id.startsWith('deepseek-ai/') ? 'deepseek'
    : /^(?:z-ai|zai-org)\//.test(id) ? 'zai' : null;
  const maker = { qwen: 'Qwen', deepseek: 'DeepSeek', zai: 'Z.ai' }[family];
  return family ? html`<span class="face model-logo ${family}" role="img" aria-label="${maker} logo"></span>`
    : face({ name: modelName(id) });
};
export const modelName = (id) => /^(?:z-ai|zai-org)\/glm-5\.3-flash$/i.test(id) ? 'GLM-5.3 Flash' : id.split('/').at(-1)
  .replace(/-(?:A\d+B|FP\d+|BF\d+|Flash|Instruct|Thinking|\d{4,8})(?=-|$)/gi, '')
  .replaceAll('-', ' ');
