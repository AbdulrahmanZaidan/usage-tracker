'use strict';
// The home table: two cups seen from above, drawn in one fragment shader. Picking a cup dives the camera
// into its coffee, then cream swirls in until the screen is exactly the colour of the accounts page.
const Scene = (() => {
  const canvas = document.getElementById('scene');
  const gl = canvas.getContext('webgl', { antialias: false, alpha: false });

  const FRAGMENT = `
precision highp float;
uniform vec2 res, cam, mouse, hov, hand0, hand1;
uniform vec3 cup0, cup1;                 // centre x, y and cup radius, in pixels
uniform float t, scale, ang, zoom, milk, spin, dpr, unit;
uniform vec4 beans[6];                    // centre x, y, angle, size
uniform vec2 lifts[6];                    // height above the table, opacity
uniform vec3 rip0, rip1;                  // where a bean fell in (in the coffee), seconds ago

const vec3 OAT = vec3(.929, .882, .804), DEEP = vec3(.137, .071, .039), ESPRESSO = vec3(.255, .141, .078),
           CREMA = vec3(.620, .392, .204), CREAM = vec3(.957, .890, .776), CHINA = vec3(.976, .949, .898),
           MOCHA = vec3(.541, .353, .204), SHADE = vec3(.58, .42, .27);   // shadows are warm, not grey

float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3. - 2. * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0., a = .5;
  for (int i = 0; i < 4; i++) { v += a * noise(p); p = mat2(1.6, 1.2, -1.2, 1.6) * p; a *= .5; }
  return v;
}
mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
float seg(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0., 1.));
}

// latte art
float burst(vec2 p) {
  float k = 6.2831853 / 8., a = atan(p.y, p.x), id = floor((a + k * .5) / k);
  a = mod(a + k * .5, k) - k * .5;
  p = length(p) * vec2(cos(a), sin(a));
  float reach = .57 - .07 * mod(id, 2.);
  return seg(p, vec2(.06, 0.), vec2(reach, 0.)) - mix(.075, .05, clamp(p.x / reach, 0., 1.));
}
float loop(vec2 p) { p = abs(p); return abs(length(vec2(p.x, max(p.y - .34, 0.))) - .215) - .036; }
float rosette(vec2 p) { return min(loop(p), min(loop(rot(1.0472) * p), loop(rot(2.0944) * p))); }

vec3 coffee(vec2 q, float which, float h, vec2 stir, vec3 rip) {
  float r = length(q);
  vec2 away0 = q - rip.xy;
  float rd = length(away0), front = rip.z * .95;
  float wave = rip.z < 0. || rip.z > 3. ? 0. : sin(rd * 34. - rip.z * 19.) * exp(-rd * 1.6 - rip.z * 1.9) * smoothstep(front + .05, front - .10, rd);
  q += away0 / max(rd, .001) * wave * .045;
  vec2 away = q - stir;
  q = stir + rot(h * 1.1 * exp(-dot(away, away) * 7.) * (1. + .25 * sin(t * 1.7))) * away;   // the pointer stirs
  float vortex = spin * exp(-r * 1.5);
  vec2 s = rot(t * .05 + vortex) * q;
  vec2 w = vec2(fbm(s * 2.1 + vec2(which * 7., t * .06)), fbm(s * 2.1 + vec2(5.2 - t * .05, 1.3 + which * 3.)));
  float n = fbm(s * 2.4 + 2. * w + which * 11.);
  vec3 c = mix(DEEP, ESPRESSO, smoothstep(.15, .6, n));
  c = mix(c, CREMA, smoothstep(.46, .82, n) * .7);
  c = mix(c, CREMA * 1.1, smoothstep(.66, .99, r + (n - .5) * .14) * .85);
  vec2 cell = q * 26., id = floor(cell);                                       // bubbles along the edge
  float bubble = hash(id + which * 9.), size = .12 + .3 * hash(id + 4.);
  float ring = abs(length(fract(cell) - .5) - size);
  c += .12 * step(.80, bubble) * smoothstep(.10, .0, ring) * smoothstep(.80, .93, r);
  vec2 g = rot(t * .07 * (which < .5 ? 1. : -1.) + vortex * .9) * q + (w - .5) * .075;
  float d = which < .5 ? burst(g) : rosette(g);
  c = mix(c, DEEP, smoothstep(.15, 0., d) * .42);
  c = mix(c, CREMA * 1.15, smoothstep(.05, 0., d) * .7);
  c = mix(c, CREAM * (.92 + .14 * n), smoothstep(.02, -.02, d));
  c += .10 * smoothstep(.5, 0., length((q - vec2(-.38, .48)) * vec2(.8, 1.5)));   // window light
  c += wave * .16;
  c *= 1. - .35 * smoothstep(.86, 1., r) * smoothstep(-.6, .9, dot(q, vec2(-.6, .8)));  // shade under the rim
  return c;
}

vec3 tableTop(vec2 w) {
  vec2 c = (w - .5 * res) / res.y, k = w / dpr;
  vec3 col = mix(vec3(.937, .890, .812), vec3(.831, .729, .588), smoothstep(.05, 1.05, length(c - vec2(-.15, .18))));
  float threads = sin(k.x * 1.55 + 2. * noise(k * .05)) * .5 + sin(k.y * 1.55 + 2. * noise(k.yx * .05)) * .5;
  col += threads * .008 + (noise(k * .7) - .5) * .022 + (fbm(k * .012) - .5) * .05;
  return col;
}

vec3 bean(vec3 col, vec2 w, vec4 b, vec2 up) {
  float a = b.z, size = unit * b.w * (1. + .22 * up.x);
  vec2 p = rot(a) * (w - b.xy) / size;
  if (dot(p, p) > 14.) return col;
  vec2 fallen = p - rot(a) * vec2(.22, -.34) * (1. + 2.6 * up.x);      // higher: the shadow falls farther and softer
  col *= 1. - vec3(.28, .36, .42) * up.y * (1. - .35 * up.x) * smoothstep(1.35 + .5 * up.x, .5 - .4 * up.x, length(fallen * vec2(.78, 1.12)));
  float d = length(p * vec2(.72, 1.)) - .62, aa = 1.4 / (size * scale);
  vec3 c = mix(vec3(.231, .125, .067), vec3(.478, .290, .165), smoothstep(-.7, .8, dot(rot(-a) * p, vec2(-.55, .8))));
  c *= .9 + .2 * noise(p * 5. + a);
  c += (.10 + .12 * up.x) * smoothstep(.42, 0., length(rot(-a) * p - vec2(-.24, .26)));      // gloss, stronger in the hand
  float crease = abs(p.y - .12 * sin(p.x * 3.2));
  c = mix(c, vec3(.118, .059, .031), smoothstep(.10, .03, crease) * smoothstep(.85, .6, abs(p.x)));
  return mix(col, c, smoothstep(aa, -aa, d) * up.y);
}

vec3 cup(vec3 col, vec2 w, vec3 at, float which, float h, vec2 hand, vec3 rip) {
  vec2 p = (w - at.xy) / at.z;
  float r = length(p), aa = 1.4 / (at.z * scale);
  if (r > 2.5) return col;
  vec2 light = normalize(vec2(-.6, .8));
  float lit = dot(p, light);
  col *= mix(vec3(1.), SHADE, (.62 + .1 * h) * smoothstep(1.95, .95, length(p - vec2(.13, -.2))));
  // saucer, with a painted band
  vec3 s = CHINA * mix(vec3(.93, .895, .835), vec3(1.005), smoothstep(-1.4, 1.4, lit));
  s -= vec3(.04, .06, .085) * smoothstep(.16, 0., abs(r - 1.14)) * smoothstep(-.8, 1., lit);
  s += .05 * smoothstep(.07, 0., abs(r - 1.41));
  s = mix(s, MOCHA, smoothstep(aa, -aa, abs(r - 1.31) - .016));
  s = mix(s, MOCHA, smoothstep(aa, -aa, abs(r - 1.262) - .006));
  float saucer = smoothstep(aa, -aa, r - 1.45);
  col = mix(col, s, saucer);
  col *= mix(vec3(1.), SHADE, .68 * smoothstep(1.36, .84, length(p - vec2(.09, -.14))) * saucer);
  // handle, cup wall, inner wall
  p /= 1. + .025 * h;
  r = length(p);
  lit = dot(p, light);
  col *= mix(vec3(1.), SHADE, .45 * smoothstep(.12, -.08, seg(p - vec2(.05, -.07), hand * .9, hand * 1.26) - .10));
  float grip = seg(p, hand * .9, hand * 1.26) - .10;
  vec3 hc = CHINA * (.88 + .12 * smoothstep(-.10, .10, dot(p - hand * dot(p, hand), light)));
  col = mix(col, hc, smoothstep(aa, -aa, grip));
  vec3 wall = CHINA * (.93 + .07 * smoothstep(-1., 1., lit));
  wall += .05 * smoothstep(.02, 0., abs(r - .965)) * smoothstep(-.2, 1., lit);
  col = mix(col, wall, smoothstep(aa, -aa, r - 1.));
  vec3 inner = mix(vec3(.925, .867, .776), vec3(.722, .604, .463), smoothstep(-.9, .9, lit));
  col = mix(col, inner, smoothstep(aa, -aa, r - .93));
  float surface = smoothstep(aa, -aa, r - .87);
  if (surface > 0.) {
    vec2 stir = clamp((mouse - at.xy) / (at.z * .87), -1.2, 1.2);
    col = mix(col, coffee(p / .87, which, h, stir, rip), surface);
  }
  // steam
  vec2 v = p * vec2(1.5, .95) - vec2(0., t * .20);
  float st = fbm(v + .9 * vec2(fbm(p * 1.3 - t * .13), 0.) + which * 5.);
  st = smoothstep(.50, .86, st) * smoothstep(1.25, .1, length(p * vec2(1.1, .78) - vec2(0., .3)));
  return mix(col, vec3(1., .985, .96), st * (.20 + .26 * h) * (1. - zoom));
}

void main() {
  vec2 w = cam + rot(ang) * (gl_FragCoord.xy - .5 * res) / scale;
  vec3 col = OAT;
  if (milk < 1.) {
    col = tableTop(w);
    for (int i = 0; i < 6; i++) if (lifts[i].x < .17) col = bean(col, w, beans[i], lifts[i]);
    col = cup(col, w, cup0, 0., hov.x, hand0, rip0);
    col = cup(col, w, cup1, 1., hov.y, hand1, rip1);
    for (int i = 0; i < 6; i++) if (lifts[i].x >= .17) col = bean(col, w, beans[i], lifts[i]);
  }
  if (milk > 0.) {
    vec2 q = (gl_FragCoord.xy - .5 * res) / min(res.x, res.y);
    float r = length(q), a = atan(q.y, q.x), n = fbm(rot(spin * .55 * exp(-r)) * q * 3.2 + 3.);
    float arms = .5 + .5 * sin(3. * a + 5.5 * log(r + .07) + spin * 1.5 + n * 4.5);
    float f = .5 * arms + .5 * n + .34 * exp(-r * 2.4);
    float edge = 1.42 - milk * 1.74, m = smoothstep(edge, edge + .26, f);
    vec3 pour = mix(vec3(.985, .953, .894), OAT, smoothstep(.35, 1., milk));
    col = mix(col, vec3(.780, .565, .353), smoothstep(edge - .2, edge + .08, f) * (1. - milk) * .75);   // milky coffee at its border
    col = mix(col, pour, m);
  }
  gl_FragColor = vec4(mix(col, OAT, smoothstep(.9, 1., milk)), 1.);
}`;

  const names = ['res', 'cam', 'mouse', 'hov', 'hand0', 'hand1', 'cup0', 'cup1', 't', 'scale', 'ang', 'zoom', 'milk', 'spin', 'dpr', 'unit', 'beans', 'lifts', 'rip0', 'rip1'];
  const at = {};
  function build() {
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}'));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.bindAttribLocation(program, 0, 'p');
    gl.vertexAttribPointer(gl.getAttribLocation(program, 'p'), 2, gl.FLOAT, false, 0, 0);
    for (const n of names) at[n] = gl.getUniformLocation(program, n);
  }
  let ok = false;
  try { if (gl) { build(); ok = true; } } catch (e) { console.warn('scene:', e.message); }

  const cups = [...document.querySelectorAll('.cup')].map(el => ({ el, x: 0, y: 0, r: 0, hover: 0, set: false }));
  const spots = new Float32Array(24), heights = new Float32Array(12);
  const pose = { zoom: 0, milk: 0, spin: 0, pick: 0 };
  const pointer = { x: -1e4, y: -1e4 };
  let running = 0, quality = 1, slow = 0, last = 0, tween = null, freeze = null;

  Beans.attach(cups, () => ok && !!running && !tween && document.body.dataset.view === 'home' && !document.querySelector('dialog[open]'));
  addEventListener('pointermove', e => { pointer.x = e.clientX; pointer.y = e.clientY; }, { passive: true });

  const clamp = x => Math.min(1, Math.max(0, x));
  const phase = (t, from, to) => clamp((t - from) / (to - from));
  const inOut = x => x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
  const smooth = x => x * x * (3 - 2 * x);

  function measure(dt) {
    const ease = 1 - Math.exp(-dt * 9);
    for (const c of cups) {
      const b = c.el.getBoundingClientRect(), x = b.left + b.width / 2, y = b.top + b.height / 2, r = b.width / 2 / 1.5;
      if (b.width) {
        if (!c.set) { Object.assign(c, { x, y, r, set: true }); }
        else { c.x += (x - c.x) * ease; c.y += (y - c.y) * ease; c.r += (r - c.r) * ease; }   // cups glide when the layout flips
      }
      const want = c.el.parentElement.matches(':hover, :focus-visible') && !tween && !Beans.held ? 1 : 0;
      c.hover += (want - c.hover) * (1 - Math.exp(-dt * 6));
    }
  }
  function draw(now) {
    const dpr = Math.min(devicePixelRatio || 1, 1.5) * quality;
    const w = Math.max(1, Math.round(innerWidth * dpr)), h = Math.max(1, Math.round(innerHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; gl.viewport(0, 0, w, h); }
    const px = c => [c.x * dpr, h - c.y * dpr, c.r * dpr];
    const a = px(cups[0]), b = px(cups[1]), target = pose.pick ? b : a;
    const full = 1.15 * Math.hypot(w, h) / 2 / (target[2] * .87);
    const scale = Math.exp(Math.log(full) * pose.zoom), keep = (1 - smooth(pose.zoom)) / scale;
    const cam = [target[0] + (w / 2 - target[0]) * keep, target[1] + (h / 2 - target[1]) * keep];
    const hand = c => { const x = Math.max(-1, Math.min(1, (c[0] - w / 2) / (w * .12))), tilt = Math.max(Math.abs(x) * .94, .2) * (x < 0 ? -1 : 1); return [tilt, Math.sqrt(1 - tilt * tilt)]; };
    gl.uniform2f(at.res, w, h);
    gl.uniform2fv(at.cam, cam);
    gl.uniform2f(at.mouse, pointer.x * dpr, h - pointer.y * dpr);
    gl.uniform2f(at.hov, cups[0].hover, cups[1].hover);
    gl.uniform2fv(at.hand0, hand(a));
    gl.uniform2fv(at.hand1, hand(b));
    gl.uniform3fv(at.cup0, a);
    gl.uniform3fv(at.cup1, b);
    gl.uniform1f(at.t, (now / 1000) % 3600);
    gl.uniform1f(at.scale, scale);
    gl.uniform1f(at.ang, -pose.zoom * .7);
    gl.uniform1f(at.zoom, pose.zoom);
    gl.uniform1f(at.milk, pose.milk);
    gl.uniform1f(at.spin, pose.spin);
    gl.uniform1f(at.dpr, dpr);
    gl.uniform1f(at.unit, Beans.unit() * dpr);
    Beans.beans.forEach((b, i) => { spots.set([b.x * dpr, h - b.y * dpr, -b.a, b.size], i * 4); heights.set([b.sink !== null ? Math.max(.17, b.lift) : b.lift, b.alpha], i * 2); });
    gl.uniform4fv(at.beans, spots);
    gl.uniform2fv(at.lifts, heights);
    Beans.ripples.forEach((r, i) => gl.uniform3f(i ? at.rip1 : at.rip0, r.x, r.y, r.at < 0 ? -1 : Math.min(9, (now - r.at) / 1000)));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  function frame(now) {
    const ms = now - last, dt = Math.max(0, Math.min(.1, ms / 1000));
    if (!tween && !Beans.held && ms < 15) { running = requestAnimationFrame(frame); return; }    // at rest 60 a second is plenty
    last = now;
    if (ms > 30 && ms < 250) { if (++slow > 24 && quality > .5) { quality *= .8; slow = 0; } }   // lighter on weak GPUs
    else slow = Math.max(0, slow - 1);
    if (tween) {
      const t = now - tween.start;
      tween.step(Math.min(t, tween.length));
      if (t >= tween.length) { const done = tween.done; tween = null; done(); }
    }
    measure(dt);
    Beans.tick(dt);
    if (freeze) Object.assign(pose, freeze);
    draw(now);
    if (running) running = requestAnimationFrame(frame);
  }
  function start() {
    if (!ok || running) return;
    canvas.classList.remove('off');
    last = performance.now();
    running = requestAnimationFrame(frame);
  }
  function stop() {
    cancelAnimationFrame(running);
    running = 0;
    canvas.classList.add('off');
  }
  const play = (length, step) => new Promise(done => { tween = { start: performance.now(), length, step, done }; });

  return {
    ok, start, stop,
    get busy() { return !!tween; },
    /** Camera into cup `i`; `reveal` runs while the cream is settling. */
    async dive(i, reveal) {
      let shown = false;
      pose.pick = i;
      start();
      await play(1650, t => {
        pose.zoom = inOut(phase(t, 0, 1080));
        pose.spin = 7.5 * smooth(phase(t, 60, 1650));
        pose.milk = smooth(phase(t, 720, 1600));
        if (!shown && t >= 1120) { shown = true; reveal(); }
      });
    },
    /** Back out to the table. */
    async rise(i) {
      pose.pick = i;
      pose.zoom = pose.milk = 1;
      pose.spin = 7.5;
      start();
      await play(1300, t => {
        pose.milk = 1 - smooth(phase(t, 0, 680));
        pose.spin = 7.5 * (1 - smooth(phase(t, 0, 1300)));
        pose.zoom = 1 - inOut(phase(t, 240, 1300));
      });
    },
    home() { Object.assign(pose, { zoom: 0, milk: 0, spin: 0 }); start(); },
    /** For looking at one moment: Scene.hold({ zoom: .5, milk: 0, spin: 3, pick: 0 }), Scene.hold(null). */
    hold(p) { freeze = p; },
  };
})();

document.addEventListener('visibilitychange', () => {
  if (document.body.dataset.view !== 'home') return;
  document.hidden ? Scene.stop() : Scene.start();
});
