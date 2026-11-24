'use strict';
const VENDOR = { claude: 'Claude', chatgpt: 'ChatGPT' };
const PROVIDERS = Object.keys(VENDOR);
const $ = (sel, root = document) => root.querySelector(sel);
const cards = $('#cards'), dialog = $('#login'), home = $('#home'), accounts = $('#accounts');
const still = matchMedia('(prefers-reduced-motion: reduce)');
let T = LANGS.ar, state = null, skew = 0, missed = 0, loginSeen = null, view = null;

// ── server ──
async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Usage-Tracker': '1' }, body: JSON.stringify(body) });
  const data = await res.json();
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
  $('#refresh').textContent = T.refresh;
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
function dialFor(box, minutes) {
  let el = $(`[data-min="${minutes}"]`, box);
  if (!el) {
    el = $('#dial').content.firstElementChild.cloneNode(true);
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
function paintDial(el, w) {
  const renewed = w.resets_at && w.resets_at <= now();
  const used = renewed ? 0 : w.used, shown = Math.round(used);
  const word = shown >= 100 ? T.out : shown >= 90 ? T.near : T.used;
  $('h3', el).textContent = windowName(w.minutes);
  el.classList.toggle('near', shown >= 70 && shown < 90);
  el.classList.toggle('full', shown >= 90);
  const fill = $('.fill', el), sweep = () => {
    fill.style.strokeDasharray = used > 0 ? `${Math.max(used, 1)} 200` : '0 200';
    fill.style.visibility = used > 0 ? 'visible' : 'hidden';      // a round cap would leave a dot at 0
  };
  const wait = settled - performance.now();
  if (wait > 0) { setTimeout(sweep, wait); } else { fill.getBoundingClientRect(); sweep(); }
  countTo($('b', el), shown);
  $('small', el).textContent = word;
  $('.back-in', el).textContent = renewed ? T.renewed : w.resets_at ? T.back(span(w.resets_at - now()))
    : used > 0 ? T.unknown : T.notStarted;
  $('.clock', el).textContent = !renewed && w.resets_at ? clock(w.resets_at) : '';
  $('.ring', el).setAttribute('aria-label', `${windowName(w.minutes)}: ${T.percent(shown)} ${word}`);
}
function cardFor(a) {
  let el = cards.querySelector(`[data-id="${a.id}"]`);
  if (el) return el;
  el = $('#card').content.firstElementChild.cloneNode(true);
  el.dataset.id = a.id;
  translate(el);
  const ask = show => { $('.confirm', el).hidden = !show; };
  $('.remove', el).onclick = () => ask($('.confirm', el).hidden);
  $('.confirm .quiet', el).onclick = () => ask(false);
  $('.confirm .danger', el).onclick = () => sync('/api/remove', { account: a.id });
  $('.problem button', el).onclick = () => startLogin(a.provider, a.id);
  return el;
}
function paintCard(el, a) {
  $('.plan', el).textContent = a.plan || '';
  $('.email', el).textContent = a.email || VENDOR[a.provider];
  const box = $('.dials', el), windows = a.windows || [];
  for (const d of [...box.children]) if (!windows.some(w => String(w.minutes) === d.dataset.min)) d.remove();
  for (const w of windows) paintDial(dialFor(box, w.minutes), w);
  $('.problem', el).hidden = !a.error;
  if (a.error) {
    $('.problem span', el).textContent = problem(a.error);
    $('.problem button', el).hidden = a.error.code !== 'login';
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
    $('p', empty).textContent = state.starting ? T.searchingText : T.noneText;
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
  $('#refresh').textContent = reading ? T.refreshing : T.refresh;
}

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

// ── start ──
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
