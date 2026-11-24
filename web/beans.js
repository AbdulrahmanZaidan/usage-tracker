'use strict';
// The coffee beans on the table: they can be picked up, thrown, knocked into saucers and each other, and
// dropped into a cup. Positions are CSS pixels; scene.js draws them.
const Beans = (() => {
  // where they lie at first: across = along the line between the cups, down = below it, in cup radii
  const HOMES = [
    { across: .10, down: .95, a: -.5 }, { across: -.30, down: 1.28, a: -2.2 }, { across: .28, down: 1.42, a: -1.3 },
    { across: .06, down: -1.16, a: -2.7 }, { across: 1.9, down: -.95, a: -.2, beyond: 1 }, { across: -1.85, down: 1.05, a: -1.8, beyond: -1 }];
  const beans = HOMES.map(h => ({ ...h, x: 0, y: 0, vx: 0, vy: 0, va: 0, lift: 0, size: 1, alpha: 1, sink: null, drop: null }));
  const ripples = [{ x: 0, y: 0, at: -1e9 }, { x: 0, y: 0, at: -1e9 }];
  let placed = null, held = null, hover = null, grip = { x: 0, y: 0 }, pointer = { x: 0, y: 0 }, trail = [], dragged = false;
  let enabled = () => false, cups = [];

  const unit = () => Math.min(cups[0].r, cups[1].r) * .16;
  const body = () => unit() * .8;
  function homeOf(b) {
    const [p, q] = cups, R = Math.min(p.r, q.r), dx = q.x - p.x, dy = q.y - p.y, len = Math.hypot(dx, dy) || 1;
    const right = Math.abs(dx) >= Math.abs(dy) ? { x: 1, y: 0 } : { x: 0, y: 1 }, down = { x: -right.y, y: right.x };
    const across = b.across * R + (b.beyond || 0) * len / 2;
    return { x: (p.x + q.x) / 2 + right.x * across + down.x * b.down * R, y: (p.y + q.y) / 2 + right.y * across + down.y * b.down * R };
  }
  function place() {                             // keeps the arrangement when the window is resized
    const mid = { x: (cups[0].x + cups[1].x) / 2, y: (cups[0].y + cups[1].y) / 2, r: Math.min(cups[0].r, cups[1].r) };
    if (!placed) for (const b of beans) Object.assign(b, homeOf(b));
    else if (Math.abs(placed.r - mid.r) > .4 || Math.abs(placed.y - mid.y) > .4) {
      for (const b of beans) { b.x = mid.x + (b.x - placed.x) / placed.r * mid.r; b.y = mid.y + (b.y - placed.y) / placed.r * mid.r; }
    }
    placed = mid;
  }
  const over = (b, c) => Math.hypot(b.x - c.x, b.y - c.y);

  function collide(dt) {
    const r = body();
    for (const b of beans) {
      if (b === held || b.sink !== null || b.drop !== null) continue;
      for (const c of cups) {                    // slide off the saucer, or bounce on its edge
        const d = over(b, c) || 1, reach = c.r * 1.45 + r;
        if (d >= reach) continue;
        const nx = (b.x - c.x) / d, ny = (b.y - c.y) / d, vn = b.vx * nx + b.vy * ny, out = Math.min(reach - d, 1100 * dt);
        b.x += nx * out; b.y += ny * out;
        if (vn < 0) { b.va += (b.vx * -ny + b.vy * nx) / r * .25; b.vx -= 1.5 * vn * nx; b.vy -= 1.5 * vn * ny; }
      }
      for (const [axis, v, size] of [['x', 'vx', innerWidth], ['y', 'vy', innerHeight]]) {
        if (b[axis] < r) { b[axis] = r; b[v] = Math.abs(b[v]) * .55; b.va *= -.6; }
        if (b[axis] > size - r) { b[axis] = size - r; b[v] = -Math.abs(b[v]) * .55; b.va *= -.6; }
      }
    }
    for (let i = 0; i < beans.length; i++) for (let j = i + 1; j < beans.length; j++) {
      const p = beans[i], q = beans[j];
      if ([p, q].some(b => b.sink !== null || b.drop !== null)) continue;
      const dx = q.x - p.x, dy = q.y - p.y, d = Math.hypot(dx, dy) || 1, gap = 1.7 * r - d;
      if (gap <= 0) continue;
      const nx = dx / d, ny = dy / d, wp = p === held ? 0 : 1, wq = q === held ? 0 : 1, w = wp + wq;
      p.x -= nx * gap * wp / w; p.y -= ny * gap * wp / w; q.x += nx * gap * wq / w; q.y += ny * gap * wq / w;
      const vn = (q.vx - p.vx) * nx + (q.vy - p.vy) * ny;
      if (vn < 0) {
        const k = -1.5 * vn / w, spin = ((q.vx - p.vx) * -ny + (q.vy - p.vy) * nx) / r * .2;
        p.vx -= k * nx * wp; p.vy -= k * ny * wp; q.vx += k * nx * wq; q.vy += k * ny * wq;
        p.va += spin * wp; q.va += spin * wq;
      }
    }
  }
  function step(dt) {
    for (const b of beans) {
      if (b.sink !== null) {                     // into the coffee, then back onto the table
        b.sink += dt;
        const k = Math.min(1, b.sink / .5);
        b.lift = Math.max(0, .5 - k); b.size = 1 - .3 * k; b.alpha = 1 - Math.max(0, (k - .35) / .65);
        if (b.sink > 1.5) Object.assign(b, homeOf(b), { sink: null, drop: 0, vx: 0, vy: 0, va: 0 });
        continue;
      }
      if (b.drop !== null) {
        b.drop += dt;
        const k = Math.min(1, b.drop / .6), fall = k < .55 ? 1 - (k / .55) ** 2 : .22 * Math.sin((k - .55) / .45 * Math.PI);
        b.lift = fall * 1.3; b.size = 1; b.alpha = Math.min(1, k * 3);
        if (k === 1) b.drop = null;
        continue;
      }
      if (b === held) {
        const k = 1 - Math.exp(-dt * 26), nx = b.x + (pointer.x - grip.x - b.x) * k, ny = b.y + (pointer.y - grip.y - b.y) * k;
        b.vx = (nx - b.x) / dt; b.vy = (ny - b.y) / dt;
        b.x = nx; b.y = ny;
        b.va += ((grip.x * b.vy - grip.y * b.vx) / (unit() * unit()) * .05 + b.vx * .004 - b.va) * (1 - Math.exp(-dt * 10));
      } else {
        b.x += b.vx * dt; b.y += b.vy * dt;
        const slow = Math.exp(-dt * 2.4);
        b.vx *= slow; b.vy *= slow; b.va *= Math.exp(-dt * 2.8);
        if (Math.hypot(b.vx, b.vy) < 3) b.vx = b.vy = 0;
      }
      b.a += b.va * dt;
      const onSaucer = cups.some(c => over(b, c) < c.r * 1.45 + body() * .4);
      const want = b === held ? 1 : onSaucer ? .4 : b === hover ? .16 : 0;
      b.lift += (want - b.lift) * (1 - Math.exp(-dt * 12));
      if (b.lift < .004) b.lift = 0;
    }
    collide(dt);
  }
  function under(x, y) {
    const reach = unit() * 1.25;
    return beans.filter(b => b.sink === null && b.drop === null).find(b => Math.hypot(b.x - x, b.y - y) < reach) || null;
  }
  function look() {
    const root = document.documentElement.classList;
    root.toggle('grab', !!hover && !held);
    root.toggle('grabbing', !!held);
  }
  function release(x, y) {
    const b = held;
    held = null;
    setTimeout(() => { dragged = false; }, 60);      // the click that ends a drag comes right after, if at all
    const now = performance.now(), recent = trail.filter(p => now - p.t < 90);
    if (recent.length > 1) {
      const p = recent[0], q = recent[recent.length - 1], dt = Math.max(.012, (q.t - p.t) / 1000), top = 2600;
      b.vx = Math.max(-top, Math.min(top, (q.x - p.x) / dt)); b.vy = Math.max(-top, Math.min(top, (q.y - p.y) / dt));
    } else b.vx = b.vy = 0;
    cups.forEach((c, i) => {
      if (over(b, c) > c.r * .80) return;
      b.sink = 0; b.vx = b.vy = 0;
      ripples[i] = { x: (b.x - c.x) / (c.r * .87), y: -(b.y - c.y) / (c.r * .87), at: now + 130 };
    });
    look();
  }

  addEventListener('pointerdown', e => {
    dragged = false;
    if (!enabled() || e.button !== 0) return;
    const b = under(e.clientX, e.clientY);
    if (!b) return;
    e.preventDefault(); e.stopPropagation();
    held = b; dragged = true;
    grip = { x: e.clientX - b.x, y: e.clientY - b.y };
    pointer = { x: e.clientX, y: e.clientY };
    trail = [{ ...pointer, t: performance.now() }];
    try { document.documentElement.setPointerCapture(e.pointerId); } catch { /* the pointer is already gone */ }
    look();
  }, true);
  addEventListener('pointermove', e => {
    pointer = { x: e.clientX, y: e.clientY };
    if (held) {
      trail.push({ ...pointer, t: performance.now() });
      if (trail.length > 24) trail.shift();
      return;
    }
    const b = enabled() && cups.length ? under(e.clientX, e.clientY) : null;
    if (b !== hover) { hover = b; look(); }
  }, { passive: true });
  for (const type of ['pointerup', 'pointercancel']) addEventListener(type, e => { if (held) release(e.clientX, e.clientY); }, true);
  addEventListener('click', e => { if (dragged) { e.preventDefault(); e.stopPropagation(); dragged = false; } }, true);   // a drag is not a pick
  addEventListener('dragstart', e => e.preventDefault());

  return {
    beans, ripples,
    get held() { return held; },
    attach(list, isEnabled) { cups = list; enabled = isEnabled; },
    tick(dt) {
      if (!dt || !cups.length || !cups.every(c => c.set)) return;
      place();
      if (!enabled() && (held || hover)) { if (held) release(0, 0); hover = null; look(); }
      const n = Math.max(1, Math.ceil(dt / .012));
      for (let i = 0; i < n; i++) step(dt / n);
    },
    unit,
  };
})();
