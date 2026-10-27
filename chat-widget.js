/* Darren LLM chat widget.
 *
 * Self-contained: no framework, no build step. It opens when the "llm" tile on
 * the home grid is clicked, talks to the Cloudflare Worker in /worker, and
 * takes its colours from the page's own light/dark theme. Settings live in
 * chat-config.js. Injected into index.html by portfolio-tools/apply_patches.py
 * so it survives Claude Design re-exports.
 */
(() => {
  'use strict';

  const cfg = window.DARREN_LLM || {};
  const isLocal = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  const ENDPOINT = isLocal ? cfg.devEndpoint || 'http://localhost:8787' : cfg.endpoint;
  if (!cfg.enabled || !ENDPOINT || /YOUR-SUBDOMAIN/.test(ENDPOINT)) return;

  const MAX_CHARS = 1000;
  const SEND_HISTORY = 10;
  const STARTERS = Array.isArray(cfg.starters) && cfg.starters.length ? cfg.starters.slice(0, 2) : [
    'What are you working on at BMO?',
    'Walk me through the Positive Pay case study',
  ];
  const INTRO = "Hi, I'm Darren LLM, an AI trained on Darren's background. Ask me about my work, process, or experience.";

  // Same tokens as the page's THEME object in index.html.
  const THEMES = {
    light: { bg: 'rgb(243,254,255)', text: 'rgb(0,100,135)', sub: 'rgb(116,159,174)', card: 'rgb(254,255,255)', pill: 'rgb(255,255,255)', navBg: 'rgb(232,247,252)', tint: 'rgb(237,246,250)', ink: 'rgb(30,40,45)', bar: 'rgb(226,233,235)' },
    dark: { bg: 'rgb(16,17,20)', text: 'rgb(194,226,255)', sub: 'rgb(140,176,206)', card: 'rgb(31,48,71)', pill: 'rgb(44,66,96)', navBg: 'rgb(21,28,38)', tint: 'rgb(24,36,52)', ink: 'rgb(235,240,245)', bar: 'rgb(24,36,52)' },
  };

  const CSS = `
.dllm-root{font-family:'Instrument Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:var(--ink);-webkit-font-smoothing:antialiased}
.dllm-root *{box-sizing:border-box}
.dllm-root{--dllm-size:68px;--dllm-right:40px;--dllm-bottom:40px;--dllm-gap:16px;--dllm-lift:calc(var(--dllm-bottom) + var(--dllm-size) + var(--dllm-gap))}
.dllm-launcher{position:fixed;z-index:150;right:calc(var(--dllm-right) + var(--dllm-size) + var(--dllm-gap));bottom:var(--dllm-bottom);width:var(--dllm-size);height:var(--dllm-size);padding:0;border:0;border-radius:999px;background:var(--card);color:var(--text);box-shadow:0 4px 20px rgba(0,0,0,.18);cursor:pointer;overflow:hidden;opacity:0;transform:translateY(12px) scale(.85);visibility:hidden;pointer-events:none;transition:opacity .25s ease,transform .25s ease,background-color .3s ease,box-shadow .2s ease,visibility 0s linear .25s}
.dllm-root[data-launcher="true"] .dllm-launcher{opacity:1;transform:none;visibility:visible;pointer-events:auto;transition-delay:0s}
.dllm-root[data-launcher="true"] .dllm-launcher:hover{box-shadow:0 10px 28px rgba(0,60,80,.22)}
.dllm-ico{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;transition:opacity .2s ease,transform .2s ease}
.dllm-ico-close{opacity:0;transform:rotate(-45deg) scale(.8)}
.dllm-root[data-open="true"] .dllm-ico-chat{opacity:0;transform:rotate(45deg) scale(.8)}
.dllm-root[data-open="true"] .dllm-ico-close{opacity:1;transform:none}
.dllm-panel{position:fixed;right:var(--dllm-right);bottom:var(--dllm-lift);z-index:1000;width:min(420px,calc(100vw - 32px));height:min(560px,calc(100vh - var(--dllm-lift) - 24px));height:min(560px,calc(100dvh - var(--dllm-lift) - 24px));display:flex;flex-direction:column;background:var(--card);border-radius:12px;box-shadow:0 10px 28px rgba(0,60,80,.16),0 1px 5px rgba(0,0,0,.08);overflow:hidden;opacity:0;transform:translateY(12px) scale(.98);transform-origin:100% 100%;visibility:hidden;pointer-events:none;transition:opacity .25s ease,transform .25s ease,background-color .3s ease,visibility 0s linear .25s}
.dllm-root[data-open="true"] .dllm-panel{opacity:1;transform:none;visibility:visible;pointer-events:auto;transition-delay:0s}
.dllm-head{display:flex;align-items:center;gap:12px;padding:16px 16px 12px 20px}
.dllm-avatar{flex:none;width:44px;height:44px;border-radius:999px;border:2px solid #fff;background:var(--navBg);overflow:hidden;display:flex;align-items:center;justify-content:center;transition:background-color .3s ease}
.dllm-avatar img{width:100%;height:100%;object-fit:contain;transform:rotate(6deg) scale(1.1)}
.dllm-avatar span{font-weight:700;font-size:18px;color:var(--text)}
.dllm-titles{flex:1;min-width:0}
.dllm-titles h2{margin:0;font-weight:600;font-size:18px;line-height:1.2;color:var(--text)}
.dllm-titles p{margin:2px 0 0;font-weight:500;font-size:13px;line-height:1.3;color:var(--sub)}
.dllm-close{flex:none;width:32px;height:32px;border:0;border-radius:999px;background:var(--navBg);color:var(--text);display:flex;align-items:center;justify-content:center;cursor:pointer;transition:box-shadow .2s ease,background-color .3s ease}
.dllm-close:hover{box-shadow:0 2px 8px rgba(0,60,80,.18)}
.dllm-log{flex:1;min-height:0;overflow-y:auto;padding:4px 20px 12px;display:flex;flex-direction:column;gap:12px;scroll-behavior:smooth;overscroll-behavior:contain}
.dllm-msg{max-width:88%;font-size:15px;line-height:1.5;word-wrap:break-word;overflow-wrap:anywhere}
.dllm-msg p{margin:0}
.dllm-msg p+p,.dllm-msg ul+p,.dllm-msg p+ul{margin-top:8px}
.dllm-msg ul{margin:0;padding-left:20px}
.dllm-msg li+li{margin-top:2px}
.dllm-msg a{color:var(--text);text-decoration:underline;text-underline-offset:2px;font-weight:600}
.dllm-a{align-self:flex-start;color:var(--ink)}
.dllm-u{align-self:flex-end;background:var(--text);color:var(--card);padding:10px 14px;border-radius:16px 16px 4px 16px;font-weight:500;transition:background-color .3s ease,color .3s ease}
.dllm-u p{white-space:pre-wrap}
.dllm-err{align-self:flex-start;background:var(--navBg);color:var(--ink);padding:10px 14px;border-radius:12px;font-size:14px}
.dllm-dots{display:inline-flex;gap:4px;padding:6px 0}
.dllm-dots i{width:7px;height:7px;border-radius:999px;background:var(--sub);animation:dllm-bounce 1.2s infinite ease-in-out}
.dllm-dots i:nth-child(2){animation-delay:.15s}
.dllm-dots i:nth-child(3){animation-delay:.3s}
@keyframes dllm-bounce{0%,60%,100%{transform:translateY(0);opacity:.5}30%{transform:translateY(-4px);opacity:1}}
.dllm-starters{display:flex;flex-wrap:wrap;gap:8px;padding:0 20px 12px}
.dllm-starters[hidden]{display:none}
.dllm-chip{border:0;border-radius:999px;background:var(--navBg);color:var(--text);font:inherit;font-weight:600;font-size:14px;line-height:1.3;padding:8px 14px;text-align:left;cursor:pointer;transition:box-shadow .2s ease,background-color .3s ease,color .3s ease}
.dllm-chip:hover{box-shadow:0 2px 8px rgba(0,60,80,.18)}
.dllm-form{display:flex;align-items:flex-end;gap:8px;padding:0 16px 8px 20px}
.dllm-field{flex:1;position:relative;min-width:0}
.dllm-input{display:block;width:100%;resize:none;border:1.5px solid var(--bar);border-radius:12px;background:var(--tint);color:var(--ink);font:inherit;font-size:15px;line-height:1.4;padding:10px 12px;max-height:112px;outline:none;transition:border-color .2s ease,background-color .3s ease,color .3s ease}
.dllm-input::placeholder{color:var(--sub)}
.dllm-input:focus{border-color:var(--text)}
.dllm-count{position:absolute;right:10px;bottom:-16px;font-size:11px;font-weight:600;color:var(--sub)}
.dllm-count[data-over="true"]{color:rgb(180,40,40)}
.dllm-send{flex:none;width:42px;height:42px;border:0;border-radius:999px;background:var(--text);color:var(--card);display:flex;align-items:center;justify-content:center;cursor:pointer;transition:opacity .2s ease,box-shadow .2s ease,background-color .3s ease}
.dllm-send:hover:not(:disabled){box-shadow:0 4px 12px rgba(0,60,80,.28)}
.dllm-send:disabled{opacity:.4;cursor:default}
.dllm-foot{margin:0;padding:6px 20px 14px;font-size:12px;line-height:1.4;font-weight:500;color:var(--sub);min-height:32px}
.dllm-root button:focus-visible,.dllm-root a:focus-visible,.dllm-log:focus-visible{outline:2px solid var(--text);outline-offset:2px}
@media (hover:hover) and (pointer:fine){body:not([data-dc-editor-on]) .dllm-root,body:not([data-dc-editor-on]) .dllm-root *{cursor:none!important}}
[data-tile="llm"][data-dllm-ready]{cursor:pointer}
[data-tile="llm"][data-dllm-ready]:focus-visible{outline:2px solid ${THEMES.light.text};outline-offset:3px}
@media (max-width:560px){
  .dllm-panel{right:16px;left:16px;width:auto}
  .dllm-input{font-size:16px}
}
@media (prefers-reduced-motion:reduce){
  .dllm-panel,.dllm-root *{transition:none!important;animation:none!important;scroll-behavior:auto!important}
}`;

  const SVG = {
    close: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    chat: '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-8.9 8.4 9 9 0 0 1-3.4-.7L3.5 21l1.9-4.8A8.3 8.3 0 0 1 3.9 11.5 8.5 8.5 0 0 1 12.4 3 8.5 8.5 0 0 1 21 11.5z"/></svg>',
    down: '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9.5l6 6 6-6"/></svg>',
    send: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5.5 11.5L12 5l6.5 6.5"/></svg>',
  };

  // ---------- state ----------
  let root, panel, launcher, log, startersEl, form, input, sendBtn, countEl, footEl, avatarImg, avatarWrap;
  let history = [];
  let busy = false;
  let isOpen = false;
  let themeName = 'light';
  let chibi = { light: null, dark: null };

  // ---------- helpers ----------
  const el = (tag, cls, attrs) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (attrs) for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  };

  function detectTheme() {
    const m = /rgba?\((\d+)/.exec(getComputedStyle(document.body).backgroundColor || '');
    return m && +m[1] < 128 ? 'dark' : 'light';
  }

  function readChibi() {
    const layers = document.querySelectorAll('[data-tile="llm"] [data-chibi] > div');
    const url = (n) => {
      const m = n && /url\(["']?([^"')]+)["']?\)/.exec(getComputedStyle(n).backgroundImage || '');
      return m ? m[1] : null;
    };
    if (layers.length >= 2) chibi = { light: url(layers[0]), dark: url(layers[1]) };
  }

  function applyTheme() {
    themeName = detectTheme();
    if (!root) return;
    const t = THEMES[themeName];
    for (const [k, v] of Object.entries(t)) root.style.setProperty('--' + k, v);
    const src = chibi[themeName];
    if (avatarImg) {
      if (src) { avatarImg.src = src; avatarImg.hidden = false; avatarWrap.querySelector('span').hidden = true; }
      else { avatarImg.hidden = true; avatarWrap.querySelector('span').hidden = false; }
    }
  }

  // Safe rich text: paragraphs, "- " bullets, **bold**, and http(s)/email links. Built with DOM nodes, never innerHTML.
  function inline(parent, text) {
    const re = /\*\*([^*]+)\*\*|(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"])|([\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,})/g;
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m.index > last) parent.append(text.slice(last, m.index));
      if (m[1] !== undefined) {
        const b = el('strong');
        b.textContent = m[1];
        parent.append(b);
      } else {
        const a = el('a');
        a.href = m[2] ? m[2] : 'mailto:' + m[3];
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = m[2] || m[3];
        parent.append(a);
      }
      last = re.lastIndex;
    }
    if (last < text.length) parent.append(text.slice(last));
  }

  function renderRich(container, text) {
    container.textContent = '';
    let list = null;
    let para = null;
    for (const raw of text.replace(/\r/g, '').split('\n')) {
      const line = raw.trimEnd();
      const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
      if (!line.trim()) { list = null; para = null; continue; }
      if (bullet) {
        para = null;
        if (!list) { list = el('ul'); container.append(list); }
        const li = el('li');
        inline(li, bullet[1]);
        list.append(li);
      } else {
        list = null;
        if (!para) { para = el('p'); container.append(para); }
        else para.append(el('br'));
        inline(para, line.trim());
      }
    }
  }

  // The launcher sits left of the page's light/dark switch and the panel opens
  // above both. Read the switch's size and offsets from the page so they stay
  // aligned if the design changes; fall back to the CSS defaults.
  function place() {
    if (!root) return;
    const sw = document.querySelector('[aria-label="Toggle day and night"]');
    if (!sw || !sw.offsetWidth) return;
    const cs = getComputedStyle(sw);
    const right = parseFloat(cs.right);
    const bottom = parseFloat(cs.bottom);
    root.style.setProperty('--dllm-size', sw.offsetWidth + 'px');
    if (Number.isFinite(right)) root.style.setProperty('--dllm-right', right + 'px');
    if (Number.isFinite(bottom)) root.style.setProperty('--dllm-bottom', bottom + 'px');
  }

  // Once the chat has been opened, the launcher stays on the page (open or closed) so it can be reopened from anywhere.
  function updateLauncher() {
    if (!launcher) return;
    root.dataset.launcher = 'true';
    launcher.setAttribute('aria-expanded', String(isOpen));
    launcher.setAttribute('aria-label', isOpen ? 'Close chat with Darren LLM' : 'Open chat with Darren LLM');
  }

  const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  const toBottom = () => { log.scrollTop = log.scrollHeight; };

  function addMessage(role, text) {
    const wrap = el('div', 'dllm-msg ' + (role === 'user' ? 'dllm-u' : 'dllm-a'));
    renderRich(wrap, text);
    log.append(wrap);
    toBottom();
    return wrap;
  }

  function addError(text) {
    const wrap = el('div', 'dllm-msg dllm-err', { role: 'alert' });
    wrap.textContent = text;
    log.append(wrap);
    toBottom();
    return wrap;
  }

  function dots() {
    const d = el('span', 'dllm-dots', { 'aria-label': 'Darren LLM is typing' });
    d.append(el('i'), el('i'), el('i'));
    return d;
  }

  function setBusy(v) {
    busy = v;
    sendBtn.disabled = v || !input.value.trim();
    input.setAttribute('aria-busy', String(v));
  }

  function autosize() {
    input.style.height = 'auto';
    const border = input.offsetHeight - input.clientHeight; // box-sizing is border-box
    const want = input.scrollHeight + border;
    input.style.height = Math.min(want, 112) + 'px';
    input.style.overflowY = want > 112 ? 'auto' : 'hidden';
    const n = input.value.length;
    countEl.hidden = n < 800;
    countEl.textContent = n + '/' + MAX_CHARS;
    countEl.dataset.over = String(n > MAX_CHARS);
    sendBtn.disabled = busy || !input.value.trim() || n > MAX_CHARS;
  }

  // ---------- network ----------
  async function readError(res) {
    let body = null;
    try { body = await res.json(); } catch { /* not JSON */ }
    if (res.status === 429) {
      return (body && body.message) || "You've reached the hourly message limit. Please try again later, or email Darren directly.";
    }
    if (res.status === 413) return `Messages are limited to ${MAX_CHARS} characters.`;
    return (body && body.message) || 'Darren LLM had trouble answering. Please try again.';
  }

  async function send(raw) {
    const text = (raw || '').trim();
    if (!text || busy || text.length > MAX_CHARS) return;
    setBusy(true);
    startersEl.hidden = true;
    footEl.textContent = '';
    const userEl = addMessage('user', text);
    input.value = '';
    autosize();
    history.push({ role: 'user', content: text });
    updateLauncher();

    const bot = el('div', 'dllm-msg dllm-a');
    bot.append(dots());
    log.append(bot);
    toBottom();

    let received = '';
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history.slice(-SEND_HISTORY) }),
      });
      if (!res.ok) throw Object.assign(new Error('http'), { userMessage: await readError(res) });

      const left = parseInt(res.headers.get('X-RateLimit-Remaining') || '', 10);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        received += decoder.decode(value, { stream: true });
        const stick = nearBottom();
        renderRich(bot, received);
        if (stick) toBottom();
      }
      received += decoder.decode();
      if (!received.trim()) throw Object.assign(new Error('empty'), { userMessage: 'Darren LLM had trouble answering. Please try again.' });
      renderRich(bot, received);
      history.push({ role: 'assistant', content: received });
      if (Number.isFinite(left) && left <= 3) {
        footEl.textContent = left === 0 ? 'That was your last message for this hour.' : `${left} message${left === 1 ? '' : 's'} left this hour.`;
      }
    } catch (err) {
      if (received.trim()) {
        // Keep what arrived, and say it was cut short.
        renderRich(bot, received);
        history.push({ role: 'assistant', content: received });
        addError('The reply was cut off. You can ask again.');
      } else {
        bot.remove();
        userEl.remove(); // the question goes back in the input box instead
        history.pop();
        input.value = text;
        autosize();
        addError(err.userMessage || "Couldn't reach Darren LLM. Check your connection and try again.");
      }
    } finally {
      setBusy(false);
      updateLauncher();
      toBottom();
      if (isOpen) input.focus({ preventScroll: true });
    }
  }

  // ---------- build / open / close ----------
  function build() {
    const style = el('style');
    style.textContent = CSS;
    document.head.append(style);

    root = el('div', 'dllm-root');
    root.dataset.open = 'false';

    launcher = el('button', 'dllm-launcher', { type: 'button', 'aria-label': 'Open chat with Darren LLM', 'aria-controls': 'dllm-panel', 'aria-expanded': 'false' });
    const icoChat = el('span', 'dllm-ico dllm-ico-chat');
    icoChat.innerHTML = SVG.chat;
    const icoClose = el('span', 'dllm-ico dllm-ico-close');
    icoClose.innerHTML = SVG.down;
    launcher.append(icoChat, icoClose);
    launcher.addEventListener('click', () => setOpen(!isOpen));

    panel = el('section', 'dllm-panel', { id: 'dllm-panel', role: 'dialog', 'aria-label': 'Chat with Darren LLM', 'aria-hidden': 'true' });

    const head = el('header', 'dllm-head');
    avatarWrap = el('div', 'dllm-avatar');
    avatarImg = el('img', '', { alt: '' });
    const initial = el('span');
    initial.textContent = 'D';
    avatarWrap.append(avatarImg, initial);
    const titles = el('div', 'dllm-titles');
    const h = el('h2');
    h.textContent = 'Darren LLM';
    const sub = el('p');
    sub.textContent = "An AI trained on Darren's background";
    titles.append(h, sub);
    const close = el('button', 'dllm-close', { type: 'button', 'aria-label': 'Close chat' });
    close.innerHTML = SVG.close;
    close.addEventListener('click', () => setOpen(false));
    head.append(avatarWrap, titles, close);

    log = el('div', 'dllm-log', { role: 'log', 'aria-live': 'polite', tabindex: '0', 'aria-label': 'Conversation' });
    addMessage('assistant', INTRO);

    startersEl = el('div', 'dllm-starters', { role: 'group', 'aria-label': 'Suggested questions' });
    for (const q of STARTERS) {
      const b = el('button', 'dllm-chip', { type: 'button' });
      b.textContent = q;
      b.addEventListener('click', () => send(q));
      startersEl.append(b);
    }

    form = el('form', 'dllm-form');
    const field = el('div', 'dllm-field');
    input = el('textarea', 'dllm-input', { rows: '1', placeholder: "Ask about Darren's work…", 'aria-label': 'Your message', autocomplete: 'off', enterkeyhint: 'send' });
    countEl = el('span', 'dllm-count', { 'aria-hidden': 'true' });
    countEl.hidden = true;
    field.append(input, countEl);
    sendBtn = el('button', 'dllm-send', { type: 'submit', 'aria-label': 'Send message' });
    sendBtn.innerHTML = SVG.send;
    sendBtn.disabled = true;
    form.append(field, sendBtn);
    form.addEventListener('submit', (e) => { e.preventDefault(); send(input.value); });
    input.addEventListener('input', autosize);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(input.value); }
    });

    footEl = el('p', 'dllm-foot', { 'aria-live': 'polite' });

    panel.append(head, log, startersEl, form, footEl);
    panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });
    root.append(launcher, panel);
    // Set the colours and position before the nodes are attached so nothing transitions in from unstyled.
    readChibi();
    applyTheme();
    place();
    updateLauncher();
    document.body.append(root);
  }

  function setOpen(open) {
    if (open === isOpen) return;
    if (open && !root) build();
    isOpen = open;
    readChibi();
    applyTheme();
    place();
    root.dataset.open = String(open);
    panel.setAttribute('aria-hidden', String(!open));
    updateLauncher();
    const tile = document.querySelector('[data-tile="llm"]');
    if (tile) tile.setAttribute('aria-expanded', String(open));
    if (open) {
      toBottom();
      setTimeout(() => input.focus({ preventScroll: true }), 50);
    } else if (panel.contains(document.activeElement)) {
      // Hand focus back to whichever opener is still on screen.
      const next = root.dataset.launcher === 'true' ? launcher : tile;
      if (next) next.focus({ preventScroll: true });
    }
  }

  // ---------- tile wiring ----------
  // The tile is rendered by the page's own template and can re-render, so
  // re-apply its attributes whenever the DOM changes.
  function prepTile() {
    const tile = document.querySelector('[data-tile="llm"]');
    if (!tile || tile.hasAttribute('data-dllm-ready')) return;
    tile.setAttribute('data-dllm-ready', '');
    tile.setAttribute('role', 'button');
    tile.setAttribute('tabindex', '0');
    tile.setAttribute('aria-label', 'Chat with Darren LLM');
    tile.setAttribute('aria-haspopup', 'dialog');
    tile.setAttribute('aria-expanded', String(isOpen));
  }

  document.addEventListener('click', (e) => {
    const tile = e.target.closest && e.target.closest('[data-tile="llm"]');
    if (tile) { e.preventDefault(); setOpen(!isOpen); }
  });
  document.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('[data-tile="llm"]')) {
      e.preventDefault();
      setOpen(!isOpen);
    }
  });

  let queued = false;
  const observer = new MutationObserver(() => {
    if (queued) return;
    queued = true;
    setTimeout(() => {
      queued = false;
      prepTile();
      if (root && detectTheme() !== themeName) applyTheme();
      place();
    }, 100);
  });
  window.addEventListener('resize', place);
  const start = () => {
    prepTile();
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
  };
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
})();
