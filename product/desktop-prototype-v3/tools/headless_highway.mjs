// 跟打模式 无头 Chrome(file://)全流程自检:按谱面时间自动"按键",验证 判定 / 连击 / 星级 / 声部锁定与分层出声 / 灯光语言,并截图、测帧耗时。
// 用法: node tools/headless_highway.mjs [--gpu] [--dgpu] [--only=smoke|shots|run|perf]
//   --gpu: 用本机显卡(ANGLE/D3D11),--dgpu: 高性能独显;都不带 = SwiftShader 软件渲染(最坏情形,舞台会自动降级为 2D 版)
import { spawn } from "node:child_process";
import { mkdirSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, "..");
const GPU = process.argv.includes("--gpu") || process.argv.includes("--dgpu"), DGPU = process.argv.includes("--dgpu");
const ONLY = (process.argv.find((a) => a.startsWith("--only=")) || "").slice(7);
const want = (k) => !ONLY || ONLY === k;
const LABEL = !GPU ? "swiftshader" : DGPU ? "dgpu-quadro" : "igpu-uhd630";
const shots = path.join(here, "shots-hw", LABEL); mkdirSync(shots, { recursive: true });
const chrome = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find(existsSync);
if (!chrome) { console.error("找不到 Chrome/Edge"); process.exit(2); }
const port = 9800 + Math.floor(Math.random() * 400), prof = path.join(here, ".prof-hw-" + port);
const args = ["--headless=new", "--remote-debugging-port=" + port, "--user-data-dir=" + prof, "--no-first-run", "--no-default-browser-check", "--autoplay-policy=no-user-gesture-required", "--ignore-gpu-blocklist", "--hide-scrollbars",
  ...(GPU ? ["--use-angle=d3d11", "--enable-gpu-rasterization", ...(DGPU ? ["--force_high_performance_gpu"] : ["--force_low_power_gpu"])] : ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"]), "about:blank"];
const proc = spawn(chrome, args, { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getWs() { for (let i = 0; i < 60; i++) { try { const l = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); const p = l.find((x) => x.type === "page"); if (p) return p.webSocketDebuggerUrl; } catch (e) { /* 等启动 */ } await sleep(250); } throw new Error("Chrome 未启动"); }
const ws = new WebSocket(await getWs()); await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map(), errors = [];
ws.onmessage = (m) => { const d = JSON.parse(m.data);
  if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); return; }
  if (d.method === "Runtime.exceptionThrown") errors.push("exception: " + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text));
  if (d.method === "Runtime.consoleAPICalled" && ["error", "assert"].includes(d.params.type)) errors.push("console." + d.params.type + ": " + d.params.args.map((a) => a.value ?? a.description).join(" "));
  if (d.method === "Log.entryAdded" && d.params.entry.level === "error") errors.push("log.error: " + d.params.entry.text + " " + (d.params.entry.url || "")); };
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, (d) => (d.error ? rej(new Error(method + ": " + d.error.message)) : res(d.result))); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error("evaluate 失败: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text)); return r.result.value; };
async function shot(name) { const r = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(path.join(shots, name + ".png"), Buffer.from(r.data, "base64")); console.log("  截图 " + name + ".png"); }
await send("Page.enable"); await send("Runtime.enable"); await send("Log.enable");
async function open(q = "", w = 1440, h = 860, reduced = false) {
  await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: reduced ? "reduce" : "no-preference" }] });
  await send("Page.navigate", { url: pathToFileURL(path.join(root, "index.html")).href + (q || "?") + (DGPU ? "&gpu=high" : "") + "&skip=1&capture=1" + (GPU ? "&quality=high" : "") });
  for (let i = 0; i < 80; i++) { await sleep(250); const r = await send("Runtime.evaluate", { expression: "typeof window.__lp", returnByValue: true }); if (r.result.value === "object") break; }
  await sleep(700);
}
const report = { label: LABEL };
const PX = `(()=>{ const s=__lp.Stage; s.auditLog.violations=0; s.auditLog.frames=0; s.auditLog.pixel=0; s.auditLog.pixelFrames=0; s.auditLog.worst=[]; s.setAudit(true); })()`;
const PXR = `(()=>{ const s=__lp.Stage; s.setAudit(false); return {violations:s.auditLog.violations, frames:s.auditLog.frames, pixelBad:s.auditLog.pixel, pixelFrames:s.auditLog.pixelFrames, worst:s.auditLog.worst}; })()`;

/* 页内自动打手:按谱面时间按键。jit=抖动(ms),bias=整体偏晚(ms),skip=整层不打,miss=漏打概率,lane=用键盘列键而不是精确格 */
const AUTO = `window.__auto = (o) => { o = Object.assign({ jit: 20, bias: 0, skip: [], miss: 0, lane: false, relJit: 40 }, o);
  let seed = 12345; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const H = __lp.HW, C = __lp.Core, notes = H.notes().map((n) => ({ n, skip: o.skip.includes(n.layer) || rnd() < o.miss, pj: (rnd() * 2 - 1) * o.jit / 1000 + o.bias / 1000, rj: (rnd() * 2 - 1) * o.relJit / 1000, p: false, r: false }));
  const tm = setInterval(() => { const T = H.visT(); if (H.phase === 'done' || H.phase === 'off') { clearInterval(tm); return; }
    for (const a of notes) { if (a.skip) continue; const n = a.n;
      if (!a.p && T >= n.t + a.pj) { a.p = true; if (o.lane) H.laneKey(n.c, true); else C.press(n.pad, true); if (!n.hold) setTimeout(() => (o.lane ? H.laneKey(n.c, false) : C.press(n.pad, false)), 40); }
      if (a.p && n.hold && !a.r && T >= n.t + n.d + a.rj) { a.r = true; if (o.lane) H.laneKey(n.c, false); else C.press(n.pad, false); } } }, 3);
  window.__autoStop = () => clearInterval(tm); return notes.length; };`;
const waitPhase = async (p, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if ((await ev("__lp.HW.phase")) === p) return true; await sleep(150); } return false; };
const waitT = async (T, ms = 90000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await ev("__lp.HW.visT()"); if (v >= T) return v; await sleep(40); } return null; };
const checks = []; const check = (name, ok, detail = "") => { checks.push({ name, ok: !!ok, detail }); console.log((ok ? "  通过  " : "  失败  ") + name + (detail ? "  " + detail : "")); };

/* ========== 1. 冒烟 + 开始卡片 ========== */
console.log("== 1. 加载 / 开始卡片");
await open("?");
report.mode = await ev("__lp.Stage.mode"); report.gpu = await ev("__lp.Stage.gpu");
await ev("document.querySelector('#hwBtn').click()"); await sleep(600);
check("点「跟打」后出现开始卡片", await ev("__lp.HW.phase === 'ready' && !document.querySelector('.hw-card').hidden"));
await shot("01-ready-card");
if (ONLY === "smoke") { console.log("控制台错误数:", errors.length, errors.slice(0, 5)); ws.close(); proc.kill(); process.exit(errors.length ? 1 : 0); }

/* ========== 2. 各提示方式在同一时刻的对比截图(冻结歌曲时间,不出声) ========== */
if (want("shots")) {
  console.log("== 2. 同一时刻,三种提示方式对比");
  for (const [T, tag, hold] of [[18.6, "bass-section-t18", false], [31.4, "chords-t31", true], [43.8, "melody-t43", false]]) {
    for (const view of ["spot", "pillar", "classic"]) {
      await ev(`__lp.HW.set.view='${view}'; __lp.HW.set.assist='full'; __lp.HW.debugSeek(${T}, {hold:${hold}})`); await sleep(500);
      await ev(`__lp.HW.debugSeek(${T}, {hold:${hold}})`); await sleep(260);
      if (view === "spot" || tag === "melody-t43") { console.log("   T=", await ev("__lp.HW.visT()"), "phase=", await ev("__lp.HW.phase"), "view=", await ev("__lp.HW.set.view")); await shot(`02-${tag}-${view}`); }
    }
  }
  await ev("__lp.HW.set.view='spot'; __lp.HW.save()");
  await ev("__lp.HW.close()"); await sleep(200);
}

/* ========== 3. 全流程:自动打手按谱面时间触发按键 ========== */
if (want("run")) {
  console.log("== 3. 全流程(约 55 秒):4 层全打,看 判定/连击/锁定/分层出声/星级");
  await open("?");
  await ev(AUTO);
  await ev("__lp.HW.open(); __lp.HW.set.mode='easy'; __lp.HW.set.assist='auto'; __lp.HW.set.calib=0; __lp.HW.set.view='spot'; __lp.A.ensure(); document.querySelector('#hwGo') ? document.querySelector('#hwGo').click() : __lp.HW.start()");
  await sleep(300);
  check("开始后进入倒数", ["count", "play"].includes(await ev("__lp.HW.phase")));
  await ev("__auto({ jit: 30, bias: 0 })");
  await ev(PX);
  await waitT(-1.2); await shot("03-count-in");
  await waitT(5.55); await shot("04-section1-falling-spot");           // 第 1 段(鼓)
  const g1 = await waitT(4.0); await shot("05-hit-moment");           // 命中瞬间(底鼓在第 8 s,打手抖动 ±30ms)
  await waitT(11.8); const mid1 = await ev("JSON.stringify(__lp.HW.snapshot())"); report.mid1 = JSON.parse(mid1);
  await waitT(12.8); const s1 = await ev("JSON.stringify(__lp.HW.snapshot())"); report.afterSec1 = JSON.parse(s1);
  check("第 1 段结束后「鼓」被锁定", report.afterSec1.locked.drums === true, "acc=" + (report.afterSec1.secScore[0]?.acc ?? 0).toFixed(3));
  await waitT(18.5); await shot("06-section2-bass");
  await waitT(30.3); await shot("07-section3-chords-hold");
  await waitT(43.0); await shot("08-section4-melody-all-layers");
  report.px = await ev(PXR);
  check("全流程中舞台灯色/渲染像素无青绿", report.px.violations === 0 && report.px.pixelBad === 0, JSON.stringify({ v: report.px.violations, px: report.px.pixelBad, frames: report.px.frames }));
  await waitPhase("done", 30000); await sleep(1700); await shot("09-result");
  const fin = JSON.parse(await ev("JSON.stringify(__lp.HW.snapshot())")); report.finish = fin;
  check("跑完进入结果", fin.phase === "done" && fin.res);
  check("四层全部锁定", fin.res && fin.res.layersOn === 4, "layersOn=" + fin.res?.layersOn);
  check("准确率高(自动打手 ±30ms)", fin.res && fin.res.pressAcc > 0.93, "pressAcc=" + fin.res?.pressAcc.toFixed(3) + " holdAcc=" + fin.res?.holdAcc.toFixed(3));
  check("星级 3", fin.res && fin.res.stars === 3, "stars=" + fin.res?.stars);
  check("最高连击 ≥ 40(软件渲染下偶有卡顿漏拍)", fin.res && fin.res.maxCombo >= 40, "maxCombo=" + fin.res?.maxCombo);
  report.soundSummary = await ev(`(()=>{ const L=__lp.HW.S.log, by={}; L.forEach(e=>{ const k=e.layer+':'+e.src; by[k]=(by[k]||0)+1; }); const first={}; L.forEach(e=>{ const k=e.layer+':'+e.src; if(first[k]==null) first[k]=e.at; }); return {by, first}; })()`);
  const by = report.soundSummary.by, first = report.soundSummary.first;
  check("分层出声:鼓只在第 1 段由用户出声,第 2 段起由乐队接力", by["drums:user"] > 20 && by["drums:auto"] > 60 && first["drums:auto"] >= 11.9, JSON.stringify({ user: by["drums:user"], auto: by["drums:auto"], firstAuto: first["drums:auto"] }));
  check("贝斯由用户在第 2 段打出,第 3 段起自动", by["bass:user"] > 10 && first["bass:user"] >= 11.9 && first["bass:auto"] >= 23.9, JSON.stringify({ user: by["bass:user"], auto: by["bass:auto"], firstUser: first["bass:user"], firstAuto: first["bass:auto"] }));
  check("旋律只有用户出声(最后一层,没有自动回放)", by["melody:user"] > 10 && !by["melody:auto"], JSON.stringify({ user: by["melody:user"], auto: by["melody:auto"] }));
  check("第 1 段内没有任何贝斯/和弦/旋律出声(没打到那一层就静默)", await ev("__lp.HW.S.log.filter(e=>e.at<11.9 && e.layer!=='drums').length === 0"));
  await ev("__autoStop && __autoStop()");

  console.log("== 3b. 没打对就静默:第 2 段整层不打");
  await open("?"); await ev(AUTO);
  await ev("__lp.HW.open(); __lp.HW.set.mode='easy'; __lp.HW.set.calib=0; __lp.A.ensure(); __lp.HW.start()");
  await ev("__auto({ jit: 30, skip: ['bass'] })");
  await waitPhase("done", 70000); await sleep(300);
  const f2 = JSON.parse(await ev("JSON.stringify(__lp.HW.snapshot())")); report.skipBass = { locked: f2.locked, stars: f2.res?.stars, layersOn: f2.res?.layersOn, acc: f2.res?.pressAcc };
  const by2 = await ev("(()=>{ const by={}; __lp.HW.S.log.forEach(e=>{ const k=e.layer+':'+e.src; by[k]=(by[k]||0)+1; }); return by; })()");
  check("不打贝斯 → 贝斯没被锁定、后面各段没有贝斯声", f2.locked.bass === false && !by2["bass:auto"] && !by2["bass:user"], JSON.stringify(f2.locked));
  check("其余三层不受影响(鼓、和弦、旋律照样叠上)", f2.locked.drums && f2.locked.chords && f2.locked.melody, "layersOn=" + f2.res?.layersOn);
  await shot("10-bass-skipped-result");

  console.log("== 3c. 严格档 + 偏晚 90 ms 的玩家:校准前后");
  await open("?"); await ev(AUTO);
  await ev("__lp.HW.open(); __lp.HW.set.mode='strict'; __lp.HW.set.calib=0; __lp.A.ensure(); __lp.HW.start()");
  await ev("__auto({ jit: 15, bias: 90, skip: ['bass','chords','melody'] })");
  await waitT(12.8, 60000); const strictLate = JSON.parse(await ev("JSON.stringify(__lp.HW.snapshot())"));
  report.strictLate = { uncal: { acc: strictLate.secScore[0]?.acc, locked: strictLate.locked.drums } };
  await ev("__autoStop && __autoStop(); __lp.HW.close()");
  await open("?"); await ev(AUTO);
  await ev("__lp.HW.open(); __lp.HW.set.mode='strict'; __lp.HW.set.calib=0.09; __lp.A.ensure(); __lp.HW.start()");
  await ev("__auto({ jit: 15, bias: 90, skip: ['bass','chords','melody'] })");
  await waitT(12.8, 60000); const strictCal = JSON.parse(await ev("JSON.stringify(__lp.HW.snapshot())"));
  report.strictLate.cal = { acc: strictCal.secScore[0]?.acc, locked: strictCal.locked.drums };
  check("校准有用:偏晚 90 ms 的玩家,严格档下未校准打不上鼓、校准 +90 ms 后能叠上", !strictLate.locked.drums && strictCal.locked.drums, JSON.stringify(report.strictLate));
  await ev("__autoStop && __autoStop(); __lp.HW.close()");

  console.log("== 3d. 校准流程(模拟玩家比节拍晚 70 ms)");
  await open("?"); await ev("__lp.HW.open(); __lp.HW.set.calib=0; __lp.A.ensure(); __lp.HW.calibrate()");
  await sleep(300);
  await ev(`(()=>{ const c=__lp.HW.S.cal, A=__lp.A; const tm=setInterval(()=>{ const ac=A.now(); c.beats.forEach((b,i)=>{ if(!c.__d) c.__d={}; if(!c.__d[i] && ac - A.outLatency() >= b + 0.07){ c.__d[i]=1; __lp.Core.press(44,true); __lp.Core.press(44,false); } }); if(c.done) clearInterval(tm); },4); })()`);
  await waitPhase("ready", 15000); await sleep(200);
  const cal = await ev("({ calib: __lp.HW.set.calib, res: __lp.HW.S.cal && __lp.HW.S.cal.result })"); report.calibration = cal;
  check("校准:取到平均偏差约 +70 ms", cal.res && cal.res.ms != null && Math.abs(cal.res.ms - 70) <= 25, JSON.stringify(cal));
  await shot("11-calibrated-card");
}

/* ========== 4. 灯光语言(盘面):预备青绿常亮、不闪、仅 该按的键 ========== */
if (want("run") || want("lamps")) {
  console.log("== 4. 盘面灯:预备青绿常亮");
  await open("?"); await ev("__lp.HW.open(); __lp.HW.set.assist='full'; __lp.HW.debugSeek(3.0,{})");
  const rep = await ev(`(()=>{ const H=__lp.HW, C=__lp.Core, out={frames:0, guideKeys:0, offPhase:0, blink:0, unmatched:0}; const G=C.GUIDE, GO=C.GUIDE_OFF;
    for(let k=0;k<60;k++){ const T=3.55+k*0.02; H.debugSeek(T,{}); const fr=C.tick(); out.frames++; const prep=new Set(H.prep(T).map(n=>n.pad));
      for(const id in fr){ const c=fr[id]; const hi=c[0]===G[0]&&c[1]===G[1]&&c[2]===G[2], lo=c[0]===GO[0]&&c[1]===GO[1]&&c[2]===GO[2]; if(hi){ out.guideKeys++; if(!prep.has(+id)) out.unmatched++; } if(lo) out.offPhase++; } }
    return out; })()`);
  report.lamps = rep;
  check("盘面青绿只出现在『该按的键』上,且从不出现闪烁的暗相", rep.guideKeys > 0 && rep.unmatched === 0 && rep.offPhase === 0, JSON.stringify(rep));
  await ev("__lp.HW.close()");
}

/* ========== 4b. 窄屏 / 减少动效 ========== */
if (want("run") || want("narrow")) {
  console.log("== 4b. 窄屏 390x780 与 减少动效 + 省电画质");
  await open("?quality=low", 390, 780);
  await ev("__lp.HW.open(); __lp.HW.set.assist='full'; __lp.HW.set.view='spot'; __lp.HW.debugSeek(18.6,{})"); await sleep(500); await ev("__lp.HW.debugSeek(18.6,{})"); await sleep(300); await shot("12-narrow-390");
  await open("?quality=low", 1280, 760, true);
  await ev("__lp.HW.open(); __lp.HW.set.assist='full'; __lp.HW.set.view='spot'; __lp.HW.debugSeek(4.02,{})"); await sleep(500); await ev("__lp.HW.debugSeek(4.02,{})"); await sleep(300); await shot("13-reduced-motion-low");
  report.reduced = await ev("({ reduced: __lp.Stage.opts.reduced, tier: __lp.Stage.effQuality() })"); check("「减少动效」被跟打画面读到", report.reduced.reduced === true, JSON.stringify(report.reduced));
  await ev("__lp.HW.close()");
}

/* ========== 5. 帧耗时 ========== */
if (want("perf")) {
  console.log("== 5. 帧耗时(同步基准:舞台 + 跟打画面)");
  report.perf = {};
  for (const tier of GPU ? ["high", "mid"] : ["auto"]) {
    await open("?quality=" + tier);
    await ev("__lp.HW.open(); __lp.HW.set.assist='full'; __lp.HW.set.view='spot'");
    await ev("__lp.HWV.drawN=0;__lp.HWV.drawMs=0"); await ev("__lp.HW.debugSeek(30.3,{hold:true})");
    const mode = await ev("__lp.Stage.mode");
    // 舞台基准:跟打期间的导演输入(能量高、灯多)。用自带的 bench(每帧回读像素强制 GPU 完成)
    const bench = await ev(`(()=>{ const H=__lp.HW; let T=30.0; return __lp.Stage.bench(${GPU ? 36 : 12}, (i)=>{ T+=1/60; H.debugSeek(T,{}); }); })()`);
    // 画面层:2D 画布每帧耗时(含全部光斑/光条/格阵)
    const draw = await ev(`(()=>{ const V=__lp.HWV, H=__lp.HW; const ts=[]; for(let i=0;i<120;i++){ H.debugSeek(30+i/60,{hold:i%2==0}); const t0=performance.now(); V.frame(i/60); ts.push(performance.now()-t0); } ts.sort((a,b)=>a-b); return {avg: ts.reduce((a,b)=>a+b,0)/ts.length, p95: ts[Math.floor(ts.length*0.95)]}; })()`);
    report.perf[tier] = { stageMode: mode, bench: bench && { avg: +bench.avg.toFixed(1), p95: +bench.p95.toFixed(1), tier: bench.tier, rt: bench.rt.join("x") }, hwDrawMs: { avg: +draw.avg.toFixed(2), p95: +draw.p95.toFixed(2) } };
    console.log("  ", tier, JSON.stringify(report.perf[tier]));
    await ev("__lp.HW.close()");
  }
}

console.log("\n== 结果");
report.checks = checks; report.errors = errors.length;
console.log(JSON.stringify(report, null, 1));
console.log("控制台错误数:", errors.length); errors.slice(0, 10).forEach((e) => console.log("  ", e));
const failed = checks.filter((c) => !c.ok); console.log(failed.length ? "失败 " + failed.length + " 项: " + failed.map((c) => c.name).join("; ") : "全部检查通过(" + checks.length + " 项)");
mkdirSync(path.join(here, "results"), { recursive: true }); writeFileSync(path.join(here, "results", "highway-" + LABEL + ".json"), JSON.stringify(report, null, 1));
ws.close(); proc.kill(); try { rmSync(prof, { recursive: true, force: true }); } catch (e) { /* 临时目录 */ }
process.exit(errors.length || failed.length ? 1 : 0);
