#!/usr/bin/env node
/* 灯光语言自检 v3(Node,不需要浏览器、不碰硬件)。在 v2 的 A~E 之上,扩展到舞台灯色与"指挥映射"的行为测试。
   A. 静态:所有源码里的颜色常量(#hex / 0xhex / rgb() / GLSL 里的 vec3(r,g,b) 字面量)不得落入引导色相(HSV 0.40~0.55);行内带 guide-ok 的除外。
   B. 色盘:音名色/身份色/和弦色/金色/暖色带(紫粉红橙黄的整条渐变,在显示空间与线性空间两种插值下都采样)不是引导色相。
   C. 引导相位:pad.js 真实逻辑 + 假时钟,引导链 5 个阶段 + 练习课,每帧所有引导键同亮同灭、1 Hz。
   D. 安静模式:引导期间按键只绽放被按的那一个键(盘面);E. 完成仪式(奖励)不含引导色相。
   F. 灯光导演(director.js)行为:F1 安静模式舞台全灭且不响应按键;F2 横扫 → 光浪从左到右;F3 行 → 光束抬升;F4 音名 → 灯色;F5 能量 → 风格档位(且有最短停留);
      F6 频闪 ≤3 次/秒;F7 随机长跑 6000 帧每帧审计灯/雾/屏墙/粒子颜色不含引导色相;F8 减少动效下镜头静止、无强闪;F9 起承转合:低谷后触顶有"落点"(先黑再炸)。
   G. 跟打模式(highway,见 跟打模式-设计.md「跟打例外条款」):G1 光条色(声部色/音名色)不落入引导色相;G2 盘面青绿只出现在"该按的键"(预备常亮),逐帧等于 prep 集合、不出现闪烁暗相、其余键/顶排/右列无引导色相;
      G3 画布录制:屏幕上凡是引导色相的绘制都带 prep 标记(光条/光斑/光柱/浮字/格阵都不含青绿);G4 舞台长跑 6000 帧审计(命中色/追光色/漏拍/完成);G5 命中越准灯越盛、漏拍收敛(可量化)。
   用法: node tools/check_lightlang.js          退出码 0 = 全部通过 */
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm");
const root = path.resolve(__dirname, "..");
let fails = 0;
const ok = (m) => console.log("  通过  " + m), bad = (m) => { fails++; console.log("  失败  " + m); };

function hueChroma(r, g, b) { const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; if (d === 0) return { h: 0, c: 0 }; const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; return { h: ((h / 6) % 1 + 1) % 1, c: d }; }
const isGuideHue = (r, g, b, minC) => { const x = hueChroma(r, g, b); return x.c >= minC && x.h >= 0.40 && x.h <= 0.55; };
const toS = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

/* ---- A. 静态扫描 ---- */
console.log("A. 源码颜色常量扫描(含 GLSL 字面量)");
const files = ["index.html", "style.css", "app.js", "views.js", "pad.js", "stage.js", "director.js", "audio.js", "charts.js", "highway.js", "hwview.js"];
let nColors = 0, nGlsl = 0;
for (const f of files) {
  fs.readFileSync(path.join(root, f), "utf8").split(/\r?\n/).forEach((ln, i) => {
    if (/guide-ok/.test(ln)) return;
    const found = [];
    for (const m of ln.matchAll(/#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g)) { let h = m[1]; if (h.length === 3) h = h.split("").map((c) => c + c).join(""); found.push([parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), m[0]]); }
    for (const m of ln.matchAll(/0x([0-9a-fA-F]{6})\b/g)) { const n = parseInt(m[1], 16); found.push([(n >> 16) & 255, (n >> 8) & 255, n & 255, m[0]]); }
    for (const m of ln.matchAll(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/g)) found.push([+m[1], +m[2], +m[3], m[0]]);
    for (const [r, g, b, txt] of found) { nColors++; if (isGuideHue(r / 255, g / 255, b / 255, 0.10)) bad(f + ":" + (i + 1) + " 颜色 " + txt + " 落在引导色相(青绿)。"); }
    if (f === "stage.js") for (const m of ln.matchAll(/vec3\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)\s*\)/g)) {   // GLSL 里的字面量既按显示值、又按线性值(转 sRGB)各查一次
      const v = [+m[1], +m[2], +m[3]]; if (v.some((x) => x > 1)) continue; nGlsl++;
      if (isGuideHue(v[0], v[1], v[2], 0.10) || isGuideHue(toS(v[0]), toS(v[1]), toS(v[2]), 0.10)) bad("stage.js:" + (i + 1) + " GLSL 常量 " + m[0] + " 落在引导色相");
    }
  });
}
if (!fails) ok("扫描 " + nColors + " 个颜色常量 + " + nGlsl + " 个 GLSL vec3 字面量,没有一个落入引导色相");

/* ---- 装载 pad.js(真实逻辑),假时钟 ---- */
let clock = 1000;
const sandbox = { window: null, performance: { now: () => clock * 1000 }, console, Math, Date, JSON, Object, Array, Map, Set, Number, String, Float32Array, Uint8Array, setTimeout, clearTimeout };
const A = { bandOn: false, drumsOn: false, tonic: 60, noteOn() {}, noteOff() {}, heard() {}, fanfare() {}, ensure() {}, setBandOn(v) { this.bandOn = v; }, setDrumsOn(v) { this.drumsOn = v; }, currentInfo: () => ({ beat: 0, chord: "I", idx: 0, bar: 0 }) };
vm.createContext(sandbox);
function freshCore() {
  const w = { LPAudio: A, addEventListener() {}, innerWidth: 1200 }; sandbox.window = w;
  vm.runInContext(fs.readFileSync(path.join(root, "pad.js"), "utf8"), sandbox, { filename: "pad.js" });
  return w.LPCore;
}
function freshDirector(Core) {
  const w = { LPCore: Core }; sandbox.window = w; sandbox.globalThis = w;
  vm.runInContext(fs.readFileSync(path.join(root, "director.js"), "utf8"), sandbox, { filename: "director.js" });
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  return w.LPDirector.create({ Core, random: rnd });
}
const eq = (a, b) => a && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

/* ---- B. 色盘 ---- */
console.log("B. 色盘 / 身份色 / 和弦色 / 暖色带");
{
  const Core = freshCore(), D = freshDirector(Core); let n = 0;
  for (let r = 1; r <= 8; r++) for (let c = 1; c <= 8; c++) { const x = Core.noteRgb(r, c).map((v) => v / 63); n++; if (isGuideHue(x[0], x[1], x[2], 0.25)) bad("音名色盘 (" + r + "," + c + ") 落入引导色相"); }
  for (const k in Core.IDENT) { const x = Core.IDENT[k].map((v) => v / 63); if (isGuideHue(x[0], x[1], x[2], 0.25)) bad("身份色 " + k + " 落入引导色相"); }
  const g = Core.GOLD.map((v) => v / 63); if (isGuideHue(g[0], g[1], g[2], 0.25)) bad("金色落入引导色相");
  D.CHORD.forEach((c, i) => { if (D.isGuideHue(c, 0.2)) bad("和弦色 " + i); });
  for (let i = 0; i <= 400; i++) {   // 暖色带整条渐变:显示空间 + 线性插值转回 sRGB 两种方式
    const c = D.ramp(i / 400); if (D.isGuideHue(c, 0.1)) { bad("暖色带 x=" + i / 400 + " 显示空间落入引导色相"); break; }
    const f = i / 400 * 4, k = Math.min(3, Math.floor(f)), l = (v) => Math.pow(v, 2.2), m = [0, 1, 2].map((j) => toS(l(D.RAMP[k][j]) * (1 - (f - k)) + l(D.RAMP[k + 1][j]) * (f - k)));
    if (D.isGuideHue(m, 0.1)) { bad("暖色带 x=" + i / 400 + " 线性插值落入引导色相"); break; }
  }
  for (let i = 0; i < 400; i++) { const x = Core.hsv(Core.rainbowHue(i / 400), 0.9, 1).map((v) => v / 63); if (isGuideHue(x[0], x[1], x[2], 0.1)) { bad("彩虹在 x=" + i / 400 + " 落入引导色相"); break; } }
  [D.WARM, D.WHITE].forEach((c, i) => { if (D.isGuideHue(c, 0.1)) bad("暖色/白 " + i); });
  if (!fails) ok(n + " 个音名色 + " + Object.keys(Core.IDENT).length + " 个身份色 + 4 个和弦色 + 金色 + 暖色带(400 点 × 2 种插值)+ 彩虹整段,全部避开青绿");
}

/* ---- C. 引导相位 ---- */
console.log("C. 引导闪烁:全局同相、1 Hz");
function collectGuide(Core, seconds, label) {
  let prev = null, flips = 0, seen = 0, mixed = 0, offGrid = 0;
  for (let i = 0; i < seconds * 50; i++) {
    clock += 0.02; const fr = Core.tick(); let hi = 0, lo = 0;
    for (const k in fr) { if (eq(fr[k], Core.GUIDE)) hi++; else if (eq(fr[k], Core.GUIDE_OFF)) lo++; }
    if (hi + lo === 0) continue; seen++; if (hi && lo) mixed++;
    const st = hi > 0; if (st !== (Math.floor(clock * 2) % 2 === 0)) offGrid++; if (prev !== null && st !== prev) flips++; prev = st;
  }
  return { label, seen, mixed, offGrid, flips, secs: seconds };
}
{
  const Core = freshCore(), results = [];
  results.push(collectGuide(Core, 6, "开场跟弹"));
  const press = (id) => { Core.press(id, true); Core.press(id, false); clock += 0.05; };
  [34, 33, 32, 33, 34, 34, 34].forEach(press); clock += 3; Core.tick(); Core.tick();
  results.push(collectGuide(Core, 6, "阶段1 乐队键")); press(109); results.push(collectGuide(Core, 6, "阶段2 鼓点键"));
  press(108); results.push(collectGuide(Core, 6, "阶段3 换调四键")); press(106); results.push(collectGuide(Core, 6, "阶段4 练习键(自由玩)"));
  Core.startPractice(1); results.push(collectGuide(Core, 6, "练习课"));
  results.forEach((r) => { const exp = r.secs * 2 - 1;
    if (r.seen < 5) bad(r.label + ":没有采到引导帧"); else if (r.mixed) bad(r.label + ":" + r.mixed + " 帧相位不一致"); else if (r.offGrid) bad(r.label + ":" + r.offGrid + " 帧与全局相位不一致");
    else if (r.flips < exp - 2 || r.flips > exp + 2) bad(r.label + ":翻转 " + r.flips + " 次,期望约 " + exp); else ok(r.label + ":" + r.seen + " 帧同相,翻转 " + r.flips + " 次/" + r.secs + " s"); });
}
console.log("D. 安静模式(盘面)");
{
  const Core = freshCore(); Core.lights.flash = {}; Core.press(33, true); Core.press(33, false);
  const n1 = Object.keys(Core.lights.flash).length; n1 === 1 ? ok("引导期间按一个键,只绽放这一个键") : bad("引导期间按键产生 " + n1 + " 处闪光");
  Core.skipGuide(); Core.lights.flash = {}; Core.press(33, true); Core.press(33, false);
  const n2 = Object.keys(Core.lights.flash).length; n2 >= 4 ? ok("自由玩阶段恢复涟漪(" + n2 + " 处)") : bad("自由玩没有涟漪");
}
console.log("E. 完成仪式(奖励)不含引导色相");
{
  const Core = freshCore(); let any = 0, gh = 0;
  [34, 33, 32, 33, 34, 34, 34].forEach((id) => { Core.press(id, true); Core.press(id, false); clock += 0.05; });
  for (let i = 0; i < 100; i++) { clock += 0.02; const fr = Core.tick(); if (!(Core.practice && Core.practice.phase === "done")) continue; any++; for (const k in fr) { const x = fr[k].map((v) => v / 63); if (isGuideHue(x[0], x[1], x[2], 0.1)) gh++; } }
  any < 20 ? bad("没有采到完成仪式的帧") : gh ? bad("完成仪式有 " + gh + " 个格子落在引导色相") : ok("完成仪式 " + any + " 帧 x 80 格,无引导色相");
}

/* ---- F. 灯光导演 ---- */
console.log("F. 灯光导演:指挥映射与灯光语言");
function run(D, seconds, inp, tick) { let t = D.state.t; const n = Math.round(seconds * 60); for (let i = 0; i < n; i++) { t += 1 / 60; if (tick) tick(i, t); D.update(1 / 60, t, typeof inp === "function" ? inp(t) : inp); } return t; }
const base = { level: 0, bands: new Float32Array(16), bandOn: false, drumsOn: false, chordIdx: 0, bar: 0, quiet: false, reduced: false, styleMode: "auto", perf: false, bpm: 100, tonic: 60 };
{ // F1 安静模式
  const Core = freshCore(), D = freshDirector(Core);
  let t = run(D, 1, { ...base, quiet: false });
  for (let i = 1; i <= 8; i++) D.hit(30 + i, 60, t);
  t = run(D, 0.3, { ...base }); const lit = D.rig.lamps.filter((l) => l.inten > 0.3).length;
  t = run(D, 2, { ...base, quiet: true, bandOn: true, drumsOn: true });
  const mx = Math.max(...D.rig.lamps.map((l) => l.inten)), nsp = D.rig.spawn.length;
  D.hit(44, 60, t); D.audioEvent({ kind: "kick" }); t = run(D, 0.3, { ...base, quiet: true });
  const mx2 = Math.max(...D.rig.lamps.map((l) => l.inten));
  lit >= 6 && mx < 0.02 && mx2 < 0.02 && D.rig.fx.flash === 0 ? ok("F1 安静模式:自由玩时 " + lit + " 盏灯亮,进入安静 2 秒后全灭(最大亮度 " + mx.toFixed(3) + "),按键/鼓点不再唤醒舞台") : bad("F1 安静模式未生效:lit=" + lit + " mx=" + mx + " mx2=" + mx2);
}
{ // F2 横扫
  const Core = freshCore(), D = freshDirector(Core); let t = run(D, 4, { ...base, bandOn: true }); const first = new Array(8).fill(null);
  for (let i = 0; i < 8; i++) { const pad = 41 + i; D.hit(pad, 60, t); t = run(D, 0.05, { ...base, bandOn: true }, null); for (let k = 0; k < 8; k++) if (first[k] === null && D.rig.lamps[k].inten > 0.55) first[k] = t; }
  t = run(D, 0.4, { ...base, bandOn: true }, () => { for (let k = 0; k < 8; k++) if (first[k] === null && D.rig.lamps[k].inten > 0.55) first[k] = D.state.t; });
  const okSeq = first.every((x, i) => x !== null && (i === 0 || x >= first[i - 1] - 1e-9));
  okSeq && D.rig.gesture.indexOf("sweep-right") >= 0 ? ok("F2 从左扫到右:第 1~8 盏灯依次点亮(" + first.map((x) => (x - first[0]).toFixed(2)).join(" ") + " s),识别为 sweep-right") : bad("F2 横扫顺序不对 " + JSON.stringify(first) + " gesture=" + D.rig.gesture);
  const D2 = freshDirector(Core); let t2 = run(D2, 4, { ...base }); const f2 = new Array(8).fill(null);
  for (let i = 7; i >= 0; i--) { D2.hit(41 + i, 60, t2); t2 = run(D2, 0.05, { ...base }, null); for (let k = 0; k < 8; k++) if (f2[k] === null && D2.rig.lamps[k].inten > 0.55) f2[k] = t2; }
  const dec = f2.every((x, i) => x !== null && (i === 7 || x >= f2[i + 1] - 1e-9)); dec ? ok("F2 从右扫到左:光浪反向,第 8 → 1 盏依次点亮") : bad("F2 反向扫不对 " + JSON.stringify(f2));
}
{ // F3 行 → 抬升
  const Core = freshCore(), D = freshDirector(Core); let t = run(D, 4, { ...base, bandOn: true });
  D.hit(14, 60, t); t = run(D, 1.0, { ...base, bandOn: true }); const lo = D.rig.lamps[3].dir[1];
  const D2 = freshDirector(Core); let t2 = run(D2, 4, { ...base, bandOn: true }); D2.hit(84, 60, t2); t2 = run(D2, 1.0, { ...base, bandOn: true }); const hi = D2.rig.lamps[3].dir[1];
  hi - lo > 0.8 ? ok("F3 第 1 行 → 光束压向观众席(dir.y=" + lo.toFixed(2) + "),第 8 行 → 冲天(dir.y=" + hi.toFixed(2) + ")") : bad("F3 行→抬升不足 lo=" + lo + " hi=" + hi);
}
{ // F4 音名 → 灯色
  const Core = freshCore(), D = freshDirector(Core); let t = run(D, 4, { ...base }); let all = true, n = 0;
  for (const pad of [11, 22, 33, 44, 55, 66, 77, 18, 87]) { const D1 = freshDirector(Core); let tt = run(D1, 3, { ...base }); D1.hit(pad, 60, tt); tt = run(D1, 0.6, { ...base }); const L = D1.rig.lamps[(pad % 10) - 1].col, nc = Core.noteRgb(Math.floor(pad / 10), pad % 10).map((v) => Math.min(1, Math.pow(v / 63, 0.55))); const d = Math.hypot(L[0] - nc[0], L[1] - nc[1], L[2] - nc[2]); n++; if (d > 0.12) { all = false; bad("F4 pad " + pad + " 灯色偏离音名色 d=" + d.toFixed(2)); } }
  all ? ok("F4 音名 → 光色:" + n + " 个键,灯色与盘面音名色一致(同一个音永远同一种颜色)") : 0;
}
{ // F5 能量 → 风格,最短停留
  const Core = freshCore(), D = freshDirector(Core); const seen = [], changes = [];
  let t = run(D, 6, { ...base }); seen.push(D.rig.styleName); let last = D.rig.styleName, lastT = D.state.styleAt;
  const track = () => { if (D.rig.styleName !== last) { changes.push(D.state.t - lastT); last = D.rig.styleName; lastT = D.state.t; seen.push(last); } };
  t = run(D, 14, { ...base, bandOn: true, drumsOn: true, level: 0.5 }, (i, tt) => { if (i % 6 === 0) D.hit(11 + (i * 7) % 8 + 10 * ((i * 3) % 8), 60, tt); track(); });
  t = run(D, 20, { ...base }, () => track());
  const s3 = new Set(seen).size >= 3, dwell = changes.every((c) => c >= 2.95);
  s3 && dwell ? ok("F5 AI 自动编排:安静期 → " + seen.join(" → ") + ";每档至少停留 " + Math.min(...changes).toFixed(1) + " s") : bad("F5 风格档位 " + seen.join(",") + " 停留 " + changes.map((c) => c.toFixed(1)).join(","));
}
{ // F6 频闪上限
  const Core = freshCore(), D = freshDirector(Core); let t = run(D, 3, { ...base });
  t = run(D, 30, { ...base, bandOn: true, drumsOn: true, level: 0.9, bpm: 180 }, (i, tt) => { if (i % 6 === 0) D.hit(11 + (i * 5) % 8 + 10 * ((i * 3) % 8), 60, tt); if (i % 9 === 0) D.audioEvent({ kind: "kick" }); });
  const log = D.state.flashLog; let worst = 0; for (let i = 0; i < log.length; i++) { let c = 0; for (let j = i; j < log.length && log[j] < log[i] + 1; j++) c++; worst = Math.max(worst, c); }
  worst <= 3 && log.length > 3 ? ok("F6 频闪:30 秒极端输入(180 bpm、底鼓每 0.15 s)下共闪 " + log.length + " 次,任意 1 秒内最多 " + worst + " 次(≤3 Hz,光敏安全线)") : bad("F6 频闪过密 worst=" + worst + " n=" + log.length);
}
{ // F7 长跑审计
  const Core = freshCore(), D = freshDirector(Core); let violations = 0, frames = 0, spawnN = 0; const modes = ["breath", "groove", "burst", "auto"];
  let t = 0;
  for (let s = 0; s < 6; s++) {
    const inp = { ...base, bandOn: s % 2 === 0, drumsOn: s % 3 !== 1, styleMode: modes[s % 4], quiet: s === 4, level: 0.2 + 0.12 * s, chordIdx: s % 4, bands: Float32Array.from({ length: 16 }, (_, i) => (i % 5) / 5) };
    t = run(D, 10, inp, (i, tt) => { if (i % 5 === 0) D.hit(11 + ((i * 13) % 8) + 10 * ((i * 7) % 8), 60, tt); if (i % 20 === 0) D.audioEvent({ kind: ["kick", "hat", "bass", "pad"][(i / 20) % 4 | 0], midi: 48 }); if (i === 300) D.celebrate(tt);
      const v = D.audit(); frames++; violations += v.length; spawnN += D.rig.spawn.length; if (v.length && violations < 4) bad("F7 " + v[0]); });
  }
  violations === 0 ? ok("F7 长跑 " + frames + " 帧(四种风格、乐队开关、安静、完成仪式):灯/雾/屏墙/冲击波/粒子每帧审计,0 处引导色相") : bad("F7 共 " + violations + " 处引导色相");
}
{ // F8 减少动效
  const Core = freshCore(), D = freshDirector(Core); let t = run(D, 2, { ...base, reduced: true }); const pos = []; let flashMax = 0;
  t = run(D, 12, { ...base, reduced: true, bandOn: true, drumsOn: true, level: 0.8 }, (i, tt) => { if (i % 5 === 0) D.hit(11 + ((i * 13) % 8) + 10 * ((i * 7) % 8), 60, tt); if (i % 30 === 0) D.audioEvent({ kind: "kick" }); pos.push(D.rig.cam.pos.slice()); flashMax = Math.max(flashMax, D.rig.fx.flash); });
  const span = Math.max(...pos.map((p) => Math.hypot(p[0] - pos[0][0], p[1] - pos[0][1], p[2] - pos[0][2])));
  span < 1.6 && flashMax <= 0.25 ? ok("F8 减少动效:12 秒极端输入下镜头最大位移 " + span.toFixed(2) + " m(仅慢漂,无推进/晃动),闪光上限 " + flashMax.toFixed(2)) : bad("F8 减少动效不够:span=" + span + " flash=" + flashMax);
}
{ // F9 起承转合:低谷 → 触顶有"落点"
  const Core = freshCore(), D = freshDirector(Core); let t = run(D, 8, { ...base }); let sawBlack = 0, sawFlash = 0;
  t = run(D, 12, { ...base, bandOn: true, drumsOn: true, level: 0.6 }, (i, tt) => { if (i % 4 === 0) D.hit(11 + ((i * 13) % 8) + 10 * ((i * 7) % 8), 60, tt); if (D.rig.fx.blackout > 0.5) sawBlack++; if (D.rig.fx.flash > 0.5) sawFlash++; });
  sawBlack >= 3 && sawBlack <= 12 && sawFlash >= 1 ? ok("F9 落点:低谷后触顶,先黑 " + sawBlack + " 帧(约 " + (sawBlack / 60 * 1000).toFixed(0) + " ms)再炸开(闪光 " + sawFlash + " 帧),区间 = " + D.rig.section) : bad("F9 没有落点 black=" + sawBlack + " flash=" + sawFlash);
}


/* ---- G. 跟打模式 ---- */
console.log("G. 跟打模式(highway):灯光语言『跟打例外条款』");
{
  let vclk = 500;   // 假 ctx.currentTime(秒);performance.now 也跟它走
  const sb = { window: null, document: null, ResizeObserver: class { observe() {} }, performance: { now: () => vclk * 1000 }, console, Math, Date, JSON, Object, Array, Map, Set, Number, String, Float32Array, Uint8Array, setTimeout, clearTimeout, setInterval, clearInterval };
  const recs = [];   // 画布录制:每次设置 fillStyle/strokeStyle/addColorStop 的颜色 + 当时的 lpTag
  const parseRgba = (v) => { const m = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/.exec(String(v)); return m ? [+m[1], +m[2], +m[3]] : null; };
  const rec = (v, tag) => { const c = parseRgba(v); if (c) recs.push({ c, tag: tag || "", v: String(v) }); };
  const ctx2d = new Proxy({ lpTag: "" }, { get(t, k) { if (k in t) return t[k]; if (k === "createLinearGradient" || k === "createRadialGradient") return () => ({ addColorStop(o, c) { rec(c, t.lpTag); } }); if (k === "measureText") return () => ({ width: 0 }); return () => {}; }, set(t, k, v) { t[k] = v; if (k === "fillStyle" || k === "strokeStyle") rec(v, t.lpTag); return true; } });
  const mockEl = () => { const e = { style: {}, dataset: {}, classList: { toggle() {}, add() {}, remove() {} }, hidden: false, className: "", childElementCount: 0, children: [], onclick: null, set innerHTML(v) { this._h = v; this.childElementCount = (String(v).match(/<span/g) || []).length; }, get innerHTML() { return this._h || ""; }, appendChild(c) { return c; }, append() {}, setAttribute() {}, querySelector: () => mockEl(), querySelectorAll: () => [], getBoundingClientRect: () => ({ width: 1440, height: 860, left: 0, right: 1440, top: 0, bottom: 860 }), getContext: () => ctx2d, textContent: "" }; return e; };
  const A = { bandOn: false, drumsOn: false, tonic: 60, noteOn() {}, noteOff() {}, heard() {}, fanfare() {}, ensure() {}, setBandOn() {}, setDrumsOn() {}, now: () => vclk, context: () => ({ currentTime: vclk, state: "running", suspend() {}, resume() {} }), outLatency: () => 0.02, click() {}, drum() {}, voice() { return { release() {} }; }, currentInfo: () => ({ idx: 0, bar: 0 }) };
  const dirLog = [], Stage = { dir: { hit(pad, m, tt, o) { dirLog.push(o); }, miss() {}, spot() {}, audioEvent() {} }, lampPx: Array.from({ length: 14 }, (_, i) => [0.2 + 0.05 * i, 0.12]) };
  sb.window = { LPAudio: A, LPStage: Stage, addEventListener() {}, innerWidth: 1440, devicePixelRatio: 1 }; sb.document = { createElement: mockEl, getElementById: () => null, body: { classList: { toggle() {} } } };
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(root, "pad.js"), "utf8"), sb, { filename: "pad.js" });
  vm.runInContext("var LPCharts = window.LPCharts = window.LPCharts || [];", sb);
  for (const f of ["charts.js", "highway.js"]) vm.runInContext(fs.readFileSync(path.join(root, f), "utf8"), sb, { filename: f });
  sb.window.LPCharts = sb.LPCharts || sb.window.LPCharts; sb.window.LPHighwayLib = sb.window.LPHighwayLib || sb.LPHighwayLib || vm.runInContext("typeof LPHighwayLib !== 'undefined' ? LPHighwayLib : undefined", sb);
  vm.runInContext(fs.readFileSync(path.join(root, "hwview.js"), "utf8"), sb, { filename: "hwview.js" });
  const Core = sb.window.LPCore, H = sb.window.LPHW, V = sb.window.LPHWView;
  V.init(mockEl()); V.resize(); H.set.calib = 0; H.set.mode = "easy";
  const hc = (c63) => { const x = c63.map((v) => v / 63); return isGuideHue(x[0], x[1], x[2], 0.2); };

  // G1 声部色 / 光条色
  H.open(); let nBar = 0, badBar = 0;
  H.layers().forEach((L) => { if (hc(H.layerRgb(L.id))) badBar++; });
  H.notes().concat(H.backing()).forEach((n) => { nBar++; if (hc(H.barRgb(n))) badBar++; });
  for (const rows of [1, 2]) { H.set.rows = rows; H.build(H.chart); H.notes().forEach((n) => { nBar++; if (hc(H.barRgb(n))) badBar++; }); } H.set.rows = 1; H.build(H.chart);
  badBar === 0 ? ok("G1 光条色:4 个声部色 + " + nBar + " 个音(旋律按音名、其余按声部,含两行难度)全部避开青绿") : bad("G1 光条色有 " + badBar + " 处落入引导色相");

  // G2 盘面灯:整首歌(真实判定逻辑 + 自动打手 + 随机漏拍)逐帧检查
  H.set.assist = "full"; H.start(); let frames = 0, guideCells = 0, mismatch = 0, offPhase = 0, strayHue = 0, topGuide = 0, maxSim = 0, contiguousBad = 0; const rows = H.notes().map((n, i) => ({ n, skip: i % 11 === 5, did: false, rel: false })); const lastPrep = new Map();
  const G = Core.GUIDE, GO = Core.GUIDE_OFF, same = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
  for (let i = 0; i < 6000 && H.phase !== "done"; i++) {
    vclk += 0.012; H.update(); H.schedule();
    if (H.phase === "play") { const T = H.judgeT(); for (const r of rows) { if (r.skip) continue; if (!r.did && T >= r.n.t + 0.01) { r.did = true; H.onPad(r.n.pad, true); if (!r.n.hold) r.up = T + 0.03; } if (r.did && r.n.hold && !r.rel && T >= r.n.t + r.n.d) { r.rel = true; H.onPad(r.n.pad, false); } if (r.up && T >= r.up) { r.up = 0; H.onPad(r.n.pad, false); } } }
    const fr = Core.tick(); frames++; const pad = new Set(H.prep().map((n) => n.pad)); let cnt = 0;
    for (const k in fr) { const c = fr[k], isG = same(c, G); if (isG) { cnt++; guideCells++; if (!(+k < 100 && pad.has(+k))) mismatch++; } else if (same(c, GO)) offPhase++; else { const x = c.map((v) => v / 63); if (isGuideHue(x[0], x[1], x[2], 0.1)) strayHue++; } if (+k >= 100 && isG) topGuide++; }
    for (const p of pad) { const c = fr[p]; if (!c || !same(c, G)) mismatch++; }
    maxSim = Math.max(maxSim, cnt);
    for (const n of H.prep()) { const prev = lastPrep.get(n.i); if (prev != null && frames - prev > 1) contiguousBad++; lastPrep.set(n.i, frames); }
  }
  guideCells > 100 && mismatch === 0 && offPhase === 0 && strayHue === 0 && topGuide === 0 ? ok("G2 盘面:整首 " + frames + " 帧(含漏拍、按住、完成),青绿格共 " + guideCells + " 个、最多同时 " + maxSim + " 个,逐帧等于『预备集合』(该按的键),常亮、无闪烁暗相,其余键/顶排/右列无引导色相") : bad("G2 盘面灯违规:mismatch=" + mismatch + " offPhase=" + offPhase + " strayHue=" + strayHue + " topGuide=" + topGuide + " guideCells=" + guideCells);
  contiguousBad === 0 ? ok("G2b 每个预备灯从亮起到命中/漏掉之间连续常亮(不闪)") : bad("G2b 预备灯有 " + contiguousBad + " 次中断");
  if (H.phase !== "done") bad("G2c 没跑到完成"); else { let g = 0; for (let i = 0; i < 80; i++) { vclk += 0.02; const fr = Core.tick(); for (const k in fr) { const x = fr[k].map((v) => v / 63); if (isGuideHue(x[0], x[1], x[2], 0.1)) g++; } } g === 0 ? ok("G2c 完成仪式:盘面暖彩虹 + 金星(沿用奖励效果),80 帧无引导色相") : bad("G2c 完成仪式有 " + g + " 格违规"); }
  H.close();

  // G3 画布录制(三种提示方式 × 多个时刻 × 倒数/按住/完成)
  recs.length = 0; let nFrames = 0;
  for (const view of ["spot", "pillar", "classic"]) {
    H.set.view = view; H.open(); H.set.assist = "full";
    for (let T = -2; T < 49.6; T += 0.41) { H.debugSeek(T, { hold: Math.floor(T * 2) % 2 === 0 }); V.frame(vclk); nFrames++; }
    H.debugUnfreeze(); H.close();
  }
  const guideRecs = recs.filter((r) => isGuideHue(r.c[0] / 255, r.c[1] / 255, r.c[2] / 255, 0.1)), notPrep = guideRecs.filter((r) => r.tag !== "prep");
  notPrep.length === 0 && guideRecs.length > 0 ? ok("G3 画布:录制 " + recs.length + " 次颜色设置(" + nFrames + " 帧 × 追光/光柱/经典),其中引导色相只有 " + guideRecs.length + " 次,且全部是『该按的格』预备描边(prep 标记)") : bad("G3 画布有 " + notPrep.length + " 次非 prep 的引导色相,如 " + (notPrep[0] && notPrep[0].v) + "; guideRecs=" + guideRecs.length);
  H.set.view = "spot";

  // G4 舞台:跟打驱动下的长跑审计(命中色 = 声部色,追光色 = 声部色)
  { const D = freshDirector(Core); let viol = 0, fr2 = 0, t = 0; const lcol = (n) => H.dispRgb(H.barRgb(n)); H.open(); const ns = H.notes();
    for (let i = 0; i < 6000; i++) { t += 1 / 60; const e = 0.5 + 0.45 * Math.sin(i / 300); const inp = { ...base, bandOn: i % 900 < 600, drumsOn: true, quiet: false, hw: { energy: e }, chordIdx: (i / 120 | 0) % 4, bar: i / 120 | 0, bpm: 120 };
      if (i % 9 === 0) { const n = ns[(i / 9 | 0) % ns.length]; D.hit(n.pad, 0, t, { col: lcol(n), gain: 0.78 + 0.22 * (i % 2) }); }
      if (i % 7 === 0) { const n = ns[(i / 7 | 0) % ns.length]; D.spot(n.lamp >= 0 ? n.lamp : n.c - 1, 0.8, lcol(n), (n.r - 1) / 7); }
      if (i % 250 === 0) D.miss(); if (i === 3000) D.celebrate(t);
      D.update(1 / 60, t, inp); const v = D.audit(); fr2++; viol += v.length; if (v.length && viol < 4) bad("G4 " + v[0]); }
    viol === 0 ? ok("G4 舞台长跑 " + fr2 + " 帧(命中色=声部色、追光、漏拍、完成仪式):灯/雾/屏墙/冲击波/粒子每帧审计,0 处引导色相") : bad("G4 共 " + viol + " 处引导色相"); H.close(); }

  // G5 命中驱动:命中越准灯越盛,漏拍收敛
  { const sumI = (D) => D.rig.lamps.reduce((a, l) => a + l.inten, 0);
    const runE = (e) => { const D = freshDirector(Core); let t = 0, acc = 0, n = 0; for (let i = 0; i < 60 * 6; i++) { t += 1 / 60; if (i % 14 === 0) D.hit(11 + (i / 14 | 0) % 8 + 10 * ((i / 14 | 0) % 4), 0, t, { gain: 1 }); D.update(1 / 60, t, { ...base, quiet: false, hw: { energy: e }, drumsOn: true }); if (i > 180) { acc += sumI(D); n++; } } return acc / n; };
    const lo = runE(0.12), hi = runE(0.85); hi > lo * 1.4 ? ok("G5 命中越准/连击越高灯越盛:灯总亮度 能量 0.12 → " + lo.toFixed(2) + ",能量 0.85 → " + hi.toFixed(2) + "(×" + (hi / lo).toFixed(1) + ")") : bad("G5 能量对灯光驱动不足 lo=" + lo + " hi=" + hi);
    const D = freshDirector(Core); let t = 0, before = 0, after = 0, rec2 = 0; for (let i = 0; i < 60 * 8; i++) { t += 1 / 60; if (i % 10 === 0) D.hit(11 + (i / 10 | 0) % 8, 0, t, { gain: 1 }); if (i === 300) { before = sumI(D); D.miss(); } D.update(1 / 60, t, { ...base, quiet: false, hw: { energy: 0.4 }, drumsOn: true }); if (i === 318) after = sumI(D); if (i === 470) rec2 = sumI(D); }
    after < before * 0.78 && rec2 > before * 0.8 ? ok("G5b 漏拍收敛:漏一拍后 0.3 秒内灯总亮度 " + before.toFixed(2) + " → " + after.toFixed(2) + "(-" + Math.round((1 - after / before) * 100) + "%),约 2.5 秒后恢复到 " + rec2.toFixed(2)) : bad("G5b 漏拍收敛不对 before=" + before + " after=" + after + " rec=" + rec2); }
}

console.log(fails ? "\n灯光语言自检:失败 " + fails + " 项" : "\n灯光语言自检:全部通过");
process.exit(fails ? 1 : 0);
