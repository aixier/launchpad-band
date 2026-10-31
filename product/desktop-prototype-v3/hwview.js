/* 跟打模式——画面层(画布 2D + 少量 DOM)。逻辑与判定在 highway.js。
   主方案「追光落点」:盘面 8x8 画成向远处收窄的透视格阵(第 1 行最近,与真实 Launchpad 同向);
     对应列的那盏摇头灯扫向目标格,光锥在格阵上打出一个清晰的光斑——光打在哪格就按哪格;光条从上空沿所在列下坠,落进光斑;
     光条长度 = 按住时长,按住期间追光保持、光条被"压"进格子,尾部到达时松开,追光熄灭;光斑外圈有向内收缩的接近圈(只用来读"几时按")。
   备选提示方式(可在开始卡片里切换,供试玩比较):「光柱」(64 根半透明光柱,目标那根长高)、「经典」(一维 8 轨瀑布 + 判定线)。
   灯光语言:这里的颜色只有 声部色/音名色(红橙黄紫粉)、暖白、中性灰;青绿只出现在"该按的格子"的预备描边(常亮,标注 ctx.lpTag="prep"),由 check_lightlang.js 的画布录制检查。 */
(function () {
  "use strict";
  const Core = window.LPCore, A = window.LPAudio, Lib = window.LPHighwayLib;
  const H = Lib.create({ Core, A, Stage: window.LPStage, charts: window.LPCharts });
  Core.hw = H; window.LPHW = H;
  const V = { H, drawMs: 0, drawN: 0, geom: null };
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const disp = (v) => Math.round(Math.min(1, Math.pow(v / 63, 0.55)) * 255);
  const rgba = (c63, a) => "rgba(" + disp(c63[0]) + "," + disp(c63[1]) + "," + disp(c63[2]) + "," + (+a.toFixed(3)) + ")";
  const WARM = (a) => "rgba(255,238,214," + (+a.toFixed(3)) + ")";
  const mixW = (c63, f) => c63.map((v) => v + (63 - v) * f);
  const smoother = (p) => p * p * p * (p * (p * 6 - 15) + 10);
  const FALL = 5.8, V_FALL = FALL / Lib.LEAD;   // 光条下坠:7.6 个格宽的高度 / LEAD 秒
  const KEYS = "ASDFJKL;";
  let root, cv, x, W = 1, Hh = 1, dpr = 1, hudR = 0, ui = {}, lastPhase = "", lastCombo = -1, lastAcc = "", reduced = false, lowQ = false;

  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  const $ = (s, r) => (r || root).querySelector(s);

  V.init = function (container, opts) {
    root = container; reduced = !!(opts && opts.reduced); lowQ = !!(opts && opts.low);
    root.innerHTML = "";
    cv = el("canvas", "hw-canvas"); cv.setAttribute("aria-hidden", "true"); root.appendChild(cv); x = cv.getContext("2d");
    ui.top = el("div", "hw-top"); ui.stats = el("div", "hw-stats", '<div class="hw-combo"><b id="hwCombo">0</b><span>连击</span></div><div class="hw-acc"><b id="hwAcc">--</b><span>准确率</span></div><div class="hw-assist" id="hwAssist"></div>');
    ui.exit = el("button", "btn ghost small hw-exit", "退出跟打"); ui.exit.type = "button"; ui.exit.onclick = () => H.close();
    ui.card = el("div", "hw-card"); ui.card.hidden = true;
    root.append(ui.top, ui.stats, ui.exit, ui.card);
    new ResizeObserver(() => V.resize()).observe(root); V.resize();
    // 键盘:A S D F J K L ; = 8 列(忽略行,找本列最近的光条);其余键仍按原四排键位对应具体的格
    const col = (e) => KEYS.indexOf(e.key.length === 1 ? e.key.toUpperCase() : "") + 1;
    const held = new Set();
    window.addEventListener("keydown", (e) => {
      if (!H.active || e.metaKey || e.ctrlKey || e.altKey || (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName))) return;
      if (e.key === "Escape") { H.close(); e.stopPropagation(); return; }
      if (e.key === " ") { if (H.phase === "play" || H.phase === "paused" || H.phase === "count") { H.pause(); e.preventDefault(); e.stopPropagation(); } return; }
      if (e.key === "Enter" && H.phase === "ready") { H.start(); e.stopPropagation(); return; }
      const c = col(e); if (!c) return; e.stopPropagation(); e.preventDefault(); if (e.repeat || held.has(c)) return; held.add(c); A.ensure(); H.laneKey(c, true);
    }, true);
    window.addEventListener("keyup", (e) => { const c = col(e); if (!c || !H.active) return; if (held.has(c)) { held.delete(c); H.laneKey(c, false); e.stopPropagation(); } }, true);
  };
  V.setOptions = (o) => { if (o.reduced != null) reduced = o.reduced; if (o.low != null) lowQ = o.low; };
  V.resize = function () {
    if (!root) return; const r = root.getBoundingClientRect(); dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const nw = Math.max(2, Math.round(r.width)), nh = Math.max(2, Math.round(r.height));
    if (nw !== W || nh !== Hh || !cv.width) { W = nw; Hh = nh; cv.width = Math.round(W * dpr); cv.height = Math.round(Hh * dpr); cv.style.width = W + "px"; cv.style.height = Hh + "px"; }
    const hud = document.getElementById("hud"); const hr = hud ? hud.getBoundingClientRect() : null; hudR = hr && hr.width > 10 ? hr.right - r.left + 64 : 0;   // 64 = 格阵左侧的行名标签宽度
    V.geom = Lib.geometry(W, Hh, hudR);
  };

  /* ---------------- 卡片:开始 / 校准 / 结果 ---------------- */
  const seg = (id, label, opts, val) => '<div class="hw-seg" data-id="' + id + '"><span>' + label + "</span>" + opts.map(([k, n]) => '<button class="chip" type="button" data-k="' + k + '" aria-pressed="' + (String(val) === String(k)) + '">' + n + "</button>").join("") + "</div>";
  const stars = (n) => '<span class="stars">' + [0, 1, 2].map((i) => '<span class="' + (i < n ? "" : "off") + '">★</span>').join("") + "</span>";
  function readyCard() {
    const s = H.set, ch = H.chart, best = H.best(ch.id), c = ui.card;
    c.innerHTML = '<h2>' + ch.title + '</h2><p class="muted">约 ' + Math.round((ch.endBeat * 60) / ch.bpm + 4) + ' 秒 · 一层一层打:' + ch.layers.map((l) => l.name).join(" → ") + '。打好一层,它就自己响起来。</p>' +
      seg("mode", "难度", [["easy", "轻松"], ["strict", "严格"]], s.mode) + seg("rows", "行数", [["1", "一行(入门)"], ["2", "两行(进阶)"]], s.rows) +
      seg("assist", "亮灯提示", [["auto", "自动淡出"], ["full", "一直亮"], ["off", "不亮"]], s.assist) + seg("view", "提示方式", [["spot", "追光落点"], ["pillar", "光柱"], ["classic", "经典瀑布"]], s.view) + seg("tick", "节拍声", [["1", "开"], ["0", "关"]], s.tick ? 1 : 0) +
      '<div class="hw-best">' + (best ? "这个难度最好:" + stars(best.stars) + " " + Math.round(best.acc * 100) + "%" : "还没打过") + '</div>' +
      '<div class="chips"><button class="btn" id="hwGo" type="button">开始</button><button class="btn ghost" id="hwCal" type="button">校准延迟 ' + (s.calib >= 0 ? "+" : "") + Math.round(s.calib * 1000) + ' ms</button></div>' +
      '<p class="kbd">键盘:A S D F J K L ; 对应 8 列(不用管行);空格暂停;Esc 退出</p>';
    c.querySelectorAll(".hw-seg").forEach((g) => g.querySelectorAll(".chip").forEach((b) => (b.onclick = () => {
      const id = g.dataset.id, k = b.dataset.k; if (id === "rows") s.rows = +k; else if (id === "tick") s.tick = k === "1"; else s[id] = k;
      if (id === "mode") s.assist = k === "strict" ? "off" : "auto"; H.save(); readyCard();
    })));
    $("#hwGo", c).onclick = () => H.start(); $("#hwCal", c).onclick = () => H.calibrate();
  }
  function calCard() {
    const cal = H.S.cal, c = ui.card;
    if (cal && cal.done) {
      const r = cal.result;
      c.innerHTML = "<h2>校准</h2>" + (r.ms == null ? '<p>按到的次数不够(' + r.n + ' 次)。再来一次,听到"嗒"就按。</p>' : '<p class="hw-big">' + (r.ms >= 0 ? "+" : "") + r.ms + " ms</p><p class=\"muted\">" + (r.ms > 25 ? "你平均比声音晚按了一点,已经替你补上。" : r.ms < -25 ? "你平均比声音早按了一点,已经替你补上。" : "几乎没有偏差。") + "</p>") + '<div class="chips"><button class="btn" id="hwBack" type="button">好</button><button class="btn ghost" id="hwAgain" type="button">再校准一次</button></div>';
      $("#hwBack", c).onclick = () => { readyCard(); }; $("#hwAgain", c).onclick = () => H.calibrate();
    } else c.innerHTML = '<h2>校准</h2><p>听到"嗒"就按一下,<b>随便哪个键</b>(键盘 A S D F J K L ; 也行),共 9 下。</p><div class="hw-dots" id="hwDots"></div>';
  }
  function resultCard() {
    const r = H.S.res, c = ui.card, pct = (v) => Math.round(v * 100) + "%", best = H.best(H.chart.id);
    c.innerHTML = "<h2>" + (r.layersOn === r.layersAll ? "整首都被你打出来了" : "叠上了 " + r.layersOn + " / " + r.layersAll + " 层") + "</h2>" + '<div class="hw-stars">' + stars(r.stars) + "</div>" +
      '<table><tr><th>按下</th><td>' + pct(r.pressAcc) + ' · 完美 ' + r.P + ' · 不错 ' + r.G + ' · 漏拍 ' + r.M + "</td></tr>" +
      '<tr><th>按住</th><td>' + (r.nHold ? pct(r.holdAcc) + " · 松得准 " + r.hP + " · 还行 " + r.hG + " · 不准 " + r.hB : "这首里没有") + "</td></tr><tr><th>最高连击</th><td>" + r.maxCombo + "</td></tr><tr><th>难度</th><td>" + H.MODES[r.mode].name + "</td></tr></table>" +
      '<div class="hw-layers">' + H.chart.layers.map((l, i) => '<span class="hw-chip' + (H.S.locked[l.id] ? " on" : "") + '"><i style="background:' + rgba(H.layerRgb(l.id), 1) + '"></i>' + l.name + (H.S.locked[l.id] ? "" : " 没叠上") + "</span>").join("") + "</div>" +
      '<div class="chips"><button class="btn" id="hwAgain" type="button">再来一次</button><button class="btn ghost" id="hwSet" type="button">改设置</button><button class="btn ghost" id="hwOut" type="button">退出</button></div>';
    $("#hwAgain", c).onclick = () => H.again(); $("#hwSet", c).onclick = () => { H.backToReady(); }; $("#hwOut", c).onclick = () => H.close();
  }
  function syncCard() {
    const ph = H.phase, show = ph === "ready" || ph === "calib" || (ph === "done" && ui.resultShown);
    ui.card.hidden = !show; ui.exit.hidden = ph === "ready" || ph === "off";
    if (ph === lastPhase && ph !== "calib") return; lastPhase = ph; ui.resultShown = false;
    if (ph === "ready") readyCard(); else if (ph === "calib") calCard(); else if (ph === "done") setTimeout(() => { if (H.phase === "done") { resultCard(); ui.resultShown = true; ui.card.hidden = false; } }, 1400);
  }

  /* ---------------- 追光:每盏灯的瞄准轨迹(只由谱面和时间决定,没有状态)---------------- */
  function aimOf(chain, T) {
    const LEAD = Lib.LEAD;
    for (let i = 0; i < chain.length; i++) {
      const n = chain[i], end = n.t + n.d + 0.4; if (T > end) continue;
      const prev = chain[i - 1], from = prev ? [prev.c, prev.r] : [n.c, 9.3], prevEnd = prev ? prev.t + prev.d + 0.12 : -99;
      const arrive = n.t - 0.38; let start = Math.max(prevEnd, arrive - 0.7); if (arrive - start < 0.2) start = arrive - 0.2;
      const p = clamp((T - start) / (arrive - start), 0, 1), e = smoother(p);
      if (T < start - 0.001) return { n, cc: from[0], rr: from[1], p: 0, live: false };   // 还没轮到:停在原位(不画)
      return { n, cc: from[0] + (n.c - from[0]) * e, rr: from[1] + (n.r - from[1]) * e, p, live: true };
    }
    return null;
  }
  function spotI(n, T, nowP, p) {
    const tau = n.t - T;
    if (n.state === "wait") return (tau > 0.38 ? 0.2 : 0.2 + 0.8 * (1 - tau / 0.38)) * (0.3 + 0.7 * p);
    if (n.state === "holding") return 0.95 + 0.05 * Math.sin(nowP * 16);
    if (n.state === "hit") return Math.max(0, 1 - (nowP - n.at) / 0.38) * (tau > -0.0 ? 1 : 1);
    if (n.state === "done") return Math.max(0, 1 - (nowP - (n.relAt || nowP)) / 0.3);
    if (n.state === "miss") return 0.45 * Math.max(0, 1 - (nowP - (n.missAt || nowP)) / 0.25);
    return 0;
  }

  /* ---------------- 绘制 ---------------- */
  function poly(pts) { x.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) x.lineTo(pts[i][0], pts[i][1]); x.closePath(); }
  function curLayerIdx(T) { const ss = H.secs(); const i = ss.findIndex((s) => T >= s.t0 - 0.2 && T < s.t1); return i < 0 ? (T < 0 ? 0 : ss.length - 1) : i; }

  function drawGrid(G, T, cur, nowP) {
    const L = H.layers(), curL = L[cur], used = {};
    H.notes().forEach((n) => { if (n.li === cur) used[n.pad] = 1; });
    // 台面暗影:让格阵与光条在舞台灯光里读得清,但不盖掉舞台
    const g = x.createRadialGradient(G.cx, G.yN - G.Hg * 0.45, 10, G.cx, G.yN - G.Hg * 0.45, G.Wb * 0.95); g.addColorStop(0, "rgba(8,6,5,0.62)"); g.addColorStop(0.7, "rgba(8,6,5,0.38)"); g.addColorStop(1, "rgba(8,6,5,0)");
    x.fillStyle = g; x.fillRect(G.cx - G.Wb, G.top - G.hu * 2, G.Wb * 2, G.yN - G.top + G.hu * 3);
    for (let r = 1; r <= 8; r++) {
      const fade = 1 - (r - 1) * 0.07;
      x.beginPath(); for (let c = 1; c <= 8; c++) poly(G.corners(r, c)); x.fillStyle = "rgba(255,240,224," + (0.05 * fade).toFixed(3) + ")"; x.fill();
      x.lineWidth = 1; x.strokeStyle = "rgba(255,240,224," + (0.13 * fade).toFixed(3) + ")"; x.stroke();
      if (r <= L.length) { const lc = H.layerRgb(L[r - 1].id), isCur = r - 1 === cur;   // 行 = 声部:这一带的格子淡淡染上声部色
        x.beginPath(); for (let c = 1; c <= 8; c++) if (isCur ? used[r * 10 + c] : true) poly(G.corners(r, c)); x.fillStyle = rgba(lc, isCur ? 0.17 : 0.05); x.fill();
        if (G.Wb > 300) { const cl = G.cell(r, 1); x.font = "600 " + Math.round(clamp(cl.h * 0.46, 10, 14)) + "px system-ui,'Microsoft YaHei UI',sans-serif"; x.textAlign = "right"; x.textBaseline = "middle"; x.fillStyle = rgba(lc, isCur ? 1 : 0.5); x.fillText(L[r - 1].name, cl.x - cl.w / 2 - 10, cl.y); }
      }
    }
    // 盘面键位提示(键盘的 8 个列键):格阵最近一行的下方
    const c1 = G.cell(1, 1); x.font = "600 12px system-ui,sans-serif"; x.textAlign = "center"; x.textBaseline = "top"; x.fillStyle = "rgba(255,240,224,0.4)";
    for (let c = 1; c <= 8; c++) { const cl = G.cell(1, c); x.fillText(KEYS[c - 1], cl.x, G.yN + 8); }
  }
  function drawPrep(G, T) {   // 青绿预备:该按的格子描边(常亮,不闪)——与盘面上的预备灯同一份数据
    const list = H.prep(); if (!list.length) return;
    x.lpTag = "prep"; const gc = Core.GUIDE;
    list.forEach((n) => { x.beginPath(); poly(G.corners(n.r, n.c)); x.fillStyle = rgba(gc, 0.2); x.fill(); x.lineWidth = 2.6; x.strokeStyle = rgba(gc, 1); x.lineJoin = "round"; x.stroke(); });
    x.lpTag = "";
  }
  function drawBar(G, n, T, nowP) {
    const tau = n.t - T, st = n.state; if (st !== "wait" && st !== "holding") return;
    if (tau > Lib.LEAD + 0.05) return;
    const cl = G.cell(n.r, n.c), col = H.barRgb(n), hHead = Math.max(0, tau) * V_FALL, hTail = Math.min(FALL * 1.15, (tau + n.d) * V_FALL), minL = 0.5;
    const yh = cl.y - G.up(cl.s, hHead) + (hHead === 0 ? 0 : 0), yt = cl.y - G.up(cl.s, Math.max(hTail, hHead + minL)), bw = cl.w * 0.34;
    const fadeIn = clamp((Lib.LEAD - tau) / 0.3, 0, 1), holding = st === "holding", a = fadeIn * (n.state === "wait" && tau < -0.02 ? clamp(1 + tau / 0.17, 0.3, 1) : 1);
    x.globalCompositeOperation = "lighter"; x.fillStyle = rgba(col, 0.14 * a * (holding ? 1.8 : 1)); x.fillRect(cl.x - bw * 1.1, yt, bw * 2.2, yh - yt);
    const bg = x.createLinearGradient(0, yh, 0, yt); bg.addColorStop(0, rgba(col, (holding ? 1 : 0.9) * a)); bg.addColorStop(1, rgba(col, 0.5 * a));
    x.globalCompositeOperation = "source-over"; x.fillStyle = bg; x.fillRect(cl.x - bw / 2, yt, bw, yh - yt);
    x.fillStyle = rgba(mixW(col, 0.55), a); x.fillRect(cl.x - bw / 2, yh - Math.max(5, bw * 0.28), bw, Math.max(5, bw * 0.28));   // 头部:亮帽,落在格子上的瞬间 = 按下
    if (n.hold) { x.fillStyle = rgba(mixW(col, 0.35), 0.5 * a); x.fillRect(cl.x - bw * 0.18, yt, bw * 0.36, yh - yt); }
  }
  function drawSpot(G, n, aim, T, nowP, anchor) {
    const I = clamp(spotI(n, T, nowP, aim.p), 0, 1.1); if (I < 0.025 || !aim.live) return;
    const p = G.pt(aim.cc, aim.rr), s = p.s, rx = G.Wd(s) / 8 * 0.66, ry = Math.max((G.Y(s - 1 / 16) - G.Y(s + 1 / 16)) * 0.64, rx * 0.26);
    const miss = n.state === "miss", col = miss ? [26, 24, 22] : H.barRgb(n);
    x.globalCompositeOperation = "lighter";
    if (anchor && !lowQ) {   // 光锥:从这盏灯到光斑
      const g = x.createLinearGradient(anchor[0], anchor[1], p.x, p.y); g.addColorStop(0, rgba(col, 0.03 * I)); g.addColorStop(1, rgba(col, 0.2 * I));
      x.fillStyle = g; x.beginPath(); x.moveTo(anchor[0] - 2, anchor[1]); x.lineTo(anchor[0] + 2, anchor[1]); x.lineTo(p.x + rx * 1.02, p.y); x.lineTo(p.x - rx * 1.02, p.y); x.closePath(); x.fill();
    }
    x.save(); x.translate(p.x, p.y); x.scale(1, ry / rx);
    const gr = x.createRadialGradient(0, 0, 0, 0, 0, rx * 1.28); gr.addColorStop(0, rgba(mixW(col, 0.25), 0.95 * I)); gr.addColorStop(0.7, rgba(col, 0.66 * I)); gr.addColorStop(0.86, rgba(col, 0.26 * I)); gr.addColorStop(1, rgba(col, 0));
    x.fillStyle = gr; x.beginPath(); x.arc(0, 0, rx * 1.28, 0, 7); x.fill();
    x.lineWidth = 2.2; x.strokeStyle = rgba(mixW(col, 0.5), 0.55 * I); x.beginPath(); x.arc(0, 0, rx * 0.96, 0, 7); x.stroke();   // 光斑的清晰边缘
    const tau = n.t - T;
    if (n.state === "wait" && tau > 0 && tau < 0.6) { const u = tau / 0.6; x.lineWidth = 2.6; x.strokeStyle = WARM(0.85 * (1 - u) + 0.1); x.beginPath(); x.arc(0, 0, rx * (1.0 + 1.25 * u), 0, 7); x.stroke(); }   // 接近圈:向内收缩,碰到光斑 = 现在按
    if (n.state === "holding") { const left = clamp((n.t + n.d - T) / n.d, 0, 1); x.lineWidth = 3.2; x.strokeStyle = WARM(0.9); x.beginPath(); x.arc(0, 0, rx * 1.1, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * left); x.stroke(); }   // 按住:外圈随剩余时间收尾,走完 = 松开
    x.restore(); x.globalCompositeOperation = "source-over";
  }
  function drawBursts(G, nowP) {   // 命中绽放:格子上扩散的光环 + 向上的光柱(与舞台上同一盏灯亮起同步)
    x.globalCompositeOperation = "lighter";
    H.notes().forEach((n) => {
      if (!n.at) return; const age = nowP - n.at; if (age > 0.55 || age < 0 || n.state === "miss") return;
      const cl = G.cell(n.r, n.c), col = H.barRgb(n), k = age / 0.55, perfect = n.press === "P";
      x.save(); x.translate(cl.x, cl.y); x.scale(1, cl.h / cl.w);
      x.lineWidth = 3 * (1 - k) + 0.5; x.strokeStyle = rgba(mixW(col, 0.4), (1 - k) * (perfect ? 0.95 : 0.6)); x.beginPath(); x.arc(0, 0, cl.w * (0.5 + 0.62 * k), 0, 7); x.stroke(); x.restore();
      if (!reduced && !lowQ) { const h = G.up(cl.s, 3.2 * (1 - k * 0.5)), g = x.createLinearGradient(0, cl.y, 0, cl.y - h); g.addColorStop(0, rgba(col, 0.5 * (1 - k))); g.addColorStop(1, rgba(col, 0)); x.fillStyle = g; x.fillRect(cl.x - cl.w * 0.3, cl.y - h, cl.w * 0.6, h); }
    });
    x.globalCompositeOperation = "source-over";
  }
  function drawFloaters(G, nowP) {
    const fl = H.floaters; x.textAlign = "center"; x.textBaseline = "middle";
    for (let i = fl.length - 1; i >= 0; i--) {
      const f = fl[i], age = nowP - f.t0; if (age > 0.8) { fl.splice(i, 1); continue; }
      const cl = G.cell(f.r, f.c), k = age / 0.8, col = f.kind === "miss" ? [34, 32, 30] : f.kind === "perfect" ? mixW(f.col, 0.75) : [60, 56, 50], al = clamp(1.6 * (1 - k), 0, 1);
      x.font = (f.kind === "perfect" ? "800 22px" : "700 18px") + " system-ui,'Microsoft YaHei UI',sans-serif"; x.lineWidth = 4; x.strokeStyle = "rgba(8,6,5," + (0.55 * al).toFixed(2) + ")"; x.lineJoin = "round"; const fy = cl.y - cl.h * 0.9 - 30 - 20 * k;
      const fx = cl.x + (/^(松|拖)/.test(f.text) ? 54 : 0);   // 松开的浮字错开到右边,不和按下的浮字叠在一起
      x.strokeText(f.text, fx, fy); x.fillStyle = rgba(col, al); x.fillText(f.text, fx, fy);
    }
  }
  function drawBanner(G, T, nowP) {
    const ss = H.secs(), ch = H.chart; let txt = null, sub = "", a = 0, col = [50, 46, 42];
    for (let i = 0; i < ss.length; i++) { const s = ss[i], d = T - s.t0; if (d > -1.0 && d < 2.0) { const L = ch.layers[s.li]; txt = (i === 0 ? "先打" : "加上") + L.name; sub = L.tip; col = H.layerRgb(L.id); a = clamp(Math.min((d + 1.0) / 0.5, (2.0 - d) / 0.6), 0, 1); break; } }
    const ev = H.events[H.events.length - 1];
    if (ev && nowP - ev.at < 2.4 && ev.k === "lock") { const L = ch.layers.find((l) => l.id === ev.layer); txt = ev.ok ? L.name + " 叠上了" : L.name + " 没叠上"; sub = ev.ok ? "它会自己接着响" : "后面这一层是静默的"; col = ev.ok ? H.layerRgb(ev.layer) : [30, 28, 26]; a = clamp(Math.min((2.4 - (nowP - ev.at)) / 0.5, (nowP - ev.at) / 0.12), 0, 1); }
    if (T < 0 && T > -ch.countIn * H.spb()) { const n = Math.ceil(-T / H.spb()), f = (-T / H.spb()) % 1; txt = String(n); sub = ""; a = 0.4 + 0.6 * (1 - f); col = [60, 56, 50]; x.font = "700 78px system-ui,sans-serif"; x.textAlign = "center"; x.textBaseline = "middle"; x.fillStyle = WARM(a); x.fillText(txt, G.cx, Hh * 0.3); return; }
    if (!txt || a <= 0.01) return; x.textAlign = "center"; x.textBaseline = "middle";
    x.font = "700 46px system-ui,'Microsoft YaHei UI',sans-serif"; x.fillStyle = rgba(mixW(col, 0.2), a); x.fillText(txt, G.cx, Hh * 0.17);
    x.font = "500 16px system-ui,'Microsoft YaHei UI',sans-serif"; x.fillStyle = WARM(0.72 * a); x.fillText(sub, G.cx, Hh * 0.17 + 36);
  }

  function drawSpotView(G, T, nowP, cur) {
    drawGrid(G, T, cur, nowP);
    const chains = H.lampChains(), lp = (window.LPStage && window.LPStage.lampPx) || [], anchorOf = (li) => { const q = lp[li]; return q ? [q[0] * W, q[1] * Hh + 6] : [G.cx + (li - 3.5) * 80, Hh * 0.14]; };
    const sp = [];
    for (const li in chains) { const aim = aimOf(chains[li], T); if (aim && aim.live) sp.push({ li: +li, aim }); }
    sp.forEach((s) => drawBar(G, s.aim.n, T, nowP));   // 光条与光斑属于同一个音;先画光条再画光斑,光斑盖在光条落点上
    H.notes().forEach((n) => { if (!sp.some((s) => s.aim.n === n)) drawBar(G, n, T, nowP); });
    drawPrep(G, T);
    const dir = window.LPStage && window.LPStage.dir;
    sp.forEach((s) => { drawSpot(G, s.aim.n, s.aim, T, nowP, anchorOf(s.li)); if (dir && dir.spot && s.aim.n.state !== "miss") dir.spot(s.li, clamp(spotI(s.aim.n, T, nowP, s.aim.p), 0, 1) * 0.85, H.dispRgb(H.barRgb(s.aim.n)), (s.aim.n.r - 1) / 7); });
    drawBursts(G, nowP);
  }
  function drawPillarView(G, T, nowP, cur) {
    drawGrid(G, T, cur, nowP);
    for (let r = 1; r <= 8; r++) for (let c = 1; c <= 8; c++) { const cl = G.cell(r, c), h = G.up(cl.s, 1.5); const g = x.createLinearGradient(0, cl.y, 0, cl.y - h); g.addColorStop(0, "rgba(255,240,224,0.07)"); g.addColorStop(1, "rgba(255,240,224,0)"); x.fillStyle = g; x.fillRect(cl.x - cl.w * 0.07, cl.y - h, cl.w * 0.14, h); }   // 64 根常态极淡的光柱(景深越远越淡)
    x.globalCompositeOperation = "lighter";
    H.notes().forEach((n) => {
      const tau = n.t - T, on = n.state === "wait" ? tau < Lib.LEAD : n.state === "holding"; if (!on) return;
      const cl = G.cell(n.r, n.c), col = H.barRgb(n), grow = n.state === "holding" ? 1 : clamp(1 - tau / Lib.LEAD, 0.05, 1), h = G.up(cl.s, 1.2 + 4.2 * grow);
      const g = x.createLinearGradient(0, cl.y, 0, cl.y - h); g.addColorStop(0, rgba(col, 0.5 * (0.35 + 0.65 * grow))); g.addColorStop(1, rgba(col, 0)); x.fillStyle = g; x.fillRect(cl.x - cl.w * 0.3, cl.y - h, cl.w * 0.6, h);
    });
    x.globalCompositeOperation = "source-over";
    H.notes().forEach((n) => drawBar(G, n, T, nowP));
    drawPrep(G, T); drawBursts(G, nowP);
  }
  function drawClassicView(G, T, nowP, cur) {
    const lw = G.Wb / 8, left = G.left, yL = G.yN - 6, top = Math.max(Hh * 0.2, G.yN - Math.min(Hh * 0.66, 520)), len = yL - top, yOf = (tau) => yL - (tau / Lib.LEAD) * len;
    x.fillStyle = "rgba(8,6,5,0.5)"; x.fillRect(left - 6, top, G.Wb + 12, len + 40);
    for (let c = 0; c <= 8; c++) { x.fillStyle = "rgba(255,240,224,0.09)"; x.fillRect(left + c * lw - 0.5, top, 1, len + 20); }
    const spb = H.spb(); for (let b = Math.ceil(T / spb); b < (T + Lib.LEAD) / spb + 1; b++) { const y = yOf(b * spb - T); if (y < top || y > yL) continue; x.fillStyle = "rgba(255,240,224," + (b % 4 === 0 ? 0.16 : 0.06) + ")"; x.fillRect(left, y, G.Wb, 1); }
    H.notes().forEach((n) => {
      const tau = n.t - T, st = n.state; if ((st !== "wait" && st !== "holding") || tau > Lib.LEAD) return;
      const col = H.barRgb(n), yh = tau > 0 ? yOf(tau) : yL, yt = Math.max(top, yOf(tau + n.d)), bw = lw * 0.7, xc = left + (n.c - 0.5) * lw, hh = Math.max(yh - yt, 14);
      x.fillStyle = rgba(col, st === "holding" ? 1 : 0.9); x.fillRect(xc - bw / 2, yh - hh, bw, hh); x.fillStyle = rgba(mixW(col, 0.55), 1); x.fillRect(xc - bw / 2, yh - 6, bw, 6);
    });
    x.fillStyle = WARM(0.95); x.fillRect(left - 10, yL, G.Wb + 20, 3);
    x.font = "600 13px system-ui,sans-serif"; x.textAlign = "center"; x.textBaseline = "top";
    for (let c = 1; c <= 8; c++) { x.fillStyle = "rgba(255,240,224,0.5)"; x.fillText(KEYS[c - 1], left + (c - 0.5) * lw, yL + 10); }
    x.lpTag = "prep"; H.prep().forEach((n) => { x.lineWidth = 2.6; x.strokeStyle = rgba(Core.GUIDE, 1); x.strokeRect(left + (n.c - 1) * lw + 3, yL - 4, lw - 6, 14); }); x.lpTag = "";
    H.notes().forEach((n) => { if (!n.at) return; const age = nowP - n.at; if (age < 0 || age > 0.4) return; const xc = left + (n.c - 0.5) * lw, col = H.barRgb(n); x.globalCompositeOperation = "lighter"; const g = x.createLinearGradient(0, yL, 0, yL - 160); g.addColorStop(0, rgba(col, 0.6 * (1 - age / 0.4))); g.addColorStop(1, rgba(col, 0)); x.fillStyle = g; x.fillRect(xc - lw * 0.4, yL - 160, lw * 0.8, 160); x.globalCompositeOperation = "source-over"; });
  }

  function hudUpdate() {
    const st = H.statsNow(), S = H.S, cb = S.combo, accTxt = st.n ? Math.round(st.acc * 100) + "%" : "--";
    if (cb !== lastCombo) { lastCombo = cb; const b = document.getElementById("hwCombo"); if (b) { b.textContent = cb; b.classList.remove("pop"); void b.offsetWidth; if (cb) b.classList.add("pop"); } }
    if (accTxt !== lastAcc) { lastAcc = accTxt; const b = document.getElementById("hwAcc"); if (b) b.textContent = accTxt; }
    // 顶部声部条
    const ch = H.chart; if (!ch) return; const T = H.visT(), cur = curLayerIdx(T);
    if (ui.top.childElementCount !== ch.layers.length) { ui.top.innerHTML = ch.layers.map((l) => '<span class="hw-chip" data-l="' + l.id + '"><i style="background:' + rgba(H.layerRgb(l.id), 1) + '"></i>' + l.name + "</span>").join(""); }
    ui.top.querySelectorAll(".hw-chip").forEach((c, i) => { const id = ch.layers[i].id; c.classList.toggle("on", !!S.locked[id]); c.classList.toggle("cur", i === cur && H.phase !== "done" && !S.locked[id]); });
    const a = document.getElementById("hwAssist"); if (a) a.textContent = H.set.assist === "off" ? "不亮灯" : "亮灯:" + ({ full: "全部", bars: "每小节第一个", off: "已淡出" }[S.assist] || "");
  }

  V.frame = function (t) {
    const on = H.active; root.hidden = !on; document.body.classList.toggle("hw-on", on); document.body.classList.toggle("hw-ready", H.phase === "ready" || H.phase === "calib"); if (!on) { lastPhase = ""; return; }
    const St = window.LPStage; if (St && St.opts) { reduced = !!St.opts.reduced; lowQ = !!(St.effQuality && St.effQuality() === "low"); }
    if ((V._n = (V._n || 0) + 1) % 15 === 0) V.resize();   // 盘面镜像的宽度有过渡动画,隔一会儿重算格阵位置
    H.update(); syncCard();
    const t0 = performance.now(), G = V.geom, nowP = performance.now() / 1000;
    x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, W, Hh);
    const ph = H.phase;
    if (ph === "calib") { const c = H.S.cal; if (c) { const dots = document.getElementById("hwDots"); if (dots && !dots.childElementCount) dots.innerHTML = c.beats.map(() => "<i></i>").join(""); const now = A.now() - A.outLatency(); if (dots) [...dots.children].forEach((d, i) => { const dd = now - c.beats[i]; d.className = dd > 0 && dd < 0.18 ? "hit" : dd >= 0.18 ? "past" : ""; d.style.opacity = dd > 0.3 ? 0.35 : 1; }); if (c.done) calCard(); } }
    else if (ph !== "ready" && ph !== "off") {
      const T = H.visT(), cur = curLayerIdx(T);
      if (H.set.view === "classic") drawClassicView(G, T, nowP, cur); else if (H.set.view === "pillar") drawPillarView(G, T, nowP, cur); else drawSpotView(G, T, nowP, cur);
      drawFloaters(G, nowP); drawBanner(G, T, nowP);
      if (ph === "paused") { x.fillStyle = "rgba(8,6,5,0.55)"; x.fillRect(0, 0, W, Hh); x.font = "700 34px system-ui,'Microsoft YaHei UI',sans-serif"; x.textAlign = "center"; x.fillStyle = WARM(0.95); x.fillText("暂停", W / 2, Hh * 0.4); x.font = "500 15px system-ui,sans-serif"; x.fillStyle = WARM(0.7); x.fillText("按空格继续", W / 2, Hh * 0.4 + 34); }
      hudUpdate();
    } else if (ph === "ready") { drawGrid(G, -9, 0, nowP); }
    V.drawMs += performance.now() - t0; V.drawN++;
  };
  window.LPHWView = V;
})();
