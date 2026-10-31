// 离线生成『大师演出』用的原曲片段素材(开发者工具;运行时不需要 ffmpeg,产物 assets/born-again-clip.js 随原型分发)。
//   输入: testdata/born-again 的 mp3(CC BY 4.0, radionarcotix x Decktonic - Born Again)
//   做法: 1) 以"drop 第一下底鼓"为锚点,按 126 BPM 恒定网格切出 [锚点-8 小节, 锚点+16 小节] = 8 小节 breakdown/蓄力 + 16 小节 drop;
//         2) ffmpeg 重新编码为 Ogg Opus(默认 80 kbps 立体声),base64 内嵌进 .js(file:// 下 fetch/XHR 读本地文件会被浏览器拦截,<script> 与 data 可以);
//         3) 在 22.05 kHz 单声道解码上,对每个 16 分音符格子提取 低频/中频/高频 的起音强度(0~99)与能量 → 舞台灯光"提前知道歌里发生了什么";
//         4) 和弦:每小节手工校对过的罗马数字(I IV V vi),依据 tools 里 chroma 模板匹配的结果(见 首次震撼-视听效果.md 附录)。
//   用法: node tools/analyze_clip.mjs [--kbps=80]
//   分析发现(记录在文档里): analysis.json 里的 123.05 BPM 偏低,drop 之后的拍点回归 + 起音自相关 都给出 126.0 BPM;
//   analysis.json 的 downbeat_phase=2 与"drop 第一下底鼓在 beat 127(127%4=3)"不一致,所以网格锚点用能量/起音实测。
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, "..");
const SRC = path.resolve(root, "../../testdata/born-again/radionarcotix x Decktonic - Born Again - CC BY 4.0/radionarcotix x Decktonic - Born Again.mp3");
const KBPS = +(process.argv.find((a) => a.startsWith("--kbps=")) || "--kbps=80").split("=")[1];
const BPM = 126.0, SPB = 60 / BPM, BAR = 4 * SPB, S16 = SPB / 4;
const BREAK_BARS = 8, DROP_BARS = 16, TOTAL_BARS = BREAK_BARS + DROP_BARS;
const ANCHOR_GUESS = 61.30;   // drop 第一下底鼓(秒,原曲时间轴),由 8 kHz 低频包络 + 拍点回归得到,下面用 22.05 kHz 精修

const run = (args, opt = {}) => { const r = spawnSync("ffmpeg", ["-v", "error", "-y", ...args], { maxBuffer: 1 << 30, ...opt }); if (r.status !== 0) throw new Error("ffmpeg 失败: " + (r.stderr || "").toString()); return r; };

// 1. 解码一个宽松窗口(22.05 kHz 单声道 f32)
const SR = 22050, W0 = ANCHOR_GUESS - BREAK_BARS * BAR - 1, W1 = ANCHOR_GUESS + DROP_BARS * BAR + 1;
const raw = run(["-ss", String(W0), "-t", String(W1 - W0), "-i", SRC, "-ac", "1", "-ar", String(SR), "-f", "f32le", "-"]).stdout;
const f = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 4));
const tOf = (i) => W0 + i / SR;

// 2. 三个频段的包络
const onePole = (fc) => 1 - Math.exp(-2 * Math.PI * fc / SR);
function band(kind) {
  const a1 = onePole(150), a2 = onePole(3000), a3 = onePole(6000), env = new Float32Array(f.length);
  let l1 = 0, l2 = 0, l3 = 0, e = 0;
  for (let i = 0; i < f.length; i++) {
    const x = f[i]; l1 += (x - l1) * a1; l2 += (x - l2) * a2; l3 += (x - l3) * a3;
    const y = kind === "lo" ? l1 : kind === "mid" ? l2 - l1 : x - l3;
    const ay = Math.abs(y); e += (ay - e) * (ay > e ? 0.25 : 0.004);   // 起音快、释放慢
    env[i] = e;
  }
  return env;
}
const lo = band("lo"), mid = band("mid"), hi = band("hi");

// 3. 精修锚点:在猜测值 ±0.12 s 内找低频包络上升最陡的一点
let best = -1, bi = 0;
for (let i = Math.floor((ANCHOR_GUESS - 0.12 - W0) * SR); i < Math.floor((ANCHOR_GUESS + 0.12 - W0) * SR); i++) { const d = lo[i + 24] - lo[i]; if (d > best) { best = d; bi = i + 12; } }
const ANCHOR = Math.round(tOf(bi) * 1000) / 1000;
const START = ANCHOR - BREAK_BARS * BAR;
console.log(`锚点(drop 第一下底鼓)= ${ANCHOR} s(猜测 ${ANCHOR_GUESS});片段 ${START.toFixed(3)} s ~ ${(START + TOTAL_BARS * BAR).toFixed(3)} s,共 ${TOTAL_BARS} 小节 = ${(TOTAL_BARS * BAR).toFixed(2)} s @ ${BPM} BPM`);

// 4. 每个 16 分格子的起音强度 + 能量
const N16 = TOTAL_BARS * 16, cue = { lo: [], mid: [], hi: [], en: [] };
const at = (env, t) => env[Math.max(0, Math.min(env.length - 1, Math.round((t - W0) * SR)))];
function strength(env, tk) {
  const pre = (at(env, tk - 0.075) + at(env, tk - 0.05) + at(env, tk - 0.035)) / 3; let mx = 0;
  for (let dt = -0.025; dt <= 0.025; dt += 0.005) mx = Math.max(mx, at(env, tk + dt) - pre);
  return Math.max(0, mx);
}
const raw16 = { lo: [], mid: [], hi: [], en: [] };
for (let k = 0; k < N16; k++) {
  const tk = START + k * S16; raw16.lo.push(strength(lo, tk)); raw16.mid.push(strength(mid, tk)); raw16.hi.push(strength(hi, tk));
  let s = 0, n = 0; for (let i = Math.floor((tk - W0) * SR); i < Math.floor((tk + S16 - W0) * SR); i++) { s += f[i] * f[i]; n++; } raw16.en.push(Math.sqrt(s / Math.max(1, n)));
}
const pct = (a, p) => { const b = a.slice().sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(b.length * p))] || 1e-9; };
for (const k of ["lo", "mid", "hi", "en"]) { const ref = pct(raw16[k], 0.97); cue[k] = raw16[k].map((v) => Math.min(99, Math.round((v / ref) * 99))); }

// 5. 和弦(每小节一个,罗马数字索引 0=I 1=IV 2=V 3=vi;依据 chroma 模板匹配 + 人工收敛)
//    breakdown 前 4 小节(循环段):vi V vi I;后 4 小节(蓄力):IV I vi I;drop:I V vi vi 循环 4 遍
const chords = [3, 2, 3, 0, 1, 0, 3, 0, ...Array.from({ length: DROP_BARS }, (_, i) => [0, 2, 3, 3][i % 4])];

// 6. 编码 Opus 并内嵌
const tmp = mkdtempSync(path.join(os.tmpdir(), "lp-clip-"));
const ogg = path.join(tmp, "clip.ogg");
run(["-ss", String(START), "-t", String(TOTAL_BARS * BAR + 0.1), "-i", SRC, "-vn", "-c:a", "libopus", "-b:a", KBPS + "k", "-ar", "48000", "-ac", "2", "-f", "ogg", ogg]);
const bytes = readFileSync(ogg); rmSync(tmp, { recursive: true, force: true });
const out = {
  meta: {
    title: "Born Again", artist: "radionarcotix x Decktonic", license: "CC BY 4.0", licenseUrl: "https://creativecommons.org/licenses/by/4.0/", source: "https://montoya.itch.io/born-again",
    change: "截取原曲 " + START.toFixed(2) + "~" + (START + TOTAL_BARS * BAR).toFixed(2) + " s(" + TOTAL_BARS + " 小节),重新编码为 Ogg Opus " + KBPS + " kbps;未做其他处理",
    bpm: BPM, tonicPc: 8, key: "Ab major", anchorSrc: ANCHOR, clipStartSrc: +START.toFixed(3), barSec: +BAR.toFixed(6), breakBars: BREAK_BARS, dropBars: DROP_BARS, sixteenths: N16, bytes: bytes.length, kbps: KBPS,
    scenes: { break: { from: 0, bars: 4 }, build: { from: 4, bars: 4 }, drop: { from: 8, bars: DROP_BARS } },
  },
  chords, cue,
};
mkdirSync(path.join(root, "assets"), { recursive: true });
const js = "/* 自动生成:node tools/analyze_clip.mjs。原曲 'Born Again' by radionarcotix and Decktonic,CC BY 4.0(https://creativecommons.org/licenses/by/4.0/);\n   本文件内嵌的是截取并重新编码的片段(见 meta.change),署名必须保留。 */\n(function(){ var d = " + JSON.stringify(out) + ";\n d.b64 = \"" + bytes.toString("base64") + "\";\n window.LPClip = d; })();\n";
writeFileSync(path.join(root, "assets/born-again-clip.js"), js);
console.log(`写入 assets/born-again-clip.js:音频 ${(bytes.length / 1024).toFixed(0)} KB(base64 后 ${(js.length / 1024).toFixed(0)} KB);16 分格子 ${N16} 个`);
const peek = (a, from, n) => a.slice(from, from + n).map((v) => String(v).padStart(2)).join(" ");
console.log("drop 第 1 小节 lo :", peek(cue.lo, 8 * 16, 16)); console.log("drop 第 1 小节 mid:", peek(cue.mid, 8 * 16, 16)); console.log("drop 第 1 小节 hi :", peek(cue.hi, 8 * 16, 16));
console.log("蓄力 第 4 小节 en :", peek(cue.en, 7 * 16, 16)); console.log("breakdown 第1小节 lo:", peek(cue.lo, 0, 16));
