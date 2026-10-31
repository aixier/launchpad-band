"""「随手乐队」原型 v1: 按键直接发声 + 灯光联动 + AI 乐队成员(贝斯 + 和弦)。

- 8x8 盘面 = C 大调五声音阶(任意键都好听);同一行向右 +1 级,向上一行 +2 级。
  同一音名同一颜色(八度不同亮度不同)。
- 按下: 立刻起音、该键变白闪,随后渐变回音名颜色;松开: 进入释音。
- 顶排圆键 CC104~107: 切调(C / D / F / G);CC108: 鼓点;CC109: AI 乐队成员(贝斯+和弦)。
- AI 乐队成员(app/band.py,本地规则,不进网络): 听你弹的音,每小节选 I/IV/V/vi 之一,
  贝斯与和弦垫音与鼓点同一采样时钟对拍。右列 8 个圆键显示节拍位置与当前和弦。
- 灯光在独立线程以 ~30 fps 刷新,只发有变化的键,一条 SysEx 带多键。
- 退出: Ctrl+C 或超过 --seconds。退出时必定熄灯。
"""
import argparse
import colorsys
import math
import threading
import time

import mido
import numpy as np
import sounddevice as sd

import band as bandmod
import track as trackmod

SR = 48000
BPM = 100
BEAT = SR * 60 // BPM  # 28800 样本/拍,与鼓点同一时钟
HDR = [0x00, 0x20, 0x29, 0x02, 0x18]
PENTA = [0, 2, 4, 7, 9]
KEYS = {104: ("C", 60), 105: ("D", 62), 106: ("F", 65), 107: ("G", 67)}

# 音色: (谐波幅度, 起音秒, 衰减时间常数秒, 释音时常秒)
TIMBRES = {
    "lead": ((1.0, 0.35, 0.12), 0.004, 1.2, 0.12),
    "bass": ((1.0, 0.5, 0.0), 0.006, 0.45, 0.10),
    "pad": ((1.0, 0.25, 0.0), 0.12, 3.0, 0.5),
}


def pad_to_degree(row, col):
    return (col - 1) + 2 * (row - 1)


def degree_to_semi(deg):
    return PENTA[deg % 5] + 12 * (deg // 5)


class Engine:
    def __init__(self):
        self.lock = threading.Lock()
        self.voices = {}
        self.drums = []
        self.beat_on = False
        self.band_on = False
        self.band = bandmod.BandAgent(BPM)
        self.beat_pos = 0
        self.sample_clock = 0
        self.stream = None
        self.peak = 0.0
        self.cbs = 0
        self.status = None
        self._bid = 0
        self.track = None          # (N,2) float32,48 kHz
        self.beats = np.zeros(0, dtype=np.int64)
        self.phase = 0
        self.track_pos = 0
        self.track_on = False
        self.beat_flash = 0.0

    def load_track(self, y48, beat_samples, phase):
        self.track, self.beats, self.phase = y48, beat_samples, phase

    def start_track(self):
        self.track_pos, self.track_on = 0, self.track is not None

    def stop_track(self):
        self.track_on = False

    def start(self):
        wasapi = [i for i, h in enumerate(sd.query_hostapis()) if "WASAPI" in h["name"]][0]
        dev = sd.query_hostapis(wasapi)["default_output_device"]
        self.stream = sd.OutputStream(samplerate=SR, blocksize=128, device=dev, channels=2,
                                      dtype="float32", latency="low", callback=self.cb)
        self.stream.start()

    def _add(self, nid, midi, kind, gain=1.0, start=0, hold=None):
        f = 440 * 2 ** ((midi - 69) / 12)
        with self.lock:
            if len(self.voices) >= 24:
                self.voices.pop(next(iter(self.voices)))
            self.voices[nid] = {"w": 2 * np.pi * f / SR, "n": -start, "rel": None, "kind": kind,
                                "g": gain, "hold": None if hold is None else int(hold * SR)}

    def note_on(self, nid, midi):
        self._add(nid, midi, "lead")

    def note_off(self, nid):
        with self.lock:
            v = self.voices.get(nid)
            if v and v["rel"] is None:
                v["rel"] = 0

    def _voice(self, v, t, frames):
        harm, atk, dec, rel_tc = TIMBRES[v["kind"]]
        n = v["n"] + t
        live = n >= 0
        nn = np.maximum(n, 0)
        env = np.minimum(1.0, nn / (atk * SR)) * (np.exp(-nn / (SR * dec)) if dec else 1.0)
        if v["hold"] is not None and v["rel"] is None and v["n"] + frames > v["hold"]:
            v["rel"] = v["n"] - v["hold"]  # 负数 = 释音将在本块内的该样本处开始
        if v["rel"] is not None:
            r = np.maximum(v["rel"] + t, 0)
            env = env * np.exp(-r / (SR * rel_tc))
            v["rel"] += frames
        ph = v["w"] * nn
        s = sum(a * np.sin((k + 1) * ph) for k, a in enumerate(harm) if a)
        return s * env * live * 0.16 * v["g"]

    def _schedule_band(self, beat_in_bar, offset):
        def sched(kind, midi, gain, dur):
            self._bid += 1
            self._add("b%d" % self._bid, midi, kind, gain, start=offset, hold=dur)
        self.band.on_beat(beat_in_bar, sched)

    def cb(self, out, frames, ti, status):
        out[:] = 0
        t = np.arange(frames)
        with self.lock:
            beat_on, band_on = self.beat_on, self.band_on
        clock = self.sample_clock
        # 乐队:每个拍边界(采样精确)
        if self.track is not None and self.track_on:
            pos = self.track_pos
            for off, i in trackmod.beats_in_window(self.beats, pos, frames):
                self.beat_flash = time.perf_counter()
                if band_on:
                    self._schedule_band((i - self.phase) % 4, off)
            seg = self.track[pos:pos + frames]
            if len(seg):
                out[:len(seg)] += seg * 0.55
            self.track_pos = pos + frames
            if self.track_pos >= len(self.track):
                self.track_on = False
        elif band_on:
            first = (-clock) % BEAT
            for off in range(first, frames, BEAT):
                self._schedule_band(((clock + off) // BEAT) % 4, off)
        if beat_on and not self.track_on:
            step = BEAT // 2
            for i in range((-clock) % step, frames, step):
                self.drums.append(["kick" if self.beat_pos % 4 == 0 else "hat", -i])
                self.beat_pos += 1
        with self.lock:
            items = list(self.voices.items())
        dead = []
        for nid, v in items:
            s = self._voice(v, t, frames)
            out[:, 0] += s
            out[:, 1] += s
            v["n"] += frames
            if v["rel"] is not None and v["rel"] > SR * 2.5:
                dead.append(nid)
        for d in list(self.drums):
            n = np.maximum(d[1] + t, 0)
            live = (d[1] + t) >= 0
            if d[0] == "kick":
                f = 55 + 90 * np.exp(-n / (SR * 0.03))
                s = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-n / (SR * 0.15)) * 0.5
            else:
                s = (np.random.rand(frames) * 2 - 1) * np.exp(-n / (SR * 0.025)) * 0.12
            s = s * live
            out[:, 0] += s
            out[:, 1] += s
            d[1] += frames
            if d[1] > SR * 0.5:
                self.drums.remove(d)
        self.sample_clock += frames
        np.tanh(out, out=out)      # 软限幅:多声部叠加不再硬削波
        self.peak = max(self.peak, float(np.abs(out).max()))
        self.cbs += 1
        if status:
            self.status = str(status)
        with self.lock:
            for nid in dead:
                self.voices.pop(nid, None)


# ---- 灯光语言(全产品一致,见 README「引导色规范」)----
# 引导 = 青绿色 + 1 Hz 硬闪烁,只用于"下一步请按这里";音名色盘、控制键身份色全部避开青绿色相。
GUIDE = (0, 63, 40)          # 引导色:亮相
GUIDE_OFF = (0, 6, 4)        # 引导色:闪烁的暗相
GUIDE_NEXT = (0, 16, 11)     # 引导色:下一步预告(常亮,暗)
NOTE_HUES = [0.0, 0.08, 0.14, 0.78, 0.92]   # 红 橙 黄 紫 粉(每个五声音级一色)


def guide_on(now):
    """全局统一相位:所有引导闪烁同时亮、同时灭。"""
    return int(now * 2) % 2 == 0


def is_guide_hue(rgb):
    r, g, b = [x / 63 for x in rgb]
    mx, mn = max(r, g, b), min(r, g, b)
    if mx - mn < 0.25:
        return False
    h = colorsys.rgb_to_hsv(r, g, b)[0]
    return 0.40 <= h <= 0.55


def note_rgb(row, col, v=1.0):
    r, g, b = colorsys.hsv_to_rgb(NOTE_HUES[pad_to_degree(row, col) % 5], 0.9, v)
    return int(r * 63), int(g * 63), int(b * 63)


def lerp(a, b, f):
    return tuple(int(a[i] + (b[i] - a[i]) * f) for i in range(3))


class Lights:
    """初始整盘白(给引导和光效做对比)。按键: 该键绽放音名颜色并向四邻涟漪,再渐回白色。"""

    def __init__(self, out):
        self.out = out
        self.flash = {}          # pad -> [强度, (r,g,b)]
        self.extra = {}          # 右列/顶排等额外键
        self.overlay = {}        # 引导/练习覆盖的格子: pad -> (r,g,b)
        self.base_level = 26     # 白底亮度(0~63)
        self.quiet = True        # 引导期间只绽放被按的键,不向四邻涟漪
        self.last = {}
        self.lock = threading.Lock()
        self.stop = False

    def press(self, pad):
        row, col = divmod(pad, 10)
        c = note_rgb(row, col)
        with self.lock:
            self.flash[pad] = [1.0, c]
            for dr, dc in (() if self.quiet else ((1, 0), (-1, 0), (0, 1), (0, -1))):
                r2, c2 = row + dr, col + dc
                if 1 <= r2 <= 8 and 1 <= c2 <= 8:
                    p2 = r2 * 10 + c2
                    cur = self.flash.get(p2)
                    if not cur or cur[0] < 0.45:
                        self.flash[p2] = [0.45, c]

    def set_extra(self, pad, rgb):
        with self.lock:
            self.extra[pad] = rgb

    def run(self):
        while not self.stop:
            batch = []
            with self.lock:
                base = (self.base_level,) * 3
                for r in range(1, 9):
                    for c in range(1, 9):
                        p = r * 10 + c
                        col = base
                        fl = self.flash.get(p)
                        if fl:
                            col = lerp(base, fl[1], fl[0])
                            fl[0] -= 0.07
                            if fl[0] <= 0:
                                del self.flash[p]
                        if p in self.overlay:
                            col = self.overlay[p]
                        if self.last.get(p) != col:
                            self.last[p] = col
                            batch.append((p, *col))
                for p, col in self.extra.items():
                    if self.last.get(p) != col:
                        self.last[p] = col
                        batch.append((p, *col))
            for i in range(0, len(batch), 80):
                body = [0x0B]
                for e in batch[i:i + 80]:
                    body += list(e)
                self.out.send(mido.Message("sysex", data=HDR + body))
            time.sleep(1 / 30)


# ---- 指法练习(跟着慢闪的键按)----
# 度数 0=C 1=D 2=E 3=G 4=A 5=C'(五声音阶),全部落在盘面第 3 行,列 = 度数+2
LESSONS = [
    ("热身·小羊", [2, 1, 0, 1, 2, 2, 2]),
    ("上行下行", [0, 1, 2, 3, 4, 5, 4, 3, 2, 1, 0]),
    ("跳进", [0, 3, 4, 3, 2, 3, 0]),
]
GOLD = (63, 45, 0)
PATH = (30, 30, 30)          # 路线:中性灰,不带色相


def lesson_pad(d):
    return 30 + d + 2


class Practice:
    def __init__(self, idx=0, intro=False, results=None):
        self.intro, self.idx = intro, idx
        self.results = results if results is not None else {}
        self.reset()

    def reset(self):
        self.seq = [lesson_pad(d) for d in LESSONS[self.idx][1]]
        self.phase, self.pos, self.wrong = "ready", 0, 0
        self.t_start = self.t_done = 0.0
        self.stars = 0
        self.wrong_flash = {}

    def next_lesson(self):
        self.idx = (self.idx + 1) % len(LESSONS)
        self.reset()

    def on_pad(self, note, now):
        """返回 None / 'hit' / 'wrong' / 'finish'。"""
        if self.phase == "done":
            return None
        if note == self.seq[self.pos]:
            if self.pos == 0:
                self.phase, self.t_start = "run", now
            self.pos += 1
            if self.pos >= len(self.seq):
                self.phase, self.t_done = "done", now
                self.stars = 3 if self.wrong == 0 else 2 if self.wrong <= 2 else 1
                self.results[self.idx] = max(self.results.get(self.idx, 0), self.stars)
                return "finish"
            return "hit"
        if self.phase == "run":
            self.wrong += 1
        self.wrong_flash[note] = now
        return "wrong"

    def render(self, now):
        """返回 (overlay{pad:rgb}, extra{pad:rgb})。慢闪 1 Hz。"""
        ov, ex = {}, {}
        blink = guide_on(now)
        if self.phase == "done":
            age = now - self.t_done
            for r in range(1, 9):
                for c in range(1, 9):
                    u = (age * 0.8 - (r + c) * 0.05) % 1.0
                    h = (0.78 + u * 0.36) % 1.0          # 暖彩虹:紫→粉→红→橙→黄,避开引导青绿色相
                    rr, gg, bb = colorsys.hsv_to_rgb(h, 0.9, 1.0)
                    ov[r * 10 + c] = (int(rr * 63), int(gg * 63), int(bb * 63))
            for i, p in enumerate((69, 79, 89)):
                ex[p] = GOLD if i < self.stars else (6, 6, 6)
        else:
            for i, p in enumerate(self.seq):
                ov[p] = note_rgb(p // 10, p % 10) if i < self.pos else PATH
            last = self.seq[-1]
            if self.pos < len(self.seq) - 1:
                ov[last] = (40, 30, 0)                         # 终点标记:暗金常亮
            if self.pos + 1 < len(self.seq) and self.phase == "run":
                ov[self.seq[self.pos + 1]] = GUIDE_NEXT      # 下一个:预告(暗引导色常亮)
            tgt = self.seq[self.pos]
            ov[tgt] = GUIDE if blink else GUIDE_OFF             # 起点与当前目标:同一种引导闪烁
            for p in (69, 79, 89):
                ex[p] = (0, 0, 0)
        for note, t in list(self.wrong_flash.items()):
            if now - t < 0.25:
                ov[note] = (63, 0, 0)
            else:
                del self.wrong_flash[note]
        for i in range(len(LESSONS)):                          # 右列下方 3 个:各课最好成绩
            s = self.results.get(i, 0)
            ex[(i + 1) * 10 + 9] = GOLD if s == 3 else (40, 40, 40) if s == 2 else (30, 12, 0) if s == 1 else (6, 6, 6)
        return ov, ex


class Guide:
    """灯色引导: 跟弹小练习(Practice)→ 开乐队 → 开鼓点 → 换调 → 自由玩 → 邀请进入"指法练习"。
    统一语言: 要按的键 = 引导色(青绿)1 Hz 硬闪烁(全局同相);其余控制键 = 各自身份色(暖色/紫),
    开启亮、关闭暗;还没轮到的键熄灭。"""
    BAND, DRUMS, KEYS_C, PRACTICE = (63, 8, 35), (63, 25, 0), (63, 50, 0), (40, 8, 63)   # 粉 橙 黄 紫
    SONG = (63, 40, 12)          # 歌曲键:暖白金

    def __init__(self):
        self.stage = 0

    def event(self, kind, on=None):
        if self.stage == 0 and kind == "intro":
            self.stage = 1
        elif self.stage == 1 and kind == "band" and on:
            self.stage = 2
        elif self.stage == 2 and kind == "drums" and on:
            self.stage = 3
        elif self.stage == 3 and kind == "key":
            self.stage = 4

    @staticmethod
    def _k(c, f):
        return tuple(int(x * f) for x in c)

    def colors(self, band_on, beat_on, key_cc, practice_on=False, now=None, has_track=False, track_on=False):
        now = time.perf_counter() if now is None else now
        cue = GUIDE if guide_on(now) else GUIDE_OFF
        dim, on = 0.12, 1.0
        out = {c: (0, 0, 0) for c in range(104, 112)}
        if self.stage == 0:
            return out
        out[109] = cue if (self.stage == 1 and not band_on) else self._k(self.BAND, on if band_on else dim)
        if self.stage >= 2:
            out[108] = cue if (self.stage == 2 and not beat_on) else self._k(self.DRUMS, on if beat_on else dim)
        if self.stage >= 3 and not has_track:
            for c in (104, 105, 106, 107):
                if self.stage == 3:
                    out[c] = cue                                  # 四个换调键一起闪:按哪个都行
                else:
                    out[c] = self._k(self.KEYS_C, on if c == key_cc else dim)
        if self.stage >= 4:
            if has_track:        # 有歌时,下一步请按歌曲键;练习键常暗
                out[111] = self._k(self.SONG, on) if track_on else cue
                out[110] = self._k(self.PRACTICE, on if practice_on else dim)
            else:
                out[110] = self._k(self.PRACTICE, on) if practice_on else cue
        return out


def band_lights(lights, info, band_on):
    """右列 8 个圆键(19~89):下 4 个 = 本小节第几拍;上 4 个 = 当前和弦颜色。"""
    side = [r * 10 + 9 for r in range(1, 9)]
    if not band_on:
        for p in side:
            lights.set_extra(p, (0, 0, 0))
        return
    beat = info["beat"]
    hue = [0.0, 0.11, 0.78, 0.92][info.get("idx", 0)]   # 避开引导青绿色相
    cr, cg, cb = colorsys.hsv_to_rgb(hue, 0.9, 0.9)
    chord = (int(cr * 63), int(cg * 63), int(cb * 63))
    for i, p in enumerate(side[:4]):
        lights.set_extra(p, (63, 63, 63) if i == beat else (6, 6, 6))
    for p in side[4:]:
        lights.set_extra(p, chord)


def fanfare(eng, tonic):
    for i, semi in enumerate((0, 4, 7, 12, 16)):
        eng._add("fan%d" % i, tonic + 12 + semi, "lead", 0.9, start=int(i * 0.11 * SR))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seconds", type=float, default=90)
    ap.add_argument("--debug", action="store_true")
    ap.add_argument("--track", help="导入一首歌(mp3/wav),跟着歌弹")
    a = ap.parse_args()
    inp = mido.open_input([n for n in mido.get_input_names() if "Launchpad" in n][0])
    out = mido.open_output([n for n in mido.get_output_names() if "Launchpad" in n][0])
    out.send(mido.Message("sysex", data=HDR + [0x22, 0x00]))
    out.send(mido.Message("sysex", data=HDR + [0x0E, 0x00]))
    eng, lights = Engine(), Lights(out)
    tonic = 60
    has_track = False
    if a.track:
        print("加载并分析:", a.track, flush=True)
        y48 = trackmod.load_stereo(a.track)
        info = trackmod.analyze(a.track, y48)
        eng.load_track(y48, trackmod.beats_to_samples(info["beats"]), info["downbeat_phase"])
        tonic = 60 + info["tonic_pc"]
        has_track = True
        print("拍速 %.1f BPM,调性 %s(相关 %.2f),五声音阶主音 %s,%d 个拍点,第 1 拍相位 %d,时长 %.0f 秒" % (
            info["bpm"], info["key_name"], info["key_corr"], trackmod.NOTE_NAMES[info["tonic_pc"]],
            len(info["beats"]), info["downbeat_phase"], info["duration"]), flush=True)
    eng.band.set_tonic(tonic)
    eng.start()
    th = threading.Thread(target=lights.run, daemon=True)
    th.start()
    guide = Guide()
    lights.quiet = True
    results = {}
    practice = Practice(0, intro=True, results=results)
    key_cc, last_guide_t = 104, 0.0
    print("开始:整盘是白的,青绿色慢闪的键是起点,跟着闪的键按。%d 秒后结束。" % a.seconds, flush=True)
    presses, last_state = 0, None
    try:
        t_end = time.perf_counter() + a.seconds
        while time.perf_counter() < t_end:
            for m in inp.iter_pending():
                now = time.perf_counter()
                if m.type in ("note_on", "note_off"):
                    row, col = divmod(m.note, 10)
                    if not (1 <= row <= 8 and 1 <= col <= 8):
                        continue
                    midi = tonic + degree_to_semi(pad_to_degree(row, col))
                    if m.type == "note_on" and m.velocity > 0:
                        if a.debug:
                            print("按键", m.note, "回调", eng.cbs, "峰值%.3f" % eng.peak, "状态", eng.status,
                                  "和弦", eng.band.info["chord"], flush=True)
                            eng.peak = 0.0
                        eng.note_on(m.note, midi)
                        eng.band.heard(midi)
                        lights.press(m.note)
                        presses += 1
                        if practice:
                            ev = practice.on_pad(m.note, now)
                            if ev == "finish":
                                fanfare(eng, tonic)
                                print("完成「%s」%d 星,错 %d 次" % (LESSONS[practice.idx][0], practice.stars, practice.wrong), flush=True)
                    else:
                        eng.note_off(m.note)
                elif m.type == "control_change" and m.value > 0:
                    if m.control in KEYS and has_track:
                        print("已载入歌曲,调性锁定为歌的调", flush=True)
                    elif m.control in KEYS:
                        tonic = KEYS[m.control][1]
                        key_cc = m.control
                        guide.event("key")
                        eng.band.set_tonic(tonic)
                        print("切调:", KEYS[m.control][0], flush=True)
                    elif m.control == 108:
                        with eng.lock:
                            eng.beat_on = not eng.beat_on
                            eng.beat_pos = 0
                        guide.event("drums", eng.beat_on)
                        print("鼓点:", "开" if eng.beat_on else "关", flush=True)
                    elif m.control == 109:
                        with eng.lock:
                            eng.band_on = not eng.band_on
                        guide.event("band", eng.band_on)
                        print("AI 乐队:", "开" if eng.band_on else "关", flush=True)
                    elif m.control == 111 and guide.stage >= 4 and has_track:
                        if eng.track_on:
                            eng.stop_track()
                            print("歌曲:停", flush=True)
                        else:
                            eng.start_track()
                            with eng.lock:
                                eng.band_on = True
                            print("歌曲:开始,乐队跟着歌的拍点", flush=True)
                    elif m.control == 110 and guide.stage >= 4:
                        if practice:
                            practice = None
                            with lights.lock:
                                lights.overlay, lights.base_level = {}, 26
                            last_state = None
                            print("退出指法练习", flush=True)
                        else:
                            practice = Practice(0, results=results)
                            print("进入指法练习:跟着慢闪的键按", flush=True)
            now = time.perf_counter()
            if now - last_guide_t > 0.066:
                last_guide_t = now
                if practice:
                    if practice.phase == "done" and now - practice.t_done > 2.6:
                        if practice.intro:
                            practice = None
                            guide.event("intro")
                            if has_track:
                                guide.stage = 4      # 有歌:节拍与调性由歌提供,直接引导"放歌"
                            with lights.lock:
                                lights.overlay, lights.base_level = {}, 26
                            last_state = None
                            print("跟弹完成 → 下一步:绿色呼吸的键", flush=True)
                        else:
                            practice.next_lesson()
                    if practice:
                        ov, ex = practice.render(now)
                        with lights.lock:
                            lights.overlay = ov
                            lights.base_level = 10
                        for p, c in ex.items():
                            lights.set_extra(p, c)
                for cc, col in guide.colors(eng.band_on, eng.beat_on, key_cc, bool(practice) and not practice.intro,
                                            has_track=has_track, track_on=eng.track_on).items():
                    lights.set_extra(cc, col)
            if eng.track_on and not practice and guide.stage >= 4:
                with lights.lock:
                    lights.base_level = int(22 + 22 * math.exp(-(now - eng.beat_flash) * 6.0))   # 底色随歌的拍点脉动
            elif has_track and not practice and guide.stage >= 4 and lights.base_level != 26:
                with lights.lock:
                    lights.base_level = 26
            info = dict(eng.band.info)
            state = (info["beat"], info["chord"], eng.band_on)
            lights.quiet = guide.stage < 4 or bool(practice)
            if state != last_state and not practice:
                band_lights(lights, info, eng.band_on and guide.stage >= 4)
                if eng.band_on and info["chord"] != (last_state or (0, None, 0))[1]:
                    print("和弦 →", info["chord"], flush=True)
                last_state = state
            time.sleep(0.001)
    except KeyboardInterrupt:
        pass
    finally:
        lights.stop = True
        th.join(timeout=1)
        eng.stream.stop()
        out.send(mido.Message("sysex", data=HDR + [0x0E, 0x00]))
        inp.close()
        out.close()
        print("结束,共按键 %d 次" % presses)


if __name__ == "__main__":
    main()
