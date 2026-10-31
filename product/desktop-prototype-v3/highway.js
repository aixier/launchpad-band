/* 跟打模式(rhythm highway)——逻辑层。不碰 DOM/画布(画面在 hwview.js),所以 Node 里也能跑(tools/check_lightlang.js G 段)。
   职责:谱面运行时、判定(按下时间窗 与 按住时长 分开)、连击/准确率/星级、声部"锁定后由乐队接力"、
   盘面灯(预备青绿常亮、层指示、进度)、给灯光导演的驱动量、延迟校准。
   时钟:一切以 WebAudio 的 ctx.currentTime 为准。heard = 歌曲时间 - 输出延迟(耳朵听到的时刻);judge = heard - 用户校准值。
   灯光语言(跟打例外条款,见 README / 跟打模式-设计.md):
     - 青绿只出现在"该按的键":盘面(与屏幕上的盘面镜像)里,光条进入判定前窗口(PRE 秒)的目标键亮青绿**常亮**(不闪),命中/漏掉后熄灭;
     - 跟打期间盘面上没有任何 1 Hz 闪烁的引导(避免"闪的"和"常亮的"两种语言同时出现);
     - 瀑布/光斑/舞台灯只用 音名色盘(红橙黄紫粉)+ 暖白,不含青绿色相。 */
(function (root) {
  "use strict";
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const lerp3 = (a, b, f) => a.map((x, i) => Math.floor(x + (b[i] - x) * f));
  const disp = (v) => Math.min(1, Math.pow(v / 63, 0.55));
  const MODES = {
    easy: { name: "轻松", perf: 0.085, good: 0.17, early: 0.17, holdP: 0.17, holdG: 0.34, lock: 0.5, stars: [0.5, 0.72, 0.88], desc: "时间窗宽,打到一半就能叠上这一层" },
    strict: { name: "严格", perf: 0.045, good: 0.10, early: 0.10, holdP: 0.09, holdG: 0.20, lock: 0.7, stars: [0.6, 0.8, 0.93], desc: "时间窗窄,要打得稳才叠得上" },
  };
  const PRE = 0.4;          // 青绿"预备"在光条头部到达前多少秒亮起(常亮)
  const LEAD = 1.4;         // 光条从出现到落点的秒数(视图用)
  const ASSIST_NEXT = { full: "bars", bars: "off", off: "off" };
  const ASSIST_NAME = { full: "全部亮灯", bars: "只亮每小节第一个", off: "不亮灯" };

  function create(deps) {
    const Core = deps.Core, A = deps.A, charts = deps.charts || [];
    const getDir = () => (deps.Stage && deps.Stage.dir) || deps.dir || null;
    const clock = deps.clock || { now: () => A.context().currentTime, out: () => A.outLatency(), perf: () => performance.now() / 1000 };
    const store = deps.store || { load: Core.load, save: Core.save };
    const H = { MODES, PRE, LEAD, ASSIST_NAME, phase: "off", events: [], floaters: [], flashes: {}, charts };

    /* ---------- 设置与成绩 ---------- */
    const set = Object.assign({ mode: "easy", assist: "auto", tick: true, rows: 1, view: "spot", calib: 0 }, store.load("lp3.hw.settings", {}));
    H.set = set; const saveSet = () => store.save("lp3.hw.settings", set);
    H.save = saveSet;
    const bestAll = store.load("lp3.hw.best", {});
    H.best = (id, mode) => bestAll[id + ":" + (mode || set.mode)] || null;

    let chart = null, spb = 0.5, notes = [], play = [], bk = [], bkPtr = 0, secs = [], layerOf = {}, mode = MODES.easy, timer = null, clickT = [], clickPtr = 0, tickPtr = 0;
    const S = H.S = { startAt: 0, locked: {}, assist: "full", combo: 0, maxCombo: 0, strays: 0, recent: 0.5, log: [], res: null, cal: null, pausedAt: 0, lastHitAt: {}, secFinal: [], secScore: [], t0perf: 0 };

    /* ---------- 时间 ---------- */
    const rawT = () => clock.now() - S.startAt;
    const heard = () => (S.frozen != null ? S.frozen : rawT() - clock.out());
    H.visT = heard;                                   // 画面用:耳朵听到的歌曲时间(秒;<0 为倒数)
    const judgeT = () => heard() - set.calib;         // 判定用:再扣掉校准的"人+设备+画面"延迟
    H.judgeT = judgeT;
    Object.defineProperty(H, "active", { get: () => H.phase !== "off" });
    Object.defineProperty(H, "chart", { get: () => chart });
    H.spb = () => spb; H.mode = () => mode;

    /* ---------- 谱面 → 运行时 ---------- */
    function build(c) {
      chart = c; spb = 60 / c.bpm; mode = MODES[set.mode] || MODES.easy;
      secs = c.sections.map((s) => ({ ...s, t0: s.b0 * spb, t1: s.b1 * spb, li: c.layers.findIndex((l) => l.id === s.layer) }));
      layerOf = {}; c.layers.forEach((l, i) => (layerOf[l.id] = { ...l, i, sec: secs[l.section] }));
      notes = c.notes.map((n, i) => {
        const L = layerOf[n.layer], pad = set.rows === 2 && n.adv ? n.adv : n.pad;
        const t = n.t * spb, d = n.d * spb, own = n.t >= L.sec.b0 && n.t < L.sec.b1;
        return { i, t, d, tb: n.t, pad, r: Math.floor(pad / 10), c: pad % 10, layer: n.layer, li: L.i, hold: n.d >= 1, own, v: n.v, state: "wait", press: null, rel: null, err: 0, handles: null, lamp: -1, key: null };
      });
      play = notes.filter((n) => n.own).sort((a, b) => a.t - b.t);
      bk = notes.filter((n) => !n.own).sort((a, b) => a.t - b.t);
      // 预备灯需要的邻接信息:同键上一个音;"小节第一个音/长间隔后的第一个音"
      const lastOnPad = {}; let prev = null;
      play.forEach((n) => { n.prevSame = lastOnPad[n.pad] || null; lastOnPad[n.pad] = n; n.lead = !prev || n.layer !== prev.layer || n.tb % 4 < 0.01 || n.tb - (prev.tb + prev.d / spb) >= 1.5 || n.tb - prev.tb >= 2; prev = n; });
      assignLamps();
    }
    /* 追光分配:每个要打的音配一盏灯。优先用它所在列的那盏(= 盘面第 c 列 ↔ 中排桁架第 c 盏),冲突(时间重叠)时借后排桁架的灯(8~11),再借地面灯(12,13) */
    function assignLamps() {
      const busy = new Array(14).fill(-9);
      play.forEach((n) => {
        const pref = [n.c - 1, ...[8, 9, 10, 11].sort((a, b) => Math.abs(-6 + 4 * (a - 8) - (n.c - 4.5) * 2.4) - Math.abs(-6 + 4 * (b - 8) - (n.c - 4.5) * 2.4)), 12, 13];
        let l = pref.find((k) => busy[k] <= n.t - 0.25); if (l == null) l = -1;
        n.lamp = l; if (l >= 0) busy[l] = n.t + n.d;
      });
    }
    H.lampChains = () => { const ch = {}; play.forEach((n) => { if (n.lamp >= 0) (ch[n.lamp] = ch[n.lamp] || []).push(n); }); return ch; };

    /* ---------- 颜色(0~63 灯值;视图再换算)---------- */
    const hsv = (h, s, v) => Core.hsv(h, s, v);
    H.layerRgb = (layer) => hsv(layerOf[layer].hue, 0.9, 1);
    H.barRgb = (n) => (n.layer === "melody" ? Core.noteRgb(n.r, n.c) : H.layerRgb(n.layer));   // 旋律按音名上色(同一个音永远同一种颜色),其余按声部
    H.dispRgb = (c63) => c63.map(disp);
    H.layerOf = (id) => layerOf[id];

    /* ---------- 声音 ---------- */
    function logSound(n, kind, when, src) { S.log.push({ layer: n.layer, k: kind, at: +(when - S.startAt).toFixed(3), src, tb: n.tb }); if (S.log.length > 800) S.log.shift(); }
    function sound(n, when, hold, src) {
      const k = n.v.k, hs = [];
      if (k === "kick" || k === "snare" || k === "hat") A.drum(k, when);
      else if (k === "bass") hs.push(A.voice("bass", n.v.m, when, 0.9, hold));
      else if (k === "chord") n.v.m.forEach((m) => hs.push(A.voice("pad", m, when, k === "chord" && n.d < 1 ? 0.55 : 0.5, hold)));
      else hs.push(A.voice("lead", n.v.m, when, 1, hold));
      logSound(n, k, when, src); return hs;
    }
    const releaseAll = (hs, t) => hs && hs.forEach((h) => h && h.release && h.release(t));

    /* ---------- 评分 ---------- */
    function score(list) {
      let np = 0, ps = 0, nh = 0, hs = 0, P = 0, G = 0, M = 0, hP = 0, hG = 0, hB = 0;
      for (const n of list) {
        np++; if (n.press === "P") { P++; ps += 1; } else if (n.press === "G") { G++; ps += 0.7; } else M++;
        if (n.hold) { nh++; if (n.rel === "P") { hP++; hs += 1; } else if (n.rel === "G") { hG++; hs += 0.7; } else { hB++; if (n.press && n.rel) hs += 0.3; } }
      }
      const pressAcc = np ? ps / np : 1, holdAcc = nh ? hs / nh : 1, acc = nh ? 0.7 * pressAcc + 0.3 * holdAcc : pressAcc;
      return { n: np, nHold: nh, P, G, M, hP, hG, hB, pressAcc, holdAcc, acc };
    }
    H.score = (list) => score(list || play);
    const starsOf = (acc) => (acc >= mode.stars[2] ? 3 : acc >= mode.stars[1] ? 2 : acc >= mode.stars[0] ? 1 : 0);
    H.starsOf = starsOf;

    /* ---------- 灯光导演联动 ---------- */
    const dirHit = (n, g) => { const d = getDir(); if (d) d.hit(n.pad, 0, clock.perf(), { col: H.dispRgb(H.barRgb(n)), gain: g === "P" ? 1 : 0.78 }); };
    const dirMiss = () => { const d = getDir(); if (d && d.miss) d.miss(); };
    H.drive = () => {
      const T = heard(), n = S.locked, nLock = Object.keys(n).filter((k) => n[k]).length;
      const energy = clamp(0.16 + 0.34 * S.recent + 0.24 * Math.min(1, S.combo / 24) + 0.065 * nLock, 0, 1);
      const beat = Math.floor(Math.max(0, T) / spb), g = Math.floor(beat / 4) % 6, CHIDX = [3, 1, 0, 2];   // Am F C G → vi IV I V
      const sec = secs.find((s) => T >= s.t0 && T < s.t1);
      return { energy, bandOn: !!(n.bass || n.chords || (sec && (sec.layer === "bass" || sec.layer === "chords") && S.recent > 0.3)), drumsOn: !!(n.drums || (sec && sec.layer === "drums" && S.recent > 0.3)), chordIdx: CHIDX[chart ? [0, 1, 2, 3, 1, 3][g] : 0], bar: Math.floor(Math.max(0, T) / spb / 4), bpm: chart ? chart.bpm : 100 };
    };

    /* ---------- 判定 ---------- */
    const floater = (n, text, kind) => { H.floaters.push({ t0: clock.perf(), c: n.c, r: n.r, pad: n.pad, text, kind, col: H.barRgb(n) }); if (H.floaters.length > 24) H.floaters.shift(); };
    const flash = (n, strong) => { H.flashes[n.pad] = { t0: clock.perf(), col: H.barRgb(n), a: strong ? 1 : 0.7 }; };
    function missNote(n, why) {
      n.state = "miss"; n.missAt = clock.perf(); n.press = null; S.combo = 0; S.recent += (0 - S.recent) * 0.22; dirMiss(); floater(n, why || "漏拍", "miss");
      if (n.hold) n.rel = null;
    }
    function pick(pad, col, T) {
      let best = null, bd = 1e9;
      for (const n of play) {
        if (n.state !== "wait") continue; const e = T - n.t;
        if (e < -mode.early - 0.0001) break;
        if (e > mode.good) continue;
        if (pad ? n.pad !== pad : n.c !== col) continue;
        if (Math.abs(e) < bd) { bd = Math.abs(e); best = n; }
      }
      return best;
    }
    function down(pad, col) {
      const T = judgeT(); if (H.phase !== "play") return;
      const n = pick(pad, col, T);
      if (!n) { S.strays++; if (pad) H.flashes[pad] = { t0: clock.perf(), col: [14, 14, 14], a: 0.5 }; return; }   // 没有对应的光条:静默,不惩罚
      const e = T - n.t, a = Math.abs(e);
      if (a > mode.good) { missNote(n, e < 0 ? "早了" : "晚了"); return; }
      n.at = clock.perf(); n.press = a <= mode.perf ? "P" : "G"; n.err = e; n.key = pad || "c" + col; n.state = n.hold ? "holding" : "hit";
      S.combo++; S.maxCombo = Math.max(S.maxCombo, S.combo); S.recent += ((n.press === "P" ? 1 : 0.8) - S.recent) * 0.22; S.lastHitAt[n.layer] = clock.perf();
      n.handles = sound(n, clock.now(), n.hold ? null : Math.max(0.14, n.d * 1.0), "user");
      floater(n, n.press === "P" ? "完美" : e < 0 ? "不错 早" : "不错 晚", n.press === "P" ? "perfect" : "good"); flash(n, n.press === "P"); dirHit(n, n.press);
    }
    function up(key) {
      const T = judgeT();
      for (const n of play) {
        if (n.state !== "holding" || n.key !== key) continue;
        const e = T - (n.t + n.d), a = Math.abs(e);
        n.rel = a <= mode.holdP ? "P" : a <= mode.holdG ? "G" : e < 0 ? "E" : "L"; n.relErr = e; n.relAt = clock.perf(); n.state = "done";
        releaseAll(n.handles, clock.now()); floater(n, n.rel === "P" ? "松得准" : n.rel === "G" ? "松得还行" : n.rel === "E" ? "松早了" : "拖长了", n.rel === "P" ? "perfect" : n.rel === "G" ? "good" : "miss");
        return;
      }
    }

    /* ---------- 输入入口:盘面键(Core.press 接管)与键盘"列键" ---------- */
    H.onPad = (id, isDown) => {
      if (id >= 100) return true;                       // 顶排/右列:跟打期间不响应(盘面灯另有用途)
      const r = Math.floor(id / 10), c = id % 10; if (r < 1 || r > 8 || c < 1 || c > 8) return true;
      if (H.phase === "calib") { if (isDown) calPress(); return true; }
      if (isDown) down(id, 0); else up(id);
      return true;
    };
    H.laneKey = (col, isDown) => {                      // 键盘模拟:8 个键 = 8 列,忽略行(找本列最近的光条)
      if (H.phase === "calib") { if (isDown) calPress(); return; }
      if (isDown) down(0, col); else up("c" + col);
    };

    /* ---------- 校准:跟着节拍按几下,取平均偏差 ---------- */
    H.calibrate = () => {
      if (H.phase !== "ready") return; A.ensure();
      const ac = clock.now(), t0 = ac + 0.9, gap = 0.6, N = 9;
      S.cal = { t0, gap, N, beats: Array.from({ length: N }, (_, i) => t0 + i * gap), errs: [], done: false, result: null };
      S.startAt = 0; H.phase = "calib";
      S.cal.beats.forEach((t, i) => A.click(t, i === 0));
      S.cal.timer = setTimeout(finishCal, (0.9 + N * gap + 0.5) * 1000);
    };
    function calPress() {
      const c = S.cal; if (!c) return; const hp = clock.now() - clock.out();   // 与判定同样的"听到的时刻"
      let bi = 0, bd = 1e9; c.beats.forEach((t, i) => { if (Math.abs(hp - t) < bd) { bd = Math.abs(hp - t); bi = i; } });
      if (bd < 0.3) c.errs.push({ i: bi, e: hp - c.beats[bi] });
    }
    H.finishCal = () => finishCal();
    function finishCal() {
      const c = S.cal; if (!c) return;
      const e = c.errs.filter((x) => x.i >= 2).map((x) => x.e).sort((a, b) => a - b);
      if (e.length >= 4) { const tr = e.length > 5 ? e.slice(1, -1) : e; const m = tr.reduce((a, b) => a + b, 0) / tr.length; set.calib = clamp(+m.toFixed(3), -0.2, 0.3); saveSet(); c.result = { ms: Math.round(set.calib * 1000), n: e.length }; }
      else c.result = { ms: null, n: e.length };
      c.done = true; H.phase = "ready";
    }

    /* ---------- 流程 ---------- */
    H.open = () => {
      if (H.phase !== "off") return; chart = charts[0]; build(chart);
      A.ensure(); Core.skipGuide(); A.setBandOn(false); A.setDrumsOn(false); H.phase = "ready"; H.events.length = 0; resetRun();
      Core.emit("state");
    };
    function resetRun() {
      S.locked = {}; S.combo = 0; S.maxCombo = 0; S.strays = 0; S.recent = 0.5; S.log = []; S.res = null; S.secFinal = []; S.secScore = []; H.floaters.length = 0; H.flashes = {}; H.events.length = 0;
      notes.forEach((n) => { n.state = "wait"; n.press = null; n.rel = null; n.handles = null; n.key = null; });
      bkPtr = 0; clickPtr = 0; tickPtr = 0; S.assist = set.assist === "auto" ? "full" : set.assist;
    }
    H.start = () => {
      if (H.phase !== "ready" && H.phase !== "done") return;
      mode = MODES[set.mode] || MODES.easy; build(chart); resetRun(); A.ensure();
      const now = clock.now(), cin = chart.countIn;
      S.startAt = now + 0.35 + cin * spb; clickT = Array.from({ length: cin }, (_, i) => S.startAt - (cin - i) * spb);
      H.phase = "count"; S.t0perf = clock.perf();
      if (!timer) timer = setInterval(H.schedule, 25);
      H.schedule();
    };
    H.pause = () => {
      if (H.phase === "play" || H.phase === "count") { H.prevPhase = H.phase; H.phase = "paused"; const c = A.context(); c && c.suspend && c.suspend(); }
      else if (H.phase === "paused") { H.phase = H.prevPhase; const c = A.context(); c && c.resume && c.resume(); }
    };
    H.close = () => {
      if (timer) { clearInterval(timer); timer = null; } if (S.cal && S.cal.timer) clearTimeout(S.cal.timer);
      play.forEach((n) => releaseAll(n.handles, clock.now())); const was = H.phase !== "off"; H.phase = "off"; Core.lights.flash = {}; if (was) Core.emit("state");
      const c = A.context(); if (c && c.state === "suspended") c.resume();
    };
    H.again = () => { H.phase = "ready"; H.start(); };
    H.backToReady = () => { H.phase = "ready"; resetRun(); };

    /* 调度:乐队接力(已锁定声部在后面各段按谱精确回放)、节拍点击、倒数 */
    H.schedule = () => {
      if (H.phase !== "play" && H.phase !== "count") return;
      const horizon = clock.now() + 0.18;
      while (clickPtr < clickT.length && clickT[clickPtr] <= horizon) { A.click(clickT[clickPtr], clickPtr === 0); clickPtr++; }
      if (set.tick) while (S.startAt + tickPtr * spb <= horizon && tickPtr * spb < chart.endBeat * spb) { A.click(S.startAt + tickPtr * spb, false); tickPtr++; }
      while (bkPtr < bk.length && S.startAt + bk[bkPtr].t <= horizon) {
        const n = bk[bkPtr++], L = layerOf[n.layer]; ensureFinal(L.section);
        if (S.locked[n.layer]) { sound(n, S.startAt + n.t, Math.max(0.1, n.d * 0.92), "auto"); }
      }
    };
    function ensureFinal(si) { if (!S.secFinal[si]) finalizeSec(si, true); }
    function finalizeSec(si, forced) {
      if (S.secFinal[si]) return; const s = secs[si];
      const list = play.filter((n) => n.li === s.li);
      list.forEach((n) => { if (n.state === "wait") { n.state = "miss"; n.press = null; } if (n.state === "holding") { n.state = "done"; n.rel = "L"; releaseAll(n.handles, clock.now()); } });
      const sc = score(list); S.secScore[si] = sc; S.secFinal[si] = true;
      const ok = sc.acc >= mode.lock; S.locked[s.layer] = ok;
      let assistNote = null;
      if (set.assist === "auto" && sc.acc >= 0.85 && ASSIST_NEXT[S.assist] !== S.assist) { S.assist = ASSIST_NEXT[S.assist]; assistNote = S.assist; }
      H.events.push({ k: "lock", layer: s.layer, ok, acc: sc.acc, assist: assistNote, at: clock.perf() });
      if (ok) { const d = getDir(); if (d) d.audioEvent({ kind: "pad" }); }
    }

    H.update = () => {
      if (H.phase === "count" && judgeT() > -0.6) H.phase = "play";   // 倒数的最后半秒就开始接受按键(第一拍的"早按"窗口)
      if (H.phase !== "play") return;
      const T = judgeT(), now = clock.now();
      for (const n of play) {
        if (n.state === "wait" && T > n.t + mode.good) missNote(n);
        else if (n.state === "holding" && T > n.t + n.d + mode.holdG) { n.rel = "L"; n.state = "done"; n.relAt = clock.perf(); releaseAll(n.handles, now + 0.05); floater(n, "拖长了", "miss"); }
        else if (n.t - T > 1) break;
      }
      secs.forEach((s, si) => { if (!S.secFinal[si] && T > s.t1 - 0.4 && !play.some((n) => n.li === s.li && (n.state === "wait" || n.state === "holding"))) finalizeSec(si); else if (!S.secFinal[si] && T > s.t1 + 0.1) finalizeSec(si, true); });
      S.recent = clamp(S.recent, 0, 1);
      if (T > chart.endBeat * spb + 1.2) finish();
    };
    function finish() {
      secs.forEach((s, si) => finalizeSec(si, true));
      const sc = score(play), stars = starsOf(sc.acc), layersOn = Object.keys(S.locked).filter((k) => S.locked[k]).length;
      S.res = { ...sc, stars, maxCombo: S.maxCombo, layersOn, layersAll: chart.layers.length, mode: set.mode, strays: S.strays, bySec: S.secScore.slice() };
      const key = chart.id + ":" + set.mode, old = bestAll[key]; if (!old || stars > old.stars || (stars === old.stars && sc.acc > old.acc)) { bestAll[key] = { stars, acc: +sc.acc.toFixed(3) }; store.save("lp3.hw.best", bestAll); }
      H.phase = "done"; S.doneAt = clock.perf(); A.fanfare && A.fanfare(Core.tonic); Core.emit("hwFinish", S.res);
    }

    /* ---------- 预备灯(青绿常亮)与盘面 ---------- */
    H.prep = (T) => {
      const out = []; if ((H.phase !== "play" && H.phase !== "count") || S.assist === "off") return out;
      const tt = T == null ? judgeT() : T;
      for (const n of play) {
        if (n.state !== "wait") continue; const dt = n.t - tt;
        if (dt > PRE) break; if (dt < -mode.good) continue;
        if (S.assist === "bars" && !n.lead) continue;
        if (n.prevSame && n.prevSame.state !== "wait" && tt < n.prevSame.t + 0.12) continue;
        if (n.prevSame && n.prevSame.state === "wait" && n.prevSame.t + 0.12 > tt) continue;
        out.push(n);
      }
      return out;
    };
    const dimOf = (c, f) => c.map((v) => Math.floor(v * f));
    H.padFrame = (t) => {
      const ov = {}, ex = {}; for (let k = 104; k < 112; k++) ex[k] = [0, 0, 0]; [19, 29, 39, 49, 59, 69, 79, 89].forEach((s) => (ex[s] = [0, 0, 0]));
      const ph = H.phase;
      if (ph === "done" && S.res) {
        const age = clock.perf() - S.doneAt;
        for (let r = 1; r <= 8; r++) for (let c = 1; c <= 8; c++) ov[r * 10 + c] = Core.hsv(Core.rainbowHue(age * 0.8 - (r + c) * 0.05), 0.9, 1);
        [69, 79, 89].forEach((p, i) => (ex[p] = i < S.res.stars ? Core.GOLD : [6, 6, 6]));
        return [ov, ex];
      }
      const T = heard(), si = secs.findIndex((s) => T >= s.t0 - 0.2 && T < s.t1);
      const cur = si >= 0 ? secs[si] : secs[0];
      if (chart && ph !== "ready" && ph !== "calib") {
        // "这一层在这一带":当前声部用到的键,淡淡亮着声部色(行 = 声部)
        if (cur) play.forEach((n) => { if (n.li === cur.li) ov[n.pad] = dimOf(H.layerRgb(n.layer), 0.16); });
        chart.layers.forEach((L, i) => { const on = S.locked[L.id]; ex[104 + i] = on ? H.layerRgb(L.id) : dimOf(H.layerRgb(L.id), i === cur.li ? 0.35 : 0.09); });
        const prog = clamp(T / (chart.endBeat * spb), 0, 1); for (let i = 0; i < 8; i++) ex[(i + 1) * 10 + 9] = prog >= (i + 1) / 8 - 0.0001 ? [34, 32, 28] : prog > i / 8 ? [14, 13, 11] : [0, 0, 0];
        const nowP = clock.perf();
        for (const pad in H.flashes) { const f = H.flashes[pad], age = nowP - f.t0; if (age > 0.4) { delete H.flashes[pad]; continue; } ov[pad] = lerp3(ov[pad] || [10, 10, 10], f.col, f.a * (1 - age / 0.4)); }
        play.forEach((n) => { if (n.state === "holding") ov[n.pad] = H.barRgb(n); });
        H.prep().forEach((n) => (ov[n.pad] = Core.GUIDE));   // 跟打例外:青绿常亮(不闪),命中/漏掉即熄灭。只有"该按的键"
      }
      return [ov, ex];
    };

    /* ---------- 测试用:把歌曲时间冻结在 T,并把 T 之前的音按"全部完美"处理(截图对比各提示方式用;不出声)---------- */
    H.debugSeek = (T, o) => {
      o = o || {}; if (H.phase === "off") H.open(); build(chart); resetRun(); S.frozen = T; H.phase = "play"; set.calib = set.calib || 0;
      const nowP = clock.perf();
      play.forEach((n) => { if (n.t + n.d < T - 0.12 || n.t < T - mode.good - 0.02) { n.state = "done"; n.press = "P"; n.rel = n.hold ? "P" : null; if (T - n.t < 0.6) { n.at = nowP - (T - n.t); n.state = n.hold ? "done" : "hit"; } } });
      secs.forEach((s2, si) => { if (T > s2.t1) { S.secFinal[si] = true; S.locked[s2.layer] = true; S.secScore[si] = score(play.filter((n) => n.li === s2.li)); } });
      S.combo = o.combo != null ? o.combo : 24; S.recent = 0.92; S.maxCombo = S.combo;
      const d = getDir(); if (d) play.forEach((n) => { if (n.state === "hit" && T - n.t < 0.3) d.hit(n.pad, 0, nowP, { col: H.dispRgb(H.barRgb(n)), gain: 1 }); });
      if (o.hold) { const hn = play.find((n) => n.hold && n.t <= T && n.t + n.d > T); if (hn) { hn.state = "holding"; hn.press = "P"; hn.key = hn.pad; } }
    };
    H.debugUnfreeze = () => { S.frozen = null; };
    /* ---------- 状态快照(测试/截图用)---------- */
    H.snapshot = () => ({ phase: H.phase, set: { ...set }, T: chart ? +heard().toFixed(3) : 0, combo: S.combo, maxCombo: S.maxCombo, locked: { ...S.locked }, assist: S.assist, strays: S.strays, res: S.res, secScore: S.secScore.map((s) => s && { ...s }), score: score(play.filter((n) => n.state !== "wait")), events: H.events.slice(), log: S.log.length });
    H.notes = () => play; H.backing = () => bk; H.secs = () => secs; H.build = build; H.layers = () => (chart ? chart.layers : []);
    H.statsNow = () => { const done = play.filter((n) => n.state !== "wait"); return score(done); };
    return H;
  }
  /* 透视格阵的几何(纯函数,视图与自检共用):盘面 8x8 画成向远处收窄的地面格阵,第 1 行在最近(屏幕下方),与真实 Launchpad 的朝向一致。
     深度 s∈[0,1](0=最近一行的下边,1=最远一行的上边):y(s)=yN-Hg*s(1+k)/(1+ks);宽度 w(s)=Wb/(1+ks)——同一个透视参数 k,格子才不会"拧"。 */
  function geometry(W, Hh, hudR) {
    const Wb = Math.min(600, W * (W < 760 ? 0.86 : 0.44), Hh * 0.78), k = 0.9, Hg = Math.min(Hh * 0.36, Wb * 0.66), hu = Wb / 8;
    const cx = clamp(W / 2, (hudR || 0) + Wb / 2 + 20, Math.max(W / 2, W - Wb / 2 - 20)), yN = Hh - 38;
    const g = (s) => (s * (1 + k)) / (1 + k * s), Y = (s) => yN - Hg * g(s), Wd = (s) => Wb / (1 + k * s);
    const pt = (cc, rr) => { const s = (rr - 0.5) / 8; return { x: cx + ((cc - 4.5) / 8) * Wd(s), y: Y(s), s }; };   // cc、rr 为连续格坐标(格中心 = 整数)
    const cell = (r, c) => { const p = pt(c, r), s0 = (r - 1) / 8, s1 = r / 8; return { x: p.x, y: p.y, w: Wd(p.s) / 8, h: Y(s0) - Y(s1), s: p.s }; };
    const up = (s, units) => (units * hu) / (1 + k * s);   // 在深度 s 处,高出地面 units 个"格宽"对应的屏幕像素
    const corners = (r, c) => { const s0 = (r - 1) / 8, s1 = r / 8; const f = (s, cc) => [cx + ((cc - 4.5) / 8) * Wd(s), Y(s)]; return [f(s0, c - 0.5), f(s0, c + 0.5), f(s1, c + 0.5), f(s1, c - 0.5)]; };
    return { W, H: Hh, Wb, k, Hg, hu, cx, yN, Y, Wd, pt, cell, up, corners, left: cx - Wb / 2, right: cx + Wb / 2, top: Y(1) };
  }
  const api = { create, MODES, PRE, LEAD, geometry };
  if (typeof module !== "undefined") module.exports = api;
  root.LPHighwayLib = api;
})(typeof window !== "undefined" ? window : globalThis);
