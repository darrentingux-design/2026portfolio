import Anthropic from '@anthropic-ai/sdk';
// Bundled as text by the [[rules]] entry in wrangler.toml. Edit knowledge.md, then redeploy.
import knowledge from '../knowledge.md';
import { handle } from './handler.js';

export default {
  fetch(request, env, ctx) {
    return handle(request, env, {
      waitUntil: (promise) => ctx.waitUntil(promise),
      systemPrompt: knowledge,
      createClient: (apiKey) => new Anthropic({ apiKey, maxRetries: 1, timeout: 60_000 }),
    });
  },
};
