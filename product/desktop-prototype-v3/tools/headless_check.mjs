// 无头 Chrome(file://)全流程自检 v3:加载 → 安静模式 → 引导链 → 自由玩(呼吸/律动/爆发)→ 指挥手势 → 完成仪式 → 表演 → 抽屉各页 → 窄屏/减少动效/无 WebGL。
// 截图存 tools/shots/;统计控制台错误;灯光语言运行时审计(灯色 + 渲染出来的像素);同步基准测帧耗时。需要 Node 22 与 Chrome/Edge。
// 用法: node tools/headless_check.mjs [--gpu] [--only=quick]
//   --gpu : 用本机显卡(ANGLE/D3D11),不带则 SwiftShader 软渲染(最坏情形)
import { spawn } from "node:child_process";
import { mkdirSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const GPU = process.argv.includes("--gpu"), QUICK = process.argv.includes("--only=quick"), DGPU = process.argv.includes("--dgpu");
const LABEL = !GPU ? "swiftshader" : DGPU ? "dgpu-quadro" : "igpu-uhd630";
const shots = path.join(here, !GPU ? "shots-soft" : DGPU ? "shots" : "shots-igpu");
mkdirSync(shots, { recursive: true });
const CHROMES = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"];
const chrome = CHROMES.find(existsSync);
if (!chrome) { console.error("找不到 Chrome/Edge"); process.exit(2); }
const port = 9300 + Math.floor(Math.random() * 500);
const prof = path.join(here, ".prof-" + port);
const args = ["--headless=new", "--remote-debugging-port=" + port, "--user-data-dir=" + prof, "--no-first-run", "--no-default-browser-check",
  "--autoplay-policy=no-user-gesture-required", "--ignore-gpu-blocklist", "--hide-scrollbars", ...(GPU ? ["--use-angle=d3d11", "--enable-gpu-rasterization", ...(DGPU ? ["--force_high_performance_gpu"] : ["--force_low_power_gpu"])] : ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"]), "about:blank"];
const proc = spawn(chrome, args, { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getWs() {
  for (let i = 0; i < 60; i++) { try { const l = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); const p = l.find((x) => x.type === "page"); if (p) return p.webSocketDebuggerUrl; } catch (e) { /* 等启动 */ } await sleep(250); }
  throw new Error("Chrome 未启动");
}
const ws = new WebSocket(await getWs());
await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map(); const errors = []; const warns = [];
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); return; }
  if (d.method === "Runtime.exceptionThrown") errors.push("exception: " + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text));
  if (d.method === "Runtime.consoleAPICalled" && ["error", "assert"].includes(d.params.type)) errors.push("console." + d.params.type + ": " + d.params.args.map((a) => a.value ?? a.description).join(" "));
  if (d.method === "Runtime.consoleAPICalled" && d.params.type === "warning") warns.push(d.params.args.map((a) => a.value ?? a.description).join(" ").slice(0, 300));
  if (d.method === "Log.entryAdded" && d.params.entry.level === "error") errors.push("log.error: " + d.params.entry.text + " " + (d.params.entry.url || ""));
};
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, (d) => (d.error ? rej(new Error(method + ": " + d.error.message)) : res(d.result))); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error("evaluate 失败: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text)); return r.result.value; };
const view = (w, h) => send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
async function shot(name) { const r = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(path.join(shots, name + ".png"), Buffer.from(r.data, "base64")); console.log("  截图 " + name + ".png"); }
await send("Page.enable"); await send("Runtime.enable"); await send("Log.enable");
const url = (q = "") => pathToFileURL(path.join(root, "index.html")).href + q;
async function open(q, w = 1440, h = 860, extra = {}) {
  await view(w, h);
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: extra.reducedMotion ? "reduce" : "no-preference" }] });
  await send("Page.navigate", { url: url(q + (DGPU ? (q.includes("?") ? "&" : "?") + "gpu=high" : "")) });
  for (let i = 0; i < 80; i++) { await sleep(250); const r = await send("Runtime.evaluate", { expression: "typeof window.__lp", returnByValue: true }); if (r.result.value === "object") break; }
  await ev(`window.__demo = {
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    async tap(p, ms = 50) { __lp.Core.press(p, true); await this.sleep(ms); __lp.Core.press(p, false); },
    async sweep(row, from, to, gap = 45) { const s = from < to ? 1 : -1; for (let c = from; c !== to + s; c += s) { await this.tap(row * 10 + c, 30); await this.sleep(gap); } },
    async dense(ms, rate = 9) { const t0 = performance.now(); let i = 0; while (performance.now() - t0 < ms) { const k = i++ % 6; if (k === 5) await this.sweep(1 + (i % 8), 1, 8, 40); else if (k === 4) await this.sweep(2 + (i % 6), 8, 1, 40); else await this.tap((1 + ((i * 3) % 8)) * 10 + 1 + ((i * 5) % 8), 40); await this.sleep(1000 / rate); } },
    async chain() { for (const p of [34, 33, 32, 33, 34, 34, 34]) await this.tap(p, 60); }
  }`);
  await sleep(extra.settle ?? 900);
}
const report = {};
const pxAudit = async (label, ms = 2500) => {
  await ev("(()=>{const S=__lp.Stage; S.auditLog.violations=0; S.auditLog.frames=0; S.auditLog.pixel=0; S.auditLog.pixelFrames=0; S.auditLog.worst=[]; S.setAudit(true)})()");
  await sleep(ms);
  const r = await ev("(()=>{const S=__lp.Stage; S.setAudit(false); return {violations:S.auditLog.violations, frames:S.auditLog.frames, pixelBad:S.auditLog.pixel, pixelFrames:S.auditLog.pixelFrames, worst:S.auditLog.worst}})()");
  (report.audit ||= {})[label] = r; return r;
};

console.log("== 1. 安静模式(新手引导期间):舞台只留氛围光");
await open("?quality=" + (GPU ? "high" : "auto") + (GPU ? "&capture=1" : ""));
report.gpu = await ev("__lp.Stage.gpu"); report.mode = await ev("__lp.Stage.mode"); report.reason = await ev("__lp.Stage.reason");
report.hdr = await ev("!!__lp.Stage.hdr");
await sleep(1200); await shot("01-quiet-start");
await sleep(500); await shot("02-quiet-guide-blink-b");
await ev("__lp.Core.press(1,true)");   // 无效键,确保不报错
await ev("__demo.tap(11)"); await ev("__demo.tap(12)"); await sleep(500);
report.quietInfo = await ev("JSON.stringify({q:__lp.Core.quiet(), style:__lp.Stage.rig().styleName, lampsOn:__lp.Stage.rig().lamps.filter(l=>l.inten>0.02).length})");
await pxAudit("quiet", 1800);
if (QUICK) { console.log(JSON.stringify(report, null, 1)); console.log("控制台错误数:", errors.length, errors.slice(0, 8)); ws.close(); proc.kill(); process.exit(errors.length ? 1 : 0); }

console.log("== 2. 走完引导链(每一步仍安静)");
await ev("__demo.chain()"); await sleep(350); await shot("03-ceremony-warm-rainbow-gold");
await pxAudit("ceremony", 1500);
await sleep(2400);
await ev("__lp.Core.press(109,true)"); await sleep(250); await shot("04-guide-step2-quiet");
await ev("__lp.Core.press(108,true)"); await sleep(250); await ev("__lp.Core.press(106,true)"); await sleep(600);
report.guideStage = await ev("__lp.Core.guide.stage");

console.log("== 3. 自由玩:单键点亮对应的灯(呼吸档)");
await ev("__lp.Core.press(109,true); __lp.Core.press(108,true)");   // 关掉乐队与鼓点,回到只有手
await sleep(700);
await ev("__lp.Stage.setOptions({styleMode:'breath'})");
await ev("__demo.tap(32,90)"); await ev("__demo.tap(57,90)"); await sleep(160); await shot("05-breath-two-notes-col2-col7");
await ev("__lp.Stage.setOptions({styleMode:'auto'})");

console.log("== 4. 手势:从左扫到右,光浪跟着扫过去(连拍两帧)");
await ev("__demo.sweep(3,1,8,38)"); await sleep(80); await shot("06-sweep-left-to-right-a");
await sleep(180); await shot("06b-sweep-left-to-right-b");
report.gesture = await ev("__lp.Stage.rig().gesture");
await sleep(900);

console.log("== 5. 乐队 + 鼓点 + 密集弹奏:律动 → 爆发(高潮)");
await ev("__lp.Core.press(109,true); __lp.Core.press(108,true)");
await ev("__demo.dense(5500, 8)"); await shot("07-groove-or-burst-after-5s");
await ev("__demo.dense(7000, 10)"); await shot("08-climax-burst");
report.rigClimax = await ev("(()=>{const r=__lp.Stage.rig(); return JSON.stringify({style:r.styleName, section:r.section, energy:+r.energy.toFixed(2), lamps:r.lamps.filter(l=>l.inten>0.05).length, info:__lp.Stage.info()})})()");
await pxAudit("climax", 3000);
await ev("__demo.dense(2500, 10)"); await shot("09-climax-burst-b");
console.log("== 5b. 回落:留白(乐队与鼓点停下,只剩余晖)");
await ev("__lp.Core.press(109,true); __lp.Core.press(108,true)"); await sleep(1800); await shot("10a-afterglow-1s"); await sleep(5500); await shot("10-afterglow-break");
report.rigAfter = await ev("(()=>{const r=__lp.Stage.rig(); return JSON.stringify({style:r.styleName, section:r.section, energy:+r.energy.toFixed(2)})})()");

console.log("== 6. 录制分享(webm)");
await ev("document.querySelector('#recBtn').click()"); await sleep(400); await ev("__demo.dense(3500, 8)"); await sleep(300);
await ev("document.querySelector('#recBtn').click()"); await sleep(1500);
report.rec = await ev("JSON.stringify(__lp.lastRec||null)");

console.log("== 7. 练习课:安静模式 + 完成仪式(金星)");
await ev("__lp.Core.press(109,true); __lp.Core.press(108,true); __lp.Core.startPractice(0)"); await sleep(1800); await shot("11-practice-quiet");
await ev("__demo.chain()"); await sleep(450); await shot("12-practice-ceremony");
await ev("__lp.Core.stopPractice()"); await sleep(300);

console.log("== 8. 表演模式");
await ev("__lp.setPerf(true)"); await sleep(500); await ev("__demo.dense(4000, 9)"); await shot("13-perf-mode");
await ev("__lp.setPerf(false)"); await sleep(300);

console.log("== 9. 抽屉:课程 / 乐队 / 教练 / 成歌 / 作品 / 设置");
for (const [n, nm] of [["lessons", "14-drawer-lessons"], ["band", "15-drawer-band"], ["coach", "16-drawer-coach"], ["gen", "17-drawer-gen"], ["library", "18-drawer-library"], ["settings", "19-drawer-settings"]]) { await ev(`__lp.openTab('${n}')`); await sleep(350); await shot(nm); }
await ev("document.querySelector('#audit').click()"); await sleep(3500); report.settingsAudit = await ev("document.querySelector('#auditT').textContent + ' | ' + document.querySelector('#auditS').textContent");
await ev("__lp.closeDrawer()");

console.log("== 10. 窄屏 / 减少动效 + 省电画质");
await open("?skip=1&quality=high", 390, 780);
await ev("__lp.Core.press(109,true);__lp.Core.press(108,true)"); await ev("__demo.dense(2500, 9)"); await shot("20-narrow");
await open("?skip=1&quality=low", 1280, 760, { reducedMotion: true });
await ev("__lp.Core.press(109,true);__lp.Core.press(108,true)"); await ev("__demo.dense(2500, 9)"); await shot("21-reduced-low");
report.reducedEff = await ev("'reduced=' + (__lp.ui.reduced==null?matchMedia('(prefers-reduced-motion: reduce)').matches:__lp.ui.reduced)");

console.log("== 11. 同步基准(不受 vsync 限制):安静(引导期) / 律动 / 爆发 × 画质档");
const bench = (n) => `(()=>{ const C=__lp.Core; return __lp.Stage.bench(${n},(i)=>{ if(i%4===0) C.press(11+((i*7)%8)+10*((i*3)%8),true); if(i%4===2) C.press(11+((i*7)%8)+10*((i*3)%8),false);}) })()`;
report.bench = {};
for (const tier of (GPU ? ["high", "mid", "low"] : ["mid", "low"])) {
  for (const kind of ["quiet", "groove", "burst"]) {
    await open("?quality=" + tier + (kind === "quiet" ? "" : "&skip=1&style=" + kind) + "&capture=1" + (GPU ? "" : "&gl=1"), 1440, 860, { settle: 600 });
    if (kind !== "quiet") { await ev("__lp.Core.press(109,true); __lp.Core.press(108,true)"); await ev("__demo.dense(" + (kind === "burst" ? 4500 : 2500) + ", 10)"); }
    const r = await ev(kind === "quiet" ? "__lp.Stage.bench(" + (GPU ? 36 : 10) + ")" : bench(GPU ? 36 : 10)); (report.bench[tier] ||= {})[kind] = r && { avg: +r.avg.toFixed(1), p95: +r.p95.toFixed(1), rt: r.rt.join("x") };
  }
}
if (!GPU) {   // 软件渲染下默认走 2D 降级;测它的帧耗时
  report.bench2d = {};
  for (const kind of ["quiet", "burst"]) {
    await open("?" + (kind === "quiet" ? "" : "skip=1&style=burst&") + "capture=1", 1440, 860, { settle: 600 });
    if (kind !== "quiet") { await ev("__lp.Core.press(109,true); __lp.Core.press(108,true)"); await ev("__demo.dense(3500, 10)"); }
    report.bench2d.mode = await ev("__lp.Stage.mode");
    const r = await ev(kind === "quiet" ? "__lp.Stage.bench(60)" : bench(60)); report.bench2d[kind] = r && { avg: +r.avg.toFixed(2), p95: +r.p95.toFixed(2), rt: r.rt.join("x") };
  }
}

console.log("== 12. 无 WebGL 降级(强制)");
await send("Page.addScriptToEvaluateOnNewDocument", { source: "(()=>{const o=HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext=function(t,...a){ if(/webgl/.test(t)) return null; return o.call(this,t,...a); };})()" });
await open("?skip=1", 1280, 760);
report.fallbackOk = await ev("__lp.Stage.mode === '2d' && !!document.querySelector('#pad .lk')");
await ev("__lp.Core.press(109,true);__lp.Core.press(108,true)"); await ev("__demo.dense(2500, 9)"); await shot("22-fallback-2d");

console.log("\n== 结果");
console.log(JSON.stringify(report, null, 1));
console.log("控制台错误数:", errors.length); errors.slice(0, 10).forEach((e) => console.log("  ", e));
if (warns.length) console.log("警告:", warns.slice(0, 5));
mkdirSync(path.join(here, "results"), { recursive: true }); report.errors = errors.length; writeFileSync(path.join(here, "results", LABEL + ".json"), JSON.stringify(report, null, 1));
ws.close(); proc.kill();
try { rmSync(prof, { recursive: true, force: true }); } catch (e) { /* 临时目录,无碍 */ }
process.exit(errors.length ? 1 : 0);
