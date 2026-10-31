/* 随手乐队 桌面端 v3:界面壳。舞台是主画面;Launchpad 只是左下角的指挥台镜像(引导在这里表达)。
   音频/灯盘逻辑在 audio.js / pad.js(与 Python 原型同源),灯光导演在 director.js,渲染在 stage.js,抽屉页面在 views.js。 */
(function () {
  "use strict";
  const Core = window.LPCore, A = window.LPAudio, Stage = window.LPStage, Views = window.LPViews;
  const $ = (s, r) => (r || document).querySelector(s);
  const params = new URLSearchParams(location.search);
  const disp = (v) => Math.round(Math.min(1, Math.pow(v / 63, 0.55)) * 255), css = (c) => "rgb(" + c.map(disp).join(",") + ")";
  const mqRed = window.matchMedia("(prefers-reduced-motion: reduce)");
  const ui = Object.assign({ quality: "auto", reduced: null, styleMode: "auto", homeDelay: 40 }, Core.load("lp3v3.ui", {}));
  ["quality", "styleMode"].forEach((k) => { if (params.get(k)) ui[k] = params.get(k); });
  if (params.get("style")) ui.styleMode = params.get("style");
  const saveUi = () => Core.save("lp3v3.ui", ui), effReduced = () => (ui.reduced == null ? mqRed.matches : ui.reduced);

  let toastT = 0;
  function toast(msg) { const t = $("#toast"); t.textContent = msg; t.classList.add("on"); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("on"), 2200); }

  /* ---------- 舞台 ---------- */
  Stage.init($("#stage"), { quality: ui.quality, reduced: effReduced(), styleMode: ui.styleMode, capture: params.get("capture") === "1", forceGL: params.get("gl") === "1", gpuPref: params.get("gpu") === "high" ? "high-performance" : "default" });
  if (Stage.mode === "2d") { const n = $("#nogl"); n.hidden = false; n.textContent = "这台电脑的浏览器暂时用不了 3D 灯光(" + (Stage.reason || "WebGL 不可用") + "),已换成平面舞台,照样能玩。"; }
  mqRed.addEventListener && mqRed.addEventListener("change", () => { Stage.setOptions({ reduced: effReduced() }); HWV.setOptions({ reduced: effReduced() }); });
  Core.build($("#pad"));
  const HW = window.LPHW, HWV = window.LPHWView;
  HWV.init($("#hw"), { reduced: effReduced() });

  /* ---------- 抽屉 ---------- */
  let cur = null;
  const drawer = $("#drawer"), tabs = $("#tabs");
  Views.tabs.forEach(([id, name]) => { const b = document.createElement("button"); b.type = "button"; b.className = "tab"; b.role = "tab"; b.textContent = name; b.dataset.v = id; b.onclick = () => openTab(id); tabs.appendChild(b); });
  function openTab(id) { cur = id; drawer.hidden = false; document.body.classList.add("drawer-open"); $("#menuBtn").setAttribute("aria-expanded", "true"); tabs.querySelectorAll(".tab").forEach((b) => b.setAttribute("aria-selected", b.dataset.v === id)); Views.render(id, $("#panel"), ctx); }
  function closeDrawer() { cur = null; drawer.hidden = true; document.body.classList.remove("drawer-open"); $("#menuBtn").setAttribute("aria-expanded", "false"); }
  $("#drawerClose").onclick = () => closeDrawer();
  $("#menuBtn").onclick = () => (drawer.hidden ? openTab("lessons") : closeDrawer());
  function confirmDlg(title, body, ok, fn) {
    const b = document.createElement("div"); b.className = "dlg-back"; b.innerHTML = '<div class="dlg" role="dialog"><h2></h2><p class="muted"></p><div class="chips"><button class="btn small" data-o type="button"></button><button class="btn ghost small" data-c type="button">取消</button></div></div>';
    $("h2", b).textContent = title; $("p", b).textContent = body; $("[data-o]", b).textContent = ok; $("[data-o]", b).onclick = () => { b.remove(); fn(); }; $("[data-c]", b).onclick = () => b.remove(); document.body.appendChild(b);
  }

  /* ---------- 灯光语言自检(运行时)---------- */
  let guideViol = 0, guideSeen = 0;
  function guidePhase(fr) {
    let hi = 0, lo = 0;
    for (const k in fr) { const c = fr[k]; if (c[0] === 0 && c[1] === 63 && c[2] === 40) hi++; else if (c[0] === 0 && c[1] === 6 && c[2] === 4) lo++; }
    if (hi + lo) { guideSeen++; if (hi && lo && !Core.settings.soft) guideViol++; }
  }
  function runAudit() {
    const p = $("#panel"); if (!$("#auditT", p)) return;
    $("#auditT", p).textContent = "检查中…"; guideViol = 0; guideSeen = 0; Object.assign(Stage.auditLog, { violations: 0, frames: 0, pixel: 0, pixelFrames: 0, worst: [] }); Stage.setAudit(true);
    setTimeout(() => {
      Stage.setAudit(false); const sv = Stage.auditLog.violations, px = Stage.auditLog.pixel, ok = sv === 0 && guideViol === 0 && px === 0;
      $("#auditT", p).textContent = ok ? "通过" : "有 " + (sv + guideViol + px) + " 处问题";
      $("#auditS", p).textContent = "3 秒内检查舞台 " + Stage.auditLog.frames + " 帧(灯色),渲染像素 " + Stage.auditLog.pixelFrames + " 帧;引导键同相检查 " + guideSeen + " 帧。" + (ok ? "青绿色只出现在引导键上。" : (Stage.auditLog.worst[0] || "有青绿色像素或引导相位不一致"));
    }, 3000);
  }

  /* ---------- 家庭灯占位:订阅同一份灯光事件流,按模拟延迟回放 ---------- */
  const busBuf = [];
  Stage.onBus((b) => { busBuf.push({ at: performance.now(), z: { wash: b.zones.wash.slice(), strip: b.zones.strip.slice(), accent: b.zones.accent.slice() } }); if (busBuf.length > 90) busBuf.shift(); });
  function lamps() {
    const w = $("#lampWash"); if (!w) return; const want = performance.now() - ui.homeDelay; let e = busBuf[0];
    for (let i = busBuf.length - 1; i >= 0; i--) if (busBuf[i].at <= want) { e = busBuf[i]; break; }
    if (!e) return;
    [["lampWash", "wash"], ["lampStrip", "strip"], ["lampAccent", "accent"]].forEach(([id, z]) => { const c = e.z[z], el = $("#" + id); el.style.background = "rgb(" + c.join(",") + ")"; el.style.boxShadow = "0 0 18px rgba(" + c.join(",") + ",0.55)"; });
  }
  const ctx = { Core, A, Stage, ui, saveUi, reduced: effReduced, toast, close: closeDrawer, cur: () => cur, confirm: confirmDlg, runAudit, lamps };

  /* ---------- 表演 / 全屏 ---------- */
  function setPerf(on) {
    document.body.classList.toggle("perf", on); $("#perfBtn").setAttribute("aria-pressed", on); $("#perfBtn").textContent = on ? "退出表演" : "表演";
    Stage.setOptions({ perf: on });
    if (on) { closeDrawer(); $("#exitPerf").classList.add("show"); setTimeout(() => $("#exitPerf").classList.remove("show"), 3500); try { document.documentElement.requestFullscreen && document.documentElement.requestFullscreen().catch(() => {}); } catch (e) { /* 浏览器不允许时仍是窗口内表演 */ } }
    else { try { document.fullscreenElement && document.exitFullscreen(); } catch (e) { /* 无害 */ } }
    window.dispatchEvent(new Event("resize"));
  }
  $("#hwBtn").onclick = () => { if (HW.active) HW.close(); else { closeDrawer(); HW.open(); } };
  $("#perfBtn").onclick = () => setPerf(!document.body.classList.contains("perf"));
  const typing = (e) => /INPUT|TEXTAREA|SELECT/.test((e.target || {}).tagName || "");
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { if (document.body.classList.contains("perf")) setPerf(false); else closeDrawer(); }
    else if (!typing(e) && !e.ctrlKey && !e.metaKey) { if (e.key === "p" || e.key === "P") setPerf(!document.body.classList.contains("perf")); else if (e.key === "m" || e.key === "M") $("#menuBtn").click(); }
  });
  document.addEventListener("fullscreenchange", () => { if (!document.fullscreenElement && document.body.classList.contains("perf")) setPerf(false); });
  let stillT = 0;
  window.addEventListener("pointermove", () => { document.body.classList.remove("still"); clearTimeout(stillT); stillT = setTimeout(() => document.body.classList.add("still"), 2600); });
  $("#keysBtn").onclick = (e) => { const on = $("#pad").classList.toggle("keys"); e.target.setAttribute("aria-pressed", on); e.target.textContent = on ? "隐藏键盘对应" : "显示键盘对应"; };

  /* ---------- HUD:引导提示、音名、舞台状态 ---------- */
  let noteAt = -99;
  Core.on("note", (n) => { $("#noteBig").textContent = n.name; $("#noteBig").classList.remove("idle"); noteAt = performance.now() / 1000; $("#start").classList.add("gone"); });
  Core.on("finish", (pr) => toast("完成「" + Core.LESSONS[pr.idx].name + "」 " + "★".repeat(pr.stars)));
  Core.on("goldKey", () => { if (Views.Gen.status === "done" || Core.bestTake()) openTab("gen"); });
  Core.on("state", () => { if (cur === "lessons") Views.refresh(); });
  const hintEl = $("#hint"), hintText = $("#hintText"), sw = $("#sw");
  function hintFor() {
    const g = Core.guide, p = Core.practice;
    if (p && !p.intro) return p.phase === "done" ? "完成了" : "按闪着的键(" + Math.min(p.pos + 1, p.seq.length) + "/" + p.seq.length + ")";
    if (g.stage === 0 || (p && p.intro)) return p && p.phase === "done" ? "好,下一步" : "按闪着的键,一格一格走";
    if (g.stage === 1) return "乐队键在闪,按它"; if (g.stage === 2) return "鼓点键在闪,按它"; if (g.stage === 3) return "四个换调键都在闪,任按一个";
    return "";
  }
  let lastHint = null;
  function hud(t) {
    const hwOn = HW.active, quiet = Core.quiet() && !hwOn, idle = t - Core.lastInput > 20;
    let msg = hwOn ? "" : hintFor(); if (!hwOn && idle && Core.guide.stage < 4) msg = "还在等你按亮着的键。不着急。";
    if (msg !== lastHint) { hintText.textContent = msg; lastHint = msg; hintEl.style.display = msg ? "" : "none"; }
    hintEl.classList.toggle("sub", idle); sw.style.background = css(Core.cue(t));   // 与盘面同一个全局相位
    document.body.classList.toggle("guided", Core.quiet());
    $("#hwBtn").setAttribute("aria-pressed", hwOn);
    const nb = $("#noteBig"); if (t - noteAt > 4) nb.classList.add("idle");
    const rig = Stage.rig && Stage.rig();
    const sub = A.bandOn ? "和弦 " + A.currentInfo().chord + (A.drumsOn ? " · 鼓点" : "") : (Core.lastNote ? "刚弹的音" : "还没弹");
    const ns = $("#noteSub"); if (ns.textContent !== sub) ns.textContent = sub;
    if (rig) {
      const st = quiet ? "安静" : rig.styleName, sec = quiet ? "先跟着灯走" : { idle: "待机", verse: "铺垫", build: "渐强", climax: "高潮", break: "留白" }[rig.section];
      if ($("#moodStyle").textContent !== st) $("#moodStyle").textContent = st; if ($("#moodSec").textContent !== sec) $("#moodSec").textContent = sec;
      $("#meterFill").style.width = Math.round(Math.min(1, rig.energy) * 100) + "%";
    }
  }

  /* ---------- 录制分享:舞台画面 + 合成器声音 -> webm ---------- */
  let rec = null, recChunks = [], recAt = 0;
  function toggleRec() {
    const btn = $("#recBtn"); if (rec) { rec.stop(); return; }
    if (!Stage.ok || !window.MediaRecorder) { toast("这个浏览器不支持录制"); return; }
    A.ensure();
    const ms = new MediaStream([...Stage.canvasStream(30).getVideoTracks(), ...A.recordStream().getAudioTracks()]);
    const mime = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m));
    rec = new MediaRecorder(ms, { mimeType: mime, videoBitsPerSecond: 8e6 }); recChunks = []; recAt = performance.now();
    rec.ondataavailable = (e) => e.data.size && recChunks.push(e.data);
    rec.onstop = () => {
      const blob = new Blob(recChunks, { type: "video/webm" }); window.__lp.lastRec = { size: blob.size, ms: Math.round(performance.now() - recAt) };
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "随手乐队-" + new Date().toISOString().slice(0, 19).replace(/[:T]/g, "") + ".webm"; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      Stage.stopStream(); rec = null; btn.textContent = "录制"; btn.classList.remove("rec"); toast(blob.size ? "已保存到下载文件夹(" + Math.round(blob.size / 1024) + " KB)" : "这个环境没有拿到画面(软件渲染时会这样),换有显卡的浏览器再试");
    };
    rec.start(250); btn.classList.add("rec"); btn.textContent = "停止录制";
  }
  $("#recBtn").onclick = toggleRec;

  /* ---------- 主循环 ---------- */
  let last = performance.now() / 1000;
  function loop() {
    const t = performance.now() / 1000, dt = Math.min(0.1, t - last); last = t;
    Views.genTick();
    const tk = Core.bestTake(), top = {}, G = Views.Gen;
    if (G.status === "run") top[111] = Core.GOLD.map((x) => Math.floor(x * 0.15)); else if (G.status === "done" && !G.heard) top[111] = Core.cue(t); else if (tk) top[111] = Core.GOLD;
    Core.extraTop = top;
    if (HW.active) HW.update();
    const fr = Core.tick(); guidePhase(fr); Core.paint(fr);
    Stage.render(fr, dt, t); HWV.frame(t);
    hud(t); if (Views.live) Views.live();
    if (rec) $("#recBtn").textContent = "停止录制 " + Math.floor((performance.now() - recAt) / 1000) + " 秒";
    requestAnimationFrame(loop);
  }
  if (params.get("perf") === "1") setPerf(true);
  if (params.get("skip") === "1") Core.skipGuide();
  window.__lp = { HW, HWV, Core, A, Stage, Views, setPerf, toast, openTab, closeDrawer, ui, get guideViol() { return guideViol; }, get guideSeen() { return guideSeen; } };
  requestAnimationFrame(loop);
})();
