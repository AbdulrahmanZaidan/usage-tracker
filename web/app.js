'use strict';
const VENDOR = { claude: 'Claude', chatgpt: 'ChatGPT' };
const PROVIDERS = Object.keys(VENDOR);
const $ = (sel, root = document) => root.querySelector(sel);
const cards = $('#cards'), dialog = $('#login'), home = $('#home'), accounts = $('#accounts');
const REMOTE = !['localhost', '127.0.0.1'].includes(location.hostname);      // a tablet on the Wi-Fi
const still = matchMedia('(prefers-reduced-motion: reduce)');
let T = LANGS.ar, state = null, skew = 0, missed = 0, loginSeen = null, view = null;

// ── server ──
async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Usage-Tracker': '1' }, body: JSON.stringify(body) });
  const data = await res.json();
  if (res.status === 401) askPair();
  if (!res.ok) throw new Error(data.error || 'error');
  return data;
}
async function sync(path = '/api/state', body) {
  try {
    const data = await api(path, body);
    state = data; skew = data.now - Date.now() / 1000; missed = 0;
  } catch (e) {
    if (e instanceof TypeError) missed++;      // no server; a refused request is not "offline"
  }
  $('#offline').hidden = missed < 2;
  if (state) render();
}

// ── words ──
const now = () => Date.now() / 1000 + skew;
function span(sec) {
  const m = Math.max(0, Math.round(sec / 60)), d = Math.floor(m / 1440), h = Math.floor(m % 1440 / 60), r = m % 60;
  if (m < 1) return T.underMinute;
  if (d) return h ? T.dh(d, h) : T.days(d);
  return h ? (r ? T.hm(h, r) : T.h(h)) : T.m(r);
}
const fmt = (t, options) => new Intl.DateTimeFormat(T.locale, options).format(t);
function clock(ts) {
  const midnight = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const t = new Date(ts * 1000), today = new Date(now() * 1000);
  const gap = Math.round((midnight(t) - midnight(today)) / 864e5);
  const day = gap === 0 ? T.today : gap === 1 ? T.tomorrow
    : gap < 7 ? fmt(t, { weekday: 'long' }) : fmt(t, { day: 'numeric', month: 'short' });
  return `${day} ${fmt(t, { hour: 'numeric', minute: '2-digit', hour12: T.hour12 })}`;
}
function windowName(min) {
  if (min === 300) return T.fiveHours;
  if (min === 10080) return T.week;
  if (min >= 40000) return T.month;
  return min >= 1440 ? T.nDays(Math.round(min / 1440)) : T.nHours(Math.round(min / 60));
}
function problem(error) {                      // { code, detail } from the program
  const text = T.errors[error.code] || T.errors.other;
  return typeof text === 'function' ? text(error.detail || '') : text;
}

// ── language ──
function translate(root = document) {
  for (const el of root.querySelectorAll('[data-t]')) el.textContent = T[el.dataset.t];
  for (const el of root.querySelectorAll('[data-t-label]')) {
    el.title = T[el.dataset.tLabel];
    el.setAttribute('aria-label', T[el.dataset.tLabel]);
  }
}
function setLanguage(code) {
  T = LANGS[code];
  document.documentElement.lang = code;
  document.documentElement.dir = T.dir;
  document.title = T.title;
  $('#langs').setAttribute('aria-label', T.language);
  for (const b of $('#langs').children) b.setAttribute('aria-pressed', b.lang === code);
  translate();
  $('#offline').textContent = REMOTE ? T.offlineTablet : T.offline;
  if (state) render();
}
function initLanguage() {
  let saved = null;
  try { saved = localStorage.getItem('lang'); } catch { /* storage blocked: Arabic */ }
  for (const code of Object.keys(LANGS)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.lang = code;
    b.textContent = LANGS[code].name;
    b.onclick = () => {
      try { localStorage.setItem('lang', code); } catch { /* not remembered */ }
      setLanguage(code);
    };
    $('#langs').append(b);
  }
  setLanguage(Object.hasOwn(LANGS, saved) ? saved : 'ar');
}

// ── going between the table and a cup ──
const wanted = () => PROVIDERS.includes(location.hash.slice(1)) ? location.hash.slice(1) : null;
function showAccounts(provider) {
  view = provider;
  fitted = '';
  cards.replaceChildren();
  $('.vendor', accounts).textContent = VENDOR[provider];
  $('.medal use').setAttribute('href', `#g-${provider}`);
  accounts.hidden = false;
  home.inert = true;
  home.hidden = true;
  scrollTo(0, 0);
  if (state) render();
}
function showHome() {
  view = null;
  accounts.hidden = true;
  home.hidden = false;
  home.inert = false;
  if (state) render();
}
const OUT = 'cubic-bezier(.16,.84,.24,1)';
function enterAccounts() {
  // the latte art stays behind from the cup and flies to its place in the header
  const medal = $('.medal'), box = medal.getBoundingClientRect();
  const dx = innerWidth / 2 - (box.left + box.width / 2), dy = innerHeight / 2 - (box.top + box.height / 2);
  medal.animate([
    { transform: `translate(${dx}px, ${dy}px) scale(3.1) rotate(-200deg)`, opacity: 0 },
    { transform: `translate(${dx}px, ${dy}px) scale(2.7) rotate(-120deg)`, opacity: 1, offset: .3, easing: 'cubic-bezier(.6,0,.1,1)' },
    { transform: 'none', opacity: 1 }], { duration: 1150, fill: 'backwards' });
  const rise = (el, delay, from = 'translateY(30px)') => el && el.animate(
    [{ opacity: 0, transform: from }, { opacity: 1, transform: 'none' }], { duration: 850, delay, easing: OUT, fill: 'backwards' });
  rise($('.accounts .back'), 620, 'scale(.4)');
  rise($('.accounts .title'), 700, 'translateY(16px)');
  rise($('.accounts .actions'), 760, 'translateY(16px)');
  [...cards.children].forEach((c, i) => rise(c, 620 + i * 110, 'translateY(70px) scale(.94)'));
}
async function leaveAccounts() {
  const gone = [...cards.children, $('.accounts header')].map((el, i) => el.animate(
    [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(34px) scale(.97)' }],
    { duration: 300, delay: Math.min(i, 3) * 40, easing: 'ease-in', fill: 'forwards' }));
  await Promise.all(gone.map(a => a.finished));
  return () => gone.forEach(a => a.cancel());
}
let moving = false, settled = 0;
async function go() {
  const to = wanted();
  if (moving || to === view) return;
  const from = view, animate = Scene.ok && !still.matches && !document.hidden;
  moving = true;
  try {
    if (from) {                                  // up, out of the cup
      const undo = animate ? await leaveAccounts() : null;
      showHome();
      undo?.();
      if (animate) {
        document.body.dataset.view = 'moving';
        const risen = Scene.rise(PROVIDERS.indexOf(from));
        setTimeout(() => { document.body.dataset.view = 'home'; }, 900);
        await risen;
      }
      Scene.home();
      document.body.dataset.view = 'home';
      if (!to) $(`.cup-link[data-provider="${from}"]`).focus({ preventScroll: true, focusVisible: false });
    }
    if (to) {                                    // down, into it
      const reveal = () => {
        showAccounts(to);
        settled = performance.now() + (animate ? 750 : 0);
        if (animate) enterAccounts();
      };
      if (animate) {
        document.body.dataset.view = 'moving';
        home.inert = true;
        await Scene.dive(PROVIDERS.indexOf(to), reveal);
      } else reveal();
      Scene.stop();
      document.body.dataset.view = 'accounts';
      $('.vendor', accounts).focus({ preventScroll: true });
    }
  } finally {
    moving = false;
  }
  if (wanted() !== view) go();                   // the person changed their mind on the way
}

// ── cards (elements are kept between syncs so the rings animate) ──
function partFor(box, template, minutes) {
  let el = $(`[data-min="${minutes}"]`, box);
  if (!el) {
    el = $(template).content.firstElementChild.cloneNode(true);
    el.dataset.min = minutes;
    box.append(el);
  }
  return el;
}
function countTo(el, value) {                    // the number runs with its ring
  const from = Number(el.dataset.value || 0);
  if (el.dataset.value === String(value)) { if (!el.counting) el.textContent = T.percent(value); return; }
  el.dataset.value = value;
  cancelAnimationFrame(el.counting);
  if (still.matches || document.hidden) { el.counting = 0; el.textContent = T.percent(value); return; }
  const start = Math.max(performance.now(), settled);
  const tick = t => {
    const k = Math.min(1, Math.max(0, (t - start) / 1200)), eased = 1 - Math.pow(1 - k, 4);
    el.textContent = T.percent(Math.round(from + (value - from) * eased));
    el.counting = k < 1 ? requestAnimationFrame(tick) : 0;
  };
  el.textContent = T.percent(from);
  el.counting = requestAnimationFrame(tick);
}
function level(w) {
  const renewed = w.resets_at && w.resets_at <= now(), used = renewed ? 0 : w.used;
  return { renewed, used, shown: Math.round(used) };
}
function paintWindow(el, w, sweep, word) {       // what the circle and the bar have in common
  const { renewed, used, shown } = level(w);
  $('h3', el).textContent = windowName(w.minutes);
  el.classList.toggle('near', shown >= 70 && shown < 90);
  el.classList.toggle('full', shown >= 90);
  const wait = settled - performance.now();
  if (wait > 0) { setTimeout(() => sweep(used), wait); } else { el.getBoundingClientRect(); sweep(used); }
  countTo($('b', el), shown);
  word ||= shown >= 100 ? T.out : shown >= 90 ? T.near : T.used;
  $('small', el).textContent = word;
  $('.back-in', el).textContent = renewed ? T.renewed : w.resets_at ? T.back(span(w.resets_at - now()))
    : used > 0 ? T.unknown : T.notStarted;
  $('.clock', el).textContent = !renewed && w.resets_at ? clock(w.resets_at) : '';
  $('[role="img"]', el).setAttribute('aria-label', `${windowName(w.minutes)}: ${T.percent(shown)} ${word}`);
}
function paintDial(el, w, longer) {              // the five hours: what changes while you work
  const blocker = longer.find(x => level(x).shown >= 100);
  el.classList.toggle('blocked', !!blocker);
  paintWindow(el, w, used => {
    const fill = $('.fill', el);
    fill.style.strokeDasharray = used > 0 ? `${Math.max(used, 1)} 200` : '0 200';
    fill.style.visibility = used > 0 ? 'visible' : 'hidden';      // a round cap would leave a dot at 0
  }, blocker && T.blocked(windowName(blocker.minutes)));
}
function paintBar(el, w) {                       // the week: a slow budget
  paintWindow(el, w, used => { $('.rail i', el).style.width = used > 0 ? `max(${used}%, 14px)` : '0'; });
}
function cardFor(a) {
  let el = cards.querySelector(`[data-id="${a.id}"]`);
  if (el) return el;
  el = $('#card').content.firstElementChild.cloneNode(true);
  el.dataset.id = a.id;
  translate(el);
  const ask = show => { $('.confirm', el).hidden = !show; fit(); };
  $('.remove', el).onclick = () => ask($('.confirm', el).hidden);
  $('.confirm .quiet', el).onclick = () => ask(false);
  $('.confirm .danger', el).onclick = () => sync('/api/remove', { account: a.id });
  $('.problem button', el).onclick = () => startLogin(a.provider, a.id);
  return el;
}
// ChatGPT gives no name: "first.last@…" reads as "first last"
const nameFrom = email => email && email.split('@')[0].split('+')[0].replace(/[._-]+/g, ' ').trim();
function paintCard(el, a) {
  $('.plan', el).textContent = a.plan || '';
  $('.name bdi', el).textContent = a.name || nameFrom(a.email) || VENDOR[a.provider];
  $('.email', el).textContent = a.email || '';
  const [first, ...longer] = a.windows || [];    // shortest first
  const dials = $('.dials', el), bars = $('.bars', el);
  for (const d of [...dials.children]) if (!first || String(first.minutes) !== d.dataset.min) d.remove();
  for (const b of [...bars.children]) if (!longer.some(w => String(w.minutes) === b.dataset.min)) b.remove();
  if (first) paintDial(partFor(dials, '#dial', first.minutes), first, longer);
  for (const w of longer) paintBar(partFor(bars, '#bar', w.minutes), w);
  $('.problem', el).hidden = !a.error;
  if (a.error) {
    $('.problem span', el).textContent = problem(a.error);
    $('.problem button', el).hidden = a.error.code !== 'login' || REMOTE;
  }
  const age = a.read_at ? now() - a.read_at : null;
  $('.age', el).textContent = (age === null ? '' : age < 60 ? T.justNow : T.age(span(age))) + (a.busy ? ` · ${T.updating}` : '');
}
function render() {
  for (const link of document.querySelectorAll('.cup-link')) {
    const n = state.accounts.filter(a => a.provider === link.dataset.provider).length;
    $('small', link).textContent = n || !state.starting ? T.accounts(n) : T.searching;
  }
  if (view) renderAccounts(state.accounts.filter(a => a.provider === view));
  renderLogin();
  renderTablet();
}
function renderAccounts(list) {
  let empty = $('.empty', cards);
  $('.count', accounts).textContent = T.accounts(list.length);
  if (!list.length) {
    if (!empty) {
      empty = $('#empty').content.firstElementChild.cloneNode(true);
      cards.replaceChildren(empty);
    }
    $('h2', empty).textContent = state.starting ? T.searching : T.none;
    $('p', empty).textContent = state.starting ? T.searchingText : REMOTE ? T.noneTablet : T.noneText;
  } else {
    if (empty) empty.remove();
    for (const el of [...cards.children]) if (!list.some(a => a.id === el.dataset.id)) el.remove();
    list.forEach((a, i) => {
      const el = cardFor(a);
      if (cards.children[i] !== el) cards.insertBefore(el, cards.children[i] || null);
      paintCard(el, a);
    });
  }
  const reading = list.some(a => a.busy);
  $('#refresh').disabled = reading || !list.length;
  $('#refresh').classList.toggle('reading', reading);
  $('#refresh span').textContent = reading ? T.refreshing : T.refresh;
  $('#refresh').setAttribute('aria-label', reading ? T.refreshing : T.refresh);
  $('#refresh').title = T.refresh;
  fit();
}

// ── every account on one screen ──
let fitted = '';
function fit() {
  const n = cards.querySelectorAll('.card').length;
  if (!view || !n) return;
  const W = cards.clientWidth, gap = 16, floor = 18, notes = cards.querySelectorAll(':is(.problem, .confirm):not([hidden])').length;
  const key = [n, W, innerHeight, T.locale, notes, view, cards.textContent.length >> 3].join();
  if (key === fitted) return;
  fitted = key;
  const H = innerHeight - cards.offsetTop - floor, options = [];
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols), w = (W - gap * (cols - 1)) / cols, h = (H - gap * (rows - 1)) / rows - (notes ? 60 : 0);
    // [shape, narrowest card, largest ring that could fit, smallest useful ring, how much we like it]
    for (const [shape, narrow, ring, least, like] of [
      ['tall', 208, Math.min(w - 56, h - 264, 240), 88, 1],
      ['wide', 310, Math.min(w * .4, h - 194, 250), 88, 1],
      ['mini', 290, Math.min(w * .3, h - 124, 124), 52, .8]]) {
      if (w >= narrow && ring >= least) options.push({ cols, rows, shape, ring, least, score: ring * like * n / (cols * rows) });      // no empty places
    }
  }
  const apply = o => {
    cards.dataset.shape = o.shape;
    cards.style.setProperty('--cols', o.cols);
    cards.style.setProperty('--ring', `${Math.floor(o.ring)}px`);
  };
  for (const o of options.sort((a, b) => b.score - a.score)) {
    apply(o);                                    // the estimate may be a little off: measure, shrink the ring, or try the next
    for (let i = 0; i < 4; i++) {
      const over = cards.offsetTop + cards.offsetHeight + floor - innerHeight;
      if (over <= 0) return;
      o.ring -= Math.ceil(over / o.rows);
      if (o.ring < o.least) break;
      apply(o);
    }
  }
  apply({ cols: Math.max(1, Math.min(n, Math.floor((W + gap) / 316))), shape: W < 360 ? 'mini' : 'tall', ring: W < 360 ? 84 : 150 });   // too many: scroll
}
addEventListener('resize', fit);

// ── sign-in dialog ──
function showStep(name) {
  const before = $('.step.on', dialog);
  for (const s of dialog.querySelectorAll('.step')) s.classList.toggle('on', s.dataset.step === name);
  if (name === 'link' && before?.dataset.step !== 'link') $('#open-private').focus({ focusVisible: false });
  $('#close').textContent = ['starting', 'link'].includes(name) ? T.cancel : T.close;
  $('#close').hidden = name === 'checking';
}
function renderLogin() {
  const l = state.login;
  if (!l || loginSeen !== l.id) return;          // not the sign-in this page is showing
  for (const h of dialog.querySelectorAll('.into')) h.textContent = T.signInTo(VENDOR[l.provider]);
  if (l.state === 'done' || l.state === 'cancelled') { loginSeen = null; dialog.close(); return; }
  $('.why', dialog).textContent = l.error ? problem(l.error) : '';
  showStep(l.state === 'waiting' ? 'link' : l.state);
}
let lastLogin = null;
async function startLogin(provider, account) {
  lastLogin = [provider, account];
  loginSeen = null;
  showStep('starting');
  if (!dialog.open) dialog.showModal();
  try {
    state = await api('/api/login', { provider, account });
    loginSeen = state.login.id;
    render();
  } catch (e) {
    $('.why', dialog).textContent = problem({ code: e.message });
    showStep('error');
  }
}
$('#add').onclick = () => startLogin(view);
$('#again').onclick = () => startLogin(...lastLogin);
$('#open-private').onclick = () => sync('/api/login/open', { private: true });
$('#open-normal').onclick = () => sync('/api/login/open', { private: false });
$('#close').onclick = () => dialog.close();
dialog.addEventListener('cancel', e => { if (loginSeen && state.login && state.login.state === 'checking') e.preventDefault(); });
dialog.addEventListener('close', () => {
  if (loginSeen) { loginSeen = null; sync('/api/login/cancel', {}); }
});

// ── letting a tablet in (on the PC) ──
const door = $('#tablet');
function renderTablet() {
  const t = state.tablet;
  $('#tablet-open').hidden = !t;
  if (!t) return;
  $('#tablet-open').classList.toggle('on', t.on);
  $('.door', door).hidden = !t.url;
  $('#tablet-url').textContent = t.url || '';
  $('#tablet-code').textContent = t.code || '';
  $('#tablet-problem').hidden = !t.problem;
  $('#tablet-problem').textContent = t.problem ? problem({ code: t.problem }) : '';
  $('#tablet-switch').textContent = t.on ? T.tabletOff : T.tabletOn;
  $('#tablet-switch').className = t.on ? 'quiet wide' : 'solid wide';
}
$('#tablet-open').onclick = () => door.showModal();
$('#tablet-close').onclick = () => door.close();
$('#tablet-switch').onclick = () => sync('/api/tablet', { on: !state.tablet.on });

// ── getting in (on the tablet) ──
const pair = $('#pair');
function askPair() {
  if (!REMOTE || pair.open) return;
  pair.showModal();
  $('#pair-code').focus();
}
$('form', pair).onsubmit = async e => {
  e.preventDefault();
  const digits = $('#pair-code').value.replace(/[٠-٩۰-۹]/g, d => d.charCodeAt(0) & 15).replace(/\D/g, '');
  try {
    state = await api('/api/pair', { code: digits });
    skew = state.now - Date.now() / 1000;
    pair.close();
    render();
  } catch (error) {
    const box = $('#pair-problem');
    box.hidden = false;
    box.textContent = error instanceof TypeError ? T.offlineTablet : problem({ code: error.message });
    $('#pair-code').select();
  }
};
pair.addEventListener('cancel', e => e.preventDefault());

// ── start ──
document.documentElement.classList.toggle('remote', REMOTE);
$('#refresh').onclick = () => sync('/api/refresh', {});
addEventListener('hashchange', go);
addEventListener('keydown', e => { if (e.key === 'Escape' && view && !dialog.open && !moving) location.hash = ''; });
document.documentElement.classList.toggle('flat', !Scene.ok);
initLanguage();
if (wanted()) {                                  // opened on a provider's page: no dive
  document.body.dataset.view = 'accounts';
  showAccounts(wanted());
  Scene.stop();
} else Scene.home();
sync();
setInterval(() => sync(), 2500);
document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });
