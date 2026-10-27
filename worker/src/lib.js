// Pure helpers for the Darren LLM worker. No SDK, no Cloudflare globals beyond
// the Web-standard ones (Response, ReadableStream, crypto), so they run in
// Workers, Node 18+, and browsers.

export const DEFAULTS = {
  model: 'claude-haiku-5-5',
  maxTokens: 700,
  maxMessageChars: 1000, // per user message
  maxAssistantChars: 4000, // per assistant message in the history the client sends back
  maxHistory: 12, // most recent messages kept; older ones are dropped
  maxBodyBytes: 64 * 1024,
  rateLimitPerHour: 20,
  allowedOrigins: ['https://darrenting.com', 'https://www.darrenting.com'],
};

export const REFUSAL_TEXT =
  "I can't help with that one. Try asking about Darren's work, process, or background.";

const LOOPBACK = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;

// "https://a.com, https://b.com" -> ["https://a.com", "https://b.com"]
export function parseOrigins(value) {
  if (!value) return DEFAULTS.allowedOrigins;
  const list = String(value).split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
  return list.length ? list : DEFAULTS.allowedOrigins;
}

export function isAllowedOrigin(origin, allowed = DEFAULTS.allowedOrigins) {
  if (!origin || typeof origin !== 'string') return false;
  return allowed.includes(origin) || LOOPBACK.test(origin);
}

export function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Expose-Headers': 'Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

// Validates the client's conversation. Returns { ok: true, messages } with a
// cleaned list that is safe to send upstream, or { ok: false, status, error, message }.
export function validateConversation(body, opts = {}) {
  const maxChars = opts.maxMessageChars ?? DEFAULTS.maxMessageChars;
  const maxAssistant = opts.maxAssistantChars ?? DEFAULTS.maxAssistantChars;
  const maxHistory = opts.maxHistory ?? DEFAULTS.maxHistory;
  const fail = (error, message, status = 400) => ({ ok: false, status, error, message });

  if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) {
    return fail('invalid_request', 'Expected a JSON body like {"messages":[{"role":"user","content":"..."}]}.');
  }
  if (body.messages.length === 0) return fail('invalid_request', 'messages must not be empty.');
  if (body.messages.length > 100) return fail('invalid_request', 'Too many messages.');

  const cleaned = [];
  for (const m of body.messages) {
    if (!m || typeof m !== 'object' || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') {
      return fail('invalid_request', 'Each message needs a role of "user" or "assistant" and a string content.');
    }
    const content = m.content.trim();
    if (!content) return fail('invalid_request', 'Messages must not be empty.');
    const limit = m.role === 'user' ? maxChars : maxAssistant;
    if (content.length > limit) {
      return fail(
        m.role === 'user' ? 'message_too_long' : 'invalid_request',
        m.role === 'user' ? `Messages are limited to ${maxChars} characters.` : 'Assistant message too long.',
        m.role === 'user' ? 413 : 400,
      );
    }
    cleaned.push({ role: m.role, content });
  }

  if (cleaned[cleaned.length - 1].role !== 'user') {
    return fail('invalid_request', 'The last message must be from the user.');
  }

  // Keep only the most recent messages, and make sure the history starts with a user turn.
  let messages = cleaned.slice(-maxHistory);
  while (messages.length > 1 && messages[0].role !== 'user') messages = messages.slice(1);
  return { ok: true, messages };
}

// SHA-256 of the IP, so raw addresses are never stored as KV keys.
export async function hashIp(ip) {
  const data = new TextEncoder().encode(`darren-llm:${ip || 'unknown'}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Fixed-window counter per hashed IP, stored in KV. KV is eventually consistent,
// so a burst of simultaneous requests can slip a few messages past the limit;
// that is fine for cost control on a portfolio, and the window resets hourly.
export async function checkRateLimit(kv, ipHash, { limit = DEFAULTS.rateLimitPerHour, now = Date.now() } = {}) {
  const windowMs = 60 * 60 * 1000;
  const bucket = Math.floor(now / windowMs);
  const key = `rl:${ipHash}:${bucket}`;
  const used = parseInt((await kv.get(key)) || '0', 10) || 0;
  const retryAfter = Math.max(1, Math.ceil(((bucket + 1) * windowMs - now) / 1000));
  if (used >= limit) return { allowed: false, limit, remaining: 0, retryAfter };
  await kv.put(key, String(used + 1), { expirationTtl: 2 * 60 * 60 });
  return { allowed: true, limit, remaining: limit - used - 1, retryAfter };
}

// Turns the SDK's event stream into a plain-text byte stream. `first` is an
// optional already-read first result from the iterator ({ value, done }), used
// so the caller can surface upstream errors as HTTP statuses before streaming
// starts. The stream is pull-based: the model is only read as fast as the client
// consumes it, and cancelling the response calls `onCancel` (which aborts upstream).
export function eventsToTextStream(iterator, first, { onCancel } = {}) {
  const encoder = new TextEncoder();
  let pendingFirst = first || null;
  let refused = false;
  // Returns true if it enqueued text.
  const handle = (event, controller) => {
    if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
      controller.enqueue(encoder.encode(event.delta.text));
      return true;
    }
    if (event?.type === 'message_delta' && event.delta?.stop_reason === 'refusal') refused = true;
    return false;
  };
  return new ReadableStream({
    async pull(controller) {
      try {
        for (;;) {
          let result;
          if (pendingFirst) {
            result = pendingFirst;
            pendingFirst = null;
          } else {
            result = await iterator.next();
          }
          if (result.done) {
            if (refused) controller.enqueue(encoder.encode(REFUSAL_TEXT));
            controller.close();
            return;
          }
          if (handle(result.value, controller)) return;
        }
      } catch (err) {
        controller.error(err);
      }
    },
    cancel() {
      if (onCancel) onCancel();
    },
  });
}
