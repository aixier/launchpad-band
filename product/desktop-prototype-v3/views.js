/* 抽屉里的页面:课程 / 乐队 / 教练 / 成歌 / 作品 / 设置与诊断。
   内容沿用 v2(课程、乐队、设置)与 v1(教练、生成整首歌、作品库)的设计,只换了外观;舞台是主画面,这里都是"需要时才打开"的东西。 */
(function () {
  "use strict";
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const mk = (html) => { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstChild; };
  const V = { tabs: [["lessons", "课程"], ["band", "乐队"], ["coach", "教练"], ["gen", "成歌"], ["library", "作品"], ["settings", "设置"]], live: () => {}, ctx: null };
  let ctx, Core, A, Stage, P;
  const $ = (s, r) => (r || P).querySelector(s);
  const disp = (v) => Math.round(Math.min(1, Math.pow(v / 63, 0.55)) * 255), css = (c) => "rgb(" + c.map(disp).join(",") + ")";
  const stars = (n) => '<span class="stars" aria-label="' + n + ' 星">' + [0, 1, 2].map((i) => '<span class="' + (i < n ? "" : "off") + '">★</span>').join("") + "</span>";

  /* ---------- 课程 ---------- */
  function lessons() {
    P.innerHTML = '<h1>课程</h1><p class="lead">每一课就是几个音。跟着盘面上闪着的键按,不用看这里。</p><div id="ll"></div><h2>引导</h2><div class="chips" id="gc"></div>';
    Core.LESSONS.forEach((L, i) => {
      const r = mk('<div class="row"><div><b>' + (i + 1) + ". " + esc(L.name) + "</b><small>" + esc(L.tip) + " · " + L.seq.length + ' 个音</small></div><div>' + stars(Core.results[i] || 0) + "</div></div>");
      const b = mk('<button class="btn small" type="button">' + (Core.results[i] ? "再练" : "开始") + "</button>"); b.onclick = () => { Core.startPractice(i); ctx.close(); };
      r.lastChild.appendChild(document.createTextNode(" ")); r.lastChild.appendChild(b); $("#ll").appendChild(r);
    });
    [["重新走一遍开场引导", () => { Core.resetGuide(); ctx.close(); }], ["跳过引导,直接自由玩(舞台全开)", () => { Core.skipGuide(); ctx.close(); }]].forEach(([t, f]) => { const b = mk('<button class="chip" type="button">' + t + "</button>"); b.onclick = f; $("#gc").appendChild(b); });
    P.insertAdjacentHTML("beforeend", '<h2>后面的章节</h2><div class="row"><div><b>第二章 · 节奏</b><small>跟着鼓点按在拍子上。需要先有节拍判定。</small></div><span class="tag">V1</span></div><div class="row"><div><b>第三章 · 和弦</b><small>同时按三个键,听见"和起来"。</small></div><span class="tag">V1</span></div>');
  }

  /* ---------- AI 乐队 ---------- */
  const STYLES = { pop: ["流行", 100, [0.3, 0, 0, 0]], soft: ["抒情", 76, [0, 0, 0, 0.8]], bright: ["轻快", 124, [0.4, 0, 0.4, 0]], chill: ["悠闲", 88, [0, 0.5, 0, 0]] };
  const MOODS = [[/忧|伤|难过|安静|想哭|雨/, "soft"], [/开心|快乐|高兴|兴奋|跑|晴/, "bright"], [/放松|平静|悠闲|咖啡|睡/, "chill"]];
  let style = "pop";
  const setStyle = (k) => { style = k; A.setBpm(STYLES[k][1]); A.bias = STYLES[k][2].slice(); };
  function band() {
    const idc = Core.IDENT;
    P.innerHTML = '<h1>AI 乐队</h1><p class="lead">三位成员都在本机算,听你弹的音换和弦。他们在舞台上站着:你按下乐队键、鼓点键,他们才亮起来。</p>' +
      '<div class="member" id="mb"><i class="dot"></i><div><b>鼓手</b><small id="mbS">休息中</small></div><button class="chip" id="mbB" type="button" aria-pressed="false">鼓点</button></div>' +
      '<div class="member" id="mc"><i class="dot"></i><div><b>贝斯手</b><small id="mcS">休息中</small></div><button class="chip" id="mcB" type="button" aria-pressed="false">乐队</button></div>' +
      '<div class="member" id="md"><i class="dot"></i><div><b>和弦手</b><small id="mdS">休息中</small></div><span></span></div>' +
      '<h2>风格(只改速度和爱用的和弦;舞台灯光风格由 AI 按能量自动换)</h2><div class="chips" id="sty"></div><h2>速度 <span id="bpmV"></span> 拍/分</h2><input id="bpm" type="range" min="60" max="150" step="1" aria-label="速度">' +
      '<h2>说一句心情,换个风格</h2><div class="row"><input type="text" id="mood" placeholder="比如:有点忧伤 / 开心 / 想放松" maxlength="30" style="flex:1"><button class="btn small" id="moodGo" type="button">换</button></div><p class="muted" id="moodRes">本地关键词表(忧伤、开心、放松),不联网;联网的 AI 理解尚未接入。</p>';
    $("#mbB").onclick = () => Core.press(108, true); $("#mcB").onclick = () => Core.press(109, true);
    Object.keys(STYLES).forEach((k) => { const b = mk('<button class="chip" type="button" aria-pressed="' + (k === style) + '">' + STYLES[k][0] + " · " + STYLES[k][1] + "</button>"); b.onclick = () => { setStyle(k); band(); }; $("#sty").appendChild(b); });
    const r = $("#bpm"); r.value = A.getBpm(); $("#bpmV").textContent = r.value; r.oninput = () => { A.setBpm(+r.value); $("#bpmV").textContent = r.value; };
    $("#moodGo").onclick = () => { const t = $("#mood").value.trim(); if (!t) return; const m = MOODS.find(([re]) => re.test(t)); if (!m) { $("#moodRes").textContent = "这句我没对上。本地只认:忧伤、开心、放松这类词。"; return; } setStyle(m[1]); band(); $("#moodRes").textContent = "听起来像「" + STYLES[m[1]][0] + "」,已换成 " + STYLES[m[1]][1] + " 拍/分。这是关键词匹配,不是 AI 的判断。"; };
    $("#mb .dot").style.background = A.drumsOn ? css(idc.drums) : ""; $("#mc .dot").style.background = A.bandOn ? css(idc.band) : ""; $("#md .dot").style.background = A.bandOn ? css(idc.band) : "";
    V.live = () => {
      if (!$("#mbS")) return; const info = A.currentInfo();
      $("#mbS").textContent = A.drumsOn ? "在打鼓 · 底鼓和踩镲" : "休息中"; $("#mcS").textContent = A.bandOn ? "在弹低音 · 第 " + (info.beat + 1) + " 拍" : "休息中"; $("#mdS").textContent = A.bandOn ? "和弦 " + info.chord + " · 跟着你刚弹的音换" : "休息中";
      $("#mbB").setAttribute("aria-pressed", A.drumsOn); $("#mcB").setAttribute("aria-pressed", A.bandOn);
    };
  }

  /* ---------- AI 教练 ---------- */
  const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  function relation(from, to) {
    const dr = Math.floor(from / 10) - Math.floor(to / 10), dc = (from % 10) - (to % 10);
    if (Math.abs(dr) + Math.abs(dc) === 1) return dc === 1 ? "目标键右边相邻的一格" : dc === -1 ? "目标键左边相邻的一格" : dr === 1 ? "目标键上面相邻的一格" : "目标键下面相邻的一格";
    return "离目标键 " + (Math.abs(dr) + Math.abs(dc)) + " 格远的地方";
  }
  V.analyze = function (p, prevBest) {
    const n = p.seq.length, lines = [], gaps = [];
    for (let i = 1; i < p.hits.length; i++) gaps.push(p.hits[i] - p.hits[i - 1]);
    lines.push(["事实", "这次按对了 " + n + " 个音,按错 " + p.wrong + " 次。" + (prevBest ? "之前最好是 " + prevBest + " 星。" : "")]);
    let cv = 0;
    if (gaps.length >= 4) {
      const m = med(gaps), mx = Math.max(...gaps), mn = Math.min(...gaps), mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      cv = Math.sqrt(gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length) / mean;
      if (mx > 2.5 * m && mx > 0.9) lines.push(["节奏", "第 " + (gaps.indexOf(mx) + 2) + " 个音之前停了约 " + mx.toFixed(1) + " 秒,其余多在 " + m.toFixed(1) + " 秒左右。"]);
      else if (cv < 0.3) lines.push(["节奏", "音和音之间的间隔很接近(约 " + m.toFixed(1) + " 秒),节拍稳。"]);
      else lines.push(["节奏", "间隔忽长忽短:最短 " + mn.toFixed(1) + " 秒,最长 " + mx.toFixed(1) + " 秒。"]);
    }
    if (p.wrongs.length) {
      const by = {}; p.wrongs.forEach((w) => { const k = w.want + ":" + relation(w.pressed, w.want); by[k] = (by[k] || 0) + 1; });
      const top = Object.entries(by).sort((a, b) => b[1] - a[1])[0], rel = top[0].split(":")[1];
      lines.push(["错键", "按错的 " + p.wrongs.length + " 次里," + top[1] + " 次落在" + rel + "。"]);
    }
    lines.push(["下一步", p.wrong ? "下次按之前先看一眼闪着的那一格,再按。" : cv > 0.3 ? "先慢一点,让每个音按得一样长。" : "可以去试试下一课。"]);
    return { ts: Date.now(), lesson: Core.LESSONS[p.idx].name, stars: p.stars, lines };
  };
  function coach() {
    const log = Core.coachLog;
    P.innerHTML = '<h1>AI 教练</h1><p class="lead">只说它从你的按键里<b>看到了什么</b>,再给一件下次可以试的小事。不打分比较,不下结论。</p><div id="cl"></div><p class="muted">现在这些话全是本地模板写出来的,没网也一样能用;联网后让 AI 把话说得更口语 <span class="tag">尚未接入</span></p>';
    const card = (r, demo) => '<div class="row col"><div style="display:flex;justify-content:space-between"><b>' + esc(r.lesson) + " " + "★".repeat(r.stars) + "</b>" + (demo ? '<span class="tag">示例</span>' : "<small>" + new Date(r.ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) + "</small>") + "</div>" + r.lines.map(([k, t]) => '<div style="margin-top:6px"><small>' + k + "</small>　" + esc(t) + "</div>").join("") + "</div>";
    const cl = $("#cl");
    if (!log.length) cl.innerHTML = '<div class="note-box">还没有你的练习记录。去「课程」跟弹一课,这里就会出现真实的反馈。下面是示例。</div>';
    log.slice().reverse().slice(0, 6).forEach((r) => cl.insertAdjacentHTML("beforeend", card(r, false)));
    if (!log.length) cl.insertAdjacentHTML("beforeend", card({ lesson: "上行下行", stars: 2, lines: [["事实", "这次按对了 11 个音,按错 2 次。之前最好是 1 星。"], ["节奏", "第 7 个音之前停了约 1.8 秒,其余多在 0.5 秒左右。"], ["错键", "按错的 2 次里,2 次落在目标键右边相邻的一格。"], ["下一步", "下次按之前先看一眼闪着的那一格,再按。"]] }, true));
  }

  /* ---------- 生成整首歌(异步占位)与作品库 ---------- */
  const Gen = V.Gen = { status: "idle", t0: 0, style: "pop", mood: "", net: true, heard: false, work: null, src: null, notes: null };
  const STEPS = [["整理你弹的", 1.2], ["上传(只含音符和风格文字)", 1.5], ["排队", 2.5], ["AI 正在写成一首歌", 6]];
  const demoNotes = (seed) => { const sc = [60, 62, 64, 67, 69, 72], out = []; let t = 0, i = seed; for (let k = 0; k < 24; k++) { i = (i * 7 + 3 + (k % 5)) % sc.length; const d = k % 6 === 5 ? 0.6 : 0.25; out.push({ t: +t.toFixed(2), midi: sc[i], dur: d }); t += d + 0.05; } return out; };
  const works = () => Core.load("lp3.works", null) || [{ id: 1, title: "示例 · 雨天散步", kind: "ai", created: Date.now() - 864e5, style: "抒情", notes: demoNotes(2), demo: true }, { id: 2, title: "示例 · 随手弹的 8 小节", kind: "self", created: Date.now() - 2 * 864e5, style: "—", notes: demoNotes(4), demo: true }];
  const saveWorks = (w) => Core.save("lp3.works", w);
  const now = () => performance.now() / 1000, total = () => STEPS.reduce((a, s) => a + s[1], 0);
  V.startGen = function () {
    if (Gen.status === "run") return;
    const tk = Core.bestTake(), notes = tk ? tk.notes.filter((n) => n.dur != null).map((n) => ({ t: n.t, midi: n.midi, dur: n.dur })) : Gen.src === "demo" ? demoNotes(1) : null;
    if (!notes || !notes.length) { ctx.toast("还没有可用的旋律:先弹十几个音"); return; }
    Object.assign(Gen, { status: "run", t0: now(), heard: false, notes, work: null }); ctx.toast("已提交。你可以接着弹,做好了灯会叫你"); if (ctx.cur() === "gen") gen();
  };
  V.genTick = function () {
    if (Gen.status !== "run") return; const el = now() - Gen.t0;
    if (!Gen.net && el > STEPS[0][1] + 1) { Gen.status = "offline"; const w = { id: Date.now(), title: "本地乐队版 " + new Date().toLocaleDateString("zh-CN"), kind: "local", created: Date.now(), style: "—", notes: Gen.notes, demo: false }; const all = works(); all.unshift(w); saveWorks(all); Gen.work = w; if (ctx.cur() === "gen") gen(); return; }
    if (el >= total()) { const w = { id: Date.now(), title: "我的第 " + (works().filter((x) => !x.demo).length + 1) + " 首", kind: "ai", created: Date.now(), style: STYLES[Gen.style][0], notes: Gen.notes, demo: false, placeholder: true }; const all = works(); all.unshift(w); saveWorks(all); Gen.work = w; Gen.status = "done"; ctx.toast("歌做好了"); if (ctx.cur() === "gen") gen(); return; }
    if (ctx.cur() === "gen") { const bar = $("#gbar"), lab = $("#glab"); if (bar) { bar.style.width = (el / total()) * 100 + "%"; let a = 0, idx = 0; STEPS.forEach((st, i) => { if (el >= a) idx = i; a += st[1]; }); lab.textContent = STEPS[idx][0] + "……"; } }
  };
  function gen() {
    const tk = Core.bestTake(); let body = "";
    if (Gen.status === "idle") body = '<h2>1 · 选一段</h2><div class="chips" id="gsrc"></div><h2>2 · 想要什么感觉</h2><div class="chips" id="gs"></div><div style="margin-top:9px"><input type="text" id="gm" maxlength="40" placeholder="可选:一句话,比如「下雨天窗边」"></div><h2>3 · 交给 AI</h2><p class="muted">会上传:你弹的音符(不是录音)和风格文字。服务商首选 MiniMax;保留期与条款 [待验证]。</p><div class="row"><button class="btn small" id="gsub" type="button">提交</button><label class="muted"><input type="checkbox" id="gnet" ' + (Gen.net ? "checked" : "") + '> 网络正常(演示开关)</label></div>';
    else if (Gen.status === "run") body = '<h2>正在做</h2><div class="bar"><i id="gbar"></i></div><p id="glab" style="margin:8px 0 0"></p><p class="muted">演示里压缩成十来秒;真实耗时 [待验证]。离开这一页也会继续,不影响弹琴。</p><button class="btn ghost small" id="gcancel" type="button">取消</button>';
    else if (Gen.status === "offline") body = '<div class="note-box warn"><b>没连上网,这首歌还没有生成。</b><br>我先把你弹的做成了「本地乐队版」,放进了作品库。联网后可以再试一次。</div><button class="btn small" id="gagain" type="button">再试一次</button>';
    else { const w = Gen.work, bars = Array.from({ length: 48 }, (_, i) => 8 + Math.abs(Math.sin(i * 0.7 + (w.id % 7)) * 30) + ((i * 37) % 9)).map((h) => '<i style="height:' + h + 'px"></i>').join("");
      body = "<h2>" + esc(w.title) + '<span class="tag">占位</span></h2><div class="wave">' + bars + '</div><p class="muted">这里是试听卡片。<b>现在播放的是本地乐队版</b>(你弹的音 + 固定和弦 + 鼓),不是 AI 成品;接入 MiniMax 后换成真正的整首歌。已自动放进「作品」。</p><div class="chips"><button class="btn small" id="gplay" type="button">' + (A.previewing ? "停止" : "试听") + '</button><button class="btn ghost small" id="gagain" type="button">再来一版</button></div>'; }
    P.innerHTML = '<h1>生成整首歌</h1><p class="lead">弹完之后的"一步异步"功能:交出去,做好了盘面会用青绿色闪烁叫你。实时弹奏不依赖它。</p>' + body;
    if (Gen.status === "idle") {
      [["take", "刚才弹的那段" + (tk ? "(" + tk.notes.length + " 个音)" : "(还没有)"), !!tk], ["demo", "用一段示例旋律", true]].forEach(([k, n, en]) => { const b = mk('<button class="chip" type="button" ' + (en ? "" : "disabled") + ' aria-pressed="' + ((Gen.src || (tk ? "take" : "demo")) === k) + '">' + n + "</button>"); b.onclick = () => { Gen.src = k; gen(); }; $("#gsrc").appendChild(b); });
      Object.keys(STYLES).forEach((k) => { const b = mk('<button class="chip" type="button" aria-pressed="' + (Gen.style === k) + '">' + STYLES[k][0] + "</button>"); b.onclick = () => { Gen.style = k; gen(); }; $("#gs").appendChild(b); });
      $("#gm").value = Gen.mood; $("#gm").oninput = (e) => (Gen.mood = e.target.value); $("#gnet").onchange = (e) => (Gen.net = e.target.checked);
      $("#gsub").onclick = () => { if (!Gen.src) Gen.src = tk ? "take" : "demo"; if (Gen.src === "take" && !tk) Gen.src = "demo"; V.startGen(); };
    }
    const gc = $("#gcancel"); if (gc) gc.onclick = () => { Gen.status = "idle"; gen(); ctx.toast("已取消"); };
    const ag = $("#gagain"); if (ag) ag.onclick = () => { Gen.status = "idle"; gen(); };
    const gp = $("#gplay"); if (gp) gp.onclick = () => { if (A.previewing) A.stopPreview(); else { A.preview(Gen.work.notes, 60); Gen.heard = true; } gen(); };
  }
  let playingId = null;
  function library() {
    const all = works();
    P.innerHTML = '<h1>作品库</h1><p class="lead">你做过的歌都在这儿,只存在这台电脑里。</p><div id="wl"></div>';
    if (!all.length) $("#wl").innerHTML = '<p class="muted">还没有作品。去弹一段,再「生成整首歌」。</p>';
    all.forEach((w) => {
      const kind = w.kind === "ai" ? (w.placeholder ? "AI 整曲(占位)" : "AI 整曲") : w.kind === "local" ? "本地乐队版" : "自己弹的", dur = w.notes.length ? Math.round(w.notes[w.notes.length - 1].t + 1) : 0;
      const it = mk('<div class="row"><div><b>' + esc(w.title) + (w.demo ? '<span class="tag">示例</span>' : "") + "</b><small>" + kind + " · " + w.style + " · 约 " + dur + " 秒</small></div><div class=\"chips\"><button class=\"btn small\" data-p type=\"button\">" + (A.previewing && playingId === w.id ? "停止" : "播放") + '</button><button class="btn ghost small" data-d type="button">删除</button></div></div>');
      $("[data-p]", it).onclick = () => { if (A.previewing && playingId === w.id) A.stopPreview(); else { playingId = w.id; A.preview(w.notes, 60); } library(); };
      $("[data-d]", it).onclick = () => ctx.confirm("删除「" + w.title + "」?", "会从这台电脑里删掉。" + (w.kind === "ai" ? "如果它已经交给云端服务生成过,云端那份能不能删、留多久,取决于服务商,我现在没法保证替你删干净 [待验证]。" : ""), "删除", () => { saveWorks(works().filter((x) => x.id !== w.id)); library(); ctx.toast("已删除"); });
      $("#wl").appendChild(it);
    });
  }
  window.LPAudio.onPreviewEnd = () => { if (ctx && ctx.cur() === "gen" && Gen.status === "done") gen(); if (ctx && ctx.cur() === "library") library(); };

  /* ---------- 设置与诊断 ---------- */
  const DEV = { ok: "正常", none: "没找到", busy: "被占用", lost: "掉线", driver: "驱动异常" };
  const HELP = { none: ["没找到灯盘", "请确认 USB 线插好;换一个 USB 口。"], busy: ["灯盘被别的程序占用", "请关闭 Ableton、Novation Components 等软件后再试。"], lost: ["灯盘掉线了", "线可能松了。重新插一下,会自动接上。"], driver: ["驱动异常", "请重新插拔;还不行就重启电脑。"] };
  function settings() {
    const ui = ctx.ui, S = Core.settings, lat = A.latency(), info = Stage.info ? Stage.info() : {};
    const seg = (id, label, opts, val) => "<h2>" + label + '</h2><div class="chips" id="' + id + '">' + opts.map(([k, n]) => '<button class="chip" type="button" data-k="' + k + '" aria-pressed="' + (String(val) === String(k)) + '">' + n + "</button>").join("") + "</div>";
    P.innerHTML = '<h1>设置与诊断</h1><p class="lead">一般用不到这一页。出问题时,屏幕上的提示会带你来这里。</p>' +
      '<div class="row col"><b>灯盘:' + DEV[Core.device] + "</b><small>" + (Core.device === "ok" ? "Launchpad MK2 · 80 键 RGB · 无力度感应 · 灯色不能读回(此原型里是屏幕上的虚拟盘面)" : HELP[Core.device][0] + "。" + HELP[Core.device][1]) + '</small><div class="chips" id="sim" style="margin-top:8px"></div></div>' +
      seg("qu", "舞台画质", [["auto", "自动"], ["low", "省电"], ["mid", "均衡"], ["high", "最好"]], ui.quality) +
      seg("sm", "舞台风格(默认由 AI 灯光导演按能量自动换档)", [["auto", "AI 自动"], ["breath", "呼吸"], ["groove", "律动"], ["burst", "爆发"]], ui.styleMode) +
      '<h2>动效与灯</h2><label class="sw-row"><span><b>减少动效</b><small>关闭镜头运动、频闪、光束摆动、粒子;盘面灯色不变。系统开了"减少动效"时默认开启。</small></span><input type="checkbox" id="red"></label>' +
      '<label class="sw-row"><span><b>柔和闪烁</b><small>引导键由硬闪改成平滑呼吸,相位和频率不变(1 次/秒)。</small></span><input type="checkbox" id="soft"></label>' +
      '<h2>盘面底亮度</h2><input id="base" type="range" min="10" max="44" step="1" aria-label="盘面底亮度"><h2>声音</h2><input id="vol" type="range" min="0" max="100" step="1" aria-label="音量"><div class="chips" style="margin-top:9px"><button class="chip" id="tone" type="button">听一声</button></div>' +
      '<h2>舞台信息</h2><table><tr><th>渲染</th><td>' + esc(info.mode || "-") + (info.hdr ? " · HDR" : "") + " · " + esc(String(info.gpu || "").slice(0, 46)) + "</td></tr><tr><th>画质档</th><td>" + esc(info.tier || "-") + " · 分辨率比例 " + (info.dyn || "-") + "</td></tr><tr><th>帧耗时</th><td>" + (info.ms ? info.ms.toFixed(1) + " ms" : "-") + "</td></tr><tr><th>声音</th><td>" + (lat ? "采样率 " + lat.sr + " Hz · 基础延迟 " + (lat.base * 1000).toFixed(0) + " ms · 输出延迟 " + (lat.out ? (lat.out * 1000).toFixed(0) + " ms" : "未知") : "还没开声音(点一下盘面)") + "</td></tr></table>" +
      '<h2>家庭灯光(占位,未连接任何硬件)</h2><p class="kbd" style="margin:0 0 8px">三盏模拟灯和舞台读同一份灯光事件流。引导期间只有灯带跟着引导色闪,其余安静。</p><div class="lamps"><div class="lamp"><i id="lampWash"></i>氛围灯</div><div class="lamp strip"><i id="lampStrip"></i>灯带</div><div class="lamp"><i id="lampAccent"></i>鼓点灯</div></div><div class="row"><div><b>模拟链路延迟 <span id="hdV"></span> 毫秒</b><small>往右拖,看多少毫秒开始"灯慢半拍"。</small></div></div><input id="hd" type="range" min="0" max="250" step="5" aria-label="模拟家庭灯延迟">' +
      '<h2>灯光语言自检</h2><div class="row"><div><b id="auditT">未检查</b><small id="auditS">检查舞台里有没有青绿色不是在叫你按键、引导闪烁是否同相、渲染出来的像素里有没有青绿。</small></div><button class="btn small" id="audit" type="button">现在检查</button></div>' +
      '<h2>键盘</h2><div class="kbd">四排对应盘面从下到上:Z X C V B N M , / A S D F G H J K / Q W E R T Y U I / 1 2 3 4 5 6 7 8。Shift+数字 = 顶排八个键。P = 表演,M = 菜单。</div>';
    Object.keys(DEV).forEach((k) => { const b = mk('<button class="chip" type="button" aria-pressed="' + (Core.device === k) + '">' + DEV[k] + "</button>"); b.onclick = () => { Core.device = k; settings(); }; $("#sim").appendChild(b); });
    $("#red").checked = ctx.reduced(); $("#soft").checked = !!S.soft; $("#base").value = S.base; $("#vol").value = 80;
    const bind = (id, fn) => $("#" + id).querySelectorAll(".chip").forEach((b) => (b.onclick = () => { fn(b.dataset.k); settings(); }));
    bind("qu", (k) => { ui.quality = k; ctx.saveUi(); Stage.setOptions({ quality: k }); }); bind("sm", (k) => { ui.styleMode = k; ctx.saveUi(); Stage.setOptions({ styleMode: k }); });
    $("#red").onchange = (e) => { ui.reduced = e.target.checked; ctx.saveUi(); Stage.setOptions({ reduced: ctx.reduced() }); };
    $("#soft").onchange = (e) => { S.soft = e.target.checked; Core.save("lp3.settings", S); }; $("#base").oninput = (e) => { S.base = +e.target.value; Core.save("lp3.settings", S); };
    $("#vol").oninput = (e) => A.setVolume(+e.target.value / 100);
    $("#tone").onclick = () => { A.ensure(); [60, 64, 67].forEach((m, i) => A.voice("lead", m, A.ensure().currentTime + i * 0.12, 1, 0.5)); };
    $("#audit").onclick = ctx.runAudit;
    const hd = $("#hd"); hd.value = ui.homeDelay; $("#hdV").textContent = hd.value; hd.oninput = () => { ui.homeDelay = +hd.value; $("#hdV").textContent = hd.value; ctx.saveUi(); };
    V.live = () => ctx.lamps();
  }

  V.render = function (id, panel, c) {
    ctx = V.ctx = c; Core = c.Core; A = c.A; Stage = c.Stage; P = panel; V.live = () => {};
    ({ lessons, band, coach, gen, library, settings }[id] || lessons)();
  };
  V.refresh = () => { if (ctx && ctx.cur() === "lessons") lessons(); };
  window.LPViews = V;
})();
