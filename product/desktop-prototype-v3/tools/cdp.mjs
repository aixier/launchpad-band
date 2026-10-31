// 无头 Chrome 的最小 CDP 封装(给 headless_master.mjs 等自检脚本用;file:// 加载,收集控制台错误)。
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function launch({ gpu = false, dgpu = false, w = 1440, h = 860, extraArgs = [] } = {}) {
  const CHROMES = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"];
  const chrome = CHROMES.find(existsSync); if (!chrome) throw new Error("找不到 Chrome/Edge");
  const port = 9300 + Math.floor(Math.random() * 600), prof = mkdtempSync(path.join(os.tmpdir(), "lp-prof-"));
  const args = ["--headless=new", "--remote-debugging-port=" + port, "--user-data-dir=" + prof, "--no-first-run", "--no-default-browser-check", "--autoplay-policy=no-user-gesture-required", "--ignore-gpu-blocklist", "--hide-scrollbars",
    ...(gpu ? ["--use-angle=d3d11", "--enable-gpu-rasterization", (dgpu ? "--force_high_performance_gpu" : "--force_low_power_gpu")] : ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"]), ...extraArgs, "about:blank"];
  const proc = spawn(chrome, args, { stdio: "ignore" });
  let wsUrl = null;
  for (let i = 0; i < 60 && !wsUrl; i++) { try { const l = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); const p = l.find((x) => x.type === "page"); if (p) wsUrl = p.webSocketDebuggerUrl; } catch (e) { /* 等启动 */ } if (!wsUrl) await sleep(250); }
  if (!wsUrl) throw new Error("Chrome 未启动");
  const ws = new WebSocket(wsUrl); await new Promise((r) => (ws.onopen = r));
  let id = 0; const pend = new Map(), errors = [], logs = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); return; }
    if (d.method === "Runtime.exceptionThrown") errors.push("exception: " + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text));
    if (d.method === "Runtime.consoleAPICalled") { const txt = d.params.args.map((a) => a.value ?? a.description).join(" "); if (["error", "assert"].includes(d.params.type)) errors.push("console." + d.params.type + ": " + txt); else logs.push(d.params.type + ": " + txt.slice(0, 300)); }
    if (d.method === "Log.entryAdded" && d.params.entry.level === "error") errors.push("log.error: " + d.params.entry.text + " " + (d.params.entry.url || ""));
  };
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, (d) => (d.error ? rej(new Error(method + ": " + d.error.message)) : res(d.result))); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error("evaluate 失败: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text)); return r.result.value; };
  await send("Page.enable"); await send("Runtime.enable"); await send("Log.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  const shot = async (file) => { const r = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(file, Buffer.from(r.data, "base64")); };
  const close = () => { try { ws.close(); } catch (e) { /* 已关 */ } try { proc.kill(); } catch (e) { /* 已退 */ } };
  return { send, ev, shot, errors, logs, close, sleep, view: (w2, h2) => send("Emulation.setDeviceMetricsOverride", { width: w2, height: h2, deviceScaleFactor: 1, mobile: false }) };
}
