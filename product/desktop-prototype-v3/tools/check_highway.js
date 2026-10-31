#!/usr/bin/env node
/* 跟打模式 逻辑自检(Node,假时钟,不需要浏览器/音频/硬件):判定窗、按住时长评分、连击/准确率/星级、声部锁定与"没打到就静默"、预备灯、校准、两行难度。
   与 check_lightlang.js(灯光语言)、headless_highway.mjs(真浏览器整流程)互补。 用法: node tools/check_highway.js */
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm");
const root = path.resolve(__dirname, "..");
let fails = 0; const ok = (m) => console.log("  通过  " + m), bad = (m) => { fails++; console.log("  失败  " + m); }, t = (c, m, d) => (c ? ok(m) : bad(m + (d ? "  " + d : "")));

let clk = 100;   // 假的 ctx.currentTime
const sandbox = { window: null, performance: { now: () => clk * 1000 }, console, Math, Date, JSON, Object, Array, Map, Set, Number, String, Float32Array, Uint8Array, setTimeout, clearTimeout, setInterval, clearInterval };
vm.createContext(sandbox);
function setup(opts) {
  opts = opts || {};
  const Alog = [], A = { bandOn: false, drumsOn: false, tonic: 60, noteOn() {}, noteOff() {}, heard() {}, fanfare() {}, ensure() {}, setBandOn() {}, setDrumsOn() {}, currentInfo: () => ({ beat: 0, chord: "I", idx: 0, bar: 0 }),
    context: () => ({ currentTime: clk, state: "running", suspend() {}, resume() {} }), outLatency: () => 0.02, click() {}, drum(k, at) { Alog.push({ k, at, kind: "drum" }); }, voice(kind, midi, at, g, hold) { const v = { kind, midi, at, released: null, release(x) { v.released = x; } }; Alog.push(v); return v; } };
  sandbox.window = { LPAudio: A, addEventListener() {}, innerWidth: 1200 };
  vm.runInContext(fs.readFileSync(path.join(root, "pad.js"), "utf8"), sandbox, { filename: "pad.js" });
  const Core = sandbox.window.LPCore;
  delete require.cache[require.resolve("../charts.js")]; delete globalThis.LPCharts;
  const chart = require("../charts.js");
  const lib = require("../highway.js"), mem = Object.assign({}, opts.mem || {});
  const dirLog = { hits: [], misses: 0 }, dir = { hit: (pad, m, tt, o) => dirLog.hits.push({ pad, o }), miss: () => dirLog.misses++, audioEvent() {} };
  const H = lib.create({ Core, A, charts: [chart], dir, clock: { now: () => clk, out: () => 0.02, perf: () => clk }, store: { load: (k, d) => (k in mem ? mem[k] : d), save: (k, v) => (mem[k] = v) } });
  return { H, A, Core, Alog, chart, dirLog, lib };
}
/* 自动打手:plan(n) → {err(秒), skip, rel(松开偏差秒)};按 judge 时间触发,步进 5 ms */
function runPlayer(E, plan, until) {
  const { H } = E; H.open(); if (plan.setup) plan.setup(H); H.start();
  const rows = H.notes().map((n) => ({ n, p: plan.of(n) || {}, did: false, rel: false }));
  let guard = 0;
  while (H.phase !== "done" && guard++ < 40000) {
    clk += 0.005; H.update(); H.schedule();
    if (H.phase === "play") {
      const T = H.judgeT();
      for (const r of rows) {
        if (r.p.skip) continue;
        if (!r.did && T >= r.n.t + (r.p.err || 0)) { r.did = true; if (plan.lane) H.laneKey(r.n.c, true); else H.onPad(r.p.pad || r.n.pad, true); if (!r.n.hold && !plan.noTapUp) r.up = T + 0.04; }
        if (r.did && r.n.hold && !r.rel && T >= r.n.t + r.n.d + (r.p.rel || 0)) { r.rel = true; if (plan.lane) H.laneKey(r.n.c, false); else H.onPad(r.p.pad || r.n.pad, false); }
        if (r.up && T >= r.up) { r.up = 0; if (plan.lane) H.laneKey(r.n.c, false); else H.onPad(r.p.pad || r.n.pad, false); }
      }
    }
    if (until && until(H)) return;
  }
  return guard < 40000;
}

console.log("A. 谱面结构");
{
  const E = setup(), c = E.chart; E.H.open(); const play = E.H.notes();
  t(c.layers.length === 4 && c.sections.length === 4, "4 个声部、4 个段:" + c.layers.map((l) => l.name).join(" → "));
  const dur = (c.endBeat * 60) / c.bpm; t(dur >= 44 && dur <= 62, "歌曲时长 " + dur.toFixed(0) + " 秒(含倒数约 " + (dur + 2).toFixed(0) + ")");
  let gapOk = true; c.sections.forEach((s, i) => { const last = Math.max(...play.filter((n) => n.li === i).map((n) => n.tb + n.d / E.H.spb())); if (last > s.b1 - 1 + 1e-6) gapOk = false; });
  t(gapOk, "每个玩家段的最后一个音在段尾前 1 拍结束(给判定与锁定决策留空档)");
  const same = {}; let dup = 0; play.forEach((n) => { const k = n.layer + ":" + n.tb; if (same[k]) dup++; same[k] = 1; }); t(dup === 0, "同一声部同一时刻只有一个音");
  const pads = new Set(play.map((n) => n.pad)); t([...pads].every((p) => p >= 11 && p <= 88), "所有键都在 8x8 网格内(" + pads.size + " 个不同的键)");
  const rowsOf = {}; play.forEach((n) => ((rowsOf[n.layer] = rowsOf[n.layer] || new Set()).add(n.r))); t(["drums", "bass", "chords", "melody"].every((k, i) => rowsOf[k].size === 1 && rowsOf[k].has(i + 1)), "入门:一个声部一行(鼓=1、贝斯=2、和弦=3、旋律=4)——『行 = 声部,列 = 轨道』");
  const byPad = {}; let minGap = 9, simul = 0; play.forEach((n) => { const q = byPad[n.pad]; if (q) minGap = Math.min(minGap, n.tb - (q.tb + q.d / E.H.spb())); byPad[n.pad] = n; });
  t(minGap >= 0.25 - 1e-9, "R3 同一个键相邻两个音之间至少空 0.25 拍(最小 " + minGap.toFixed(2) + " 拍,手指要能抬起来再按)");
  play.forEach((n) => { const k = play.filter((m) => m.tb <= n.tb + 1e-6 && m.tb + m.d / E.H.spb() > n.tb + 1e-6).length; simul = Math.max(simul, k); }); t(simul <= 2, "R5 同一时刻最多 " + simul + " 个光条(≤ 2)");
  t(c.sections.every((s, i) => play.filter((n) => n.li === i).length <= 40), "R6 每段音符数 " + c.sections.map((s, i) => play.filter((n) => n.li === i).length).join(" / ") + "(≤ 40)");
  const hold = play.filter((n) => n.hold).length; t(hold >= 20, "按住类光条 " + hold + " 个 / 短点 " + (play.length - hold) + " 个,共 " + play.length + " 个要打的音");
  const E2 = setup({ mem: { "lp3.hw.settings": { rows: 2 } } }); E2.H.open(); const r5 = E2.H.notes().filter((n) => n.r === 5).length; t(r5 >= 8, "进阶『两行』:旋律中 " + r5 + " 个音改按第 5 行同音的键");
}

console.log("B. 判定窗(轻松 / 严格)与分级");
{
  const g = (mode, err) => { const E = setup({ mem: { "lp3.hw.settings": { mode, calib: 0 } } }); runPlayer(E, { of: (n) => (n.layer === "drums" ? { err } : { skip: true }) }); return E.H.S.res; };
  let r = g("easy", 0); t(r.P === 36 && r.G === 0 && r.stars === 3 || r.P >= 34, "轻松:准点 → 全部『完美』(" + r.P + ")");
  r = g("easy", 0.12); t(r.G >= 30 && r.P === 0, "轻松:晚 120 ms → 『不错』(" + r.G + "),不算漏");
  r = g("easy", 0.25); t(r.M >= 34, "轻松:晚 250 ms → 超出时间窗,漏拍(" + r.M + ")");
  r = g("strict", 0.12); t(r.M >= 34 && r.G === 0, "严格:晚 120 ms → 漏拍(" + r.M + ")");
  r = g("strict", 0.07); t(r.G >= 30, "严格:晚 70 ms → 不错(" + r.G + ")");
  r = g("strict", -0.03); t(r.P >= 30, "严格:早 30 ms → 完美(" + r.P + ")");
}

console.log("C. 按住时长(松开时机)与按下分开计");
{
  const f = (rel) => { const E = setup({ mem: { "lp3.hw.settings": { mode: "easy", calib: 0 } } }); runPlayer(E, { of: (n) => (n.layer === "bass" ? { rel } : n.layer === "drums" ? { skip: true } : { skip: true }) }, null); return E.H.S.secScore[1]; };
  let r = f(0); t(r.n > 0 && r.pressAcc > 0.95 && r.holdAcc > 0.95 && r.hP >= 10, "按下准、松得准:按下 " + (r.pressAcc * 100).toFixed(0) + "%,按住 " + (r.holdAcc * 100).toFixed(0) + "% (松得准 " + r.hP + ")");
  r = f(-0.4); t(r.pressAcc > 0.95 && r.holdAcc < 0.5 && r.hB >= 10, "按下准、但每次都早松 0.4 s:按下 " + (r.pressAcc * 100).toFixed(0) + "% 不受影响,按住只有 " + (r.holdAcc * 100).toFixed(0) + "%");
  r = f(0.6); t(r.pressAcc > 0.95 && r.holdAcc < 0.6 && r.hB >= 5, "每次都拖 0.6 s 才松:按住 " + (r.holdAcc * 100).toFixed(0) + "%");
  r = f(0.2); t(r.hG >= 10 && r.hP === 0, "松晚 0.2 s:『松得还行』" + r.hG + " 个");
}

console.log("D. 声部锁定与分层出声(没打到就静默)");
{
  const E = setup({ mem: { "lp3.hw.settings": { mode: "easy", calib: 0 } } });
  runPlayer(E, { of: () => ({ err: 0.01 }) }); const S = E.H.S, log = S.log;
  t(["drums", "bass", "chords", "melody"].every((k) => S.locked[k]) && S.res.stars === 3, "四层都打好:全部锁定,3 星,最高连击 " + S.res.maxCombo);
  const first = (l, src) => Math.min(...log.filter((e) => e.layer === l && e.src === src).map((e) => e.at));
  t(first("drums", "user") < 1 && first("drums", "auto") >= 11.95, "鼓:第 1 段由用户打出(" + first("drums", "user").toFixed(2) + " s 起),第 2 段起乐队接力(" + first("drums", "auto").toFixed(2) + " s 起)");
  t(first("bass", "user") >= 11.95 && first("bass", "auto") >= 23.95 && first("chords", "auto") >= 35.95, "贝斯 / 和弦的接力分别从第 3 / 第 4 段开始");
  t(!log.some((e) => e.layer === "melody" && e.src === "auto"), "最后一层(旋律)没有自动回放,只有用户出声");
  t(!log.some((e) => e.at < 11.95 && e.layer !== "drums"), "第 1 段里只有鼓的声音(还没打到的层是静默的)");
  const E2 = setup({ mem: { "lp3.hw.settings": { mode: "easy", calib: 0 } } }); runPlayer(E2, { of: (n) => (n.layer === "bass" ? { skip: true } : { err: 0.01 }) });
  const l2 = E2.H.S.log; t(E2.H.S.locked.bass === false && !l2.some((e) => e.layer === "bass") && E2.H.S.locked.drums && E2.H.S.locked.melody, "整层不打(贝斯):它没被锁定、全曲没有贝斯声,其余层不受影响");
  const E3 = setup({ mem: { "lp3.hw.settings": { mode: "strict", calib: 0 } } }); runPlayer(E3, { of: (n) => (n.layer === "drums" ? (n.tb % 4 < 2 ? { err: 0.01 } : { skip: true }) : { skip: true }) });
  t(E3.H.S.secScore[0].acc < 0.7 && E3.H.S.locked.drums === false, "严格档只打对一半(准确率 " + (E3.H.S.secScore[0].acc * 100).toFixed(0) + "%):没达到 70%,鼓没叠上");
  const E4 = setup({ mem: { "lp3.hw.settings": { mode: "easy", calib: 0 } } }); runPlayer(E4, { of: (n) => (n.layer === "drums" ? (n.tb % 4 < 2.5 ? { err: 0.01 } : { skip: true }) : { skip: true }) });
  t(E4.H.S.secScore[0].acc >= 0.5 && E4.H.S.locked.drums === true, "轻松档打对约 " + (E4.H.S.secScore[0].acc * 100).toFixed(0) + "%:达到 50%,鼓叠上");
}

console.log("E. 连击、杂键、列键、灯光导演联动");
{
  const E = setup({ mem: { "lp3.hw.settings": { mode: "easy", calib: 0 } } }); const H = E.H;
  runPlayer(E, { of: (n) => (n.layer === "drums" ? (n.i % 7 === 3 ? { skip: true } : { err: 0 }) : { skip: true }) }); const r = H.S.res;
  t(r.maxCombo > 0 && r.maxCombo < 36, "漏拍会断连击:最高连击 " + r.maxCombo + " < 36");
  t(E.dirLog.misses >= 4 && E.dirLog.hits.length >= 25, "命中交给舞台灯 " + E.dirLog.hits.length + " 次(带声部色与 gain)、漏拍通知 " + E.dirLog.misses + " 次");
  t(E.dirLog.hits.every((h) => h.o && h.o.col && h.o.gain > 0), "每次命中都带声部色(display 空间)与命中质量");
  const E2 = setup({ mem: { "lp3.hw.settings": { mode: "easy", calib: 0 } } }); runPlayer(E2, { lane: true, of: () => ({ err: 0 }) });
  t(E2.H.S.locked.melody === true && E2.H.S.res.stars === 3, "键盘列键(不分行)也能打完整首:3 星");
  const E3 = setup({ mem: { "lp3.hw.settings": { mode: "easy", calib: 0 } } }); runPlayer(E3, { of: (n) => (n.layer === "drums" ? { err: 0, pad: n.pad + 10 } : { skip: true }) });
  t(E3.H.S.res.M >= 34 && E3.H.S.strays >= 34, "按错行(同一列的另一行):不算命中,静默(杂键 " + E3.H.S.strays + " 次),没有任何出声记录");
  t(!E3.H.S.log.some((e) => e.src === "user"), "没打对:用户没有出声(不是随便按就有声)");
}

console.log("F. 预备灯与亮灯提示自动淡出");
{
  const E = setup({ mem: { "lp3.hw.settings": { mode: "easy", calib: 0, assist: "full" } } }), H = E.H; H.open(); H.debugSeek(3.0, {}); const kick = H.notes().find((n) => n.tb === 8);
  H.debugSeek(kick.t - 0.3, {}); const a = H.prep().map((n) => n.pad); t(a.includes(kick.pad), "光条到达前 0.3 s:目标键进入预备(青绿常亮)");
  H.debugSeek(kick.t - 0.55, {}); t(!H.prep().some((n) => n === kick), "光条还在 0.55 s 外:不亮(预备窗 " + E.lib.PRE + " s)");
  const E2 = setup({ mem: { "lp3.hw.settings": { mode: "easy", calib: 0, assist: "bars" } } }); E2.H.open(); E2.H.debugSeek(5, {});
  const k2 = E2.H.notes().filter((n) => n.layer === "drums" && n.tb >= 12 && n.tb < 16); E2.H.debugSeek(k2[0].t - 0.1, {}); const lead = E2.H.prep().length; E2.H.debugSeek(k2[2].t - 0.1, {}); const nonlead = E2.H.prep().length;
  t(lead >= 1 && nonlead === 0, "『只亮每小节第一个』:小节首音亮、其余不亮");
  const E3 = setup({ mem: { "lp3.hw.settings": { mode: "easy", calib: 0, assist: "auto" } } }); runPlayer(E3, { of: () => ({ err: 0.005 }) });
  const ev = E3.H.events.filter((e) => e.assist); t(ev.length >= 2 && ev[0].assist === "bars" && ev[1].assist === "off", "自动淡出:打得稳(≥85%)后 全部亮灯 → 只亮小节首 → 不亮灯(" + ev.map((e) => e.assist).join(" → ") + ")");
  const E4 = setup({ mem: { "lp3.hw.settings": { mode: "easy", calib: 0, assist: "off" } } }); E4.H.open(); E4.H.debugSeek(kick.t - 0.2, {}); t(E4.H.prep().length === 0, "选『不亮』:盘面没有任何预备灯");
}

console.log("G. 校准");
{
  const E = setup({ mem: { "lp3.hw.settings": { calib: 0 } } }), H = E.H; H.open(); H.calibrate(); const c = H.S.cal;
  const hit = new Set();
  for (let i = 0; i < 4000 && !c.done; i++) { clk += 0.005; const heard = clk - 0.02; c.beats.forEach((b, k) => { if (!hit.has(k) && heard >= b + 0.07 + (k % 3) * 0.004) { hit.add(k); H.onPad(44, true); H.onPad(44, false); } }); if (clk > c.beats[c.beats.length - 1] + 0.5) { H.finishCal && H.finishCal(); break; } }
  t(Math.abs(H.set.calib - 0.07) < 0.012, "按得比节拍晚约 70 ms:校准结果 +" + Math.round(H.set.calib * 1000) + " ms,已保存");
}

console.log("H. 同时多个光条的追光分配(合成数据)");
{
  const E = setup(), H = E.H, mk = (t, pad) => ({ t, d: 1, layer: "melody", pad, v: { k: "lead", m: 80 } });
  const c = { format: "lp-chart/1", id: "t", title: "t", bpm: 120, meter: [4, 4], key: {}, countIn: 4, endBeat: 24, layers: [{ id: "melody", name: "旋律", hue: 0.14, section: 0, row: 4 }], sections: [{ id: "s", name: "旋律", layer: "melody", b0: 0, b1: 24 }],
    notes: [mk(2, 43), mk(2, 53), mk(2, 45), mk(2, 47), mk(8, 43), mk(8.5, 44)] };
  H.build(c); const ns = H.notes(); const at2 = ns.filter((n) => n.tb === 2);
  t(new Set(at2.map((n) => n.lamp)).size === 4 && at2.every((n) => n.lamp >= 0), "同一时刻 4 个光条(含同一列的两个不同行)分到 4 盏不同的灯(" + at2.map((n) => n.pad + "→灯" + n.lamp).join(",") + ")");
  const first = at2.find((n) => n.pad === 43); t(first.lamp === 2, "优先用所在列的那盏灯(第 3 列 → 灯 2),冲突者借后排/地面灯");
  const later = ns.filter((n) => n.tb >= 8); t(later[0].lamp === 2 && later[1].lamp === 3, "之后没有冲突时回到各自列的灯(第 3、4 列 → 灯 2、3)");
}

console.log(fails ? "\n跟打逻辑自检:失败 " + fails + " 项" : "\n跟打逻辑自检:全部通过");
process.exit(fails ? 1 : 0);
