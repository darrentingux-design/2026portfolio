import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isAllowedOrigin,
  parseOrigins,
  validateConversation,
  hashIp,
  checkRateLimit,
  eventsToTextStream,
  REFUSAL_TEXT,
} from '../src/lib.js';
import { handle } from '../src/handler.js';

// ---------- fakes ----------
function fakeKv() {
  const store = new Map();
  return {
    store,
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value) { store.set(key, value); },
  };
}

const textEvent = (text) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
const thinkingEvent = { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } };

function fakeClient(events, { failWith, calls = [], state = {} } = {}) {
  return {
    messages: {
      stream(params) {
        calls.push(params);
        return {
          abort() { state.aborted = true; },
          [Symbol.asyncIterator]() {
            let i = 0;
            return {
              async next() {
                if (failWith) throw failWith;
                return i < events.length ? { value: events[i++], done: false } : { value: undefined, done: true };
              },
            };
          },
        };
      },
    },
  };
}

const ORIGIN = 'https://darrenting.com';
const baseEnv = (over = {}) => ({ ANTHROPIC_API_KEY: 'test-key', RATE_LIMIT: fakeKv(), ...over });
const post = (body, { origin = ORIGIN, headers = {}, raw } = {}) =>
  new Request('https://worker.test/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}), 'CF-Connecting-IP': '203.0.113.7', ...headers },
    body: raw ?? JSON.stringify(body),
  });
const ask = (text) => ({ messages: [{ role: 'user', content: text }] });
const deps = (client) => ({ systemPrompt: 'SYSTEM PROMPT', createClient: () => client });

// ---------- origins / CORS ----------
test('allows darrenting.com and loopback, rejects look-alikes', () => {
  for (const o of ['https://darrenting.com', 'https://www.darrenting.com', 'http://localhost', 'http://localhost:3000', 'http://127.0.0.1:8787']) {
    assert.equal(isAllowedOrigin(o), true, o);
  }
  for (const o of ['https://evil.com', 'https://darrenting.com.evil.com', 'http://localhost.evil.com', 'http://darrenting.com', 'null', '', null, undefined]) {
    assert.equal(isAllowedOrigin(o), false, String(o));
  }
});

test('parseOrigins reads a comma list and falls back to defaults', () => {
  assert.deepEqual(parseOrigins('https://a.com/, https://b.com'), ['https://a.com', 'https://b.com']);
  assert.deepEqual(parseOrigins(''), ['https://darrenting.com', 'https://www.darrenting.com']);
});

test('preflight: allowed origin gets CORS headers, others get 403', async () => {
  const ok = await handle(new Request('https://worker.test/', { method: 'OPTIONS', headers: { Origin: ORIGIN } }), baseEnv(), deps());
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.match(ok.headers.get('Access-Control-Allow-Methods'), /POST/);
  const bad = await handle(new Request('https://worker.test/', { method: 'OPTIONS', headers: { Origin: 'https://evil.com' } }), baseEnv(), deps());
  assert.equal(bad.status, 403);
  assert.equal(bad.headers.get('Access-Control-Allow-Origin'), null);
});

test('POST from a disallowed or missing origin is refused before any work', async () => {
  const calls = [];
  for (const origin of ['https://evil.com', null]) {
    const res = await handle(post(ask('hi'), { origin }), baseEnv(), deps(fakeClient([], { calls })));
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
  }
  assert.equal(calls.length, 0);
});

test('health check works for a plain GET', async () => {
  const res = await handle(new Request('https://worker.test/health'), baseEnv(), deps());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, service: 'darren-llm' });
});

// ---------- validation ----------
test('validateConversation: accepts good input and trims', () => {
  const r = validateConversation({ messages: [{ role: 'user', content: '  hi  ' }] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.messages, [{ role: 'user', content: 'hi' }]);
});

test('validateConversation: 1000 chars ok, 1001 rejected with 413', () => {
  assert.equal(validateConversation(ask('a'.repeat(1000))).ok, true);
  const r = validateConversation(ask('a'.repeat(1001)));
  assert.equal(r.ok, false);
  assert.equal(r.status, 413);
  assert.equal(r.error, 'message_too_long');
});

test('validateConversation: rejects malformed input', () => {
  for (const body of [null, {}, { messages: 'x' }, { messages: [] }, { messages: [{ role: 'system', content: 'x' }] },
    { messages: [{ role: 'user', content: 5 }] }, { messages: [{ role: 'user', content: '   ' }] },
    { messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] }]) {
    const r = validateConversation(body);
    assert.equal(r.ok, false, JSON.stringify(body));
    assert.equal(r.status >= 400, true);
  }
});

test('validateConversation: keeps the last 12 messages and starts on a user turn', () => {
  const msgs = [];
  for (let i = 0; i < 15; i++) msgs.push({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` });
  msgs.push({ role: 'user', content: 'last' });
  const r = validateConversation({ messages: msgs });
  assert.equal(r.ok, true);
  assert.equal(r.messages.length <= 12, true);
  assert.equal(r.messages[0].role, 'user');
  assert.equal(r.messages.at(-1).content, 'last');
});

// ---------- rate limiting ----------
test('rate limit: 20 allowed per hour, 21st blocked, other IPs unaffected, window resets', async () => {
  const kv = fakeKv();
  const t0 = Date.UTC(2026, 9, 26, 12, 10, 0);
  for (let i = 1; i <= 20; i++) {
    const r = await checkRateLimit(kv, 'ipA', { limit: 20, now: t0 });
    assert.equal(r.allowed, true);
    assert.equal(r.remaining, 20 - i);
  }
  const blocked = await checkRateLimit(kv, 'ipA', { limit: 20, now: t0 });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfter, 50 * 60);
  assert.equal((await checkRateLimit(kv, 'ipB', { limit: 20, now: t0 })).allowed, true);
  assert.equal((await checkRateLimit(kv, 'ipA', { limit: 20, now: t0 + 60 * 60 * 1000 })).allowed, true);
});

test('hashIp is stable, short, and does not contain the address', async () => {
  const a = await hashIp('203.0.113.7');
  assert.equal(a, await hashIp('203.0.113.7'));
  assert.notEqual(a, await hashIp('203.0.113.8'));
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.equal(a.includes('203'), false);
});

// ---------- streaming ----------
async function readAll(stream) {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let out = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return out;
    out += dec.decode(value, { stream: true });
  }
}

test('eventsToTextStream: only text deltas come through; refusal adds a fallback line', async () => {
  const events = [{ type: 'message_start' }, thinkingEvent, textEvent('Hel'), textEvent('lo'), { type: 'message_delta', delta: { stop_reason: 'end_turn' } }];
  const it = events[Symbol.iterator]();
  const wrap = { async next() { return it.next(); } };
  assert.equal(await readAll(eventsToTextStream(wrap, await wrap.next())), 'Hello');

  const ref = [{ type: 'message_delta', delta: { stop_reason: 'refusal' } }];
  const it2 = ref[Symbol.iterator]();
  const wrap2 = { async next() { return it2.next(); } };
  assert.equal(await readAll(eventsToTextStream(wrap2, await wrap2.next())), REFUSAL_TEXT);
});

test('eventsToTextStream: a mid-stream failure errors the stream', async () => {
  let n = 0;
  const it = { async next() { if (n++ === 0) return { value: textEvent('a'), done: false }; throw new Error('boom'); } };
  await assert.rejects(readAll(eventsToTextStream(it, await it.next())), /boom/);
});

// ---------- end to end through the handler ----------
test('POST streams the reply with CORS headers and calls the model correctly', async () => {
  const calls = [];
  const client = fakeClient([{ type: 'message_start' }, textEvent('Hi '), textEvent('there'), { type: 'message_stop' }], { calls });
  const res = await handle(post({ messages: [{ role: 'user', content: 'Who is Darren?' }] }), baseEnv({ MODEL: 'claude-haiku-5-5' }), deps(client));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.match(res.headers.get('Content-Type'), /text\/plain/);
  assert.equal(res.headers.get('X-RateLimit-Remaining'), '19');
  assert.equal(await readAll(res.body), 'Hi there');

  assert.equal(calls.length, 1);
  const p = calls[0];
  assert.equal(p.model, 'claude-haiku-5-5');
  assert.equal(p.system[0].text, 'SYSTEM PROMPT');
  assert.deepEqual(p.system[0].cache_control, { type: 'ephemeral' });
  assert.deepEqual(p.messages, [{ role: 'user', content: 'Who is Darren?' }]);
  for (const banned of ['temperature', 'top_p', 'top_k']) assert.equal(banned in p, false, banned);
});

test('defaults to claude-haiku-5-5 when MODEL is not set', async () => {
  const calls = [];
  await handle(post(ask('hi')), baseEnv(), deps(fakeClient([textEvent('x')], { calls })));
  assert.equal(calls[0].model, 'claude-haiku-5-5');
});

test('21st message in an hour from one IP gets a 429 with Retry-After and CORS', async () => {
  const env = baseEnv();
  const client = fakeClient([textEvent('ok')]);
  for (let i = 0; i < 20; i++) {
    const r = await handle(post(ask('hi')), env, deps(client));
    assert.equal(r.status, 200, `request ${i + 1}`);
    await readAll(r.body);
  }
  const res = await handle(post(ask('hi')), env, deps(client));
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.equal(Number(res.headers.get('Retry-After')) > 0, true);
  assert.equal((await res.json()).error, 'rate_limited');
});

test('rate limit counts per IP', async () => {
  const env = baseEnv({ RATE_LIMIT_PER_HOUR: '1' });
  const client = fakeClient([textEvent('ok')]);
  const a = (ip) => post(ask('hi'), { headers: { 'CF-Connecting-IP': ip } });
  assert.equal((await handle(a('198.51.100.1'), env, deps(client))).status, 200);
  assert.equal((await handle(a('198.51.100.1'), env, deps(client))).status, 429);
  assert.equal((await handle(a('198.51.100.2'), env, deps(client))).status, 200);
});

test('overlong message is rejected with 413 and never reaches the model or the rate limiter', async () => {
  const calls = [];
  const env = baseEnv();
  const res = await handle(post(ask('x'.repeat(1001))), env, deps(fakeClient([], { calls })));
  assert.equal(res.status, 413);
  assert.equal(calls.length, 0);
  assert.equal(env.RATE_LIMIT.store.size, 0);
});

test('bad content type, bad JSON, and oversized bodies are refused', async () => {
  assert.equal((await handle(post(null, { headers: { 'Content-Type': 'text/plain' }, raw: 'hi' }), baseEnv(), deps())).status, 415);
  assert.equal((await handle(post(null, { raw: '{not json' }), baseEnv(), deps())).status, 400);
  assert.equal((await handle(post(null, { raw: JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(70000) }] }) }), baseEnv(), deps())).status, 413);
});

test('missing API key or KV binding fails closed with a generic 500', async () => {
  const noKey = await handle(post(ask('hi')), { RATE_LIMIT: fakeKv() }, deps());
  assert.equal(noKey.status, 500);
  const noKv = await handle(post(ask('hi')), { ANTHROPIC_API_KEY: 'k' }, deps());
  assert.equal(noKv.status, 500);
  assert.equal((await noKv.json()).error, 'server_misconfigured');
});

test('KV outage fails closed with 503', async () => {
  const env = baseEnv({ RATE_LIMIT: { async get() { throw new Error('kv down'); }, async put() {} } });
  const res = await handle(post(ask('hi')), env, deps(fakeClient([textEvent('x')])));
  assert.equal(res.status, 503);
});

test('upstream errors map to safe statuses without leaking details', async () => {
  const cases = [[429, 503, 'busy'], [529, 503, 'busy'], [401, 500, 'server_misconfigured'], [400, 502, 'upstream_error'], [500, 502, 'upstream_error']];
  for (const [upstream, expected, code] of cases) {
    const err = Object.assign(new Error('secret upstream detail'), { status: upstream });
    const res = await handle(post(ask('hi')), baseEnv(), deps(fakeClient([], { failWith: err })));
    assert.equal(res.status, expected, `upstream ${upstream}`);
    const body = await res.json();
    assert.equal(body.error, code);
    assert.equal(JSON.stringify(body).includes('secret upstream detail'), false);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  }
});

test('cancelling the response aborts the upstream stream', async () => {
  const state = {};
  const res = await handle(post(ask('hi')), baseEnv(), deps(fakeClient([textEvent('a'), textEvent('b'), textEvent('c')], { state })));
  const reader = res.body.getReader();
  await reader.read();
  await reader.cancel();
  assert.equal(state.aborted, true);
});
