/* 大师演出 · 编排层(show.js)——纯逻辑,不依赖 DOM / Three.js / WebAudio,所以 Node 里也能跑自检(tools/check_lightlang.js H 段)。
   它站在灯光导演(director.js)之上,只做四件事:
     1. 开场仪式:第一次按键 → 8 盏灯从左到右依次点亮(盘面同步一列一列醒来)→ 镜头缓缓后拉 → 雾散开;
     2. drop 时刻:蓄力(张力 0→1)→ 静默(0.30 s 全黑)→ 爆发(闪光/冲击环/彩带/镜头一冲/光束扇形展开),曲线写成参数表(见 首次震撼-视听效果.md 第 3 节);
     3. 熟练度(Mastery,0~1)→ 效果层(观众/学徒/乐手/DJ/大师):弹得越密、越准、手势越多、越敢指挥,画面越盛;
     4. 盘面(指挥台)的灯:开场前只有一个青绿闪烁键;仪式一列一列醒来;DROP 键在"可以引爆"时才用青绿闪烁(唯一的引导)。
   灯光语言:这里不新增任何颜色——全部来自 director.js / pad.js 的音名色盘、暖色带、暖白、金色;青绿(HSV 0.40~0.55)只在 padFrame 里以 Core.cue(t)(与全局同相的引导色)出现。
   时间单位:秒,与 director 一致(performance.now()/1000)。音频时钟里的事件由 master.js 在"耳朵听到"的那一刻转成 cue() 调用。 */
(function (root) {
  "use strict";
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const lerp = (a, b, f) => a + (b - a) * f;
  const ease = (rate, dt) => 1 - Math.exp(-rate * dt);
  const smooth = (x, a, b) => { const k = clamp((x - a) / (b - a), 0, 1); return k * k * (3 - 2 * k); };
  const LEVELS = ["观众", "学徒", "乐手", "DJ", "大师"], LEVEL_AT = [0, 0.05, 0.25, 0.5, 0.75];

  /* 可测的编排参数(文档第 3 节同表;改这里就是改"震撼的曲线") */
  const P = {
    gap: 0.30,                 // 静默时长(秒):全黑 + 声音收掉
    ritual: { ignite0: 0.0, igniteStep: 0.238, dolly: 4.5, haze: 6.0, length: 7.62, fov0: 9, z0: 3 },
    build: { chaseMax: 3.0, fovIn: 5, zIn: 1.2, hazeAdd: 0.6, bloomAdd: 0.25, floor0: 0.40, floor1: 0.90 },
    impact: { flash: 1.0, punchFov: 7, punchTau: 0.35, overdrive: 0.35, ring2: 0.14, confetti0: 55, confetti1: 60, goldAt: 3, liftTau: 1.2 },
    floors: { idle: 0, break: 0.10, drop: 0.92, exhale: 0.10 },
    calm: 0.6,                 // 引导键在闪的时候,舞台整体退让到 60%,且不放彩带/闪光
    startPad: 25,              // 开场前唯一闪烁的键:中排(A S D F J K L ; 那一排)的 J
  };


  /* ---------- 音乐规则(纯函数,Node 可测):音阶锁定 / 量化 / 和声跟随 ---------- */
  const MUSIC = {
    BASE: 44, PENT: [0, 2, 4, 7, 9],                                              // Ab2 起的 Ab 大调五声音阶
    CHORD_PC: [[8, 0, 3], [1, 5, 8], [3, 7, 10], [5, 8, 0]],                      // I IV V vi 的和弦音(音级类 0=C)
    VOICING: [[56, 60, 63], [56, 61, 65], [58, 63, 67], [56, 60, 65]],            // 平滑连接的三和弦(Ab3 起)
    BASS: [44, 37, 39, 41], LATE: 0.22,
    padMidi(r, c) { const deg = (c - 1) + 2 * (r - 1); return MUSIC.BASE + MUSIC.PENT[deg % 5] + 12 * Math.floor(deg / 5); },   // 盘面任何一个键都落在五声音阶上;同一个音永远同一种颜色(颜色按 deg%5)
    nearestTone(m, chord) { let best = m, bd = 99; for (let d = -2; d <= 2; d++) { const pc = (((m + d) % 12) + 12) % 12; if (MUSIC.CHORD_PC[chord].includes(pc) && Math.abs(d) < bd) { bd = Math.abs(d); best = m + d; } } return best; },
    harmonyOf(m, chord) { for (let d = 3; d <= 9; d++) { const pc = (((m - d) % 12) + 12) % 12; if (MUSIC.CHORD_PC[chord].includes(pc)) return m - d; } return m - 5; },
    // 强拍(每小节第 1、3 拍)吸附到和弦音;V 级上的 Ab(与 G 小二度冲突)下落半音;其余保持盘面原音
    adjust(m, chord, step16) { if (step16 % 8 === 0) return MUSIC.nearestTone(m, chord); if (chord === 2 && ((m % 12) + 12) % 12 === 8) return m - 1; return m; },
    // 量化:刚过格(≤ LATE 个 16 分音符)立刻响,否则落到下一格。返回 {tOn, off(相对最近格的误差,秒), delay(按下到发声,秒), n(格号)}
    quantize(now, T0, s16) {
      if (T0 > now) return { tOn: T0, off: T0 - now, delay: T0 - now, n: 0 };
      const ph = (now - T0) / s16, n0 = Math.floor(ph), frac = ph - n0;
      if (frac <= MUSIC.LATE) return { tOn: now + 0.004, off: frac * s16, delay: 0.004, n: n0 };
      const tOn = T0 + (n0 + 1) * s16; return { tOn, off: Math.min(frac, 1 - frac) * s16, delay: tOn - now, n: n0 + 1 };
    },
  };

  function create(opts) {
    const Core = opts.Core, dir = opts.dir, rnd = opts.random || Math.random;
    const DS = dir.state, rig = dir.rig;
    const S = {
      phase: "idle", t0: -99, scene: "idle", sceneT0: -99, buildT0: -99, buildDur: 7.6, armed: false, armedT: -99, guide: false, calm: false,
      gapT0: -99, gapK: 0, impactT: -99, power: 0.8, episode: 0, exhaleT0: -99, exhaleDur: 1.9, reduced: false, chord: 0, beat: 0, bar: 0,
      dHaze: 0, dBloom: 0, M: 0, level: 0, notes: [], gest: [], barNotes: new Map(), streak: 0, conduct: 0, lastBar: -1, lastDust: -99, lastPhrase: -99,
      ign: new Array(8).fill(-99), later: [], held: { roll: false, filter: false }, tension: 0, lastLevelT: -99, onLevel: null, fired: { impact: 0, gap: 0 }, forceM: null,
    };
    const col63 = (a) => a.map((v) => Math.min(1, Math.pow(v / 63, 0.55)));

    /* ---------- 事件入口 ---------- */
    function begin(t) {   // 第一次按键:仪式开始。必须在 Stage 的 dir.hit 之前调用(要把导演从"安静"里叫醒,否则第一下按键被吞)
      if (S.phase !== "idle") return;
      S.phase = "ritual"; S.t0 = t; S.scene = "break"; S.sceneT0 = t; DS.quiet = false; S.M = Math.max(S.M, 0.08); updateLevel(t);
    }
    function ignite(i, t) {   // 仪式里第 i 盏灯(0~7)被点亮:列 = 灯,行随琶音爬升
      i = clamp(i | 0, 0, 7); S.ign[i] = t;
      const row = 1 + Math.round(i * 0.6);
      dir.hit(row * 10 + i + 1, 0, t, { gain: 1 });
    }
    function note(info) {   // info: {t, pad, off (相对 16 分格的误差秒), s16, gesture}
      const t = info.t, tight = 1 - Math.min(1, Math.abs(info.off || 0) / ((info.s16 || 0.119) * 0.5));
      S.notes.push({ t, tight }); if (S.notes.length > 24) S.notes.shift();
      if (info.gesture && /sweep|lift/.test(info.gesture)) { S.gest.push(t); if (S.gest.length > 12) S.gest.shift(); }
      if (S.bar >= 0) S.barNotes.set(S.bar, (S.barNotes.get(S.bar) || 0) + 1);
      S.M = Math.max(S.M, 0.08);
      // 乐手(L2)起:镜像列也亮(和声的另一半),左右对称的舞台
      if (S.level >= 2 && info.pad) {   // 不走 dir.hit(那会打乱手势识别),直接给镜像列一点能量与同样的色
        const r = Math.floor(info.pad / 10), c = info.pad % 10;
        if (c >= 1 && c <= 8 && c !== 9 - c) { const ci = 8 - c; DS.e[ci] = Math.max(DS.e[ci], 0.5 + 0.08 * S.level); DS.noteCol[ci] = col63(Core.noteRgb(r, 9 - c)); DS.epsHit[ci] = (r - 1) / 7; DS.epsHold[ci] = t + 2.0; }
      }
    }
    function cue(name, t, arg) {
      arg = arg || {};
      if (name === "scene") {
        S.scene = arg.scene; S.sceneT0 = t;
        if (arg.scene === "build") { S.buildT0 = t; S.buildDur = arg.dur || 7.6; S.armed = false; }
        if (arg.scene === "break") { S.exhaleT0 = -99; S.conductedThis = false; }
        if (arg.scene === "drop") S.tension = 0;
      } else if (name === "armed") { S.armed = true; S.armedT = t; S.conductedThis = true; S.conduct = Math.min(1, S.conduct + 0.5); }
      else if (name === "gap") { S.gapT0 = t; S.fired.gap++; }
      else if (name === "impact") impact(t, arg.power);
      else if (name === "exhale") { S.exhaleT0 = t; S.exhaleDur = arg.dur || 1.9; }
      else if (name === "bar") { S.bar = arg.bar; S.chord = arg.chord || 0; S.beat = 0; barRoll(arg.bar); }
      else if (name === "beat") S.beat = arg.beat;
    }
    function barRoll(bar) {   // 每小节结算一次"连续弹奏"
      const n = S.barNotes.get(bar - 1) || 0; S.streak = n >= 3 ? S.streak + 1 : Math.max(0, S.streak - 2);
      S.barNotes.delete(bar - 1);
    }
    function impact(t, power) {
      S.impactT = t; S.gapT0 = -99; S.gapK = 0; S.fired.impact++; S.episode++;
      S.power = clamp(power != null ? power : 0.55 + 0.45 * S.M + 0.04 * Math.min(5, S.episode - 1), 0.55, 1);
      const pw = S.power, I = P.impact, red = S.reduced;
      DS.flash = red ? Math.min(0.25, pw) : I.flash * pw; DS.lastFlashT = t; DS.flashLog.push(t); if (DS.flashLog.length > 40) DS.flashLog.shift();
      DS.shocks.push({ t0: t, amp: pw, col: dir.WHITE.slice() }); if (DS.shocks.length > 4) DS.shocks.shift();
      S.later.push({ t: t + I.ring2, fn: (tt) => { DS.shocks.push({ t0: tt, amp: 0.75 * pw, col: dir.GOLD.slice() }); if (DS.shocks.length > 4) DS.shocks.shift(); } });
      if (!red) {
        DS.spawn.push({ kind: "confetti", n: Math.round(I.confetti0 + I.confetti1 * pw), gold: false, cols: dir.RAMP.map((c) => c.slice()) });
        if (S.level >= I.goldAt) DS.spawn.push({ kind: "confetti", n: 50, gold: true, cols: [dir.GOLD.slice()] });
      }
      DS.lift = 1; DS.liftT = t; DS.dropK = red ? 0 : 1; DS.energy = Math.max(DS.energy, 0.92); DS.styleIdx = 2; DS.styleAt = t; DS.inClimax = true;
      for (let i = 0; i < 8; i++) {   // 八盏灯一起"开扇":每盏一个暖色带上的色,光束向天空抬起
        DS.noteCol[i] = dir.ramp(i / 7); DS.epsHold[i] = t + 2.6; DS.epsHit[i] = 0.5 + 0.5 * (i / 7); DS.e[i] = 1;
        DS.hits.push({ x: (i + 0.5) / 8, y: 0.5 + 0.25 * Math.sin(i * 1.3), t, col: dir.ramp(i / 7), ci: i });
      }
      while (DS.hits.length > 8) DS.hits.shift();
    }
    function setHeld(k, v) { S.held[k] = !!v; }

    /* ---------- 熟练度 ---------- */
    function updateLevel(t) {
      let lv = 0; for (let i = 0; i < LEVEL_AT.length; i++) if (S.M >= LEVEL_AT[i] + (i > S.level ? 0.0 : -0.03)) lv = i;
      if (S.phase === "idle") lv = 0;
      if (lv !== S.level) { const up = lv > S.level; S.level = lv; S.lastLevelT = t; if (up && S.onLevel) S.onLevel(lv, LEVELS[lv]); }
    }
    function mastery(dt, t) {
      S.notes = S.notes.filter((n) => t - n.t < 8); S.gest = S.gest.filter((g) => t - g < 10);
      const d = clamp(S.notes.length / 24, 0, 1);                                 // 8 秒内 24 个音 = 满密度(3 个/秒)
      const tight = S.notes.length >= 4 ? clamp((S.notes.reduce((a, n) => a + n.tight, 0) / S.notes.length - 0.5) * 2, 0, 1) : 0;   // 乱按平均 0.5 → 0;越准越高
      const gest = clamp(S.gest.length / 3, 0, 1), streak = clamp(S.streak / 4, 0, 1);
      S.conduct = Math.max(0, S.conduct - dt / 60);
      const target = S.forceM != null ? S.forceM : 0.30 * d + 0.20 * tight + 0.20 * gest + 0.20 * streak + 0.10 * S.conduct;
      S.parts = { d, tight, gest, streak, conduct: S.conduct };
      if (S.forceM != null) S.M = S.forceM; else S.M += (Math.max(target, S.phase === "idle" ? 0 : 0.06) - S.M) * ease(target > S.M ? 0.7 : 0.03, dt);
      updateLevel(t);
    }

    /* ---------- 每帧:改写导演的输入 ---------- */
    // 导演里 haze.density / fx.bloom 是"自己缓动自己"的状态量:在 post 里直接 += 会被它当成状态反馈、放大几十倍(首跑实测 haze 1.5 → 10.5)。
    // 所以每次叠加都记账,下一帧 update 之前先减掉(pre)。
    function pre() { rig.haze.density -= S.dHaze; rig.fx.bloom -= S.dBloom; S.dHaze = 0; S.dBloom = 0; }
    function patch(inp, t, dt) {
      pre(); S.reduced = !!inp.reduced; inp.manual = true;
      if (S.phase === "ritual" && t - S.t0 >= P.ritual.length) S.phase = "play";
      const idle = S.phase === "idle"; inp.quiet = idle;
      inp.bandOn = inp.drumsOn = !idle; inp.bpm = 126;
      inp.chordIdx = S.chord; inp.bar = S.bar;
      S.calm = S.guide && S.phase !== "idle" && S.scene === "break";
      // 张力与能量地板:level 是导演里最直接的"能量"输入(E ≈ 0.5*level + 0.22 + 按键密度)
      const tb = t - S.buildT0;
      S.tension = S.scene === "build" ? clamp(Math.pow(clamp(tb / S.buildDur, 0, 1), 1.4), 0, 1) : 0;
      const F = P.floors, B = P.build;
      let floor = idle ? 0 : S.scene === "break" ? F.break + 0.15 * S.M : S.scene === "build" ? lerp(B.floor0, B.floor1, S.tension) : S.scene === "drop" ? F.drop : F.exhale;
      if (S.exhaleT0 > 0) floor = lerp(F.drop, F.exhale, clamp((t - S.exhaleT0) / S.exhaleDur, 0, 1));
      if (S.calm) floor *= P.calm;
      if (S.gapT0 > 0 && t >= S.gapT0 && S.impactT < S.gapT0) floor = 0;
      inp.level = Math.max(inp.level || 0, floor);
      mastery(dt, t);
      while (S.later.length && S.later[0].t <= t) S.later.shift().fn(t);
      // 大师(L4)的金粉:drop 里每 0.45 秒撒一小把
      if (S.level >= 4 && S.scene === "drop" && !S.reduced && t - S.lastDust > 0.45 && !S.calm) { S.lastDust = t; DS.spawn.push({ kind: "confetti", n: 8, gold: true, cols: [dir.GOLD.slice()] }); }
      // 每个 4 小节乐句开头,光束"抬头"一次(DJ 起)
      if (S.level >= 3 && S.scene === "drop" && S.bar !== S.lastPhrase && S.bar % 4 === 0) { S.lastPhrase = S.bar; DS.lift = 1; DS.liftT = t; }
      return inp;
    }

    /* ---------- 每帧:在导演算完之后,改写 rig ---------- */
    function post(r, dt, t) {
      const red = S.reduced, mv = red ? 0 : 1, I = P.impact, B = P.build, R = P.ritual;
      const idle = S.phase === "idle";
      const addH = (v) => { r.haze.density += v; S.dHaze += v; }, addB = (v) => { r.fx.bloom += v; S.dBloom += v; };
      // 静默:瞬间全黑(16 ms 内),到 impact 立刻放开
      const gapOn = S.gapT0 > 0 && t >= S.gapT0 && S.impactT < S.gapT0;
      S.gapK += ((gapOn ? 1 : 0) - S.gapK) * (gapOn ? ease(90, dt) : 1);
      if (S.gapK < 0.001) S.gapK = 0;
      // 仪式:镜头后拉(揭幕)+ 雾由浓到散
      const tr = t - S.t0;
      if (!idle && tr < R.dolly + 0.1 && mv) { const k = 1 - Math.pow(1 - clamp(tr / R.dolly, 0, 1), 3); r.cam.fov -= R.fov0 * (1 - k); r.cam.pos[2] -= R.z0 * (1 - k); }
      if (!idle && tr < R.haze) addH(0.5 * (1 - tr / R.haze));
      // 蓄力:张力
      const tau = S.tension;
      if (tau > 0) {
        addH(B.hazeAdd * tau); addB(B.bloomAdd * tau); r.wall.dim = Math.min(1, r.wall.dim + 0.12 * tau);
        r.cam.fov -= B.fovIn * tau * mv; r.cam.pos[2] -= B.zIn * tau * mv;
        const rate = 0.5 + (B.chaseMax - 0.5) * tau;   // 每盏灯的呼吸速度 0.5 → 3 Hz(单盏灯,非全场闪)
        for (let i = 0; i < 8; i++) { const ph = 0.5 + 0.5 * Math.sin(2 * Math.PI * (rate * t - i / 8)); r.lamps[i].inten = Math.max(r.lamps[i].inten, (0.12 + 0.6 * tau) * ph * ph); }
      }
      // 熟练度 → 效果层
      const M = S.M;
      addH(0.25 * M); addB(0.15 * M);
      for (let i = 8; i < 12; i++) r.lamps[i].inten *= 0.35 + 0.65 * smooth(M, 0.2, 0.55);     // 乐手之后后排桁架才加入
      for (let i = 12; i < 14; i++) r.lamps[i].inten *= smooth(M, 0.5, 0.8);                    // DJ 之后台口两盏扫场灯才加入
      // 爆发后的一冲(镜头先放宽再回落)与灯的过载
      if (t >= S.impactT && S.impactT > 0) {
        const pk = Math.exp(-(t - S.impactT) / I.punchTau);
        r.cam.fov += I.punchFov * pk * mv * S.power;
        for (let i = 0; i < r.lamps.length; i++) r.lamps[i].inten = Math.min(1.3, r.lamps[i].inten * (1 + I.overdrive * pk * S.power));
      }
      // 退场:最后一小节灯收敛
      if (S.exhaleT0 > 0) { const k = clamp((t - S.exhaleT0) / S.exhaleDur, 0, 1); for (let i = 0; i < r.lamps.length; i++) r.lamps[i].inten *= 1 - 0.55 * k; }
      // 引导期间安静:舞台退让,不放彩带/闪光
      if (S.calm) { for (let i = 0; i < r.lamps.length; i++) r.lamps[i].inten *= P.calm; r.spawn.length = 0; r.fx.flash = 0; r.fx.shocks.length = 0; }
      // DJ 滤波手势(按住 FILTER 键):画面一起"捂住"——灯压暗、屏墙暗、雾浓;松开时反弹(由音频侧的 cue 触发 flash)
      if (S.held.filter) { for (let i = 0; i < r.lamps.length; i++) r.lamps[i].inten *= 0.45; r.wall.dim *= 0.5; addH(0.3); }
      // 静默:灯、屏墙、闪光全部压到 0,烟雾留着(爆发时光束从雾里"撕"出来)
      if (S.gapK > 0) {
        const g = 1 - S.gapK;
        for (let i = 0; i < r.lamps.length; i++) r.lamps[i].inten *= g * (red ? 0.4 : 1) + (red ? 0.6 * S.gapK : 0);
        r.fx.blackout = Math.max(r.fx.blackout, S.gapK * (red ? 0.55 : 1)); r.fx.flash = 0; r.wall.dim *= red ? 1 - 0.5 * S.gapK : g; r.fx.shocks.length = 0;
      }
      if (idle) {   // 开场前:黑暗里只有中间两盏灯的"值班灯",暖色,0.2 Hz 呼吸
        const br = 0.16 + 0.07 * Math.sin(t * 0.2 * 2 * Math.PI);
        for (let i = 0; i < r.lamps.length; i++) r.lamps[i].inten = 0;
        [3, 4].forEach((i) => { const L = r.lamps[i]; L.col = dir.WARM.slice(); L.inten = br; });
        r.haze.density = 0.34; r.haze.col = r.haze.col.map((v) => v * 0.4); r.wall.dim = 0.015; r.fx.bloom = Math.min(r.fx.bloom, 0.45);
      }
      r.fx.lift = idle ? 0.3 : 1;   // 暗部分级的抬升:开场前压低,黑暗才是真黑
      r.show = { phase: S.phase, scene: S.scene, level: S.level, M: S.M, tension: S.tension, gap: S.gapK, power: S.power };
      return r;
    }

    /* ---------- 盘面(指挥台)的灯 ---------- */
    // o: {cue: 与全局同相的引导色(Core.cue(t)), chord, beat, scene}
    const base63 = () => Core.settings.base;
    function padFrame(fr, t, o) {
      for (let c = 104; c <= 111; c++) fr[c] = [0, 0, 0];
      for (let r = 1; r <= 8; r++) fr[r * 10 + 9] = [0, 0, 0];
      if (S.phase === "idle") { fr[P.startPad] = o.cue; return fr; }   // 开场前:唯一的引导 = 一个闪着的键
      const tr = t - S.t0;
      if (S.phase === "ritual" || tr < P.ritual.length + 0.6) {
        // 仪式:盘面先暗,然后一列一列"醒来"(列 = 灯),醒来的瞬间是音名色,0.55 s 衰回底色;被按下的键保持它自己的绽放
        for (let r = 1; r <= 8; r++) for (let c = 1; c <= 8; c++) {
          const p = r * 10 + c, age = t - S.ign[c - 1];
          if (Core.lights.flash[p]) continue;
          if (S.ign[c - 1] < 0 || age < 0) { fr[p] = [7, 7, 7]; continue; }
          const k = Math.exp(-age / 0.55), nc = Core.noteRgb(r, c), b = base63();
          fr[p] = [0, 1, 2].map((j) => Math.round(lerp(b, nc[j], k * 0.9)));
        }
      }
      if (S.phase === "ritual") return fr;
      // 控制键:DROP(107,红)/ ROLL(108,橙)/ FILTER(109,粉)
      const k = (c, f) => c.map((x) => Math.floor(x * f)), pulse = 0.55 + 0.45 * (o.beat === 0 ? 1 : 0.35);
      if (S.guide) fr[107] = o.cue;                                             // 下一步 = 引爆:唯一的青绿
      else if (S.armed || S.scene === "build") fr[107] = k([63, 4, 0], pulse);   // 已经按下:红色随拍呼吸
      else if (S.scene === "drop") fr[107] = [34, 0, 0]; else fr[107] = [14, 0, 0];
      fr[108] = k(Core.IDENT.drums, S.held.roll ? 1 : 0.25);
      fr[109] = k(Core.IDENT.band, S.held.filter ? 1 : 0.25);
      // 右列:下四格 = 拍点(白),上四格 = 当前和弦色(与 pad.js 乐队灯同一规则)
      const side = [19, 29, 39, 49, 59, 69, 79, 89], [cr, cg, cb] = Core.hsv([0, 0.11, 0.78, 0.92][o.chord || 0], 0.9, 0.9);
      side.slice(0, 4).forEach((s, i) => (fr[s] = i === o.beat ? [63, 63, 63] : [6, 6, 6]));
      side.slice(4).forEach((s) => (fr[s] = [cr, cg, cb]));
      return fr;
    }

    function setGuide(v) { S.guide = !!v; }
    const api = { S, P, LEVELS, LEVEL_AT, begin, ignite, note, cue, patch, post, padFrame, setGuide, setHeld, updateLevel, setMastery: (m) => { S.forceM = m == null ? null : m; if (m != null) { S.M = m; updateLevel(0); } }, col63 };
    return api;
  }
  root.LPShow = { create, P, LEVELS, LEVEL_AT, MUSIC };
})(typeof window !== "undefined" ? window : globalThis);
