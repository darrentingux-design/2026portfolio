# Darren LLM worker

A Cloudflare Worker that answers questions about Darren using Claude Haiku 5.5. The site's chat widget (`../chat-widget.js`) talks to it.

- `knowledge.md`: the system prompt. The only file you edit to change what it knows or how it behaves.
- `src/handler.js`: the request flow (CORS, validation, rate limit, streaming).
- `src/lib.js`: small pure helpers. `src/index.js` wires in the Anthropic SDK.
- `wrangler.toml`: Worker config. Non-secret settings live under `[vars]`.
- `test/`: unit tests (`npm test`).

## What it enforces

| Rule | Where |
|---|---|
| Only `https://darrenting.com`, `https://www.darrenting.com`, and `localhost` / `127.0.0.1` (any port) may call it | `ALLOWED_ORIGINS` in `wrangler.toml` + `src/lib.js` |
| 20 messages per hour per IP (IPs are hashed before storage) | `RATE_LIMIT_PER_HOUR`, stored in KV |
| 1,000 characters per message, last 12 messages of history, 64 KB body | `MAX_MESSAGE_CHARS`, `src/lib.js` |
| Replies capped at 700 tokens | `MAX_TOKENS` |
| API key is a Worker secret, never in code | `wrangler secret put` |

The origin check stops other websites using your Worker from a browser. It does not stop someone calling it with `curl` and a forged `Origin` header, so the per-IP limit and your Anthropic spend limit are the real protection.

## Deploy

You need a free [Cloudflare account](https://dash.cloudflare.com/sign-up) and an [Anthropic API key](https://console.anthropic.com/). Run everything from this `worker/` folder.

**1. Install Node.js** (LTS) from <https://nodejs.org>, then check it:

```bash
node -v
```

**2. Install dependencies**

```bash
npm install
```

**3. Log in to Cloudflare** (opens your browser)

```bash
npx wrangler login
```

**4. Create the rate-limit store**

```bash
npx wrangler kv namespace create RATE_LIMIT
```

Copy the `id` it prints into `wrangler.toml`, replacing `PASTE_KV_NAMESPACE_ID_HERE`. (Newer Wrangler versions may offer to add the binding for you. If so, accept, and make sure the binding name stays `RATE_LIMIT`.)

**5. Deploy.** The first time, Wrangler asks you to pick a `workers.dev` subdomain.

```bash
npx wrangler deploy
```

It prints your URL, like `https://darren-llm.<your-subdomain>.workers.dev`.

**6. Store the API key as a secret.** Type or paste it at the prompt (the input is hidden). Do not paste it into chat or into any file in this repo.

```bash
npx wrangler secret put ANTHROPIC_API_KEY
```

**7. Set a monthly spend limit** in the Anthropic console (Settings, then Limits). This is your hard backstop.

**8. Test it**

```bash
curl https://darren-llm.<your-subdomain>.workers.dev/health
```

```bash
curl -N -X POST https://darren-llm.<your-subdomain>.workers.dev \
  -H "Origin: https://darrenting.com" -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Who is Darren?"}]}'
```

You should see the answer stream in. The same request without the `Origin` header should return `403`.

**9. Turn on the site widget.** Edit `../chat-config.js`: set `endpoint` to your URL and `enabled` to `true`. Then publish the site as usual:

```bash
~/Projects/portfolio-tools/publish.sh
```

The publish script adds the widget to `index.html` and changes the tile from "coming soon" to "Ask".

## Day to day

- **Change what it knows or how it talks:** edit `knowledge.md`, then `npx wrangler deploy`.
- **Change the limits or model:** edit `[vars]` in `wrangler.toml`, then `npx wrangler deploy`.
- **Watch live logs:** `npx wrangler tail` (logs contain error events only, never messages or IPs).
- **Run it locally:** copy `.dev.vars.example` to `.dev.vars`, put your key in it, run `npx wrangler dev`, and open the site from `http://localhost:<port>`. The widget uses `http://localhost:8787` when the site runs on localhost.
- **Run the tests:** `npm test`.

## Good to know

- **This folder is public.** The site is hosted from this repo, so `knowledge.md` is readable at `darrenting.com/worker/knowledge.md`. Only put things in it that you are happy to publish. `.dev.vars` is git-ignored; never commit a key.
- **The Worker is not behind the site's password.** Anyone can ask it anything in `knowledge.md`.
- **Cost:** Haiku 5.5 is $0.10 per million input tokens and $0.50 per million output tokens, and the knowledge file is about 3,500 tokens. Rough estimate: about $0.0005 per message, so 1,000 messages is around 50 cents. Prompt caching lowers it further.
- **Cloudflare free plan:** KV allows roughly 1,000 writes per day (check current limits), and each chat message uses one. If you hit it, the Worker refuses requests (it fails closed instead of running unmetered) until the next day. The Workers Paid plan removes this.
- **The rate limit is approximate.** KV is eventually consistent, so a burst of simultaneous requests can slip a few messages past 20.
