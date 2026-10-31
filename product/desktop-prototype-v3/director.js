/* 灯光导演(Lighting Director)——v3 的核心。纯逻辑,不依赖 Three.js/DOM,所以 Node 里也能跑自检(tools/check_lightlang.js F 段)。
   它的职责:把"玩家在 Launchpad 上做的事"和"音乐里发生的事"翻译成一份舞台状态 rig(14 盏灯、LED 屏墙、烟雾、镜头、闪光、粒子请求),
   舞台渲染器(stage.js)只读 rig,不自己做决定。用户不编灯,AI(这里是规则 + 能量曲线)就是灯光师。

   指挥映射(设计文档第 3 节有完整表):
     盘面第 c 列 ↔ 中排桁架上第 c 盏摇头灯;行 r ↔ 光束抬升(第 1 行压向观众席,第 8 行冲天);音名 ↔ 光色;
     手从左扫到右 ↔ 一道光浪从左扫到右(扫完仍继续滑出去);竖着往上扫 ↔ 全部光束抬起;
     无力度 → 用"按键密度/连击"驱动强度;鼓点 → 地面冲击波 + 屏墙环 + 镜头一顿(爆发档才频闪);和弦 → 全场色调转移 + 后排灯换阵型;
     能量 → 风格档位、镜头推进、烟雾浓度、点亮的灯数;安静模式(引导期间) → 只留低亮度氛围光。
   灯光语言:所有颜色只来自 音名色盘(红橙黄紫粉)/和弦色(红橙紫粉)/暖白/金色 及它们的 RGB 渐变;青绿色相(HSV 0.40~0.55)一律不出现。
   颜色一律用"显示空间"0~1 的 RGB(与盘面 DOM 同一条 (v/63)^0.55 换算),stage.js 负责转线性。 */
(function (root) {
  "use strict";
  const NL = 14, NC = 8;
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const lerp = (a, b, f) => a + (b - a) * f;
  const mix3 = (a, b, f) => [lerp(a[0], b[0], f), lerp(a[1], b[1], f), lerp(a[2], b[2], f)];
  const disp63 = (v) => Math.min(1, Math.pow(v / 63, 0.55));
  const ease = (rate, dt) => 1 - Math.exp(-rate * dt);

  // 与 playground.py::is_guide_hue 同判据(色相 0.40~0.55 且色度 ≥ 阈值),入参 0~1
  function hueChroma(r, g, b) {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    if (d === 0) return { h: 0, c: 0 };
    const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return { h: ((h / 6) % 1 + 1) % 1, c: d / mx };   // c 取 HSV 饱和度:暗色也要查
  }
  const isGuideHue = (c, minS) => { if (Math.max(c[0], c[1], c[2]) < 0.03) return false; const x = hueChroma(c[0], c[1], c[2]); return x.c >= (minS == null ? 0.25 : minS) && x.h >= 0.40 && x.h <= 0.55; };

  /* 三档舞台风格:AI 按能量自动换档;每档是一整套"灯怎么亮"的编排,不是装饰动画 */
  const STYLES = [
    { name: "呼吸", grp: { col: 0.05, chord: 0.28, up: 0 },    tan: 0.085, haze: 0.85, wall: [0.9, 0.1, 0, 0.8],  sway: 0.35, spread: 0.25, push: 0,   bloom: 0.55, chase: 0, strobe: 0 },
    { name: "律动", grp: { col: 0.2,  chord: 0.34, up: 0.18 }, tan: 0.06, haze: 1.0,  wall: [0.22, 0.95, 0.1, 0.8], sway: 0.8,  spread: 0.6,  push: 0.3, bloom: 0.7,  chase: 1, strobe: 0 },
    { name: "爆发", grp: { col: 0.34, chord: 0.45, up: 0.5 },  tan: 0.048, haze: 1.2,  wall: [0.1, 0.75, 0.8, 0.9],   sway: 1.2,  spread: 1.0,  push: 1,   bloom: 0.9,  chase: 1, strobe: 1 },
  ];
  // 灯位(米):中排桁架 8 盏(= 盘面 8 列)、后排桁架 4 盏(和弦)、台口地面 2 盏(扫场)
  const POS = [];
  for (let i = 0; i < 8; i++) POS.push([-8.4 + 2.4 * i, 8.6, -8]);
  [-7, -2.5, 2.5, 7].forEach((x) => POS.push([x, 9.8, -14.5]));
  POS.push([-8.8, 0.25, -6], [8.8, 0.25, -6]);

  function create(opts) {
    const Core = opts.Core, rnd = opts.random || Math.random;
    const col63 = (a) => a.map(disp63), hsvD = (h, s, v) => col63(Core.hsv(h, s, v));
    const noteCol = (pad) => col63(Core.noteRgb(Math.floor(pad / 10), pad % 10));
    // 暖色带:紫 → 粉 → 红 → 橙 → 黄(只在相邻色之间做 RGB 渐变,绝不经过绿/青/蓝)
    const RAMP = [hsvD(0.78, 0.9, 1), hsvD(0.92, 0.9, 1), hsvD(0, 0.9, 1), hsvD(0.08, 0.9, 1), hsvD(0.14, 0.9, 1)];
    const ramp = (x) => { const f = clamp(x, 0, 1) * 4, i = Math.min(3, Math.floor(f)); return mix3(RAMP[i], RAMP[i + 1], f - i); };
    const CHORD_HUES = [0.0, 0.11, 0.78, 0.92];   // I IV V vi:红 橙 紫 粉(与 pad.js / playground.py 一致)
    const CHORD = CHORD_HUES.map((h) => hsvD(h, 0.9, 0.95));
    const WARM = [1.0, 0.6, 0.38], WHITE = [1, 0.93, 0.84], GOLD = col63(Core.GOLD), DRUM = col63(Core.IDENT.drums);

    const S = {   // 内部状态
      t: 0, level: 0, energy: 0, energyHist: [], styleIdx: 0, styleAt: -99, fxK: 0, quiet: true, ceremony: 0, ceremonyT0: -99,
      e: new Array(NC).fill(0), eps: new Array(NL).fill(0.6), epsHold: new Array(NC).fill(-99), epsHit: new Array(NC).fill(0.5),
      sx: new Array(NL).fill(0), lampCol: Array.from({ length: NL }, () => WARM.slice()), tint: WARM.slice(), tintTarget: WARM.slice(),
      noteCol: new Array(NC).fill(null), hits: [], presses: [], hist: [], combo: 0, lastPad: -1, lastHitT: -99,
      sweep: null, lift: 0, liftT: -99, kick: 0, hat: 0, flash: 0, lastFlashT: -99, flashLog: [], dropT: -99, blackout: 0, dropK: 0,
      inClimax: false, lowSeen: false, lastLowT: -99, climaxEnd: -99, shocks: [], bar: -1, pattern: 0, push: 0, camBias: 0,
      drumE: 0, bassE: 0, chordE: 0, pulse: { drum: 0, hat: 0, bass: 0, chord: 0 }, bassIdx: 0, lastKickT: 0, spawn: [], section: "idle", perfDrop: 0,
      active: 0, chaseClock: 0, missDip: 0, hwK: 1, spots: {},
    };
    const rig = {
      lamps: POS.map((p) => ({ pos: p.slice(), dir: [0, -1, 0], tan: 0.12, col: [0, 0, 0], inten: 0, gobo: 0 })),
      wall: { mode: [0.9, 0.1, 0, 0.8], tint: WARM.slice(), tint2: WARM.slice(), hits: [], bands: new Float32Array(16), kick: 0, dim: 0.1, gold: 0, level: 0 },
      haze: { density: 0.5, col: [0.2, 0.12, 0.08] },
      fx: { flash: 0, blackout: 0, shocks: [], bloom: 0.5, kick: 0, crowd: 0, hands: 0, beat: 0 },
      cam: { pos: [0, 2.3, 12], target: [0, 4.7, -9], fov: 38, shake: [0, 0] },
      perf: { drum: { e: 0, k: 0, h: 0 }, bass: { e: 0, v: 0, idx: 0 }, keys: { e: 0, pulse: 0 } },
      styleName: "呼吸", styleIdx: 0, section: "idle", energy: 0, quiet: true, gesture: "", spawn: [], tint: WARM.slice(), chordIdx: 0, ceremony: 0,
    };

    /* ---------- 输入:玩家按键 ---------- */
    function hit(pad, midi, t, opts) {
      const r = Math.floor(pad / 10), c = pad % 10; if (r < 1 || r > 8 || c < 1 || c > 8) return;
      if (S.quiet && S.ceremony < 0.3) return;   // 安静模式:舞台不回应按键(盘面自己会绽放被按的键)
      opts = opts || {};
      const ci = c - 1, col = opts.col || noteCol(pad);   // 跟打模式:光色用声部色(display 空间 0~1),命中质量决定 gain
      S.combo = (pad === S.lastPad && t - S.lastHitT < 0.7) ? S.combo + 1 : Math.max(0, S.combo - 1);
      S.lastPad = pad; S.lastHitT = t;
      const gain = opts.gain != null ? opts.gain : 0.7 + 0.3 * Math.min(1, S.combo / 4);   // 设备没有力度:用连击代替力度(跟打:用命中质量)
      S.e[ci] = Math.max(S.e[ci], gain);
      if (ci > 0) S.e[ci - 1] = Math.max(S.e[ci - 1], 0.28);
      if (ci < 7) S.e[ci + 1] = Math.max(S.e[ci + 1], 0.28);
      S.noteCol[ci] = col; S.epsHit[ci] = (r - 1) / 7; S.epsHold[ci] = t + 2.6;
      S.tintTarget = mix3(S.tintTarget, col, 0.18);
      S.hits.push({ x: (c - 0.5) / 8, y: (r - 0.5) / 8, t, col, ci }); if (S.hits.length > 8) S.hits.shift();
      S.presses.push(t);
      S.hist.push({ c, r, t }); if (S.hist.length > 5) S.hist.shift();
      // 手势:最近 3 次按键列单调且 0.9 秒内 = 横扫;行单调 = 竖扫
      const h = S.hist, n = h.length; rig.gesture = "";
      if (n >= 3 && t - h[n - 3].t < 0.9) {
        const d1 = h[n - 2].c - h[n - 3].c, d2 = h[n - 1].c - h[n - 2].c;
        if (d1 * d2 > 0 && Math.abs(d1) <= 3 && Math.abs(d2) <= 3) {
          const dir = Math.sign(d2);
          if (!S.sweep || S.sweep.dir !== dir) S.sweep = { dir, head: c - 1, speed: 13, life: 1.2 };
          else { S.sweep.head = dir > 0 ? Math.max(S.sweep.head, c - 1) : Math.min(S.sweep.head, c - 1); S.sweep.life = 1.2; }
          rig.gesture = dir > 0 ? "sweep-right" : "sweep-left";
        }
        const r1 = h[n - 2].r - h[n - 3].r, r2 = h[n - 1].r - h[n - 2].r;
        if (r1 * r2 > 0 && Math.abs(r1) <= 3 && Math.abs(r2) <= 3) { S.lift = Math.sign(r2); S.liftT = t; rig.gesture = (rig.gesture ? rig.gesture + "+" : "") + (S.lift > 0 ? "lift-up" : "lift-down"); }
      }
      // 火花:从这一列的灯口顺着光束喷出
      const L = rig.lamps[ci];
      for (let k = 0; k < 2; k++) {
        const sp = 9 + rnd() * 7, jx = (rnd() - 0.5) * 0.3, jy = (rnd() - 0.5) * 0.3, jz = (rnd() - 0.5) * 0.3;
        S.spawn.push({ kind: "spark", pos: [L.pos[0], L.pos[1] - 0.3, L.pos[2]], vel: [(L.dir[0] + jx) * sp, (L.dir[1] + jy) * sp, (L.dir[2] + jz) * sp], col: col.slice(), n: 3 });
      }
    }
    /* ---------- 输入:音频时钟里排好的乐队事件 ---------- */
    function audioEvent(ev) {
      if (S.quiet && S.ceremony < 0.3) return;
      if (ev.kind === "kick") {
        S.kick = 1; S.pulse.drum = 1; S.lastKickT = S.t;
        S.shocks.push({ t0: S.t, amp: 0.5 + 0.5 * S.styleIdx / 2, col: DRUM.slice() }); if (S.shocks.length > 4) S.shocks.shift();
        const st = STYLES[S.styleIdx];
        if (st.strobe && S.energy > 0.66 && S.t - S.lastFlashT > 0.34 && !S.reduced) { S.flash = 1; S.lastFlashT = S.t; S.flashLog.push(S.t); if (S.flashLog.length > 40) S.flashLog.shift(); }
      } else if (ev.kind === "hat") S.pulse.hat = 1;
      else if (ev.kind === "bass") { S.pulse.bass = 1; S.bassIdx = clamp(Math.floor((ev.midi - (S.tonic - 12)) / 22 * 8), 0, 7); }
      else if (ev.kind === "pad") {
        S.pulse.chord = 1;
        if (S.styleIdx >= 2 && !S.reduced) confetti(S.styleIdx === 2 ? 46 : 0, null);
      }
    }
    // 跟打:漏拍 → 灯光收敛(missDip 1→0 约 1.6 秒回升)
    function miss() { S.missDip = 1; }
    // 跟打「追光」:视图每帧告诉导演"第 li 盏灯正在追光到哪一行/什么颜色/多亮"(0.12 秒内有效),真正的摇头灯随之亮起并抬/压光束
    function spot(li, I, col, eps) { S.spots[li] = { I, col, eps, t: S.t }; }
    function confetti(n, gold) {
      if (!n) return;
      S.spawn.push({ kind: "confetti", n, gold: !!gold, cols: gold ? [GOLD] : RAMP.map((c) => c.slice()) });
    }
    function celebrate(t) {
      S.ceremony = 1; S.ceremonyT0 = t;
      S.spawn.push({ kind: "confetti", n: 70, gold: true, cols: [GOLD] });
      S.shocks.push({ t0: t, amp: 0.9, col: GOLD.slice() }); if (S.shocks.length > 4) S.shocks.shift();
    }

    /* ---------- 每帧推进 ---------- */
    function update(dt, t, inp) {
      dt = clamp(dt, 0.0005, 0.1); S.t = t; S.tonic = inp.tonic == null ? 60 : inp.tonic; S.reduced = !!inp.reduced;
      S.quiet = !!inp.quiet; S.level = inp.level || 0;
      const hw = inp.hw || null;   // 跟打模式:能量由命中驱动,漏拍收敛
      const A = S.active = (hw || inp.bandOn || inp.drumsOn || S.level > 0.03 || t - S.lastHitT < 6) ? 1 : 0;
      S.missDip = Math.max(0, S.missDip - dt / 1.6);
      S.hwK = hw ? clamp(0.1 + 0.9 * hw.energy, 0, 1) * (1 - 0.65 * S.missDip) : 1;
      S.fxK += ((S.quiet ? 0 : 1) - S.fxK) * ease(4, dt);
      S.ceremony = Math.max(0, 1 - (t - S.ceremonyT0) / 3.2); const cer = S.ceremony;
      const fx = Math.max(S.fxK, cer * 0.9);
      // 能量 = 近 3 秒按键密度 + 音频电平 + 乐队/鼓点
      S.presses = S.presses.filter((x) => t - x < 3);
      const instE = hw ? hw.energy * (1 - 0.5 * S.missDip) : Math.min(1, S.presses.length / 9) * 0.65 + S.level * 0.5 + (inp.drumsOn ? 0.12 : 0) + (inp.bandOn ? 0.1 : 0);
      S.energy += (instE - S.energy) * ease(instE > S.energy ? 1.2 : 0.35, dt);
      const E = S.energy;
      if (!S.energyHist.length || t - S.energyHist[S.energyHist.length - 1].t > 0.25) { S.energyHist.push({ t, e: E }); if (S.energyHist.length > 24) S.energyHist.shift(); }
      // 档位:AI 自动(至少停 3 秒),或用户固定
      const m = inp.styleMode || "auto";
      const want = m === "breath" ? 0 : m === "groove" ? 1 : m === "burst" ? 2 : (E < 0.3 ? 0 : E < 0.62 ? 1 : 2);
      if (want !== S.styleIdx && (m !== "auto" || t - S.styleAt > 3)) { S.styleIdx = want; S.styleAt = t; }
      const st = STYLES[S.styleIdx];
      // 起承转合:低谷 → 爬升 → 触顶瞬间"落点"(先黑 0.14 秒再炸开)→ 回落留白
      if (E < 0.38) { S.inClimax = false; S.lowSeen = true; S.lastLowT = t; }
      if (E > 0.62 && !S.inClimax && S.lowSeen && t - S.lastLowT < 14 && !S.quiet && !inp.manual) {   // inp.manual:大师演出(show.js)自己编排 drop,关掉自动落点
        S.inClimax = true; S.lowSeen = false; S.dropT = t; S.blackout = 1;
      }
      if (S.blackout > 0 && t - S.dropT > 0.14) {
        S.blackout = 0;
        if (!S.reduced) { S.flash = 1; S.lastFlashT = t; S.flashLog.push(t); }
        S.shocks.push({ t0: t, amp: 1, col: WHITE.slice() }); if (S.shocks.length > 4) S.shocks.shift();
        S.dropK = 1; if (!S.reduced) confetti(60, false);
      }
      if (S.inClimax && E < 0.5) { S.inClimax = false; S.climaxEnd = t; }
      const rising = S.energyHist.length > 4 && E - S.energyHist[Math.max(0, S.energyHist.length - 7)].e > 0.1;
      S.section = !A ? "idle" : (S.inClimax || E > 0.72) ? "climax" : t - S.climaxEnd < 4 ? "break" : (rising && E > 0.35) ? "build" : "verse";
      // 衰减
      S.kick = Math.max(0, S.kick - dt * 6); S.hat = Math.max(0, S.hat - dt * 10);
      for (const k in S.pulse) S.pulse[k] = Math.max(0, S.pulse[k] - dt * (k === "chord" ? 2 : k === "hat" ? 9 : 5));
      S.flash = Math.max(0, S.flash - dt * 11); S.dropK = Math.max(0, S.dropK - dt * 0.8);
      for (let i = 0; i < NC; i++) S.e[i] *= Math.exp(-dt / 0.75);
      S.hits = S.hits.filter((h) => t - h.t < 2.4);
      S.shocks = S.shocks.filter((s) => t - s.t0 < 1.6);
      // 和弦与色调
      const ci = inp.chordIdx || 0, bar = inp.bar == null ? 0 : inp.bar;
      if (inp.bandOn && bar !== S.bar) { S.bar = bar; S.pattern = (S.pattern + 1) % 3; }
      const chordCol = CHORD[ci];
      const tintGoal = inp.bandOn ? chordCol : (t - S.lastHitT < 8 ? S.tintTarget : WARM);
      S.tint = mix3(S.tint, tintGoal, ease(inp.bandOn ? 1.2 : 0.5, dt));
      S.tintTarget = mix3(S.tintTarget, WARM, ease(0.05, dt));
      // 节拍相位(自由玩时按 bpm 自走,有鼓时被底鼓校准)
      const bpm = inp.bpm || 100; S.chaseClock = (t - S.lastKickT) * bpm / 60;
      const phase = inp.drumsOn ? S.chaseClock : t * bpm / 60;
      // 横扫:光浪头继续往前滑
      let sweepBoost = null;
      if (S.sweep) {
        S.sweep.head += S.sweep.dir * S.sweep.speed * dt; S.sweep.life -= dt;
        if (S.sweep.life <= 0 || S.sweep.head < -2 || S.sweep.head > 9) S.sweep = null;
        else { sweepBoost = new Array(NC).fill(0); for (let i = 0; i < NC; i++) { const d = Math.abs(i - S.sweep.head); if (d < 1.4) sweepBoost[i] = 0.95 * (1 - d / 1.4); } }
      }
      // 竖扫:所有光束一起抬起/压下,1.5 秒复位
      const liftK = Math.exp(-(t - S.liftT) / 1.2) * S.lift;
      // 每盏灯
      const sway = S.quiet ? 0 : (S.reduced ? 0.3 : 1) * st.sway;
      let sum = 0;
      for (let i = 0; i < NL; i++) {
        const L = rig.lamps[i];
        let I = 0, epsT, sxT, col, tan = st.tan * (1 + 0.3 * S.kick), gobo = 0;
        if (i < NC) {
          const held = t < S.epsHold[i];
          const wave = 0.5 + 0.5 * Math.cos(2 * Math.PI * (phase * 0.5 - i / 8));
          const base = st.grp.col * A * (st.chase ? (0.35 + 1.3 * wave * wave) : 1) * S.hwK;
          I = base + S.e[i] + (sweepBoost ? sweepBoost[i] : 0) + (st.chase && inp.drumsOn ? S.kick * 0.3 : 0);
          // 光束抬升:盘面第 r 行 → 灯的仰角参数 ε(0=压向观众,1=冲天);没有按键时由风格给默认
          const dflt = S.styleIdx === 0 ? 0.62 + 0.05 * Math.sin(t * 0.4 + i * 0.6) * sway
            : S.styleIdx === 1 ? 0.42 + 0.3 * Math.sin(phase * Math.PI * 0.5 + i * 0.7) * Math.min(1, sway)
            : 0.36 + 0.4 * Math.sin(phase * Math.PI + i * 0.9) * Math.min(1, sway);
          epsT = (held ? S.epsHit[i] : dflt) + liftK * 0.3;
          const pat = S.styleIdx === 0 ? 0 : S.pattern, u = (i - 3.5) / 3.5;
          sxT = pat === 0 ? u * 0.7 * st.spread : pat === 1 ? -u * 1.25 * st.spread : 1.1 * Math.sin(t * 0.8 + i * 0.7) * st.spread * Math.min(1, sway + 0.2);
          col = S.noteCol[i] && held ? S.noteCol[i] : mix3(ramp(((i / 7) * 0.7 + t * 0.03 * (S.styleIdx > 0 ? 1 : 0) + ci * 0.12) % 1), S.tint, S.styleIdx === 0 ? 0.85 : 0.5);
          if (cer > 0) { col = hsvD(Core.rainbowHue(i / 8 * 0.5 + (t - S.ceremonyT0) * 0.5), 0.9, 1); I = Math.max(I, 0.85 * cer); }
          gobo = held ? Math.min(3, Math.floor((S.epsHit[i]) * 4)) : (S.styleIdx === 1 ? 1 : S.styleIdx === 2 ? i % 4 : 0);
        } else if (i < 12) {
          const j = i - 8, wave = 0.5 + 0.5 * Math.sin(t * 0.6 + j * 1.3);
          I = (st.grp.chord * A * (S.styleIdx === 0 ? 0.7 + 0.3 * wave : 1) + S.pulse.chord * 0.35 + (st.chase && inp.drumsOn ? S.kick * 0.25 : 0)) * S.hwK;
          epsT = 0.12 + 0.06 * Math.sin(t * 0.3 + j) * sway;   // 压向观众席:光柱从后排桁架穿过头顶打向观众,有纵深
          const pat = S.pattern, u = (j - 1.5) / 1.5;
          sxT = pat === 0 ? u * 0.8 : pat === 1 ? -u * 0.7 : 0.7 * Math.sin(t * 0.5 + j) * Math.min(1, sway + 0.2);
          col = mix3(chordCol, WHITE, S.styleIdx === 2 ? 0.35 : 0.1); tan = (0.035 + 0.012 * S.styleIdx) * (1 + 0.2 * S.kick);
          if (cer > 0) { col = hsvD(Core.rainbowHue(j / 4 * 0.5 + (t - S.ceremonyT0) * 0.5 + 0.2), 0.9, 1); I = Math.max(I, 0.6 * cer); }
        } else {
          const j = i - 12, sg = j ? 1 : -1;
          I = (st.grp.up * A * (0.6 + 0.4 * Math.sin(t * 0.9 + j * 2)) + S.kick * (S.styleIdx >= 1 ? 0.3 : 0)) * S.hwK;
          epsT = 1.0; sxT = -sg * (0.3 + 0.25 * Math.sin(t * 0.7 + j * 3) * Math.min(1, sway + 0.2));
          col = mix3(ramp(0.4 + 0.5 * Math.sin(t * 0.05 + j)), S.tint, 0.4); tan = 0.045;
        }
        const spt = S.spots[i]; if (spt && S.t - spt.t < 0.12) { I = Math.max(I, spt.I); col = spt.col; if (i < NC) { epsT = spt.eps; } }
        L.gobo = gobo;
        S.eps[i] += (epsT - S.eps[i]) * ease(i < NC && t < S.epsHold[i] ? 14 : 4, dt);
        S.sx[i] += (sxT - S.sx[i]) * ease(5, dt);
        for (let k = 0; k < 3; k++) L.col[k] += (col[k] - L.col[k]) * ease(14, dt);
        L.tan += (tan - L.tan) * ease(10, dt);
        // 方向:ε=0 压向观众席(迎面),0.4 斜扎台面(从侧面看光柱最清楚),1 冲天;在三个关键方向间插值,再叠加左右偏摆 sx
        if (i < 12) {
          const e = clamp(S.eps[i], 0, 1), K = e < 0.4 ? [[0, -0.5, 0.85], [0, -0.93, -0.3], e / 0.4] : [[0, -0.93, -0.3], [0, 0.95, -0.12], (e - 0.4) / 0.6];
          const a = K[0], b = K[1], f = K[2], sc = i < NC ? 1.0 : 0.7;
          const x = S.sx[i] * sc, y = lerp(a[1], b[1], f), z = lerp(a[2], b[2], f), n = Math.hypot(x, y, z);
          L.dir[0] = x / n; L.dir[1] = y / n; L.dir[2] = z / n;
        } else {
          const x = S.sx[i], y = 1.1, z = -0.2, n = Math.hypot(x, y, z); L.dir[0] = x / n; L.dir[1] = y / n; L.dir[2] = z / n;
        }
        L.inten = clamp(I, 0, 1.3) * fx * (1 - S.blackout) * (1 - 0.45 * S.missDip);   // 跟打:漏拍时整体收敛
        sum += L.inten;
      }
      const lim = Math.min(1, 5.5 / Math.max(sum, 0.001));   // 总亮度上限:灯越多,每盏越收,避免满屏过曝
      for (let i = 0; i < NL; i++) rig.lamps[i].inten *= lim;
      // 屏墙
      const W = rig.wall, wallFx = Math.max(S.fxK, cer * 0.9);
      for (let k = 0; k < 4; k++) W.mode[k] += (st.wall[k] - W.mode[k]) * ease(1.5, dt);
      W.tint = S.tint.slice(); W.tint2 = mix3(S.tint, RAMP[(ci + 2) % 5], 0.5);
      W.hits = S.hits.map((h) => ({ x: h.x, y: h.y, age: t - h.t, col: h.col })); W.kick = S.kick;
      const bands = inp.bands;
      for (let b = 0; b < 16; b++) {   // 屏墙均衡器:真实频谱 + 手在盘面上弹的列(没声音时也有反应)
        const col = Math.floor(b / 2), padV = col < 8 ? S.e[col] * 0.9 : 0;
        const v = Math.max(bands ? bands[b] : 0, padV);
        W.bands[b] += (v - W.bands[b]) * ease(v > W.bands[b] ? 25 : 6, dt);
      }
      W.dim = (S.quiet ? 0.05 : 0.14 + 0.86 * (A ? 1 : 0.1)) * (1 - 0.0 * S.blackout) * (1 - S.blackout) ; W.dim = Math.max(W.dim, cer * 0.9);
      W.gold = cer; W.level = S.level;
      // 烟雾与后期
      const hz = rig.haze; hz.density += ((0.45 + 0.4 * A + 0.35 * st.haze * E + 0.5 * S.dropK + (S.quiet ? -0.15 : 0)) - hz.density) * ease(1.5, dt);
      hz.col = S.tint.map((v) => v * (S.quiet ? 0.07 : 0.14));
      const F = rig.fx; F.flash = S.reduced ? Math.min(S.flash, 0.25) : S.flash; F.blackout = S.blackout; F.kick = S.kick;
      F.shocks = S.shocks.map((s) => ({ age: t - s.t0, amp: s.amp, col: s.col }));
      F.bloom += ((st.bloom * (S.quiet ? 0.7 : 1) + 0.4 * E + 0.3 * S.dropK) - F.bloom) * ease(2, dt);
      F.crowd += (E - F.crowd) * ease(0.8, dt); F.hands = clamp((F.crowd - 0.3) / 0.5, 0, 1) * (S.quiet ? 0 : 1);
      F.beat = S.kick;
      // 乐队成员
      const P = rig.perf;
      S.drumE += ((inp.drumsOn ? 1 : 0) - S.drumE) * ease(5, dt); S.bassE += ((inp.bandOn ? 1 : 0) - S.bassE) * ease(5, dt);
      P.drum.e = S.drumE; P.drum.k = S.pulse.drum; P.drum.h = S.pulse.hat;
      P.bass.e = S.bassE; P.bass.v = S.pulse.bass; P.bass.idx = S.bassIdx;
      P.keys.e = S.bassE; P.keys.pulse = S.pulse.chord;
      // 镜头:推拉摇移(安静模式与"减少动效"下静止)
      const C = rig.cam, still = S.quiet || S.reduced, perf = inp.perf;
      const pushT = still ? 0 : st.push * clamp((E - 0.45) / 0.4, 0, 1) * S.fxK;
      S.push += (pushT - S.push) * ease(0.6, dt);
      const lastCol = S.hist.length ? S.hist[S.hist.length - 1].c : 4.5;
      S.camBias += ((still ? 0 : (lastCol - 4.5) / 3.5 * Math.exp(-(t - S.lastHitT) / 3)) - S.camBias) * ease(1.2, dt);
      const mv = still ? 0 : 1, kk = S.reduced ? 0 : S.kick;
      const baseZ = perf ? 14.6 : 13.4, baseY = perf ? 2.2 : 2.7;
      C.pos[0] = mv * (1.3 * Math.sin(t * 0.07) + 0.9 * S.camBias) + (S.reduced ? 0 : (rnd() - 0.5) * 0.05 * kk);
      C.pos[1] = baseY + mv * 0.35 * Math.sin(t * 0.11) - 0.45 * S.push + (S.reduced ? 0 : (rnd() - 0.5) * 0.06 * kk);
      C.pos[2] = baseZ - 3.6 * S.push - 1.4 * S.dropK * mv - 0.3 * kk + mv * 0.6 * Math.sin(t * 0.05);
      C.target[0] = mv * (0.9 * Math.sin(t * 0.05 + 1) + 0.5 * S.camBias); C.target[1] = 5.1 + mv * 0.3 * Math.sin(t * 0.09) + 0.5 * S.push; C.target[2] = -9;
      C.fov = 40 - 3 * S.push - 2 * S.dropK * mv;
      // 汇总
      rig.styleName = st.name; rig.styleIdx = S.styleIdx; rig.section = S.section; rig.energy = E; rig.quiet = S.quiet; rig.tint = S.tint;
      rig.chordIdx = ci; rig.ceremony = cer; rig.spawn = S.spawn; S.spawn = [];
      return rig;
    }

    // 灯光语言审计:rig 里每一个会变成光的颜色都不得落入引导色相
    function audit() {
      const bad = [], chk = (what, c) => { if (isGuideHue(c, 0.2)) bad.push(what + " " + c.map((v) => v.toFixed(2)).join(",")); };
      rig.lamps.forEach((L, i) => { if (L.inten > 0.01) chk("lamp" + i, L.col); });
      chk("tint", rig.tint); chk("tint2", rig.wall.tint2); chk("haze", rig.haze.col);
      rig.wall.hits.forEach((h, i) => chk("hit" + i, h.col)); rig.fx.shocks.forEach((s, i) => chk("shock" + i, s.col));
      rig.spawn.forEach((s) => (s.cols || [s.col]).forEach((c) => chk("spawn", c)));
      return bad;
    }
    return { rig, update, hit, miss, spot, audioEvent, celebrate, audit, state: S, STYLES, ramp, RAMP, CHORD, WARM, WHITE, GOLD, DRUM, NL, NC, POS, isGuideHue };
  }
  root.LPDirector = { create, STYLES, POS, isGuideHue, hueChroma, NL, NC };
})(typeof window !== "undefined" ? window : globalThis);
