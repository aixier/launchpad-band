// 无头 Chrome(file://)自检:大师演出 master.html。
//   node tools/headless_master.mjs [--gpu] [--song=synth] [--quick]
//   --gpu   用本机显卡(ANGLE/D3D11);不带则 SwiftShader 软渲染(舞台自动降级为 2D 版)
//   --song=synth  用自合成曲(默认用原曲片段)
// 流程:加载(控制台 0 错误)→ 开场前 → 第一次按键(量延迟)→ 仪式 → 乱按 → 引导键 → 按 DROP → 蓄力 → 静默 → 爆发(逐帧采样亮度)→ 熟练度分级 → 表演/窄屏 → 帧耗时 → 减少动效。
// 截图存 tools/shots-master/<label>/,统计 JSON 存 tools/results/master-<label>.json。
import { pathToFileURL, fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { launch, sleep } from "./cdp.mjs";
const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, "..");
const DGPU = process.argv.includes("--dgpu"), GPU = process.argv.includes("--gpu") || DGPU, SYNTH = process.argv.includes("--song=synth"), QUICK = process.argv.includes("--quick");
const LABEL = (DGPU ? "dgpu" : GPU ? "igpu" : "soft") + (SYNTH ? "-synth" : "-clip");
const shots = path.join(here, "shots-master", LABEL); mkdirSync(shots, { recursive: true });
const c = await launch({ gpu: GPU, dgpu: DGPU });
const { ev, send, errors } = c;
const url = (q) => pathToFileURL(path.join(root, "master.html")).href + q;
const report = { label: LABEL, when: new Date().toISOString() };
const shot = async (n) => { await c.shot(path.join(shots, n + ".png")); console.log("  截图", n); };
const START = 25;   // Show.P.startPad
async function open(q, w = 1440, h = 860, reduced = false) {
  await c.view(w, h);
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: reduced ? "reduce" : "no-preference" }] });
  await send("Page.navigate", { url: url(q) });
  for (let i = 0; i < 80; i++) { await sleep(250); const r = await send("Runtime.evaluate", { expression: "typeof window.__master", returnByValue: true }); if (r.result.value === "object") break; }
  await ev(`window.__t = { sleep: (ms) => new Promise((r) => setTimeout(r, ms)), tap: async (p, ms = 60) => { __master.Core.press(p, true); await __t.sleep(ms); __master.Core.press(p, false); },
    rnd: async (ms, rate = 7) => { const t0 = performance.now(); let i = 0; while (performance.now() - t0 < ms) { const r = 1 + ((i * 3) % 5), cc = 1 + ((i * 5) % 8); await __t.tap(r * 10 + cc, 40); i++; await __t.sleep(1000 / rate); } },
    sweep: async (row, a, b, gap = 45) => { const s = a < b ? 1 : -1; for (let x = a; x !== b + s; x += s) { await __t.tap(row * 10 + x, 25); await __t.sleep(gap); } },
    until: async (fn, ms = 20000, every = 50) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (fn()) return true; await __t.sleep(every); } return false; } }`);
  await sleep(700);
}
const q = (extra = "") => "?" + [SYNTH ? "song=synth" : "", GPU ? (DGPU ? "gpu=high&" : "") + "quality=" + (DGPU ? "high" : "auto") + "&capture=1" : "capture=1", extra].filter(Boolean).join("&");
// 画面平均亮度:舞台 canvas 缩到 64x36 取平均(软件渲染下是 2D 版,同样可读)——静默/爆发的对比度证据
const LUMA = `(()=>{ const cv=document.querySelector('#stage canvas'); if(!cv) return -1; if(!window.__lc){ window.__lc=document.createElement('canvas'); window.__lc.width=64; window.__lc.height=36; window.__lx=window.__lc.getContext('2d',{willReadFrequently:true}); } window.__lx.drawImage(cv,0,0,64,36); const d=window.__lx.getImageData(0,0,64,36).data; let s=0; for(let i=0;i<d.length;i+=4) s+=0.2126*d[i]+0.7152*d[i+1]+0.0722*d[i+2]; return s/(d.length/4)/255; })()`;

console.log("== 1. 加载、开场前(黑暗里只有一个闪烁的键)");
await open(q());
report.boot = JSON.parse(await ev("JSON.stringify({mode: __master.Stage.mode, gpu: __master.Stage.gpu, phase: __master.show.S.phase, song: document.body.dataset.song})"));
await ev("__master.debug.clipReady.then(()=>0)"); await sleep(400);
report.clipDecoded = await ev("(__master.E.clip ? ({dur: +__master.E.clip.buf.duration.toFixed(2), sr: __master.E.clip.buf.sampleRate, ch: __master.E.clip.buf.numberOfChannels}) : null)");
report.idleLuma = await ev(LUMA);
await sleep(1200); await shot("01-idle-dark-one-guide-key");
await sleep(500); await shot("01b-idle-other-phase");
report.idleGuideCells = await ev("(()=>{const Core=__master.Core; const t=performance.now()/1000; const fr=Core.tick(); __master.show.padFrame(fr, t, {cue: Core.cue(t), chord:0, beat:0}); return Object.keys(fr).filter(k=>(fr[k][0]===0&&fr[k][1]===63&&fr[k][2]===40)||(fr[k][0]===0&&fr[k][1]===6&&fr[k][2]===4)).join(',')})()");

console.log("== 2. 第一次按键:同一帧内光/声/画同时(量延迟)+ 仪式");
const probe = await ev(`(async()=>{ const m=__master; const t0=performance.now(); m.Core.press(${START},true); const t1=performance.now(); const r={syncMs: +(t1-t0).toFixed(2), eAfter: +m.Stage.dir.state.e[4].toFixed(2), phase: m.show.S.phase, quietAfter: m.Stage.dir.state.quiet, flashInPad: !!m.Core.lights.flash[${START}], ctxState: m.A.context().state}; await new Promise(res=>requestAnimationFrame(()=>requestAnimationFrame(res))); r.padCell=document.querySelector('.lk[data-id="${START}"]').style.background; r.lamp4=+m.Stage.rig().lamps[4].inten.toFixed(2); return JSON.stringify(r); })()`);
report.firstPress = JSON.parse(probe); console.log("  ", probe);
await ev(`__master.Core.press(${START},false)`);
await sleep(100); await shot("02-first-press-0.1s");
await sleep(500); await shot("03-ritual-0.7s");
await sleep(1100); await shot("04-ritual-1.8s-eight-lamps");
await sleep(2300); await shot("05-ritual-4s-reveal");
report.ritualLuma = await ev(LUMA);
await ev("__t.until(()=>__master.show.S.phase==='play', 8000)"); await sleep(300);
await shot("06-after-ritual-pad-awake");
report.afterRitual = JSON.parse(await ev("JSON.stringify({phase:__master.show.S.phase, guide:__master.show.S.guide, scene:__master.show.S.scene, cur:(__master.debug.curBar()||{}).scene, mode:__master.E.mode})"));
console.log("  ", JSON.stringify(report.afterRitual));

console.log("== 3. 乱按:屏幕上每个键立刻有灯;声音量化 + 音阶锁定 + 和声");
await ev("__t.rnd(3500, 8)");
await sleep(200); await shot("07-random-mashing");
report.afterMash = JSON.parse(await ev("JSON.stringify({M:+__master.show.S.M.toFixed(3), level:__master.show.S.level, parts:__master.show.S.parts, quant:__master.summary().quantDelay})"));
console.log("  ", JSON.stringify(report.afterMash));
await ev("__t.sweep(3,1,8,40)"); await sleep(120); await shot("08-sweep-left-to-right");

console.log("== 4. 引导键(DROP)闪烁 → 按下 → 蓄力 → 静默 → 爆发");
report.guideAppeared = await ev("__t.until(()=>__master.show.S.guide, 25000)");
await sleep(400); await shot("09-guide-key-flashing-calm-stage");
report.guideFrame = JSON.parse(await ev("(()=>{const Core=__master.Core; const t=performance.now()/1000; const fr=Core.tick(); __master.show.padFrame(fr, t, {cue: Core.cue(t), chord:0, beat:0}); const cells=Object.keys(fr).filter(k=>(fr[k][0]===0&&fr[k][1]===63&&fr[k][2]===40)||(fr[k][0]===0&&fr[k][1]===6&&fr[k][2]===4)); return JSON.stringify({cells, calm: __master.show.S.calm})})()"));
await ev("__t.rnd(1000, 5)");
await ev(`(()=>{ window.__rec=[]; window.__recOn=true; const f=()=>{ if(!window.__recOn) return; const m=__master, S=m.show.S, r=m.Stage.rig(); window.__rec.push({t:performance.now(), L:${LUMA}, gap:+S.gapK.toFixed(3), tau:+S.tension.toFixed(3), flash:+r.fx.flash.toFixed(3), black:+r.fx.blackout.toFixed(3), scene:S.scene, impact:S.impactT, lamps:+r.lamps.reduce((a,l)=>a+l.inten,0).toFixed(2), fov:+r.cam.fov.toFixed(2)}); requestAnimationFrame(f); }; f(); })()`);
await ev("(()=>{ __master.Core.press(107,true); setTimeout(()=>__master.Core.press(107,false),80); })()");
await sleep(150); await shot("10-armed-just-pressed");
report.armed = JSON.parse(await ev("JSON.stringify({launchG: __master.E.st.launchG, armed: __master.show.S.armed, nextBar: __master.E.g})"));
await ev("__t.until(()=>__master.show.S.scene==='build', 12000)"); await shot("11-build-start");
await ev("__t.until(()=>__master.show.S.tension>0.75, 12000, 30)"); await shot("12-build-tension-0.75");
await ev(`(async()=>{ for(let i=0;i<900;i++){ if(__master.show.S.gapK>0.5) return; await new Promise(r=>requestAnimationFrame(r)); } })()`);
await shot("13-gap-black");
await ev(`(async()=>{ for(let i=0;i<300;i++){ if(__master.show.S.impactT>0 && performance.now()/1000-__master.show.S.impactT>0.04) return; await new Promise(r=>requestAnimationFrame(r)); } })()`);
await shot("14-impact-0.05s");
await sleep(230); await shot("15-impact-0.3s");
await sleep(900); await shot("16-drop-1.2s");
await sleep(2200); await ev("__t.rnd(1800, 9)"); await shot("17-drop-playing");
await ev("window.__recOn=false");
const R = JSON.parse(await ev("JSON.stringify(window.__rec)"));
const iImp = R.findIndex((r, i) => i > 0 && r.impact > 0 && R[i - 1].impact !== r.impact);
const gi = R.findIndex((r) => r.gap > 0.5), gapFr = R.filter((r) => r.gap > 0.5);
const peak = Math.max(...R.slice(Math.max(0, iImp), iImp + 30).map((r) => r.L)), gapL = gapFr.length ? Math.min(...gapFr.map((r) => r.L)) : null;
const buildL = R.filter((r) => r.scene === "build" && r.tau > 0.5 && r.gap < 0.1).map((r) => r.L);
report.drop = {
  frames: R.length, gapFrames: gapFr.length, gapMs: gapFr.length >= 2 ? Math.round(R[gi + gapFr.length - 1].t - R[gi].t) : null,
  gapLuma: gapL, buildLumaMean: buildL.length ? +(buildL.reduce((a, b) => a + b, 0) / buildL.length).toFixed(4) : null, peakLuma: +peak.toFixed(4), ratioPeakOverGap: gapL != null ? +(peak / Math.max(gapL, 0.002)).toFixed(1) : null,
  flashAtImpact: iImp >= 0 ? R.slice(iImp, iImp + 4).map((r) => r.flash) : null, maxFlash: Math.max(...R.map((r) => r.flash)), tauMonotonic: R.filter((r) => r.scene === "build").every((r, i, a) => i === 0 || r.tau >= a[i - 1].tau - 1e-6),
};
console.log("  ", JSON.stringify(report.drop));
const fl = JSON.parse(await ev("JSON.stringify(__master.Stage.dir.state.flashLog)")); let worst = 0; for (let i = 0; i < fl.length; i++) { let n = 0; for (let j = i; j < fl.length && fl[j] < fl[i] + 1; j++) n++; worst = Math.max(worst, n); }
report.strobe = { flashes: fl.length, worstPerSecond: worst };

if (!QUICK) {
  console.log("== 5. 熟练度逐级:同一输入,L0~L4(强制熟练度)");
  for (const [m, name] of [[0.0, "L0"], [0.12, "L1"], [0.35, "L2"], [0.6, "L3"], [0.9, "L4"]]) {
    await ev(`__master.debug.setMastery(${m})`);
    await ev("__t.rnd(1800, 9)"); await ev("__t.sweep(4,1,8,35)"); await sleep(200);
    report["level_" + name] = JSON.parse(await ev("JSON.stringify({lvl:__master.show.S.level, lamps:+__master.Stage.rig().lamps.reduce((a,l)=>a+l.inten,0).toFixed(2), bloom:+__master.Stage.rig().fx.bloom.toFixed(2), haze:+__master.Stage.rig().haze.density.toFixed(2), luma:" + LUMA + "})"));
    await shot("20-mastery-" + name);
  }
  await ev("__master.debug.setMastery(null)");
  console.log("== 6. 表演模式 + 窄屏");
  await ev("document.querySelector('#perfBtn').click()"); await sleep(600); await ev("__t.rnd(1500, 9)"); await shot("21-perf");
  await ev("document.querySelector('#perfBtn').click()"); await sleep(300);
  await c.view(480, 800); await sleep(700); await shot("22-narrow"); await c.view(1440, 860); await sleep(400);
}

console.log("== 7. 帧耗时与延迟统计");
report.summary = JSON.parse(await ev("JSON.stringify(__master.summary())"));
report.stage = JSON.parse(await ev("JSON.stringify(__master.Stage.info())"));
if (!QUICK) { report.bench = await ev("__master.Stage.bench(" + (GPU ? 36 : 12) + ", (i)=>{ if(i%4===0) __master.Core.press(11+((i*7)%8)+10*((i*3)%8),true); if(i%4===2) __master.Core.press(11+((i*7)%8)+10*((i*3)%8),false);})"); console.log("  bench:", JSON.stringify(report.bench)); }

console.log("== 8. 减少动效(系统偏好):无闪光、镜头静止、无彩带");
await open(q(), 1440, 860, true);
await ev(`__t.tap(${START},60)`); await ev("__t.until(()=>__master.show.S.phase==='play', 9000)"); await ev("__t.rnd(1500, 8)");
await ev("__master.debug.launchNow()");
await ev(`(async()=>{ window.__mx={flash:0, black:0, span:0, spawn:0, minLamp:9}; const p0=__master.Stage.rig().cam.pos.slice(); const t0=performance.now(); let seenGap=false; while(performance.now()-t0<30000){ const r=__master.Stage.rig(); __mx.flash=Math.max(__mx.flash,r.fx.flash); __mx.black=Math.max(__mx.black,r.fx.blackout); __mx.spawn+=r.spawn.filter(s=>s.kind==='confetti').length*0; const p=r.cam.pos; __mx.span=Math.max(__mx.span, Math.hypot(p[0]-p0[0],p[1]-p0[1],p[2]-p0[2])); if(__master.show.S.gapK>0.5) seenGap=true; if(__master.show.S.scene==='drop' && performance.now()-t0>8000 && seenGap) { await new Promise(r=>setTimeout(r,1500)); break; } await new Promise(r=>requestAnimationFrame(r)); } __mx.seenGap=seenGap; })()`);
report.reduced = JSON.parse(await ev("JSON.stringify({reducedOpt: __master.Stage.opts.reduced, scene: __master.show.S.scene, mx: __mx})"));
await shot("30-reduced-motion-drop");

console.log("\n== 结果");
report.padAudit = JSON.parse(await ev("JSON.stringify(__master.M.audit)"));
report.errors = errors.slice(); report.errorCount = errors.length;
console.log(JSON.stringify(report, null, 1));
mkdirSync(path.join(here, "results"), { recursive: true }); writeFileSync(path.join(here, "results", "master-" + LABEL + ".json"), JSON.stringify(report, null, 1));
c.close(); process.exit(errors.length ? 1 : 0);
