/* v3:在 v2 基础上增加 16 段频谱(给 LED 屏墙的均衡器)。其余逻辑不变。
   v2:相对 v1 增加 事件队列(给舞台对拍)与电平分析器。
   自带合成器 + 节拍时钟 + 本地规则乐队(与 app/playground.py、app/band.py 同一套逻辑的 WebAudio 版)
   设计原型:不接真实 MIDI。实时路径不进网络。 */
(function () {
  "use strict";
  const TIMBRES = {
    lead: { h: [1, 0.35, 0.12], atk: 0.004, dec: 1.2, rel: 0.12 },
    bass: { h: [1, 0.5], atk: 0.006, dec: 0.45, rel: 0.10 },
    pad: { h: [1, 0.25], atk: 0.12, dec: 3.0, rel: 0.5 },
  };
  const CHORDS = [
    { name: "I", root: 0, tones: [0, 4, 7], tri: [0, 4, 7] },
    { name: "IV", root: 5, tones: [5, 9, 0], tri: [0, 4, 7] },
    { name: "V", root: 7, tones: [7, 11, 2], tri: [0, 4, 7] },
    { name: "vi", root: 9, tones: [9, 0, 4], tri: [0, 3, 7] },
  ];
  let ctx = null, master = null, analyser = null, fan = null, fbuf = null, bands = new Float32Array(16), recDest = null, lvBuf = null, lvSmooth = 0, waves = {}, noiseBuf = null;
  let volume = 0.8;
  const live = new Map();
  let timer = null, nextT = 0, beatTotal = 0, drumPos = 0, bpm = 100;
  const A = {
    bandOn: false, drumsOn: false, tonic: 60,
    chordIdx: 0, bias: [0.3, 0, 0, 0], recent: [], lastInputBeat: -999,
    infoQueue: [], info: { beat: 0, chord: "I", idx: 0, bar: 0 },
    started: false, previewing: false, onPreviewEnd: null,
  };

  function ensure() {
    if (ctx) { if (ctx.state === "suspended") ctx.resume(); return ctx; }
    const C = window.AudioContext || window.webkitAudioContext;
    ctx = new C({ latencyHint: "interactive" });
    master = ctx.createGain(); master.gain.value = volume;
    const comp = ctx.createDynamicsCompressor(); A.compNode = comp;   // master.js 把它改成近似限幅器(默认参数会把原曲的 drop 压得和铺垫一样响)
    master.connect(comp); comp.connect(ctx.destination);
    analyser = ctx.createAnalyser(); analyser.fftSize = 256; analyser.smoothingTimeConstant = 0.6;
    lvBuf = new Uint8Array(analyser.fftSize); comp.connect(analyser);
    fan = ctx.createAnalyser(); fan.fftSize = 512; fan.smoothingTimeConstant = 0.72; fbuf = new Uint8Array(fan.frequencyBinCount); comp.connect(fan);
    recDest = ctx.createMediaStreamDestination(); comp.connect(recDest);
    for (const k in TIMBRES) {
      const im = new Float32Array(TIMBRES[k].h.length + 1);
      TIMBRES[k].h.forEach((a, i) => (im[i + 1] = a));
      waves[k] = ctx.createPeriodicWave(new Float32Array(im.length), im);
    }
    noiseBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.2), ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    A.started = true;
    nextT = ctx.currentTime + 0.1;
    timer = setInterval(tick, 25);
    return ctx;
  }

  function voice(kind, midi, t0, gain, hold) {
    ensure();
    if (kind !== "lead") pushEv(kind, t0, midi);
    const T = TIMBRES[kind];
    const osc = ctx.createOscillator();
    osc.setPeriodicWave(waves[kind]);
    osc.frequency.value = 440 * Math.pow(2, (midi - 69) / 12);
    const env = ctx.createGain(), rel = ctx.createGain();
    const peak = 0.2 * (gain || 1);
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.linearRampToValueAtTime(peak, t0 + T.atk);
    env.gain.setTargetAtTime(0.0001, t0 + T.atk, T.dec);
    rel.gain.setValueAtTime(1, t0);
    osc.connect(env); env.connect(rel); rel.connect(master);
    osc.start(t0);
    const v = { osc, rel, T, ended: false };
    v.release = (t) => {
      if (v.ended) return;
      v.ended = true;
      rel.gain.setTargetAtTime(0, t, T.rel / 3);
      osc.stop(t + T.rel * 2.5);
    };
    if (hold != null) v.release(t0 + hold);
    return v;
  }

  /* 舞台对拍:合成器在"音频时钟"里排好的每个事件(t 为 ctx.currentTime 坐标)同时进入队列,
     舞台在 t + outputLatency 到来时触发对应的灯,这样画面对的是"耳朵听到"的时刻。 */
  const evq = [];
  function pushEv(kind, t, midi) { evq.push({ kind, t, midi }); if (evq.length > 160) evq.splice(0, evq.length - 160); }
  A.drainEvents = (fn) => {
    if (!ctx) return;
    const ol = Math.min(0.2, Math.max(0, ctx.outputLatency || ctx.baseLatency || 0.02));
    const due = ctx.currentTime - ol;
    for (let i = 0; i < evq.length;) { if (evq[i].t <= due) fn(evq.splice(i, 1)[0]); else i++; }
  };
  A.clearEvents = () => { evq.length = 0; };
  A.level = () => {
    if (!analyser) return 0;
    analyser.getByteTimeDomainData(lvBuf);
    let s = 0; for (let i = 0; i < lvBuf.length; i++) { const x = (lvBuf[i] - 128) / 128; s += x * x; }
    const r = Math.min(1, Math.sqrt(s / lvBuf.length) * 3.2);
    lvSmooth += (r - lvSmooth) * (r > lvSmooth ? 0.6 : 0.12);
    return lvSmooth;
  };
  // 16 段对数频谱(0~1),给舞台 LED 屏墙;没有声音时全 0
  A.spectrum = () => {
    if (!fan) return bands;
    fan.getByteFrequencyData(fbuf);
    const n = fbuf.length, sr = ctx.sampleRate;   // 每个 bin = sr/512 Hz
    for (let b = 0; b < 16; b++) {
      const f0 = 55 * Math.pow(2, b * 0.5), f1 = 55 * Math.pow(2, (b + 1) * 0.5);
      let i0 = Math.max(1, Math.floor(f0 / (sr / 512))), i1 = Math.min(n - 1, Math.max(i0, Math.floor(f1 / (sr / 512))));
      let m = 0; for (let i = i0; i <= i1; i++) m = Math.max(m, fbuf[i]);
      const v = Math.pow(m / 255, 1.6) * (1 + b * 0.05);
      bands[b] += (v - bands[b]) * (v > bands[b] ? 0.7 : 0.2);
    }
    return bands;
  };
  /* v3-master:给『大师演出』(master.js)用——总线与事件入口。其余行为不变。 */
  A.bus = () => { ensure(); return master; };
  A.pushEvent = (kind, t, midi) => pushEv(kind, t, midi);
  A.recordStream = () => { ensure(); return recDest.stream; };   // 录制分享:与舞台画面一起录进 webm
  A.now = () => (ctx ? ctx.currentTime : 0);

  function noteOn(id, midi) {
    ensure();
    if (live.size >= 24) { const k = live.keys().next().value; live.get(k).release(ctx.currentTime); live.delete(k); }
    const old = live.get(id); if (old) old.release(ctx.currentTime);
    live.set(id, voice("lead", midi, ctx.currentTime, 1));
  }
  function noteOff(id) {
    const v = live.get(id);
    if (v && ctx) { v.release(ctx.currentTime); live.delete(id); }
  }

  function kick(t) {
    pushEv("kick", t);
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.setValueAtTime(145, t); o.frequency.exponentialRampToValueAtTime(55, t + 0.1);
    g.gain.setValueAtTime(0.5, t); g.gain.setTargetAtTime(0.0001, t, 0.07);
    o.connect(g); g.connect(master); o.start(t); o.stop(t + 0.6);
  }
  function hat(t) {
    pushEv("hat", t);
    const s = ctx.createBufferSource(); s.buffer = noiseBuf;
    const f = ctx.createBiquadFilter(); f.type = "highpass"; f.frequency.value = 6000;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.12, t); g.gain.setTargetAtTime(0.0001, t, 0.015);
    s.connect(f); f.connect(g); g.connect(master); s.start(t); s.stop(t + 0.12);
  }

  /* 跟打模式用:军鼓、节拍点击、统一的鼓入口(都是 ctx 时钟里的精确起音) */
  function snare(t) {
    pushEv("snare", t);
    const s = ctx.createBufferSource(); s.buffer = noiseBuf;
    const f = ctx.createBiquadFilter(); f.type = "bandpass"; f.frequency.value = 1900; f.Q.value = 0.7;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.32, t); g.gain.setTargetAtTime(0.0001, t, 0.05);
    s.connect(f); f.connect(g); g.connect(master); s.start(t); s.stop(t + 0.2);
    const o = ctx.createOscillator(), og = ctx.createGain(); o.frequency.setValueAtTime(210, t); o.frequency.exponentialRampToValueAtTime(130, t + 0.08);
    og.gain.setValueAtTime(0.16, t); og.gain.setTargetAtTime(0.0001, t, 0.04); o.connect(og); og.connect(master); o.start(t); o.stop(t + 0.3);
  }
  A.drum = (kind, t, gain) => { ensure(); (kind === "kick" ? kick : kind === "snare" ? snare : hat)(t); };
  A.click = (t, accent) => { ensure(); const o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.value = accent ? 1760 : 1175; g.gain.setValueAtTime(accent ? 0.22 : 0.12, t); g.gain.setTargetAtTime(0.0001, t, 0.012); o.connect(g); g.connect(master); o.start(t); o.stop(t + 0.12); };
  A.context = () => ctx;
  A.outLatency = () => (ctx ? Math.min(0.2, Math.max(0, ctx.outputLatency || ctx.baseLatency || 0.02)) : 0.02);

  /* ---- 乐队 agent(规则,与 band.py 同)---- */
  function chooseChord() {
    const silent = beatTotal - A.lastInputBeat > 16;
    if (silent || !A.recent.length) { if (silent) A.chordIdx = 0; return; }
    let best = -1e9, bi = 0;
    CHORDS.forEach((c, i) => {
      let s = A.bias[i];
      for (const r of A.recent) {
        const age = beatTotal - r.born; if (age > 6) continue;
        const w = 1 - age / 7;
        s += c.tones.indexOf(r.pc) >= 0 ? w : -0.15 * w;
      }
      if (i === A.chordIdx) s += 0.25;
      if (s > best) { best = s; bi = i; }
    });
    A.chordIdx = bi;
  }
  function bandBeat(b, t) {
    if (b === 0) chooseChord();
    const c = CHORDS[A.chordIdx], tonic = A.tonic, base = tonic - 12 + c.root;
    if (b === 0) {
      voice("bass", base, t, 0.9, 0.9);
      c.tri.forEach((o) => voice("pad", tonic + c.root + o, t, 0.55, 2.4));
    } else if (b === 1) voice("bass", base, t, 0.5, 0.35);
    else if (b === 2) voice("bass", base + 7, t, 0.75, 0.6);
    else voice("bass", beatTotal % 8 < 4 ? base + 12 : base, t, 0.55, 0.4);
    A.infoQueue.push({ t, beat: b, chord: c.name, idx: A.chordIdx, bar: Math.floor(beatTotal / 4) });
  }
  function tick() {
    if (!ctx) return;
    while (nextT < ctx.currentTime + 0.12) {
      const spb = 60 / bpm, b = beatTotal % 4;
      if (A.bandOn) bandBeat(b, nextT);
      if (A.drumsOn) {
        [0, 0.5].forEach((o) => { (drumPos % 4 === 0 ? kick : hat)(nextT + o * spb); drumPos++; });
      }
      beatTotal++; nextT += spb;
    }
  }
  function currentInfo() {
    if (!ctx) return A.info;
    while (A.infoQueue.length && A.infoQueue[0].t <= ctx.currentTime) A.info = A.infoQueue.shift();
    return A.info;
  }

  A.ensure = ensure;
  A.noteOn = noteOn; A.noteOff = noteOff; A.voice = voice;
  A.heard = (midi) => {
    A.recent.push({ pc: (((midi - A.tonic) % 12) + 12) % 12, born: beatTotal });
    A.recent = A.recent.slice(-24); A.lastInputBeat = beatTotal;
  };
  A.setBandOn = (v) => { A.bandOn = v; if (!v) A.infoQueue = []; };
  A.setDrumsOn = (v) => { A.drumsOn = v; drumPos = 0; };
  A.setBpm = (v) => { bpm = v; };
  A.getBpm = () => bpm;
  A.setVolume = (v) => { volume = v; if (master) master.gain.value = v; };
  A.currentInfo = currentInfo;
  A.CHORDS = CHORDS;
  A.fanfare = (tonic) => { ensure(); [0, 4, 7, 12, 16].forEach((s, i) => voice("lead", tonic + 12 + s, ctx.currentTime + i * 0.11, 0.9, 0.6)); };
  A.latency = () => (ctx ? { base: ctx.baseLatency, out: ctx.outputLatency, sr: ctx.sampleRate, state: ctx.state } : null);

  /* 试听:把弹过的音 + 固定和弦走向 + 鼓,本地渲染(占位,不是 AI 成品) */
  let previewTimer = null;
  A.stopPreview = () => {
    if (previewTimer) { clearTimeout(previewTimer); previewTimer = null; }
    const was = A.previewing; A.previewing = false;
    if (was && A.onPreviewEnd) A.onPreviewEnd();
  };
  A.preview = (notes, tonic) => {
    ensure(); A.stopPreview();
    const t0 = ctx.currentTime + 0.15, spb = 0.5;
    const prog = [0, 3, 1, 2];
    const last = notes.length ? Math.max(...notes.map((n) => n.t + (n.dur || 0.4))) : 8;
    const total = Math.min(30, Math.max(8, last + 1));
    notes.forEach((n) => { if (n.t < total) voice("lead", n.midi, t0 + n.t, 1, Math.min(n.dur || 0.4, 1.2)); });
    const bars = Math.ceil(total / (spb * 4));
    for (let b = 0; b < bars; b++) {
      const c = CHORDS[prog[b % 4]], bt = t0 + b * spb * 4, base = tonic - 12 + c.root;
      voice("bass", base, bt, 0.9, 0.9);
      c.tri.forEach((o) => voice("pad", tonic + c.root + o, bt, 0.5, 1.8));
      voice("bass", base + 7, bt + spb * 2, 0.7, 0.6);
      for (let i = 0; i < 8; i++) (i % 4 === 0 ? kick : hat)(bt + (i * spb) / 2);
    }
    A.previewing = true;
    previewTimer = setTimeout(() => { previewTimer = null; A.stopPreview(); }, total * 1000 + 600);
  };
  window.LPAudio = A;
})();
