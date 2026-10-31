/* 演示谱面《电音小样》——自合成,不含任何受版权保护的旋律/采样。
   格式见 product/跟打模式-设计.md 第 6 节(JSON 可序列化;时间单位=拍;为"AI 从歌曲生成谱面"预留同一结构)。
   这里用代码生成 notes 数组只是为了写得短,生成结果是纯数据,注册时不带任何函数。
   结构:4 个声部,每个声部一个"段"(6 小节 = 24 拍 = 12 秒 @120 BPM),按 鼓 → 贝斯 → 和弦 → 旋律 叠加;
   一个声部在自己的段里由玩家亲手打(判定),打得够好就被"锁定",之后各段由乐队按谱精确接力回放(没打好则后面静默)。
   谱面作者规则:玩家要打的段里,最后一个音必须在段尾前 1 拍结束(给判定与锁定决策留出空档);同一时刻一个声部最多一个音。 */
(function (root) {
  "use strict";
  const BPM = 120, SEC_BARS = 6, BEATS = 4, SEC_BEATS = SEC_BARS * BEATS;
  // 和弦走向(C 大调):Am F C G F G,每段一遍;lane = 该和弦在盘面上的列(贝斯与和弦共用同一列,行不同)
  const CH = [
    { n: "Am", root: 45, tri: [57, 60, 64], col: 2 }, { n: "F", root: 41, tri: [53, 57, 60], col: 4 },
    { n: "C", root: 48, tri: [60, 64, 67], col: 6 }, { n: "G", root: 43, tri: [55, 59, 62], col: 8 },
  ];
  const PROG = [0, 1, 2, 3, 1, 3];
  const layers = [
    { id: "drums", name: "鼓", hue: 0.07, section: 0, row: 1, tip: "先打鼓:光落在哪格就按哪格" },
    { id: "bass", name: "贝斯", hue: 0.92, section: 1, row: 2, tip: "鼓已经在响了,再加上贝斯" },
    { id: "chords", name: "和弦", hue: 0.78, section: 2, row: 3, tip: "按住和弦,到光条尾部再松开" },
    { id: "melody", name: "旋律", hue: 0.14, section: 3, row: 4, tip: "最后一层:旋律" },
  ];
  const sections = layers.map((L, i) => ({ id: "s" + (i + 1), name: L.name, layer: L.id, b0: i * SEC_BEATS, b1: (i + 1) * SEC_BEATS }));
  const END = 4 * SEC_BEATS;
  const notes = [];
  const add = (t, d, layer, pad, v, adv) => { const o = { t: +t.toFixed(3), d: +d.toFixed(3), layer, pad, v }; if (adv) o.adv = adv; notes.push(o); };
  const ownEnd = (layer) => sections[layers.findIndex((l) => l.id === layer)].b1;
  const own = (layer, t) => { const s = sections[layers.findIndex((l) => l.id === layer)]; return t >= s.b0 && t < s.b1; };
  const keep = (layer, t, d) => !own(layer, t) || t + d <= ownEnd(layer) - 1;   // 段尾空一拍

  // 鼓:底鼓 col3、军鼓 col5、踩镲 col7,都在第 1 行。自己那一段的前 3 小节只有底鼓+军鼓,后 3 小节加踩镲
  for (let g = 0; g < END / BEATS; g++) {
    const b = g * BEATS, barInSec = g % SEC_BARS, ownSec = g < SEC_BARS, full = !ownSec || barInSec >= 3;
    [[0, 3, "kick"], [2, 3, "kick"], [1, 5, "snare"], [3, 5, "snare"]].forEach(([o, c, k]) => keep("drums", b + o, 0.1) && add(b + o, 0.1, "drums", 10 + c, { k }));
    if (full) [0.5, 1.5, 2.5, 3.5].forEach((o) => keep("drums", b + o, 0.1) && add(b + o, 0.1, "drums", 17, { k: "hat" }));
  }
  // 贝斯:第 2 行,每小节 4 个音(两个按住 + 两个短点;同一个键上相邻两个音之间至少空 0.25 拍,手指要能抬起来再按),列 = 和弦所在列
  for (let g = SEC_BARS; g < END / BEATS; g++) {
    const ch = CH[PROG[g % SEC_BARS]], b = g * BEATS, pad = 20 + ch.col;
    [[0, 1, 0], [1.5, 0.25, 0], [2, 1, 0], [3.5, 0.25, 12]].forEach(([o, d, oct]) => keep("bass", b + o, d) && add(b + o, d, "bass", pad, { k: "bass", m: ch.root + oct }));
  }
  // 和弦:第 3 行,每小节一个长按(2.5 拍)+ 一个短切分(第 4 拍)
  for (let g = 2 * SEC_BARS; g < END / BEATS; g++) {
    const ch = CH[PROG[g % SEC_BARS]], b = g * BEATS, pad = 30 + ch.col;
    [[0, 2.5], [3, 0.25]].forEach(([o, d]) => keep("chords", b + o, d) && add(b + o, d, "chords", pad, { k: "chord", m: ch.tri }));
  }
  // 旋律:第 4 行(入门);标 adv 的音在"进阶两行"时改按第 5 行同音的键(盘面上同一个音有两个键)
  const row4 = { 74: 1, 76: 2, 79: 3, 81: 4, 84: 5, 86: 6, 88: 7, 91: 8 }, row5 = { 79: 1, 81: 2, 84: 3, 86: 4, 88: 5, 91: 6 };
  const MEL = [   // [拍, 时值, 音高, 进阶换行]
    [0, 1, 81], [1, 0.5, 84], [1.5, 0.5, 88], [2, 1.5, 84],
    [4, 1, 81], [5, 0.5, 79], [5.5, 0.5, 81], [6, 1.5, 84],
    [8, 1, 84, 1], [9, 0.5, 88, 1], [9.5, 0.5, 86, 1], [10, 1.5, 84, 1],
    [12, 1, 79, 1], [13, 0.5, 81, 1], [13.5, 0.5, 86, 1], [14, 1.5, 88, 1],
    [16, 1, 84], [17, 1, 81], [18, 1.5, 79],
    [20, 0.5, 79, 1], [20.5, 0.5, 81, 1], [21, 1, 84, 1], [22, 1, 86, 1],
  ];
  MEL.forEach(([o, d, m, adv]) => {
    const t = 3 * SEC_BEATS + o;
    if (!keep("melody", t, d)) return;
    add(t, d < 1 ? 0.25 : d, "melody", 40 + row4[m], { k: "lead", m }, adv && row5[m] ? 50 + row5[m] : 0);
  });
  notes.sort((a, b) => a.t - b.t || a.pad - b.pad);

  const chart = {
    format: "lp-chart/1", id: "demo-edm-1", title: "电音小样", artist: "自合成(本项目)", license: "自制,可随意使用",
    bpm: BPM, meter: [4, 4], key: { tonic: 60, mode: "major", chords: ["Am", "F", "C", "G", "F", "G"] }, countIn: 4, endBeat: END,
    source: { kind: "handmade" },   // 将来 kind 可为 "ai-transcribed",并带 stems/transcriber/confidence
    layers, sections, notes,
  };
  (root.LPCharts = root.LPCharts || []).push(chart);
  if (typeof module !== "undefined") module.exports = chart;
})(typeof window !== "undefined" ? window : globalThis);
