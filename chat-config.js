// Settings for the Darren LLM chat widget (chat-widget.js).
//
// To switch it on after deploying the Worker (see worker/README.md):
//   1. set `endpoint` to your Worker URL, e.g. https://darren-llm.<your-subdomain>.workers.dev
//   2. set `enabled` to true
//   3. publish
// While `enabled` is false the widget does nothing and the tile stays "coming soon".
window.DARREN_LLM = {
  enabled: true,
  endpoint: 'https://darren-llm.darren-llm-worker.workers.dev',
  // Used instead of `endpoint` when the site is opened from localhost (wrangler dev default).
  devEndpoint: 'http://localhost:8787',
  // Suggested first questions (3 or 4 works best).
  starters: [
    'What are you working on at BMO?',
    'Walk me through the Positive Pay case study',
    'How do you approach design problems?',
    'What do you do outside of design?',
  ],
};
