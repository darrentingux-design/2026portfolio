// The whole request flow. The Anthropic client and the system prompt are
// injected (see index.js) so this file can be tested without the SDK.
import {
  DEFAULTS,
  parseOrigins,
  isAllowedOrigin,
  corsHeaders,
  jsonResponse,
  validateConversation,
  hashIp,
  checkRateLimit,
  eventsToTextStream,
} from './lib.js';

const num = (value, fallback) => {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

function describeUpstreamError(err) {
  const status = err && typeof err.status === 'number' ? err.status : undefined;
  console.error(JSON.stringify({ event: 'upstream_error', status, requestId: err?.requestID ?? err?.request_id, name: err?.name }));
  if (status === 429 || status === 503 || status === 529) {
    return [503, 'busy', 'Darren LLM is busy right now. Please try again in a minute.'];
  }
  if (status === 401 || status === 403) {
    return [500, 'server_misconfigured', 'Darren LLM is not set up correctly. Please let Darren know.'];
  }
  return [502, 'upstream_error', 'Darren LLM had trouble answering. Please try again.'];
}

export async function handle(request, env, deps) {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  const allowedOrigins = parseOrigins(env.ALLOWED_ORIGINS);
  const originOk = isAllowedOrigin(origin, allowedOrigins);

  // Health check: lets you confirm a deploy with a plain browser visit.
  if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
    return jsonResponse(200, { ok: true, service: 'darren-llm' });
  }

  if (url.pathname !== '/' && url.pathname !== '/chat') {
    return jsonResponse(404, { error: 'not_found', message: 'Not found.' });
  }

  if (request.method === 'OPTIONS') {
    return originOk
      ? new Response(null, { status: 204, headers: corsHeaders(origin) })
      : jsonResponse(403, { error: 'origin_not_allowed', message: 'Origin not allowed.' });
  }

  if (request.method !== 'POST') {
    return jsonResponse(405, { error: 'method_not_allowed', message: 'Use POST.' }, { Allow: 'POST, OPTIONS' });
  }

  // Browsers always send Origin on cross-origin POSTs. Anything else (curl,
  // scripts) is refused. Origin can be spoofed outside a browser, so the rate
  // limit below is the real protection.
  if (!originOk) return jsonResponse(403, { error: 'origin_not_allowed', message: 'Origin not allowed.' });

  const cors = corsHeaders(origin);
  const fail = (status, error, message, extra = {}) => jsonResponse(status, { error, message }, { ...cors, ...extra });

  if (!(request.headers.get('Content-Type') || '').toLowerCase().includes('application/json')) {
    return fail(415, 'unsupported_media_type', 'Send JSON with Content-Type: application/json.');
  }
  const declared = parseInt(request.headers.get('Content-Length') || '0', 10);
  if (declared > DEFAULTS.maxBodyBytes) return fail(413, 'body_too_large', 'Request body too large.');

  let raw;
  try {
    raw = await request.text();
  } catch {
    return fail(400, 'invalid_request', 'Could not read the request body.');
  }
  if (raw.length > DEFAULTS.maxBodyBytes) return fail(413, 'body_too_large', 'Request body too large.');

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return fail(400, 'invalid_json', 'Body must be valid JSON.');
  }

  const maxMessageChars = num(env.MAX_MESSAGE_CHARS, DEFAULTS.maxMessageChars);
  const checked = validateConversation(body, { maxMessageChars });
  if (!checked.ok) return fail(checked.status, checked.error, checked.message);

  if (!env.ANTHROPIC_API_KEY || !env.RATE_LIMIT) {
    console.error(JSON.stringify({ event: 'misconfigured', hasKey: !!env.ANTHROPIC_API_KEY, hasKv: !!env.RATE_LIMIT }));
    return fail(500, 'server_misconfigured', 'Darren LLM is not set up correctly. Please let Darren know.');
  }

  // Rate limit per IP. Fails closed: if KV is unavailable we refuse rather than
  // risk unmetered spend.
  const limit = num(env.RATE_LIMIT_PER_HOUR, DEFAULTS.rateLimitPerHour);
  let rl;
  try {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    rl = await checkRateLimit(env.RATE_LIMIT, await hashIp(ip), { limit });
  } catch (err) {
    console.error(JSON.stringify({ event: 'rate_limit_error', name: err?.name }));
    return fail(503, 'rate_limiter_unavailable', 'Darren LLM is unavailable right now. Please try again later.');
  }
  const rlHeaders = { 'X-RateLimit-Limit': String(rl.limit), 'X-RateLimit-Remaining': String(rl.remaining) };
  if (!rl.allowed) {
    const minutes = Math.ceil(rl.retryAfter / 60);
    return fail(
      429,
      'rate_limited',
      `You've reached the limit of ${rl.limit} messages per hour. Please try again in about ${minutes} minute${minutes === 1 ? '' : 's'}, or email Darren directly.`,
      { ...rlHeaders, 'Retry-After': String(rl.retryAfter) },
    );
  }

  // Call the model. Read the first event before responding so upstream errors
  // become proper HTTP statuses instead of a broken 200 stream.
  let stream;
  let iterator;
  let first;
  try {
    const client = deps.createClient(env.ANTHROPIC_API_KEY);
    stream = client.messages.stream({
      model: env.MODEL || DEFAULTS.model,
      max_tokens: num(env.MAX_TOKENS, DEFAULTS.maxTokens),
      system: [{ type: 'text', text: deps.systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: checked.messages,
      output_config: { effort: 'low' },
    });
    iterator = stream[Symbol.asyncIterator]();
    first = await iterator.next();
  } catch (err) {
    const [status, error, message] = describeUpstreamError(err);
    return fail(status, error, message, rlHeaders);
  }

  const onCancel = () => {
    try {
      if (typeof stream.abort === 'function') stream.abort();
      else stream.controller?.abort();
    } catch {
      // already finished
    }
  };

  return new Response(eventsToTextStream(iterator, first, { onCancel }), {
    status: 200,
    headers: {
      ...cors,
      ...rlHeaders,
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
