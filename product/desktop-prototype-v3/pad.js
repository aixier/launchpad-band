/* v3:逻辑与 v2 相同(此文件未改行为),舞台由 director.js/stage.js 驱动。
   v2:与 v1 的差异只有两处——(1) 完成仪式的彩虹改成"暖彩虹"、整段跳过青绿/蓝绿(见 rainbowHue;Python 版彩虹会扫过引导色相,已作为建议提出);(2) 导出 hsv/IDENT/NOTE_HUES 给舞台与自检使用。
   虚拟 Launchpad:灯光、引导链、跟弹练习、按键输入。
   逻辑逐段移植自 app/playground.py(Lights / Practice / Guide / band_lights)。
   灯色单位沿用设备的 0~63;显示时换算成 0~255。 */
(function () {
  "use strict";
  const A = window.LPAudio;
  const PENTA = [0, 2, 4, 7, 9];
  const NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
  const KEYS = { 104: ["C", 60], 105: ["D", 62], 106: ["F", 65], 107: ["G", 67] };
  const LESSONS = [
    { name: "热身·小羊", seq: [2, 1, 0, 1, 2, 2, 2], tip: "三个音来回走" },
    { name: "上行下行", seq: [0, 1, 2, 3, 4, 5, 4, 3, 2, 1, 0], tip: "从低到高再回来" },
    { name: "跳进", seq: [0, 3, 4, 3, 2, 3, 0], tip: "隔着几格跳着按" },
  ];
  // 灯光语言(与 app/playground.py 一致):青绿色相 0.40~0.55 为引导独占,全产品只有"青绿 + 1 Hz 硬闪烁"一种引导语言
const GUIDE = [0, 63, 40], GUIDE_OFF = [0, 6, 4], GUIDE_NEXT = [0, 16, 11], GOLD = [63, 45, 0];
const NOTE_HUES = [0.0, 0.08, 0.14, 0.78, 0.92];   // 红 橙 黄 紫 粉
const IDENT = { band: [63, 8, 35], drums: [63, 25, 0], keys: [63, 50, 0], practice: [40, 8, 63] };
const guideOn = (t) => Math.floor(t * 2) % 2 === 0;   // 全局同相:所有引导元素同亮同灭
  const now = () => performance.now() / 1000;
  // 暖彩虹:只用 红→橙→黄(0~0.20)与 紫→粉(0.70~1.0),整段 0.20~0.70(黄绿/绿/青/蓝)都跳过——
  // 引导青绿 0.40~0.55 独占;屏幕显示经过伽马换算后色相会偏移约 0.05,所以留足缓冲。x∈[0,1)
  const rainbowHue = (x) => { let h = (((x % 1) + 1) % 1) * 0.5; if (h >= 0.20) h += 0.5; return h; };
  const lerp = (a, b, f) => a.map((x, i) => Math.floor(x + (b[i] - x) * f));
  const padToDeg = (r, c) => c - 1 + 2 * (r - 1);
  const degToSemi = (d) => PENTA[((d % 5) + 5) % 5] + 12 * Math.floor(d / 5);
  const lessonPad = (d) => 30 + d + 2;
  function hsv(h, s, v) {
    const i = Math.floor(h * 6), f = h * 6 - i, p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
    const m = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][((i % 6) + 6) % 6];
    return m.map((x) => Math.floor(x * 63));
  }
  const noteRgb = (r, c, v = 1) => hsv(NOTE_HUES[((padToDeg(r, c) % 5) + 5) % 5], 0.9, v);
  const load = (k, d) => { try { const s = localStorage.getItem(k); return s ? JSON.parse(s) : d; } catch (e) { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 存储被禁用:本次会话内仍可用 */ } };

  const Core = {
    LESSONS, NAMES, KEYS, hsv, rainbowHue, IDENT, NOTE_HUES, GUIDE_OFF, GUIDE_NEXT, GOLD, load, save, noteRgb, padToDeg, degToSemi,
    tonic: 60, keyCC: 104, device: "ok", settings: Object.assign({ base: 26, soft: false }, load("lp3.settings", {})),
    results: load("lp3.results", {}), coachLog: load("lp3.coach", []),
    handlers: {}, practice: null, guide: null, lastInput: now(), presses: 0,
    takes: [], extraTop: {}, lastNote: null,
  };
  Core.on = (e, f) => { (Core.handlers[e] = Core.handlers[e] || []).push(f); };
  Core.emit = (e, a) => (Core.handlers[e] || []).forEach((f) => f(a));

  /* ---------- 灯 ---------- */
  Core.quiet = () => Core.guide.stage < 4 || !!Core.practice || !!(Core.hw && Core.hw.active);   // 安静模式:引导期间只绽放被按的键
  const L = { flash: {}, extra: {}, overlay: {}, baseLevel: 26 };
  L.press = (pad) => {
    const r = Math.floor(pad / 10), c = pad % 10, col = noteRgb(r, c);
    L.flash[pad] = [1, col];
    (Core.quiet() ? [] : [[1, 0], [-1, 0], [0, 1], [0, -1]]).forEach(([dr, dc]) => {
      const r2 = r + dr, c2 = c + dc;
      if (r2 >= 1 && r2 <= 8 && c2 >= 1 && c2 <= 8) {
        const p2 = r2 * 10 + c2, cur = L.flash[p2];
        if (!cur || cur[0] < 0.45) L.flash[p2] = [0.45, col];
      }
    });
  };
  L.frame = (dt) => {
    const out = {}, base = [Core.settings.base, Core.settings.base, Core.settings.base];
    const baseC = (Core.practice || (Core.hw && Core.hw.active)) ? [10, 10, 10] : base;
    for (let r = 1; r <= 8; r++) for (let c = 1; c <= 8; c++) {
      const p = r * 10 + c; let col = baseC;
      const fl = L.flash[p];
      if (fl) { col = lerp(baseC, fl[1], fl[0]); fl[0] -= 2.1 * dt; if (fl[0] <= 0) delete L.flash[p]; }
      if (L.overlay[p]) col = L.overlay[p];
      out[p] = col;
    }
    for (const k in L.extra) out[k] = L.extra[k];
    return out;
  };

  /* ---------- 跟弹练习 ---------- */
  function cue(t) {   // 引导闪烁;柔和模式只把硬闪改成平滑,相位仍全局一致
    if (Core.settings.soft) return lerp(GUIDE_OFF, GUIDE, 0.5 + 0.5 * Math.sin(t * Math.PI * 2 * 1));
    return guideOn(t) ? GUIDE : GUIDE_OFF;
  }
  Core.cue = cue; Core.GUIDE = GUIDE; Core.guideOn = guideOn;
  class Practice {
    constructor(idx, intro) { this.intro = !!intro; this.idx = idx; this.reset(); }
    reset() {
      this.seq = LESSONS[this.idx].seq.map(lessonPad);
      this.phase = "ready"; this.pos = 0; this.wrong = 0; this.tStart = 0; this.tDone = 0; this.stars = 0;
      this.wf = {}; this.hits = []; this.wrongs = [];
    }
    next() { this.idx = (this.idx + 1) % LESSONS.length; this.reset(); }
    onPad(note, t) {
      if (this.phase === "done") return null;
      if (note === this.seq[this.pos]) {
        if (this.pos === 0) { this.phase = "run"; this.tStart = t; }
        this.hits.push(t);
        this.pos++;
        if (this.pos >= this.seq.length) {
          this.phase = "done"; this.tDone = t;
          this.stars = this.wrong === 0 ? 3 : this.wrong <= 2 ? 2 : 1;
          Core.results[this.idx] = Math.max(Core.results[this.idx] || 0, this.stars);
          save("lp3.results", Core.results);
          return "finish";
        }
        return "hit";
      }
      if (this.phase === "run") { this.wrong++; this.wrongs.push({ at: this.pos, pressed: note, want: this.seq[this.pos], t }); }
      this.wf[note] = t;
      return "wrong";
    }
    render(t) {
      const ov = {}, ex = {};
      if (this.phase === "done") {
        const age = t - this.tDone;
        for (let r = 1; r <= 8; r++) for (let c = 1; c <= 8; c++) ov[r * 10 + c] = hsv(rainbowHue(age * 0.8 - (r + c) * 0.05), 0.9, 1);
        [69, 79, 89].forEach((p, i) => (ex[p] = i < this.stars ? GOLD : [6, 6, 6]));
      } else {
        this.seq.forEach((p, i) => { ov[p] = i < this.pos ? noteRgb(Math.floor(p / 10), p % 10) : [30, 30, 30]; });
        const last = this.seq[this.seq.length - 1];
        if (this.pos < this.seq.length - 1) ov[last] = [40, 30, 0];
        if (this.pos + 1 < this.seq.length && this.phase === "run") ov[this.seq[this.pos + 1]] = GUIDE_NEXT;
        const tgt = this.seq[this.pos];
        ov[tgt] = cue(t);
        [69, 79, 89].forEach((p) => (ex[p] = [0, 0, 0]));
      }
      for (const n in this.wf) { if (t - this.wf[n] < 0.25) ov[n] = [63, 0, 0]; else delete this.wf[n]; }
      LESSONS.forEach((_, i) => {
        const s = Core.results[i] || 0;
        ex[(i + 1) * 10 + 9] = s === 3 ? GOLD : s === 2 ? [40, 40, 40] : s === 1 ? [30, 12, 0] : [6, 6, 6];
      });
      return [ov, ex];
    }
  }

  /* ---------- 引导链 ---------- */
  class Guide {
    constructor() { this.stage = 0; }
    event(kind, on) {
      if (this.stage === 0 && kind === "intro") this.stage = 1;
      else if (this.stage === 1 && kind === "band" && on) this.stage = 2;
      else if (this.stage === 2 && kind === "drums" && on) this.stage = 3;
      else if (this.stage === 3 && kind === "key") this.stage = 4;
    }
    colors(bandOn, beatOn, keyCC, practiceOn) {
      const t = now(), cu = cue(t), dim = 0.12;
      const k = (c, f) => c.map((x) => Math.floor(x * f));
      const out = {}; for (let c = 104; c < 112; c++) out[c] = [0, 0, 0];
      if (this.stage === 0) return out;
      out[109] = this.stage === 1 && !bandOn ? cu : k(IDENT.band, bandOn ? 1 : dim);
      if (this.stage >= 2) out[108] = this.stage === 2 && !beatOn ? cu : k(IDENT.drums, beatOn ? 1 : dim);
      if (this.stage >= 3) [104, 105, 106, 107].forEach((c) => { out[c] = this.stage === 3 ? cu : k(IDENT.keys, c === keyCC ? 1 : dim); });
      if (this.stage >= 4) out[110] = practiceOn ? IDENT.practice : cu;
      return out;
    }
  }
  Core.guide = new Guide();
  Core.resetGuide = () => {
    Core.guide = new Guide(); Core.practice = new Practice(0, true);
    A.setBandOn(false); A.setDrumsOn(false); Core.keyCC = 104; Core.tonic = 60; A.tonic = 60; Core.emit("state");
  };
  Core.skipGuide = () => { Core.guide.stage = 4; Core.practice = null; Core.emit("state"); };
  Core.practice = new Practice(0, true);
  Core.startPractice = (idx) => {
    if (Core.guide.stage < 4) Core.guide.stage = 4;
    Core.practice = new Practice(idx, false); Core.emit("state");
  };
  Core.stopPractice = () => { Core.practice = null; L.overlay = {}; Core.emit("state"); };

  /* ---------- 输入 ---------- */
  function recordNote(pad, midi, down, t) {
    if (Core.practice) return;
    let tk = Core.takes[Core.takes.length - 1];
    if (down) {
      if (!tk || t - tk.last > 12) { tk = { t0: t, last: t, notes: [] }; Core.takes.push(tk); Core.takes = Core.takes.slice(-5); }
      tk.last = t; tk.notes.push({ t: +(t - tk.t0).toFixed(3), midi, pad, dur: null });
      if (tk.notes.length > 400) tk.notes.shift();
    } else if (tk) {
      for (let i = tk.notes.length - 1; i >= 0; i--) if (tk.notes[i].pad === pad && tk.notes[i].dur == null) { tk.notes[i].dur = +(t - tk.t0 - tk.notes[i].t).toFixed(3); break; }
    }
  }
  Core.bestTake = () => { for (let i = Core.takes.length - 1; i >= 0; i--) if (Core.takes[i].notes.length >= 12) return Core.takes[i]; return null; };

  Core.press = (id, down) => {
    const t = now();
    if (down) Core.lastInput = t;
    if (Core.hw && Core.hw.active && Core.hw.onPad(id, down)) return;   // 跟打模式接管全部按键(判定、出声都在 highway.js)
    if (id >= 104 && id <= 111) { if (down) controlKey(id, t); return; }
    const r = Math.floor(id / 10), c = id % 10;
    if (r < 1 || r > 8 || c < 1 || c > 8) { if (down && c === 9) Core.emit("side", id); return; }
    const midi = Core.tonic + degToSemi(padToDeg(r, c));
    if (down) {
      A.noteOn(id, midi); A.heard(midi); L.press(id); Core.presses++;
      Core.lastNote = { name: NAMES[midi % 12], midi, t };
      recordNote(id, midi, true, t);
      if (Core.practice) {
        const ev = Core.practice.onPad(id, t);
        if (ev === "finish") { A.fanfare(Core.tonic); Core.emit("finish", Core.practice); }
        else if (ev === "wrong") Core.emit("wrong", Core.practice);
      }
      Core.emit("note", Core.lastNote);
    } else { A.noteOff(id); recordNote(id, midi, false, t); }
  };
  function controlKey(cc, t) {
    const g = Core.guide;
    if (KEYS[cc]) {
      Core.tonic = KEYS[cc][1]; Core.keyCC = cc; A.tonic = Core.tonic; g.event("key");
    } else if (cc === 108) { A.ensure(); A.setDrumsOn(!A.drumsOn); g.event("drums", A.drumsOn); }
    else if (cc === 109) { A.ensure(); A.setBandOn(!A.bandOn); g.event("band", A.bandOn); }
    else if (cc === 110 && g.stage >= 4) {
      if (Core.practice) Core.stopPractice(); else Core.practice = new Practice(0, false);
    } else if (cc === 111 && g.stage >= 4 && !Core.practice) Core.emit("goldKey");
    Core.emit("state");
  }

  /* ---------- 每帧推进 ---------- */
  let lastF = now();
  Core.tick = () => {
    const t = now(), dt = Math.min(0.1, t - lastF); lastF = t;
    const p = Core.practice;
    if (p) {
      if (p.phase === "done" && t - p.tDone > 2.6) {
        if (p.intro) { Core.practice = null; Core.guide.event("intro"); L.overlay = {}; Core.emit("state"); }
        else p.next();
      }
    }
    const pr = Core.practice;
    L.extra = {};
    if (Core.hw && Core.hw.active) {   // 跟打:盘面由 highway.js 整盘负责(预备青绿常亮、层指示、进度);引导链/练习/乐队侧灯全部让位
      const [ov, ex] = Core.hw.padFrame(t); L.overlay = ov; L.extra = ex;
      let frame = L.frame(dt); if (Core.device !== "ok") { const f = {}; for (const k in frame) f[k] = [0, 0, 0]; frame = f; } return frame;
    }
    if (pr) {
      const [ov, ex] = pr.render(t); L.overlay = ov; Object.assign(L.extra, ex);
    } else {
      L.overlay = {};
      const info = A.currentInfo(), side = [19, 29, 39, 49, 59, 69, 79, 89];
      side.forEach((s) => (L.extra[s] = [0, 0, 0]));
      if (A.bandOn && !Core.quiet()) {
        const [cr, cg, cb] = hsv([0, 0.11, 0.78, 0.92][info.idx || 0], 0.9, 0.9);
        side.slice(0, 4).forEach((s, i) => (L.extra[s] = i === info.beat ? [63, 63, 63] : [6, 6, 6]));
        side.slice(4).forEach((s) => (L.extra[s] = [cr, cg, cb]));
      }
    }
    Object.assign(L.extra, Core.guide.colors(A.bandOn, A.drumsOn, Core.keyCC, !!pr && !pr.intro));
    if (!pr && Core.guide.stage >= 4) Object.assign(L.extra, Core.extraTop);
    let frame = L.frame(dt);
    if (Core.device !== "ok") { const f = {}; for (const k in frame) f[k] = [0, 0, 0]; frame = f; }
    return frame;
  };
  Core.lights = L;

  /* ---------- 盘面 DOM ---------- */
  const KEYMAP = {};
  ["zxcvbnm,", "asdfghjk", "qwertyui", "12345678"].forEach((row, ri) => [...row].forEach((ch, ci) => (KEYMAP[ch] = (ri + 1) * 10 + ci + 1)));
  Core.keymap = KEYMAP;
  const els = {};
  Core.build = (root) => {
    root.innerHTML = "";
    const mk = (id, cls, label) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "lk " + cls; b.dataset.id = id; b.setAttribute("aria-label", label);
      els[id] = b; return b;
    };
    const corner = document.createElement("span"); corner.className = "lk-corner";
    for (let c = 104; c <= 111; c++) root.appendChild(mk(c, "round rtop", "顶排第 " + (c - 103) + " 个键"));
    root.appendChild(corner);
    for (let r = 8; r >= 1; r--) {
      for (let c = 1; c <= 8; c++) { const b = mk(r * 10 + c, "sq", "盘面 第" + r + "行第" + c + "列"); root.appendChild(b); }
      root.appendChild(mk(r * 10 + 9, "round rside", "右列第 " + r + " 个键"));
    }
    for (const ch in KEYMAP) if (els[KEYMAP[ch]]) els[KEYMAP[ch]].dataset.k = ch === "," ? "," : ch.toUpperCase();
    const down = new Map();
    root.addEventListener("pointerdown", (e) => {
      const b = e.target.closest(".lk"); if (!b) return;
      e.preventDefault(); const id = +b.dataset.id;
      down.set(e.pointerId, id); Core.press(id, true);
    });
    const up = (e) => { if (down.has(e.pointerId)) { Core.press(down.get(e.pointerId), false); down.delete(e.pointerId); } };
    root.addEventListener("pointerup", up); root.addEventListener("pointercancel", up);
    root.addEventListener("pointerleave", up);
  };
  const cache = {};
  Core.paint = (frame) => {
    for (const id in els) {
      const c = frame[id] || [0, 0, 0], key = c.join(",");
      if (cache[id] === key) continue; cache[id] = key;
      const e = els[id], f = c.map((v) => Math.round(Math.min(1, Math.pow(v / 63, 0.55)) * 255));
      const lum = (c[0] + c[1] + c[2]) / 189;
      e.style.background = lum < 0.01 ? "" : "rgb(" + f.join(",") + ")";
      e.style.boxShadow = lum > 0.45 ? "0 0 " + Math.round(lum * 16) + "px rgba(" + f.join(",") + ",0.55)" : "";
    }
  };
  const held = new Set();
  window.addEventListener("keydown", (e) => {
    if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    const tg = e.target; if (tg && /INPUT|TEXTAREA|SELECT/.test(tg.tagName)) return;
    if (e.shiftKey && /^Digit[1-8]$/.test(e.code)) { Core.press(103 + +e.code[5], true); e.preventDefault(); return; }
    const id = KEYMAP[e.key.toLowerCase()];
    if (id && !held.has(e.key)) { held.add(e.key); Core.press(id, true); }
  });
  window.addEventListener("keyup", (e) => {
    const id = KEYMAP[e.key.toLowerCase()];
    if (id && held.has(e.key)) { held.delete(e.key); Core.press(id, false); }
  });
  window.LPCore = Core;
})();
