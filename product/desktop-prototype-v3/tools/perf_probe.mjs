// 性能探针:在指定画质/场景下用同步基准(readPixels 强制 GPU 完成)测单帧耗时,可调各项开关定位耗时来源,并截一张图。
// 用法: node tools/perf_probe.mjs [--soft] [--shot=名字] [--igpu]   (默认本机 GPU / ANGLE-D3D11)
import { spawn } from "node:child_process"; import { pathToFileURL, fileURLToPath } from "node:url"; import path from "node:path"; import { writeFileSync, mkdirSync, rmSync } from "node:fs";
const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, "..");
const SOFT = process.argv.includes("--soft"), shotName = (process.argv.find((a) => a.startsWith("--shot=")) || "").slice(7);
const port = 9600 + Math.floor(Math.random() * 150), prof = path.join(here, ".prof-p" + port);
const proc = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", ["--headless=new", "--remote-debugging-port=" + port, "--user-data-dir=" + prof, "--no-first-run", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required", ...(SOFT ? ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"] : ["--use-angle=d3d11", ...(process.argv.includes("--dgpu") ? ["--force_high_performance_gpu"] : ["--force_low_power_gpu"])]), "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws; for (let i = 0; i < 40; i++) { try { const l = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); const p = l.find((x) => x.type === "page"); if (p) { ws = new WebSocket(p.webSocketDebuggerUrl); break; } } catch (e) { /* 等 */ } await sleep(250); }
await new Promise((r) => (ws.onopen = r)); let id = 0; const pend = new Map(); const errs = [];
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); return; } if (d.method === "Runtime.exceptionThrown") errs.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text); if (d.method === "Runtime.consoleAPICalled" && d.params.type === "error") errs.push(d.params.args.map((a) => a.value ?? a.description).join(" ").slice(0, 600)); };
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => { const r = await send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description); return r.result.result.value; };
await send("Page.enable"); await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 860, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: pathToFileURL(path.join(root, "index.html")).href + "?skip=1&capture=1&quality=high" + (process.argv.includes("--dgpu") ? "&gpu=high" : "") }); await sleep(3000);
await ev(`window.__demo = { sleep:(ms)=>new Promise(r=>setTimeout(r,ms)), async tap(p,ms=40){__lp.Core.press(p,true);await this.sleep(ms);__lp.Core.press(p,false)}, async dense(ms,rate=10){const t0=performance.now();let i=0;while(performance.now()-t0<ms){const k=i++%6; if(k===5){for(let c=1;c<=8;c++){await this.tap(30+c,25);await this.sleep(35)}} else await this.tap((1+((i*3)%8))*10+1+((i*5)%8)); await this.sleep(1000/rate);}} }`);
const scen = process.argv.find((a) => a.startsWith("--scene=")) || "--scene=burst";
if (scen.endsWith("burst")) { await ev("__lp.Core.press(109,true);__lp.Core.press(108,true);__lp.Stage.setOptions({styleMode:'"+((process.argv.find(a=>a.startsWith('--style='))||'--style=burst').slice(8))+"'})"); await ev("__demo.dense(6000,10)"); }
const tune = process.argv.find((a) => a.startsWith("--tune=")); if (tune) { const [k, v] = tune.slice(7).split(":"); await ev(`__lp.Stage.tune("${k}", ${v})`); await sleep(400); }
if (shotName) { const r = await send("Page.captureScreenshot", { format: "png" }); mkdirSync(path.join(here, "shots"), { recursive: true }); writeFileSync(path.join(here, "shots", shotName + ".png"), Buffer.from(r.result.data, "base64")); console.log("shot", shotName); }
if (process.argv.includes("--shotonly")) { ws.close(); proc.kill(); try { rmSync(prof, { recursive: true, force: true }); } catch (e) { /* 临时目录 */ } if (errs.length) console.log("ERR", errs.slice(0, 5)); process.exit(0); }
const sc = `(()=>{const C=__lp.Core; return __lp.Stage.bench(36,(i)=>{ if(i%4===0) C.press(11+((i*7)%8)+10*((i*3)%8),true); if(i%4===2) C.press(11+((i*7)%8)+10*((i*3)%8),false);})})()`;
const out = { gpu: await ev("__lp.Stage.gpu") };
const min3 = async () => { let m = 1e9; for (let k = 0; k < 3; k++) { const r = await ev(sc); m = Math.min(m, r.avg); } return +m.toFixed(1); };
const Qs = "__lp.Stage.Q";
for (const tier of ["high", "mid", "low"]) { await ev(`__lp.Stage.setOptions({quality:'${tier}'})`); out[tier] = await min3(); }
await ev("__lp.Stage.setOptions({quality:'mid'})");
const base = await ev(Qs + ".bn+','+" + Qs + ".steps");
const abl = (v) => `__lp.Stage.tune("uAbl", [${v}])`;
for (const [name, pre] of [["mid 基线", abl("0,0,0,0")], ["去掉 LED 屏墙(含地面反射)", abl("1,0,0,0")], ["去掉观众席", abl("0,1,0,0")], ["去掉墙/地光斑", abl("0,0,1,0")], ["去掉体积光", abl("0,0,0,1")], ["全去掉(只剩后期/剪影/粒子)", abl("1,1,1,1")], ["无 bloom", abl("0,0,0,0") + ";" + Qs + ".bloom=false"]]) {
  await ev("__lp.Stage.setOptions({quality:'mid'})"); await ev(pre + ";0"); out[name] = await min3();
}
await ev(abl("0,0,0,0"));
console.log(JSON.stringify(out, null, 1)); if (errs.length) console.log("ERR", errs.slice(0, 5));
ws.close(); proc.kill(); try { rmSync(prof, { recursive: true, force: true }); } catch (e) { /* 临时目录 */ }
