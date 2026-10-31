#!/usr/bin/env node
/* 「按哪里」的可读性指标(Node,纯几何,不需要浏览器):比较三种提示方式在 1440x860 窗口下,
     · 眼动距离  = 光条/提示出现的位置 → 真正要按的那一格 的屏幕距离(像素 / 以"格宽"计)。越小越好,0 = 提示就落在目标格上。
     · 歧义数    = 看到提示后,玩家还要在几个格子里猜(不靠颜色/不靠记忆)。1 = 无歧义。
     · 同时 N 个光条(和弦/双手)时的拥挤:随机抽 N 个不同格(来自谱面真实用到的格,含进阶两行),统计 (a)两个提示落在同一"轨"(同列)而无法区分的概率;
       (b)光斑/光柱互相重叠(相邻距离 < 1.3 个格宽)的概率。
   三种方式:spot 追光落点(默认)、pillar 光柱、classic 经典一维瀑布 + 判定线(要去盘面/设备上找格子)。
   说明:这是几何指标,不是用户实验;用来比较方案、暴露歧义,不能代替真人试玩 [待验证]。 */
"use strict";
const path = require("path");
const root = path.resolve(__dirname, "..");
const lib = require("../highway.js"); const chart = require("../charts.js");
const W = 1440, Hh = 860, HUD_R = 394, G = lib.geometry(W, Hh, 0), spb = 60 / chart.bpm;
const pads = []; chart.notes.forEach((n) => { pads.push(n.pad); if (n.adv) pads.push(n.adv); });
const used = [...new Set(pads)].map((p) => ({ p, r: Math.floor(p / 10), c: p % 10 }));
const V_FALL = 5.8 / lib.LEAD, TAU = 0.35;   // 玩家定位目标的决策时刻:光条头部落地前 0.35 秒
const hudCell = (r, c) => ({ x: 22 + 9 + (c - 0.5) * 38.6, y: 805 - (r - 0.5) * 40 + 0 });   // HUD 镜像盘面里第 r 行第 c 列的大致位置(底部居左)
const lane = (c) => ({ x: G.left + (c - 0.5) * (G.Wb / 8), y: G.yN - 6 - (TAU / lib.LEAD) * Math.min(Hh * 0.66, 520) });
const cellPt = (r, c) => { const cl = G.cell(r, c); return { x: cl.x, y: cl.y, w: cl.w }; };
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

const own = chart.notes.filter((n) => { const L = chart.layers.find((l) => l.id === n.layer), s = chart.sections[L.section]; return n.t >= s.b0 && n.t < s.b1; });
const rowsPerCol = {}; used.forEach((u) => ((rowsPerCol[u.c] = rowsPerCol[u.c] || new Set()).add(u.r)));
const res = { window: W + "x" + Hh, cellWidthNear: +(G.Wb / 8).toFixed(1), notes: own.length, single: {}, multi: {} };

// 单个光条:眼动距离、歧义数
const single = { spot: [], pillar: [], classic: [] }, amb = { spot: [], pillar: [], classic: [], classicWithColor: [] };
own.forEach((n) => {
  const r = Math.floor(n.pad / 10), c = n.pad % 10, cl = cellPt(r, c);
  single.spot.push(0 / cl.w);                                                   // 光斑本身就落在目标格上
  const grow = 1 - TAU / lib.LEAD, pillarTop = { x: cl.x, y: cl.y - G.up(G.cell(r, c).s, 1.2 + 4.2 * grow) }; single.pillar.push(dist(pillarTop, cl) / cl.w);   // 光柱顶 → 光柱根(格)
  single.classic.push(dist(lane(c), hudCell(r, c)) / cl.w);                       // 轨道光条 → 盘面镜像/设备上的那一格
  amb.spot.push(1); amb.pillar.push(1);
  amb.classic.push(8); amb.classicWithColor.push([...rowsPerCol[c]].filter((rr) => chart.layers[rr - 1] && (rr === r || chart.layers[rr - 1].id === n.layer)).length);
});
res.single = {
  眼动距离_格宽: { 追光落点: +mean(single.spot).toFixed(2), 光柱: +mean(single.pillar).toFixed(2), 经典瀑布: +mean(single.classic).toFixed(1) },
  眼动距离_像素: { 追光落点: 0, 光柱: Math.round(mean(single.pillar) * G.Wb / 8 * 0.7), 经典瀑布: Math.round(mean(single.classic) * G.Wb / 8) },
  歧义数_不靠颜色: { 追光落点: 1, 光柱: 1, 经典瀑布: 8 },
  歧义数_靠声部颜色与记忆: { 追光落点: 1, 光柱: 1, 经典瀑布: +mean(amb.classicWithColor).toFixed(2) },
};

// 同时 N 个光条
let seed = 20261026; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
for (const N of [2, 3, 4]) {
  let sameLane = 0, overlap = 0, minSepSum = 0, sameLaneBars = 0; const TR = 4000;
  for (let k = 0; k < TR; k++) {
    const pick = []; while (pick.length < N) { const u = used[Math.floor(rnd() * used.length)]; if (!pick.some((q) => q.p === u.p)) pick.push(u); }
    let sl = false, ov = false, minSep = 1e9;
    for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
      if (pick[i].c === pick[j].c) sl = true;
      const a = cellPt(pick[i].r, pick[i].c), b = cellPt(pick[j].r, pick[j].c), d = dist(a, b) / Math.min(a.w, b.w); minSep = Math.min(minSep, d); if (d < 1.3) ov = true;
    }
    if (sl) sameLane++; if (ov) overlap++; minSepSum += minSep;
  }
  res.multi["N=" + N] = { 经典_同轨无法区分概率: +(sameLane / TR).toFixed(3), 追光与光柱_同列_光条重叠但落点不同: +(sameLane / TR).toFixed(3), 追光与光柱_光斑互相重叠概率: +(overlap / TR).toFixed(3), 平均最小间距_格宽: +(minSepSum / TR).toFixed(2) };
}
// 谱面里实际出现的同时光条(时间差 < 0.3 s 的相邻两个)
const sorted = own.slice().sort((a, b) => a.t - b.t); let near = 0, nearSameCol = 0;
for (let i = 1; i < sorted.length; i++) if ((sorted[i].t - sorted[i - 1].t) * spb < 0.3) { near++; if (sorted[i].pad % 10 === sorted[i - 1].pad % 10) nearSameCol++; }
res.chartReality = { 相邻间隔小于0点3秒的光条对: near, 其中同列: nearSameCol, 同一时刻有两个及以上光条: sorted.filter((n, i) => i && Math.abs(n.t - sorted[i - 1].t) < 1e-6).length };
console.log(JSON.stringify(res, null, 1));
