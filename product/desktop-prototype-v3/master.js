/* 大师演出(master.html)——引擎与界面。
   一句话:Pad 是指挥,屏幕是舞台。新手乱按也好听(音阶锁定 + 量化到 16 分音符 + 和声自动跟随),每个键都立刻点亮舞台,drop 由预编排的曲线爆发,
   而且 drop 是"你按下去才炸"的(盘面上唯一闪着青绿的键)。
   两种声源(同一套时间轴 / 同一套舞台):
     clip  = 原曲片段(Born Again, CC BY 4.0,126 BPM, Ab 大调;assets/born-again-clip.js 里是重新编码的 Opus + 每个 16 分音符的起音强度)——WebAudio 解码后用 BufferSource 逐小节排程,
             与合成器同一个 ctx 时钟(直接读 mp3 在 file:// 下被浏览器拦截;<audio> 元素的声音进不了分析器、也进不了录制,所以不用);
     synth = 自合成曲(同速度同调性同和弦进行,没有素材文件时的退路 / ?song=synth)。
   场景状态机(逐小节决定,提前 0.45 s 排程):break(4 小节循环,等你)→ 你按 DROP 键 → build(4 小节蓄力,末尾 0.30 s 静默)→ drop(16/8 小节)→ 退场 → break。
   舞台编排在 show.js(纯逻辑,可在 Node 里测),灯光导演在 director.js,渲染在 stage.js。 */
(function () {
  "use strict";
  const Core = window.LPCore, A = window.LPAudio, Stage = window.LPStage, Show = window.LPShow;
  const $ = (s, r) => (r || document).querySelector(s);
  const params = new URLSearchParams(location.search);
  const mqRed = window.matchMedia("(prefers-reduced-motion: reduce)");
  const ui = Object.assign({ reduced: null }, Core.load("lp3m.ui", {}));
  const effReduced = () => (ui.reduced == null ? mqRed.matches : ui.reduced);

  /* ---------- 音乐常数 ---------- */
  const BPM = 126, SPB = 60 / BPM, BAR = SPB * 4, S16 = SPB / 4, GAP = Show.P.gap;
  const MU = Show.MUSIC, VOICING = MU.VOICING, BASS = MU.BASS;   // 音阶锁定 / 量化 / 和声跟随的规则在 show.js(纯函数,Node 里测过)
  const SYN = { break: [3, 2, 3, 0], build: [1, 0, 3, 2], drop: [0, 2, 3, 3, 0, 2, 3, 3] };
  const LEN = { break: 4, build: 4 }, AUTO_BREAK_BARS = 12, LOOK = 0.45;
  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const nowS = () => performance.now() / 1000;

  /* ---------- 度量(自检读这里) ---------- */
  const M = { inputToFrame: [], evLag: [], frameMs: [], quantDelay: [], pressStamps: [], audit: { padFrames: 0, padViol: 0, worst: [] }, firstPress: null };
  const keep = (arr, v, n = 600) => { arr.push(v); if (arr.length > n) arr.shift(); };

  /* ---------- 舞台、导演、编排 ---------- */
  Stage.init($("#stage"), { quality: params.get("quality") || "auto", reduced: effReduced(), styleMode: "auto", capture: params.get("capture") === "1", forceGL: params.get("gl") === "1", gpuPref: params.get("gpu") === "high" ? "high-performance" : "default" });
  if (Stage.mode === "2d") { const n = $("#nogl"); n.hidden = false; n.textContent = "这台电脑的浏览器暂时用不了 3D 灯光(" + (Stage.reason || "WebGL 不可用") + "),已换成平面舞台,照样能玩。"; }
  const dir = Stage.dir, DS = dir.state;
  const show = Show.create({ Core, dir });
  const odu = dir.update;
  dir.update = (dt, t, inp) => { show.patch(inp, t, dt); const r = odu(dt, t, inp); return show.post(r, dt, t); };
  Core.skipGuide();
  Core.quiet = () => show.S.phase === "idle" || show.S.calm;     // 盘面:开场前/引导期间只绽放被按的键(舞台自己在 patch 里判断"开场前")
  Core.build($("#pad"));

  /* ---------- 引擎状态 ---------- */
  const E = { ctx: null, started: false, mode: "synth", T0: 0, g: 0, bars: [], st: { scene: "break", sceneG0: 0, launchG: null, auto: false }, live: new Map(), skipNote: null, clip: null, graph: null, lastOff: null, buildStartG: 0, rollNext: 0, rollT0: 0, dropBars: 8 };
  const pushEv = (kind, t, midi) => A.pushEvent(kind, t, midi);

  /* ---------- 原曲片段:解码一次,留着用 ---------- */
  const clipReady = (async () => {
    if (params.get("song") === "synth" || !window.LPClip) return null;
    try {
      const d = window.LPClip, bin = atob(d.b64), u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      const oc = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(2, 1, 48000);
      const buf = await oc.decodeAudioData(u8.buffer); E.clip = { buf, meta: d.meta, cue: d.cue, chords: d.chords }; return E.clip;
    } catch (e) { console.warn("原曲片段解码失败,改用自合成曲:", e && e.message); return null; }
  })();

  clipReady.then((c) => { document.body.dataset.song = c ? "clip" : "synth"; });

  /* ---------- 音频图与音色 ---------- */
  function makeIR(ctx, sec) { const n = Math.floor(ctx.sampleRate * sec), b = ctx.createBuffer(2, n, ctx.sampleRate); for (let ch = 0; ch < 2; ch++) { const d = b.getChannelData(ch); for (let i = 0; i < n; i++) { const k = i / n; d[i] = (Math.random() * 2 - 1) * Math.pow(1 - k, 3.2) * (k < 0.01 ? k / 0.01 : 1); } } return b; }
  function audioInit() {
    const ctx = A.ensure(), out = A.bus(), G = {};
    const gain = (v) => { const g = ctx.createGain(); g.gain.value = v; return g; };
    G.mix = gain(1); G.gate = gain(1); G.djf = ctx.createBiquadFilter(); G.djf.type = "lowpass"; G.djf.frequency.value = 22000; G.djf.Q.value = 0.7;
    G.mix.connect(G.gate); G.gate.connect(G.djf); G.djf.connect(out);
    G.drum = gain(1); G.drum.connect(G.mix); G.duck = gain(1); G.duck.connect(G.mix); G.music = gain(1); G.music.connect(G.duck);
    G.lead = gain(1); G.lead.connect(G.mix); G.clip = gain(0.85); G.clip.connect(G.mix);
    const dly = ctx.createDelay(1.5); dly.delayTime.value = SPB * 0.75; const fb = gain(0.34), lpf = ctx.createBiquadFilter(); lpf.type = "lowpass"; lpf.frequency.value = 2600;
    const dsend = gain(0.24); G.lead.connect(dsend); dsend.connect(dly); dly.connect(lpf); lpf.connect(fb); fb.connect(dly); lpf.connect(G.mix);
    const conv = ctx.createConvolver(); conv.buffer = makeIR(ctx, 1.7); const rsend = gain(0.22), rret = gain(0.9); G.lead.connect(rsend); G.music.connect(rsend); rsend.connect(conv); conv.connect(rret); rret.connect(G.mix);
    G.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate); const nd = G.noise.getChannelData(0); for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    E.graph = G; E.ctx = ctx; return G;
  }
  const O = (type, f, det) => { const o = E.ctx.createOscillator(); o.type = type; o.frequency.value = f; if (det) o.detune.value = det; return o; };
  const GN = (v) => { const g = E.ctx.createGain(); g.gain.value = v; return g; };
  const LP = (f, q) => { const b = E.ctx.createBiquadFilter(); b.type = "lowpass"; b.frequency.value = f; b.Q.value = q || 0.7; return b; };
  const noiseSrc = (t, dur) => { const s = E.ctx.createBufferSource(); s.buffer = E.graph.noise; s.loop = true; s.start(t, Math.random() * 1.5); s.stop(t + dur); return s; };
  const duckAt = (t) => { const p = E.graph.duck.gain; p.setValueAtTime(0.3, t); p.linearRampToValueAtTime(1, t + 0.2); };

  function kick(t, g) {
    const G = E.graph, o = O("sine", 155), a = GN(0); o.frequency.setValueAtTime(155, t); o.frequency.exponentialRampToValueAtTime(46, t + 0.11);
    a.gain.setValueAtTime(g * 0.9, t); a.gain.setTargetAtTime(0.0001, t + 0.012, 0.085); o.connect(a); a.connect(G.drum); o.start(t); o.stop(t + 0.5);
    const n = noiseSrc(t, 0.02), hp = E.ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 2500; const c = GN(0.2 * g); c.gain.setTargetAtTime(0.0001, t, 0.004); n.connect(hp); hp.connect(c); c.connect(G.drum);
    pushEv("kick", t);
  }
  function snare(t, g) {
    const G = E.graph, n = noiseSrc(t, 0.25), bp = E.ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 1900; bp.Q.value = 0.8; const a = GN(0.3 * g); a.gain.setTargetAtTime(0.0001, t, 0.055); n.connect(bp); bp.connect(a); a.connect(G.drum);
    const o = O("triangle", 200), b = GN(0.15 * g); o.frequency.exponentialRampToValueAtTime(130, t + 0.08); b.gain.setTargetAtTime(0.0001, t, 0.04); o.connect(b); b.connect(G.drum); o.start(t); o.stop(t + 0.3);
    pushEv("snare", t);
  }
  function clap(t, g) {
    const G = E.graph;[0, 0.011, 0.022].forEach((d, i) => { const n = noiseSrc(t + d, 0.3), bp = E.ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 1300; bp.Q.value = 0.9; const a = GN(0.2 * g); a.gain.setTargetAtTime(0.0001, t + d, i === 2 ? 0.07 : 0.012); n.connect(bp); bp.connect(a); a.connect(G.drum); });
    pushEv("snare", t);
  }
  function hat(t, g, open) {
    const G = E.graph, n = noiseSrc(t, open ? 0.5 : 0.15), hp = E.ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 7000; const a = GN(0.1 * g); a.gain.setTargetAtTime(0.0001, t, open ? 0.09 : 0.016); n.connect(hp); hp.connect(a); a.connect(G.drum);
    pushEv("hat", t);
  }
  function bassNote(midi, t, dur, g) {
    const G = E.graph, f = mtof(midi), o = O("sawtooth", f), s = O("sine", f), lp = LP(900, 3), a = GN(0), sg = GN(0.7);
    lp.frequency.setValueAtTime(900, t); lp.frequency.setTargetAtTime(240, t + 0.004, 0.09);
    a.gain.setValueAtTime(0, t); a.gain.linearRampToValueAtTime(0.2 * g, t + 0.006); a.gain.setValueAtTime(0.2 * g, t + dur); a.gain.setTargetAtTime(0, t + dur, 0.04);
    o.connect(lp); s.connect(sg); lp.connect(a); sg.connect(a); a.connect(G.music); o.start(t); s.start(t); o.stop(t + dur + 0.3); s.stop(t + dur + 0.3);
    pushEv("bass", t, midi);
  }
  function padChord(midis, t, dur, g) {
    const G = E.graph;
    midis.forEach((m) => {
      const f = mtof(m), lp = LP(500, 0.8), a = GN(0);
      lp.frequency.setValueAtTime(500, t); lp.frequency.linearRampToValueAtTime(1900, t + dur * 0.55); lp.frequency.linearRampToValueAtTime(700, t + dur);
      a.gain.setValueAtTime(0, t); a.gain.linearRampToValueAtTime(0.05 * g, t + 0.45); a.gain.setValueAtTime(0.05 * g, t + dur - 0.1); a.gain.linearRampToValueAtTime(0, t + dur + 0.5);
      [-7, 7].forEach((d) => { const o = O("sawtooth", f, d); o.connect(lp); o.start(t); o.stop(t + dur + 0.6); }); lp.connect(a); a.connect(G.music);
    });
  }
  function stab(midis, t, dur, g) {
    const G = E.graph;
    midis.forEach((m) => {
      const f = mtof(m + 12), lp = LP(4200, 1.2), a = GN(0);
      lp.frequency.setValueAtTime(4200, t); lp.frequency.setTargetAtTime(1100, t + 0.004, 0.12);
      a.gain.setValueAtTime(0, t); a.gain.linearRampToValueAtTime(0.05 * g, t + 0.004); a.gain.setTargetAtTime(0, t + 0.004 + Math.min(dur, 0.3) * 0.5, 0.1);
      [-12, 12].forEach((d) => { const o = O("sawtooth", f, d); o.connect(lp); o.start(t); o.stop(t + 0.9); }); lp.connect(a); a.connect(G.music);
    });
    pushEv("pad", t);
  }
  function pluck(midi, t, g, bright, dest) {
    const G = E.graph, f = mtof(midi), o = O("sawtooth", f), o2 = O("triangle", f * 2), lp = LP(bright || 3600, 1), a = GN(0);
    lp.frequency.setValueAtTime(bright || 3600, t); lp.frequency.setTargetAtTime(900, t + 0.004, 0.09);
    a.gain.setValueAtTime(0, t); a.gain.linearRampToValueAtTime(0.1 * g, t + 0.004); a.gain.setTargetAtTime(0, t + 0.004, 0.2);
    o.connect(lp); o2.connect(lp); lp.connect(a); a.connect(dest || G.lead); o.start(t); o2.start(t); o.stop(t + 1.1); o2.stop(t + 1.1);
  }
  function leadVoice(midi, t, vel) {
    const G = E.graph, f = mtof(midi), lp = LP(6200, 1.2), env = GN(0), rel = GN(1), sub = GN(0.3);
    lp.frequency.setValueAtTime(6200, t); lp.frequency.setTargetAtTime(1900, t + 0.004, 0.16);
    const pk = 0.16 * vel; env.gain.setValueAtTime(0, t); env.gain.linearRampToValueAtTime(pk, t + 0.004); env.gain.setTargetAtTime(pk * 0.55, t + 0.006, 0.5);
    const os = [O("sawtooth", f, -9), O("sawtooth", f, 9)], su = O("triangle", f / 2);
    os.forEach((o) => { const h = GN(0.5); o.connect(h); h.connect(lp); o.start(t); }); su.connect(sub); sub.connect(lp); su.start(t); lp.connect(env); env.connect(rel); rel.connect(G.lead);
    const v = { t0: t, ended: false, release(tr) { if (v.ended) return; v.ended = true; tr = Math.max(tr, E.ctx.currentTime); rel.gain.setTargetAtTime(0, tr, 0.07); const te = tr + 0.5; os.forEach((o) => o.stop(te)); su.stop(te); } };
    v.autoStop = t + 5; setTimeout(() => v.release(E.ctx.currentTime), Math.max(0, (v.autoStop - E.ctx.currentTime)) * 1000);
    return v;
  }
  function ghost(midi, t) {   // 量化延迟 > 40 ms 时,按下的那一刻先给一个极轻的"指尖声"(25 ms,-26 dB),触觉上不空
    const G = E.graph, o = O("sine", mtof(midi + 12)), a = GN(0.03); a.gain.setTargetAtTime(0.0001, t, 0.008); o.connect(a); a.connect(G.lead); o.start(t); o.stop(t + 0.06);
  }
  function riser(t, dur) {
    const G = E.graph, n = noiseSrc(t, dur + 0.1), bp = E.ctx.createBiquadFilter(); bp.type = "bandpass"; bp.Q.value = 3; bp.frequency.setValueAtTime(300, t); bp.frequency.exponentialRampToValueAtTime(9000, t + dur);
    const a = GN(0); a.gain.setValueAtTime(0, t); a.gain.linearRampToValueAtTime(0.26, t + dur); n.connect(bp); bp.connect(a); a.connect(G.mix);
    const o = O("sine", 180), b = GN(0); o.frequency.setValueAtTime(180, t); o.frequency.exponentialRampToValueAtTime(2200, t + dur); b.gain.setValueAtTime(0, t); b.gain.linearRampToValueAtTime(0.05, t + dur); o.connect(b); b.connect(G.mix); o.start(t); o.stop(t + dur + 0.05);
  }
  function whoosh(t) {   // 按下 DROP 的即时回应:一声上扬的气流
    const G = E.graph, n = noiseSrc(t, 0.7), bp = E.ctx.createBiquadFilter(); bp.type = "bandpass"; bp.Q.value = 1.5; bp.frequency.setValueAtTime(500, t); bp.frequency.exponentialRampToValueAtTime(5200, t + 0.6);
    const a = GN(0); a.gain.setValueAtTime(0, t); a.gain.linearRampToValueAtTime(0.14, t + 0.25); a.gain.setTargetAtTime(0, t + 0.3, 0.12); n.connect(bp); bp.connect(a); a.connect(G.mix);
  }
  function boom(t, big) {   // 仪式第一声 / drop 重击
    const G = E.graph, o = O("sine", big ? 70 : 90), a = GN(0); o.frequency.setValueAtTime(big ? 70 : 90, t); o.frequency.exponentialRampToValueAtTime(big ? 32 : 38, t + (big ? 0.8 : 0.5));
    a.gain.setValueAtTime(big ? 0.75 : 0.55, t); a.gain.setTargetAtTime(0.0001, t + 0.02, big ? 0.35 : 0.3); o.connect(a); a.connect(G.mix); o.start(t); o.stop(t + 1.6);
    const n = noiseSrc(t, big ? 1.8 : 1.2), hp = E.ctx.createBiquadFilter(); hp.type = big ? "highpass" : "lowpass"; hp.frequency.value = big ? 2500 : 900; const c = GN(big ? 0.28 : 0.1); c.gain.setTargetAtTime(0.0001, t + 0.03, big ? 0.5 : 0.5); n.connect(hp); hp.connect(c); c.connect(G.mix);
  }

  /* ---------- 小节排程:状态机 + 声音 + 视觉事件 ---------- */
  const chordFor = (scene, i, cb) => (E.mode === "clip" ? E.clip.chords[cb] : SYN[scene][i % SYN[scene].length]);
  function schedBar(g) {
    const st = E.st, t0 = E.T0 + g * BAR; let n = g - st.sceneG0;
    if (st.scene === "break" && st.launchG != null && g >= st.launchG) { st.scene = "build"; st.sceneG0 = g; n = 0; st.launchG = null; }
    else if (st.scene === "build" && n >= LEN.build) { st.scene = "drop"; st.sceneG0 = g; n = 0; }
    else if (st.scene === "drop" && n >= E.dropBars) { st.scene = "break"; st.sceneG0 = g; n = 0; st.auto = false; }
    const scene = st.scene, i = scene === "break" ? n % 4 : n, first = n === 0;
    const cb = E.mode === "clip" ? (scene === "break" ? i : scene === "build" ? 4 + i : 8 + i) : -1, chord = chordFor(scene, i, cb);
    const info = { g, scene, i, n, chord, cb, t: t0 }; E.bars[g] = info; if (E.bars.length > 80) delete E.bars[g - 80];
    pushEv("m:bar:" + g, t0); for (let b = 0; b < 4; b++) pushEv("m:beat:" + b, t0 + b * SPB);
    if (first) pushEv("m:scene:" + scene, t0);
    if (scene === "break" && !st.auto && st.launchG == null && n >= AUTO_BREAK_BARS) { st.auto = true; requestLaunch(true); }
    if (E.mode === "clip") clipBar(info); else synthBar(info);
    // 蓄力的最后一小节:末尾 GAP 秒静默(灯先黑);drop 第一小节:重击
    if (scene === "build" && i === 3) { const tg = t0 + BAR - GAP; pushEv("m:gap", tg); if (E.mode === "synth") { const p = E.graph.gate.gain; p.setValueAtTime(1, tg - 0.012); p.linearRampToValueAtTime(0, tg); p.setValueAtTime(0, t0 + BAR - 0.004); p.linearRampToValueAtTime(1, t0 + BAR + 0.004); } }
    if (scene === "drop" && i === 0) { pushEv("m:impact", t0); boom(t0, true); stab(VOICING[0], t0, 0.6, 1.4); }
    if (scene === "drop" && i === E.dropBars - 1) {   // 退场:最后一小节低通合上,下一小节开头重新打开
      pushEv("m:exhale", t0); const p = E.graph.djf.frequency; p.setValueAtTime(22000, t0); p.exponentialRampToValueAtTime(500, t0 + BAR * 0.97); p.setValueAtTime(500, t0 + BAR - 0.002); p.exponentialRampToValueAtTime(22000, t0 + BAR + 0.7);
    }
    return info;
  }
  function clipBar(info) {
    const ctx = E.ctx, G = E.graph, buf = E.clip.buf, off = info.cb * BAR, XF = 0.02, t0 = info.t, so = Math.max(0, off - XF), lead = off - so;
    const src = ctx.createBufferSource(); src.buffer = buf; const gn = ctx.createGain();
    gn.gain.setValueAtTime(0, t0 - lead); gn.gain.linearRampToValueAtTime(1, t0); gn.gain.setValueAtTime(1, t0 + BAR); gn.gain.linearRampToValueAtTime(0, t0 + BAR + XF);
    src.connect(gn); gn.connect(G.clip); src.start(t0 - lead, so); src.stop(t0 + BAR + XF + 0.02);
    // 视觉事件:来自离线分析的每个 16 分音符起音强度(灯"提前知道"歌里发生了什么)
    const c = E.clip.cue;
    for (let s = 0; s < 16; s++) {
      const k = info.cb * 16 + s, t = t0 + s * S16, lo = c.lo[k], mid = c.mid[k], hi = c.hi[k];
      if (lo >= 55 && (s % 4 === 0 || lo >= 85)) pushEv("kick", t); else if (lo >= 40) pushEv("bass", t);
      if (mid >= 60 && (s === 4 || s === 12 || mid >= 90)) pushEv("snare", t);
      if (hi >= 50) pushEv("hat", t);
    }
    pushEv("pad", t0);
  }
  function synthBar(info) {
    const { scene, i, chord, t: t0 } = info, V = VOICING[chord], tones = V.map((m) => m + 12), root = BASS[chord], T = (s) => t0 + s * S16;
    padChord(V, t0, BAR, scene === "drop" ? 0.7 : 1); pushEv("pad", t0);
    if (scene === "break") {
      bassNote(root + 12, t0, BAR * 0.9, 0.55);
      for (let s = 0; s < 16; s += (i < 2 ? 2 : 1)) pluck(tones[[0, 1, 2, 1, 0, 2, 1, 2][(s >> (i < 2 ? 1 : 0)) % 8]] + (s % 4 === 3 ? 12 : 0), T(s), 0.42, 3000);
      for (const s of [2, 6, 10, 14]) hat(T(s), 0.55, false);
    } else if (scene === "build") {
      if (i === 0) riser(t0, 4 * BAR - GAP);
      if (i <= 1) for (const s of [0, 4, 8, 12]) { kick(T(s), 0.85); duckAt(T(s)); } else if (i === 2) for (const s of [0, 8]) { kick(T(s), 0.7); duckAt(T(s)); }
      const sn = i === 0 ? [4, 12] : i === 1 ? [0, 4, 8, 12] : i === 2 ? [0, 2, 4, 6, 8, 10, 12, 14] : [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
      sn.forEach((s, k) => snare(T(s), 0.3 + 0.1 * i + 0.012 * k));
      bassNote(root + 12, t0, BAR * 0.9, 0.6);
    } else {
      for (const s of [0, 4, 8, 12]) { kick(T(s), 1); duckAt(T(s)); }
      for (const s of [4, 12]) clap(T(s), 0.9);
      for (let s = 0; s < 16; s++) if (s % 2 === 1) hat(T(s), 0.4, false); else if (s % 4 === 2) hat(T(s), 0.6, true);
      [2, 6, 10, 14].forEach((s, k) => bassNote(root + (k % 2 ? 12 : 0), T(s), S16 * 1.6, 0.9));
      [[0, 1], [3, 0.6], [6, 0.7], [10, 0.7], [12, 0.6]].forEach(([s, g]) => stab(V, T(s), S16 * 1.8, g));
      for (let s = 1; s < 16; s += 2) pluck(tones[[0, 2, 1, 2][(s >> 1) % 4]] + 12, T(s), 0.32, 4200);
    }
  }
  function requestLaunch(auto) {
    const st = E.st; if (!E.started || st.scene !== "break" || st.launchG != null) return false;
    const now = E.ctx.currentTime; let b = E.g;
    while ((b - st.sceneG0) % 2 !== 0 || E.T0 + b * BAR < now + 0.25) b++;
    st.launchG = b; show.cue("armed", nowS());
    if (!auto) { whoosh(now + 0.005); }
    return true;
  }
  function tickEngine() {
    if (!E.started) return;
    const ctx = E.ctx;
    while (E.T0 + E.g * BAR < ctx.currentTime + LOOK) { schedBar(E.g); E.g++; }
    // ROLL:按住时 16 分 → 32 分的军鼓滚奏
    if (rollHeld) {
      if (!E.rollNext || E.rollNext < ctx.currentTime) E.rollNext = Math.ceil((ctx.currentTime - E.T0) / S16) * S16 + E.T0;
      const held = ctx.currentTime - E.rollT0, step = held > 2.2 ? S16 / 2 : S16;
      while (E.rollNext < ctx.currentTime + 0.12) { snare(E.rollNext, 0.45 + Math.min(0.4, held * 0.15)); E.rollNext += step; }
    }
  }
  let rollHeld = false, filterHeld = false;

  /* ---------- 开场仪式(第一次按键) ---------- */
  function firstPress(id) {
    const tp = nowS(); show.begin(tp);     // 先把导演从"安静"里叫醒,否则这一下按键会被吞
    const clip = E.clip && params.get("song") !== "synth" ? E.clip : null;
    E.mode = clip ? "clip" : "synth"; E.dropBars = clip ? clip.meta.dropBars : 8;
    const G = E.graph, ctx = E.ctx; ctx.resume(); const now = ctx.currentTime;   // 音频图在页面加载时已经建好(第一次按键只做 resume + 排程,不卡这一帧)
    E.T0 = now + 0.1; E.g = 0; E.started = true; E.st = { scene: "break", sceneG0: 0, launchG: null, auto: false };
    // 声音:立刻一记低沉的重击 + 这一下按下的音;滤波从闷到亮 6 秒打开;原曲 1.5 秒淡入
    boom(now + 0.004, false);
    G.djf.frequency.setValueAtTime(260, now); G.djf.frequency.exponentialRampToValueAtTime(22000, now + 6);
    G.clip.gain.setValueAtTime(0, now); G.clip.gain.linearRampToValueAtTime(0.85, now + 1.6);
    const r = Math.floor(id / 10), c = id % 10; leadNote(id, r, c, now + 0.004, true);
    // 琶音:8 个音(Ab 五声音阶上行)落在 8 分音符格上,每个音点亮一盏灯(列 = 灯)
    const arp = [56, 60, 63, 65, 68, 72, 75, 77];
    arp.forEach((m, i) => { const t = E.T0 + i * SPB / 2; pluck(m, t, 0.55 + 0.04 * i, 5200); pushEv("m:ign:" + i, t); });
    E.skipNote = id; M.firstPress = { at: tp, mode: E.mode };
    schedBar(0); E.g = 1;
  }

  /* ---------- 弹奏:量化 + 和声 ---------- */
  const padMidi = MU.padMidi, harmonyOf = MU.harmonyOf;
  function chordAt(t) { const g = Math.floor((t - E.T0) / BAR), b = E.bars[g] || E.bars[g - 1] || E.bars[g + 1]; return b ? b.chord : 0; }
  function leadNote(id, r, c, tOn, immediate) {
    let m = padMidi(r, c); const chord = chordAt(tOn), step = ((Math.round((tOn - E.T0) / S16) % 16) + 16) % 16;
    if (!immediate) m = MU.adjust(m, chord, step);   // 强拍吸附到和弦音;V 级上的 Ab 下落半音
    const v = leadVoice(m, tOn, 1); E.live.set(id, v);
    pluck(harmonyOf(m, chord), tOn + 0.002, 0.5, 2800);                                  // 和声自动跟随:低三度/五度的和弦音
    pushEv("m:lead:" + id, tOn);
    return m;
  }
  A.noteOn = (id) => {
    if (!E.started) return;
    if (E.skipNote === id) { E.skipNote = null; return; }
    const ctx = E.ctx, now = ctx.currentTime, r = Math.floor(id / 10), c = id % 10;
    const q = MU.quantize(now, E.T0, S16), tOn = q.tOn, off = q.off;   // 刚过格立刻响(最多晚 26 ms),否则落到下一个 16 分格(最多等 93 ms)
    E.lastOff = off; keep(M.quantDelay, (tOn - now) * 1000);
    const m = leadNote(id, r, c, tOn, false);
    if (tOn - now > 0.04) ghost(m, now + 0.002);
  };
  A.noteOff = (id) => { const v = E.live.get(id); if (v && E.ctx) { v.release(Math.max(E.ctx.currentTime, v.t0 + 0.12)); E.live.delete(id); } };
  A.heard = () => {};

  /* ---------- 事件:音频时钟里的"那一刻" → 舞台 ---------- */
  const origDrain = A.drainEvents;
  A.drainEvents = (fn) => origDrain((ev) => {
    if (E.ctx) keep(M.evLag, (E.ctx.currentTime - A.outLatency() - ev.t) * 1000);
    if (ev.kind.charCodeAt(0) === 109 && ev.kind.charCodeAt(1) === 58) handleM(ev); else fn(ev);
  });
  function handleM(ev) {
    const p = ev.kind.split(":"), type = p[1], t = nowS();
    if (type === "lead") {   // 声音真正响起的瞬间:盘面那个键再亮一次、对应的灯再顶一下(按下的那一刻已经亮过了——这是"音"的同步点)
      const id = +p[2], r = Math.floor(id / 10), c = id % 10;
      Core.lights.flash[id] = [1, Core.noteRgb(r, c)]; DS.e[c - 1] = Math.max(DS.e[c - 1], 1);
    } else if (type === "ign") show.ignite(+p[2], t);
    else if (type === "scene") show.cue("scene", t, { scene: p[2], dur: LEN.build * BAR });
    else if (type === "bar") { const b = E.bars[+p[2]]; show.cue("bar", t, { bar: +p[2], chord: b ? b.chord : 0 }); }
    else if (type === "beat") show.cue("beat", t, { beat: +p[2] });
    else if (type === "gap") show.cue("gap", t);
    else if (type === "impact") show.cue("impact", t, {});
    else if (type === "exhale") show.cue("exhale", t, { dur: BAR });
  }

  /* ---------- 控制键 ---------- */
  function control(id, down) {
    if (!E.started || show.S.phase === "ritual") return;
    if (id === 107 && down) {
      Core.lights.flash[107] = [1, [63, 4, 0]];
      if (E.st.scene === "break") requestLaunch(false);
    } else if (id === 108) {
      rollHeld = down; show.setHeld("roll", down); if (down) { E.rollT0 = E.ctx.currentTime; E.rollNext = 0; }
    } else if (id === 109) {
      filterHeld = down; show.setHeld("filter", down); const p = E.graph.djf.frequency, t = E.ctx.currentTime;
      p.cancelScheduledValues(t); p.setValueAtTime(p.value, t); p.setTargetAtTime(down ? 380 : 22000, t, down ? 0.16 : 0.05);
    }
  }
  const inner = Core.press;
  Core.press = (id, down) => {
    const tp = performance.now();
    if (down) M.pressStamps.push(tp);
    if (id >= 104 && id <= 111) { control(id, down); return; }
    const r = Math.floor(id / 10), c = id % 10; if (r < 1 || r > 8 || c < 1 || c > 8) return;
    if (down && !E.started) firstPress(id);
    E.lastOff = null; inner(id, down);
    if (down && E.started && E.lastOff != null) show.note({ t: tp / 1000, pad: id, off: E.lastOff, s16: S16, gesture: dir.rig.gesture });
  };

  /* ---------- 键盘:A S D F J K L ; 为中排(第 2 行),上下各一排;Shift 抬高四行;Space = DROP ---------- */
  const ROWS = [["KeyZ", "KeyX", "KeyC", "KeyV", "KeyM", "Comma", "Period", "Slash"], ["KeyA", "KeyS", "KeyD", "KeyF", "KeyJ", "KeyK", "KeyL", "Semicolon"], ["KeyQ", "KeyW", "KeyE", "KeyR", "KeyU", "KeyI", "KeyO", "KeyP"], ["Digit1", "Digit2", "Digit3", "Digit4", "Digit7", "Digit8", "Digit9", "Digit0"]];
  const CODE = {}; ROWS.forEach((row, ri) => row.forEach((cd, ci) => (CODE[cd] = [ri + 1, ci + 1]))); CODE.Space = 107; CODE.KeyG = 109; CODE.KeyH = 108;
  const heldKeys = new Map();
  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === "Escape") { if (document.body.classList.contains("perf")) setPerf(false); return; }
    if (e.code === "Backquote") { setPerf(!document.body.classList.contains("perf")); e.preventDefault(); return; }
    const m = CODE[e.code]; if (!m) return;
    e.preventDefault(); e.stopImmediatePropagation(); if (e.repeat || heldKeys.has(e.code)) return;
    const id = typeof m === "number" ? m : (m[0] + (e.shiftKey ? 4 : 0)) * 10 + m[1];
    heldKeys.set(e.code, id); Core.press(id, true);
  }, true);
  window.addEventListener("keyup", (e) => { const id = heldKeys.get(e.code); if (id != null) { heldKeys.delete(e.code); Core.press(id, false); e.preventDefault(); e.stopImmediatePropagation(); } }, true);
  window.addEventListener("blur", () => { heldKeys.forEach((id) => Core.press(id, false)); heldKeys.clear(); });
  (function labels() {
    ROWS.forEach((row, ri) => row.forEach((cd, ci) => { const el = $('#pad .lk[data-id="' + ((ri + 1) * 10 + ci + 1) + '"]'); if (el) el.dataset.k = cd.replace("Key", "").replace("Digit", "").replace("Semicolon", ";").replace("Comma", ",").replace("Period", ".").replace("Slash", "/"); }));
    [["107", "␣"], ["108", "H"], ["109", "G"]].forEach(([id, k]) => { const el = $('#pad .lk[data-id="' + id + '"]'); if (el) el.dataset.k = k; });
    $("#pad").classList.add("keys");
  })();

  /* ---------- 界面 ---------- */
  const LV_TEXT = ["", "每个键点亮一盏灯", "左右对称,后排灯加入", "全场扫灯,光束随乐句抬头", "金粉、扇形开灯、满功率 drop"];
  let lvT = 0;
  show.S.onLevel = (lv, name) => { const el = $("#lvlTitle"); el.innerHTML = "<b></b><span></span>"; $("b", el).textContent = name; $("span", el).textContent = LV_TEXT[lv]; el.classList.remove("on"); void el.offsetWidth; el.classList.add("on"); clearTimeout(lvT); lvT = setTimeout(() => el.classList.remove("on"), 2600); };
  function toast(msg) { const t = $("#toast"); t.textContent = msg; t.classList.add("on"); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("on"), 2200); }
  function setPerf(on) {
    document.body.classList.toggle("perf", on); Stage.setOptions({ perf: on }); $("#perfBtn").setAttribute("aria-pressed", on);
    if (on) { try { document.documentElement.requestFullscreen && document.documentElement.requestFullscreen().catch(() => {}); } catch (e) { /* 浏览器不允许时仍是窗口内表演 */ } }
    else { try { document.fullscreenElement && document.exitFullscreen(); } catch (e) { /* 无害 */ } }
    window.dispatchEvent(new Event("resize"));
  }
  $("#perfBtn").onclick = () => setPerf(!document.body.classList.contains("perf"));
  document.addEventListener("fullscreenchange", () => { if (!document.fullscreenElement && document.body.classList.contains("perf")) setPerf(false); });
  const rb = $("#redBtn"); const paintRed = () => { rb.setAttribute("aria-pressed", effReduced()); rb.textContent = effReduced() ? "动效:减少" : "动效:完整"; };
  rb.onclick = () => { ui.reduced = !effReduced(); Core.save("lp3m.ui", ui); Stage.setOptions({ reduced: effReduced() }); paintRed(); toast(effReduced() ? "已减少动效:无闪光、镜头不动、无彩带" : "已恢复完整动效"); }; paintRed();
  const sb = $("#songBtn"); sb.textContent = params.get("song") === "synth" ? "声源:自合成" : "声源:原曲片段"; sb.onclick = () => { const u = new URL(location.href); if (params.get("song") === "synth") u.searchParams.delete("song"); else u.searchParams.set("song", "synth"); location.href = u.href; };
  let stillT = 0; window.addEventListener("pointermove", () => { document.body.classList.remove("still"); clearTimeout(stillT); stillT = setTimeout(() => document.body.classList.add("still"), 2600); });
  mqRed.addEventListener && mqRed.addEventListener("change", () => { Stage.setOptions({ reduced: effReduced() }); paintRed(); });

  const SCENE_NAME = { break: "铺垫", build: "蓄力", drop: "DROP" }, elScene = $("#sceneName"), elTicks = $("#ticks"), elLvl = $("#lvlName"), elMeter = $("#lvlFill"), hintEl = $("#hint"), hintText = $("#hintText"), sw = $("#sw"), elCredit = $("#credit");
  const css = (c) => "rgb(" + c.map((v) => Math.round(Math.min(1, Math.pow(v / 63, 0.55)) * 255)).join(",") + ")";
  let lastScene = "", lastTicks = "", lastLv = -1;
  function guideNow() {
    if (!E.started) return true;                                   // 开场前:唯一的引导 = 45 号键闪烁
    if (show.S.phase !== "play") return false;
    const b = curBar(); return !!b && b.scene === "break" && b.n >= 2 && E.st.launchG == null && !show.S.armed;
  }
  function curBar() { if (!E.started) return null; const t = E.ctx.currentTime - A.outLatency(), g = Math.floor((t - E.T0) / BAR); return g >= 0 ? E.bars[g] || null : null; }
  function hud() {
    const S = show.S, g = S.guide;
    const msg = !E.started ? "按闪着的键" : g ? "按闪着的键" : "";
    if (hintText.textContent !== msg) { hintText.textContent = msg; hintEl.style.display = msg ? "" : "none"; }
    sw.style.background = g ? css(Core.cue(nowS())) : "";
    document.body.classList.toggle("guided", g);
    document.body.classList.toggle("idle", !E.started);
    const b = curBar(), sc = b ? b.scene : "";
    if (sc !== lastScene) { lastScene = sc; elScene.textContent = SCENE_NAME[sc] || ""; document.body.dataset.scene = sc; }
    const n = sc === "break" ? 4 : sc === "build" ? 4 : sc === "drop" ? E.dropBars : 0, cur = b ? (sc === "break" ? b.i : b.n) : -1, key = sc + ":" + cur;
    if (key !== lastTicks) { lastTicks = key; let h = ""; for (let i = 0; i < n; i++) h += '<i class="' + (i === cur ? "cur" : i < cur ? "past" : "") + '"></i>'; elTicks.innerHTML = h; }
    if (S.level !== lastLv) { lastLv = S.level; elLvl.textContent = Show.LEVELS[S.level]; }
    elMeter.style.width = Math.round(S.M * 100) + "%";
    const arm = E.st.launchG != null && sc === "break"; document.body.classList.toggle("armed", arm);
  }

  /* ---------- 盘面灯的运行时审计(青绿只许出现在"引导"该出现的键上) ---------- */
  const GD = Core.GUIDE, GO = Core.GUIDE_OFF, eq3 = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
  function auditPad(fr) {
    M.audit.padFrames++;
    for (const k in fr) {
      const c = fr[k], isG = eq3(c, GD) || eq3(c, GO);
      if (isG) { if (!(+k === Show.P.startPad && !E.started) && !(+k === 107 && show.S.guide && E.started)) { M.audit.padViol++; if (M.audit.worst.length < 3) M.audit.worst.push("guide@" + k); } }
      else { const mx = Math.max(c[0], c[1], c[2]); if (mx > 8) { const mn = Math.min(c[0], c[1], c[2]), d = mx - mn; if (d / mx >= 0.25) { const h = mx === c[0] ? ((c[1] - c[2]) / d) % 6 : mx === c[1] ? (c[2] - c[0]) / d + 2 : (c[0] - c[1]) / d + 4, hh = ((h / 6) % 1 + 1) % 1; if (hh >= 0.40 && hh <= 0.55) { M.audit.padViol++; if (M.audit.worst.length < 3) M.audit.worst.push("hue@" + k + " " + c.join(",")); } } } }
    }
  }

  /* ---------- 主循环 ---------- */
  let last = nowS();
  function loop() {
    const t = nowS(), dt = Math.min(0.1, t - last); last = t; keep(M.frameMs, dt * 1000);
    tickEngineSoft();
    show.setGuide(guideNow());
    const fr = Core.tick();
    show.padFrame(fr, t, { cue: Core.cue(t), chord: show.S.chord, beat: show.S.beat });
    auditPad(fr); Core.paint(fr);
    Stage.render(fr, dt, t);
    const tn = performance.now(); while (M.pressStamps.length) keep(M.inputToFrame, tn - M.pressStamps.shift());   // 按下 → 这一帧提交渲染:≤ 1 帧(16.7 ms)
    hud();
    requestAnimationFrame(loop);
  }
  let lastTick = 0; function tickEngineSoft() { const n = performance.now(); if (n - lastTick > 20) { lastTick = n; tickEngine(); } }
  // 页面一加载就把音频图建好(AudioContext 会停在 suspended,第一次按键 resume);同时把总压缩器改成近似限幅器
  try { audioInit(); const cn = A.compNode; if (cn) { cn.threshold.value = -3; cn.knee.value = 4; cn.ratio.value = 16; cn.attack.value = 0.002; cn.release.value = 0.12; } } catch (e) { console.warn("音频初始化失败:", e && e.message); }
  setInterval(tickEngine, 25);    // 排程不能依赖 rAF(后台标签页会降频);rAF 里的是补充
  if (params.get("perf") === "1") setPerf(true);

  /* ---------- 对外(自检 / 调试) ---------- */
  const pct = (a, p) => { if (!a.length) return null; const b = a.slice().sort((x, y) => x - y); return +b[Math.min(b.length - 1, Math.floor(b.length * p))].toFixed(2); };
  window.__master = {
    Core, A, Stage, show, E, M, params,
    summary() { return { inputToFrame: { n: M.inputToFrame.length, p50: pct(M.inputToFrame, 0.5), p95: pct(M.inputToFrame, 0.95), max: pct(M.inputToFrame, 1) }, evLag: { n: M.evLag.length, p50: pct(M.evLag, 0.5), p95: pct(M.evLag, 0.95), max: pct(M.evLag, 1) }, frame: { n: M.frameMs.length, p50: pct(M.frameMs, 0.5), p95: pct(M.frameMs, 0.95), max: pct(M.frameMs, 1) }, quantDelay: { n: M.quantDelay.length, p50: pct(M.quantDelay, 0.5), p95: pct(M.quantDelay, 0.95), max: pct(M.quantDelay, 1) }, audit: M.audit }; },
    debug: { launchNow() { return requestLaunch(false); }, curBar, setMastery: (m) => show.setMastery(m), mode: () => E.mode, clipReady },
  };
  requestAnimationFrame(loop);
})();
