"""效果板:用电脑麦克风听音乐,让 Launchpad 的 RGB 灯阵表达音乐。

不只是频谱:一个"效果导演"根据节拍、能量、频段、段落心情(平静/律动/高潮)
在 8 种场景间切换(频谱、镜像、涟漪、等离子、火焰、扫描、隧道、闪爆),
场景之间交叉淡入淡出。

噪声处理(麦克风是开放环境):
  - 风扇:启动先听 2.5 秒环境噪声,逐频点建底噪,之后只取高出底噪的部分;底噪可缓慢适应(上限 2.5 倍)。
  - 键盘:敲击是 <30 ms 的宽带尖峰。中高频段做 3 帧中值滤波(杀孤立尖峰),
    节拍只看 50~205 Hz 的低频起音(键盘声几乎没有这部分)。
  - 音量自适应(AGC):响度不同都能用;底噪保护避免静音时把风扇放大。

用法:
  python app/visualizer.py                    # 默认麦克风阵列
  python app/visualizer.py --list             # 列出输入设备
  python app/visualizer.py --selftest FILE    # 离线自测:拿歌曲 + 模拟风扇/键盘噪声,测节拍精度
顶排 8 个键:锁定某个场景(再按一次回到自动)。右列:音量表。
"""
import argparse
import collections
import contextlib
import math
import queue
import sys
import threading
import time

import numpy as np

H, W = 8, 8
FPS = 30
SCENES = ["spectrum", "mirror", "ripple", "plasma", "fire", "layers", "tunnel", "burst"]
POOLS = {
    "calm": ["plasma", "tunnel", "mirror"],
    "groove": ["spectrum", "ripple", "layers", "fire", "mirror"],
    "peak": ["burst", "ripple", "tunnel", "fire", "layers"],
}
BAND_EDGES = np.geomspace(50, 14000, 9)

# 风格族:调色板、场景池、频闪、速度、过渡节奏都不同
PROFILES = {
    "dance": dict(name="舞曲", accent=1.0, hue=(0.0, 1.0), sat=1.0, gain=1.4, speed=1.0, fade=0.5, flash_gap=0.34, switch=14.0,
                  pools={"calm": ["plasma", "tunnel", "mirror"], "groove": ["spectrum", "ripple", "layers", "fire", "mirror"],
                         "peak": ["burst", "ripple", "tunnel", "fire", "layers"]}),
    "groove": dict(name="律动", accent=0.8, hue=(0.92, 0.30), sat=0.95, gain=1.35, speed=0.85, fade=0.7, flash_gap=0.6, switch=16.0,
                   pools={"calm": ["mirror", "plasma", "ripple"], "groove": ["spectrum", "ripple", "mirror", "layers", "fire"],
                          "peak": ["fire", "ripple", "layers", "spectrum"]}),
    "mellow": dict(name="抒情", accent=0.3, hue=(0.85, 0.35), sat=0.85, gain=1.25, speed=0.55, fade=1.3, flash_gap=9.0, switch=22.0,
                   pools={"calm": ["plasma", "mirror"], "groove": ["plasma", "ripple", "mirror", "tunnel"],
                          "peak": ["ripple", "mirror", "plasma", "tunnel"]}),
    "ambient": dict(name="氛围", hue=(0.58, 0.27), sat=0.8, gain=1.2, speed=0.4, fade=2.0, flash_gap=9.0, switch=30.0,
                    pools={"calm": ["plasma", "tunnel"], "groove": ["plasma", "tunnel"], "peak": ["plasma", "tunnel", "mirror"]}),
}


# ───────────────────────── 颜色 ─────────────────────────
def hsv(h, s, v):
    h = np.mod(h, 1.0) * 6.0
    i = np.floor(h).astype(int) % 6
    f = h - np.floor(h)
    v = np.asarray(v, dtype=float)
    s = np.asarray(s, dtype=float)
    p, q, t = v * (1 - s), v * (1 - s * f), v * (1 - s * (1 - f))
    r = np.select([i == 0, i == 1, i == 2, i == 3, i == 4, i == 5], [v, q, p, p, t, v])
    g = np.select([i == 0, i == 1, i == 2, i == 3, i == 4, i == 5], [t, v, v, q, p, p])
    b = np.select([i == 0, i == 1, i == 2, i == 3, i == 4, i == 5], [p, p, t, v, v, q])
    return np.stack([r, g, b], axis=-1)


def pal(h):
    """色相映射:跳过 0.40~0.55(青绿留给产品里的"请按这里"引导)。"""
    h = np.mod(h, 1.0) * 0.85
    return np.where(h >= 0.40, h + 0.15, h)


# ───────────────────────── 音频分析 ─────────────────────────
class Onset:
    """单个乐器的起音检测:自适应阈值 + 不应期。"""

    def __init__(self, gap, k=2.0, floor_rel=0.12):
        self.gap, self.k, self.floor_rel = gap, k, floor_rel
        self.prev, self.last = 0.0, -9.0
        self.h = collections.deque(maxlen=FPS * 2)
        self.peak = 1e-9
        self.age = 9.0

    def update(self, level, now, guard=0.0):
        on = max(0.0, level - self.prev)
        self.prev = level
        self.peak = max(guard, level, self.peak * 0.997)
        self.h.append(on)
        hit = False
        if len(self.h) > 20:
            a = np.array(self.h)
            if on > a.mean() + self.k * a.std() and on > self.floor_rel * self.peak and now - self.last > self.gap:
                hit, self.last = True, now
        self.age = now - self.last
        return hit


class Analyzer:
    N = 2048
    CAL_FRAMES = int(2.5 * FPS)

    def __init__(self, sr, filt=True):
        self.sr, self.filt = sr, filt
        self.buf = np.zeros(self.N, dtype=np.float32)
        self.win = np.hanning(self.N).astype(np.float32)
        f = np.fft.rfftfreq(self.N, 1.0 / sr)
        self.hp = (f >= 45).astype(np.float32)
        self.idx = [np.where((f >= BAND_EDGES[i]) & (f < BAND_EDGES[i + 1]))[0] for i in range(8)]
        self.kick_idx = np.where((f >= 50) & (f < 205))[0]
        self.centroid_f = f
        self.cal = []
        self.loose = False
        self.floor = None
        self.floor_cal = None
        self.hist = collections.deque(maxlen=3)
        self.peak = np.full(8, 1e-9)
        self.guard = np.zeros(8)
        self.kick_peak = 1e-9
        self.kick_guard = 0.0
        self.prev_kick = 0.0
        self.onsets = collections.deque(maxlen=FPS * 2)
        self.last_beat = -9.0
        self.beat_count = 0
        self.clicks = 0
        self.beat_times = []
        self.e_fast = self.e_slow = 0.0
        self.e_ref = 1e-3
        self.quiet = 0
        self.mood_state, self.mood_n, self.mood_age = "groove", 0, 0
        self.amb_n = 0
        f = self.centroid_f
        self.snare_idx = np.where((f >= 1700) & (f < 4500))[0]
        self.low_idx = np.where((f >= 40) & (f < 260))[0]
        self.lead_idx = np.where((f >= 260) & (f < 1800))[0]
        self.snare, self.hat = Onset(0.18, 2.0), Onset(0.07, 1.8)
        self.pad_s, self.lead_x, self.lead_lvl, self.bass_pc, self.bass_lvl = 0.0, 0.5, 0.0, 0.0, 0.0
        self.noisy = True      # 麦克风有键盘等尖峰要中值滤波;内录是干净的数字音频,不需要
        self.inst_cnt = {"kick": 0, "snare": 0, "hat": 0}
        self.eh = collections.deque(maxlen=FPS * 10)     # 近 10 秒的特征历史
        self.bh = collections.deque(maxlen=FPS * 10)
        self.style = "groove"
        self.style_info = {}
        self.cand, self.cand_n = None, 0
        self.music_frames = 0

    def push(self, x):
        n = len(x)
        if n >= self.N:
            self.buf = x[-self.N:].astype(np.float32)
        elif n:
            self.buf = np.concatenate([self.buf[n:], x.astype(np.float32)])

    def set_clean(self):
        """内录(电脑直接输出的数字音频)没有环境噪声:跳过校准,底噪设为极小。"""
        self.floor_cal = np.full(self.N // 2 + 1, 0.02)
        self.floor = self.floor_cal.copy()
        nb = np.array([self.floor[ix].sum() for ix in self.idx])
        self.guard = nb * 3 + 1e-3
        self.kick_guard = float(self.floor[self.kick_idx].sum()) * 3 + 1e-3
        self.peak = self.guard.copy()
        self.kick_peak = self.kick_guard
        self.noisy = False

    @property
    def calibrating(self):
        return self.floor is None

    def step(self, now):
        X = np.abs(np.fft.rfft(self.buf * self.win)) * self.hp
        if self.floor is None:
            self.cal.append(X)
            if len(self.cal) >= self.CAL_FRAMES:
                arr = np.array(self.cal)
                tot = arr[:, 4:200].sum(axis=1)       # 校准段的总能量:风扇平稳(p90/p10≈1.3),有音乐则起伏大
                self.loose = float(np.percentile(tot, 90) / max(np.percentile(tot, 10), 1e-9)) > 1.8
                if self.loose:    # 校准时音乐没停:改用逐频点最小值当底噪,并放宽扣除
                    m = arr.min(axis=0)
                else:
                    m = np.median(arr, axis=0)
                self.floor_cal = m * 1.3 + 1e-4
                self.floor = self.floor_cal.copy()
                nb = np.array([self.floor[ix].sum() for ix in self.idx])
                self.guard = nb * 3 + 1e-3
                self.kick_guard = float(self.floor[self.kick_idx].sum()) * 3 + 1e-3
                self.peak = self.guard.copy()
                self.kick_peak = self.kick_guard
            return self._idle(now)
        floor = self.floor if self.filt else np.zeros_like(self.floor)
        clean = np.maximum(0.0, X - (1.2 if self.loose else 2.2) * floor) if self.filt else X
        if self.filt:   # 底噪缓慢适应(风扇变速),上限 2.5 倍
            self.floor = np.clip(np.minimum(X, self.floor * 1.0012), self.floor_cal * (0.05 if self.loose else 0.7), self.floor_cal * 2.5)
        band = np.array([clean[ix].sum() for ix in self.idx])
        kick = float(clean[self.kick_idx].sum())
        self.hist.append(band)
        out = band.copy()
        if self.filt and self.noisy and len(self.hist) == 3:
            a, b, c = self.hist
            out[2:] = np.median(np.stack([a[2:], b[2:], c[2:]]), axis=0)   # 一帧延迟换去孤立尖峰
            if np.any(b[3:] > 3 * np.maximum(a[3:], c[3:]) + self.guard[3:]) and kick < 0.5 * self.kick_peak:
                self.clicks += 1
        self.peak = np.maximum(np.maximum(out, self.guard), self.peak * 0.998)
        norm = np.clip(out / self.peak, 0, 1)
        bands = norm ** 0.6
        energy = float(np.mean(bands))
        # 节拍:只看低频起音
        onset = max(0.0, kick - self.prev_kick)
        self.prev_kick = kick
        self.kick_peak = max(self.kick_guard, kick, self.kick_peak * 0.998)
        self.onsets.append(onset)
        beat = False
        if len(self.onsets) > 20:
            arr = np.array(self.onsets)
            thr = arr.mean() + 1.8 * arr.std()
            if onset > thr and kick > 0.3 * self.kick_peak and onset > 0.12 * self.kick_peak and now - self.last_beat > 0.28:
                beat = True
                self.last_beat = now
                self.beat_count += 1
                self.beat_times.append(now)
        # 分乐器:军鼓(鼓身+中高频噪声)、镲片(高频)、低音线(音高)、主旋律(音高/强弱)、铺底(缓变中频)
        snare_lv = float(out[2] * 0.5 + clean[self.snare_idx].sum() / max(len(self.snare_idx), 1) * 4)
        hat_lv = float(out[7] + 0.5 * out[6])
        snare_hit = self.snare.update(snare_lv, now, float(self.guard[2:6].mean()))
        hat_hit = self.hat.update(hat_lv, now, float(self.guard[6:].mean()))
        if beat:
            self.inst_cnt["kick"] += 1
        self.inst_cnt["snare"] += int(snare_hit)
        self.inst_cnt["hat"] += int(hat_hit)
        low = clean[self.low_idx]
        if low.max() > 4 * float(self.floor_cal[self.low_idx].mean()):
            fb = float(self.centroid_f[self.low_idx[int(np.argmax(low))]])
            self.bass_pc = (12 * math.log2(max(fb, 20.0) / 440.0) + 69) % 12 / 12.0
        self.bass_lvl = float(bands[:2].mean())
        lead = clean[self.lead_idx]
        lead_tot = float(lead.sum())
        peaky = float(lead.max() / (lead.mean() + 1e-9)) if lead_tot > 0 else 0.0
        if peaky > 6.0 and lead_tot > 2 * float(self.guard[2:5].sum()):     # 有明显单一音高才跟踪(人声/主旋律)
            fl = float(self.centroid_f[self.lead_idx[int(np.argmax(lead))]])
            x = math.log2(fl / 260.0) / math.log2(1800.0 / 260.0)
            self.lead_x += (min(1.0, max(0.0, x)) - self.lead_x) * 0.5
            self.lead_lvl += (min(1.0, lead_tot / (float(self.peak[2:5].sum()) + 1e-9)) - self.lead_lvl) * 0.5
        else:
            self.lead_lvl *= 0.85
        self.pad_s += (float(bands[3:6].mean()) - self.pad_s) * (1 - math.exp(-1 / FPS / 1.5))
        # 段落心情
        self.e_fast += (energy - self.e_fast) * (1 - math.exp(-1 / FPS / 1.0))
        self.e_slow += (energy - self.e_slow) * (1 - math.exp(-1 / FPS / 10.0))
        ratio = self.e_fast / max(self.e_slow, 0.05)
        self.quiet = self.quiet + 1 if self.e_fast < 0.07 else 0
        if self.quiet > 2 * FPS:     # 持续 2 秒几乎无声才算"无音乐",避免一闪一闪地切换
            raw, mood = "idle", "idle"
            self.mood_state, self.mood_n, self.mood_age = "groove", 0, 0
        else:
            if ratio > 1.25 or self.e_fast > 0.62:
                raw = "peak"
            elif ratio < 0.6 or self.e_fast < 0.22:
                raw = "calm"
            else:
                raw = "groove"
            # 滞回:新心情要持续一段时间才采纳,且距上次切换至少 8 秒
            self.mood_age += 1
            if raw == self.mood_state:
                self.mood_n = 0
            else:
                self.mood_n += 1
                need = {"peak": 3 * FPS, "calm": 5 * FPS, "groove": 5 * FPS}[raw]
                if self.mood_n >= need and self.mood_age >= 8 * FPS:
                    self.mood_state, self.mood_n, self.mood_age = raw, 0, 0
            mood = self.mood_state
        self.eh.append(energy)
        self.bh.append(float(bands[:2].mean()))
        if mood != "idle":
            self.music_frames += 1
            if self.music_frames >= 8 * FPS and self.music_frames % (4 * FPS) == 0:
                self._update_style(now)
        w = bands + 1e-6
        centroid = float(np.dot(w, np.arange(8)) / w.sum() / 7.0)
        return dict(bands=bands, energy=energy, beat=beat, beat_age=now - self.last_beat, beat_count=self.beat_count,
                    mood=mood, centroid=centroid, bass=float(bands[:2].mean()), mid=float(bands[2:5].mean()),
                    high=float(bands[5:].mean()), now=now, calibrating=False, style=self.style, style_info=self.style_info,
                    snare=bool(snare_hit), hat=bool(hat_hit), snare_age=self.snare.age, hat_age=self.hat.age,
                    bass_lvl=self.bass_lvl, bass_pc=self.bass_pc, lead_lvl=self.lead_lvl, lead_x=self.lead_x, pad=self.pad_s)

    def _update_style(self, now):
        """规则法风格识别:速度 + 节拍规律 + 低频占比 + 能量大小 → 舞曲/律动/抒情/氛围。"""
        bt = np.array([t for t in self.beat_times if t > now - 10.0])
        e_mean, b_mean = float(np.mean(self.eh)), float(np.mean(self.bh))
        bpm, reg = 0.0, 0.0
        if len(bt) >= 6:
            iv = np.diff(bt)
            med = float(np.median(iv))
            ratio = iv / med
            reg = float(np.mean((np.abs(ratio - np.round(np.maximum(ratio, 1))) < 0.22)))
            bpm = 60.0 / med
            while bpm < 70:
                bpm *= 2
            while bpm > 180:
                bpm /= 2
        if len(bt) < 6 or reg < 0.45:
            cv = float(np.std(self.eh) / max(e_mean, 1e-3))     # 能量起伏小 = 持续铺底
            recent60 = sum(1 for t in self.beat_times if t > now - 60.0)
            # 氛围:近一分钟几乎没出现过节拍,且能量平稳;否则最多算抒情
            label = "ambient" if (recent60 < 8 and (cv < 0.25 or e_mean < 0.15)) else "mellow"
        elif bpm >= 118 and reg >= 0.6:
            label = "dance"
        else:
            label = "groove"
        self.style_info = dict(bpm=round(bpm), reg=round(reg, 2), energy=round(e_mean, 2), bass=round(b_mean, 2), raw=label)
        if label == self.style:
            self.cand, self.cand_n = None, 0
        elif label == self.cand:
            self.cand_n += 1
            if self.cand_n >= (3 if label == "ambient" else 2):     # 连续 2 次(进入氛围要 3 次)一致才切换
                self.style, self.cand, self.cand_n = label, None, 0
        else:
            self.cand, self.cand_n = label, 1

    def _idle(self, now):
        return dict(bands=np.zeros(8), energy=0.0, beat=False, beat_age=9.0, beat_count=self.beat_count, mood="idle",
                    centroid=0.5, bass=0.0, mid=0.0, high=0.0, now=now, calibrating=self.floor is None,
                    style=self.style, style_info=self.style_info, snare=False, hat=False, snare_age=9.0, hat_age=9.0,
                    bass_lvl=0.0, bass_pc=0.0, lead_lvl=0.0, lead_x=0.5, pad=0.0)


# ───────────────────────── 效果导演 ─────────────────────────
class Director:
    def __init__(self, seed=None):
        self.rng = np.random.default_rng(seed)
        self.Y, self.X = np.mgrid[0:H, 0:W].astype(float)
        self.cur = "plasma"
        self.prev = None
        self.fade = 1.0
        self.locked = None
        self.hue = float(self.rng.random())
        self.rings = []
        self.heat = np.zeros((H, W))
        self.trail = np.zeros((H, W, 3))
        self.peakhold = np.zeros(W)
        self.flash = 0.0
        self.flash_hue = 0.0
        self.last_flash = -9.0
        self.last_switch = 0.0
        self.last_mood = "idle"
        self.phase_t = 0.0
        self.scan_dir = 0
        self.fire_acc = 0.0
        self.log = []
        self.sparkle = np.zeros((H, W))
        self.snare_f = 0.0
        self.lead_trail = np.zeros((H, W, 3))
        self.style = "groove"
        self.prof = PROFILES["groove"]

    def pal(self, h):
        lo, span = self.prof["hue"]
        h = np.mod(h, 1.0) * span + lo
        if span >= 1.0:      # 舞曲:全色相,但跳过青绿
            h = np.mod(h, 1.0) * 0.85
            h = np.where(h >= 0.40, h + 0.15, h)
        return np.mod(h, 1.0)

    # ---- 选场景 ----
    def _choose(self, F, why):
        pool = [s for s in self.prof["pools"].get(F["mood"], self.prof["pools"]["groove"]) if s != self.cur]
        new = pool[int(self.rng.integers(len(pool)))]
        self.prev, self.cur, self.fade = self.cur, new, 0.0
        self.last_switch = F["now"]
        self.log.append((round(F["now"], 1), F["mood"], new, why))

    def update_scene(self, F):
        if self.locked:
            if self.cur != self.locked:
                self.prev, self.cur, self.fade = self.cur, self.locked, 0.0
            return
        mood = F["mood"]
        if mood == "idle":
            self.last_mood = mood
            return
        since = F["now"] - self.last_switch
        if mood != self.last_mood and since > 8.0:
            self._choose(F, "心情→" + mood)
        elif F["beat"] and F["beat_count"] % 16 == 0 and since > 10.0:
            self._choose(F, "16拍")
        elif since > self.prof["switch"]:
            self._choose(F, "超时")
        self.last_mood = mood

    # ---- 渲染 ----
    def render(self, F, dt):
        if F["style"] != self.style:
            self.style, self.prof = F["style"], PROFILES[F["style"]]
            self.log.append((round(F["now"], 1), "风格→" + self.prof["name"], F["style_info"]))
            if self.cur not in self.prof["pools"].get(F["mood"], []) and F["mood"] != "idle":
                self._choose(F, "风格切换")
        dt = dt * self.prof["speed"]
        self.update_scene(F)
        if F["beat"] and F["beat_count"] % 4 == 0:
            self.hue = (self.hue + 0.13 + 0.05 * self.rng.random()) % 1.0
        self.hue = (self.hue + dt * 0.01) % 1.0
        if F["mood"] == "idle" or F["calibrating"]:
            return self._idle(F)
        self.fade = min(1.0, self.fade + dt / self.prof["fade"] * self.prof["speed"])
        img = self._scene(self.cur, F, dt)
        if self.fade < 1.0 and self.prev:
            img = img * self.fade + self._scene(self.prev, F, 0.0, passive=True) * (1 - self.fade)
        acc = self.prof.get("accent", 0.0)
        if acc > 0 and self.cur != "layers":
            if F["hat"]:
                for _ in range(2):
                    self.sparkle[int(self.rng.integers(0, H)), int(self.rng.integers(0, W))] = 1.0
            if F["snare"]:
                self.snare_f = 1.0
            self.sparkle *= math.exp(-10.0 * dt)
            self.snare_f *= math.exp(-9.0 * dt)
            img = np.maximum(img, hsv(self.pal(self.hue + 0.15), 0.4, self.sparkle * 0.8 * acc))
            img = img + hsv(self.pal(self.hue + 0.5), 0.8, np.full((H, W), self.snare_f * 0.18 * acc))
        # 保色相的增益:超出 1 的整体缩回(不是各通道各自截断,否则高亮会变白),再加对比曲线拉开明暗
        img = img * self.prof["gain"]
        img = img / np.maximum(1.0, img.max(axis=-1, keepdims=True))
        lum = img.max(axis=-1, keepdims=True)
        img = lum * (1 - self.prof["sat"]) + img * self.prof["sat"]
        return np.clip(img, 0, 1) ** 1.1

    def _idle(self, F):
        t = F["now"]
        breath = 0.10 + 0.08 * (0.5 + 0.5 * math.sin(t * 1.5))
        img = np.zeros((H, W, 3)) + np.array([1.0, 0.85, 0.6]) * breath
        if F["calibrating"]:   # 校准:一条橙色进度扫描,提示"先别放音乐"
            x = int((t * 4) % W)
            img[:, x] = np.array([1.0, 0.45, 0.0]) * 0.5
        return img

    def _scene(self, name, F, dt, passive=False):
        return getattr(self, "s_" + name)(F, dt, passive)

    def s_spectrum(self, F, dt, passive):
        h = F["bands"] * H
        img = np.zeros((H, W, 3))
        for c in range(W):
            full = int(h[c])
            frac = h[c] - full
            for r in range(H):
                if r < full:
                    v = 0.3 + 0.7 * (r + 1) / (full + 1)
                elif r == full:
                    v = frac
                else:
                    v = 0.0
                if v > 0:
                    img[r, c] = hsv(self.pal(self.hue + c * 0.07 + r * 0.015), 1.0, v)
            if not passive:
                self.peakhold[c] = max(self.peakhold[c] - 5 * dt, h[c])
            ph = int(min(H - 1, self.peakhold[c]))
            if self.peakhold[c] > 0.5:
                img[ph, c] = np.maximum(img[ph, c], 0.8)
        return img

    def s_mirror(self, F, dt, passive):
        d = np.abs(self.Y - 3.5)
        img = np.zeros((H, W, 3))
        for c in range(W):
            v = np.clip(F["bands"][c] * 4.2 - d[:, c] + 0.3, 0, 1) * (0.45 + 0.55 * d[:, c] / 3.5)
            img[:, c] = hsv(self.pal(self.hue + c * 0.09 + d[:, c] * 0.03), 1.0, v)
        return img

    def s_ripple(self, F, dt, passive):
        if F["beat"] and not passive:
            if not self.rings:
                cx, cy = 3.5, 3.5
            else:
                cx, cy = self.rng.integers(0, W), self.rng.integers(0, H)
            self.rings.append([float(cx), float(cy), F["now"], float(self.hue + self.rng.random() * 0.2),
                               4.0 + 6.0 * F["bass"]])
            self.rings = self.rings[-8:]
        img = np.zeros((H, W, 3))
        img += hsv(self.pal(self.hue), 1.0, 0.04 + 0.12 * F["energy"])[None, None, :]
        for cx, cy, t0, hue, sp in self.rings:
            age = F["now"] - t0
            if age > 2.5:
                continue
            dist = np.hypot(self.X - cx, self.Y - cy)
            m = np.exp(-((dist - sp * age) ** 2) / 0.7) * math.exp(-age * 1.2)
            img = np.maximum(img, hsv(self.pal(hue + dist * 0.03), 1.0, m[..., None][..., 0]))
        return img

    def s_plasma(self, F, dt, passive):
        if not passive:
            self.phase_t += dt * (0.5 + 2.5 * F["energy"])
        t = self.phase_t
        v = (np.sin(self.X * 0.9 + t * 1.1) + np.sin(self.Y * 1.1 - t * 0.9) +
             np.sin((self.X + self.Y) * 0.6 + t * 0.7) +
             np.sin(np.hypot(self.X - 3.5, self.Y - 3.5) * 0.9 - t * 1.3)) / 4.0
        v = 0.5 + 0.5 * v
        br = 0.04 + 0.96 * np.clip(F["energy"] * 1.4, 0, 1) * v ** 2
        if F["beat_age"] < 0.15:
            br = np.clip(br + 0.25 * (1 - F["beat_age"] / 0.15), 0, 1)
        return hsv(self.pal(self.hue + v * 0.35 + F["centroid"] * 0.2), 1.0, br)

    def s_fire(self, F, dt, passive):
        if not passive:
            self.fire_acc += dt
            while self.fire_acc >= 1.0 / FPS:
                self.fire_acc -= 1.0 / FPS
                below = self.heat[:-1]
                cool = 0.78 + 0.10 * F["energy"]
                new = np.empty_like(self.heat)
                new[1:] = (np.roll(below, 1, 1) + 2 * below + np.roll(below, -1, 1)) / 4 * cool
                new[0] = np.clip(self.rng.random(W) * 0.35 + F["bass"] * 0.9 + (0.5 if F["beat_age"] < 0.1 else 0), 0, 1)
                self.heat = new
        h = self.heat
        return np.stack([np.clip(h * 3, 0, 1), np.clip(h * 3 - 1, 0, 1) * 0.8, np.clip(h * 3 - 2, 0, 1) * 0.6], axis=-1)

    def s_scanner(self, F, dt, passive):
        if not passive:
            if F["beat"] and F["beat_count"] % 8 == 0:
                self.scan_dir ^= 1
            self.trail *= 0.80 ** (dt * FPS)
            sp = 1.2 + 4.0 * F["energy"]
            tri = abs(((F["now"] * sp) % 14.0) - 7.0)
            width = 0.6 + 1.4 * F["energy"]
            coord = self.X if self.scan_dir == 0 else self.Y
            m = np.exp(-((coord - tri) ** 2) / (2 * width ** 2))
            col = hsv(self.pal(self.hue + tri * 0.05), 1.0, m)
            self.trail = np.maximum(self.trail, col * (0.5 + 0.5 * min(1.0, F["energy"] * 1.5)))
        return self.trail.copy()

    def s_tunnel(self, F, dt, passive):
        if not passive:
            self.phase_t += dt * (2.0 + 5.0 * F["energy"])
        dist = np.hypot(self.X - 3.5, self.Y - 3.5)
        v = (0.5 + 0.5 * np.sin(dist * 1.9 - self.phase_t)) ** 3
        br = v * (0.25 + 0.75 * np.clip(F["energy"] * 1.4, 0, 1))
        if F["beat_age"] < 0.12:
            br = np.clip(br + 0.3 * (1 - F["beat_age"] / 0.12) * (1 - dist / 6), 0, 1)
        return hsv(self.pal(self.hue + dist * 0.07), 1.0, br)

    def hsv_(self, h, s, v):
        return hsv(self.pal(h), s, v)

    def s_layers(self, F, dt, passive):
        """按乐器分层:铺底=背景色雾,低音=底部两行(色随音高),底鼓=自底向上的光环,
        军鼓=中线横扫,镲片=顶部星点,主旋律=跟着音高移动的亮点。"""
        if not passive:
            if F["beat"]:
                self.rings.append([3.5, -0.5, F["now"], float(self.hue), 6.5])
                self.rings = self.rings[-5:]
            if F["snare"]:
                self.snare_f = 1.0
            self.snare_f *= math.exp(-9.0 * dt)
            if F["hat"]:
                for _ in range(3):
                    self.sparkle[int(self.rng.integers(4, H)), int(self.rng.integers(0, W))] = 1.0
            self.sparkle *= math.exp(-10.0 * dt)
            self.lead_trail *= math.exp(-6.0 * dt)
        img = np.zeros((H, W, 3))
        img += self.hsv_(self.hue + 0.5, 0.8, 0.04 + 0.22 * F["pad"])[None, None, :]              # 铺底
        for r in range(2):                                                                      # 低音
            m = np.clip(F["bass_lvl"] * (W / 2.0) - np.abs(np.arange(W) - 3.5) + 0.5, 0, 1) * (1.0 - 0.45 * r)
            img[r] = np.maximum(img[r], self.hsv_(np.full(W, 0.95 + 0.25 * F["bass_pc"]), 1.0, m))
        for cx, cy, t0, hue, sp in self.rings:                                                  # 底鼓
            age = F["now"] - t0
            if 0 <= age < 1.2:
                dist = np.hypot(self.X - cx, self.Y - cy)
                m = np.exp(-((dist - sp * age) ** 2) / 0.8) * math.exp(-age * 2.2)
                img = np.maximum(img, hsv(self.pal(hue + dist * 0.03), 1.0, m))
        if self.snare_f > 0.02:                                                                 # 军鼓
            m = np.exp(-((self.Y - 4.0) ** 2) / 0.5) * self.snare_f
            img = np.maximum(img, hsv(self.pal(self.hue + 0.5), 0.75, m))
        img = np.maximum(img, hsv(self.pal(self.hue + 0.12), 0.35, self.sparkle))              # 镲片
        if F["lead_lvl"] > 0.12 and not passive:                                                # 主旋律
            cx = F["lead_x"] * (W - 1)
            cy = 3.0 + 3.0 * min(1.0, F["lead_lvl"])
            d = np.hypot(self.X - cx, self.Y - cy)
            self.lead_trail = np.maximum(self.lead_trail, hsv(self.pal(0.1 + F["lead_x"] * 0.7), 1.0,
                                                              np.exp(-d ** 2 / 0.9) * min(1.0, 0.4 + F["lead_lvl"])))
        return np.maximum(img, self.lead_trail)

    def s_burst(self, F, dt, passive):
        if F["beat"] and not passive and F["now"] - self.last_flash > self.prof["flash_gap"]:   # 全盘闪 ≤3 次/秒
            self.flash, self.last_flash = 1.0, F["now"]
            self.flash_hue = float(self.rng.random())
        if not passive:
            self.flash *= math.exp(-6.0 * dt)
        dist = np.hypot(self.X - 3.5, self.Y - 3.5)
        img = hsv(self.pal(self.flash_hue + dist * 0.04), 1.0 - 0.2 * self.flash, self.flash * 0.9 * (1 - dist / 9.0))
        img = np.maximum(img, self.s_spectrum(F, 0.0, True) * 0.35)
        return img


# ───────────────────────── Launchpad 输出 ─────────────────────────
class Pad:
    HDR = [0x00, 0x20, 0x29, 0x02, 0x18]

    def __init__(self):
        import mido
        self.mido = mido
        outs = [n for n in mido.get_output_names() if "Launchpad" in n]
        ins = [n for n in mido.get_input_names() if "Launchpad" in n]
        if not outs:
            raise RuntimeError("没找到 Launchpad,请检查 USB")
        self.out = mido.open_output(outs[0])
        self.inp = mido.open_input(ins[0]) if ins else None
        self.out.send(mido.Message("sysex", data=self.HDR + [0x22, 0x00]))   # Session 布局
        self.last = {}
        self.n = 0

    @staticmethod
    def cells():
        return [(r, c, (r + 1) * 10 + (c + 1)) for r in range(H) for c in range(W)]

    def show(self, img, vu, scene_idx, locked_idx):
        want = {}
        for r, c, led in self.cells():
            want[led] = tuple(int(round(63 * float(v) ** 1.0)) for v in img[r, c])
        for r in range(H):   # 右列:音量表
            lit = vu * H > r
            want[(r + 1) * 10 + 9] = (50, 36, 14) if lit else (0, 0, 0)
        for i in range(8):   # 顶排:当前场景
            on = i == scene_idx
            want[104 + i] = ((63, 63, 63) if i == locked_idx else (24, 24, 24)) if on else (0, 0, 0)
        self.n += 1
        full = self.n % (FPS * 3) == 0
        data = []
        for led, rgb in want.items():
            if full or self.last.get(led) != rgb:
                data += [led, *rgb]
                self.last[led] = rgb
        for i in range(0, len(data), 5 * 80):
            try:
                self.out.send(self.mido.Message("sysex", data=self.HDR + [0x0B] + data[i:i + 400]))
            except Exception as e:      # USB 抖动:丢这一帧,重开端口,下一帧整盘重发
                self.last = {}
                self.errors = getattr(self, "errors", 0) + 1
                print("MIDI 发送失败(%s),重试" % e, flush=True)
                time.sleep(0.2)
                try:
                    self.out.close()
                    self.out = self.mido.open_output([n for n in self.mido.get_output_names() if "Launchpad" in n][0])
                    self.out.send(self.mido.Message("sysex", data=self.HDR + [0x22, 0x00]))
                except Exception:
                    pass
                return

    def close(self):
        try:
            self.out.send(self.mido.Message("sysex", data=self.HDR + [0x0E, 0x00]))
            self.out.close()
            if self.inp:
                self.inp.close()
        except Exception:
            pass


# ───────────────────────── 麦克风 ─────────────────────────
def pick_mic(sd, idx=None):
    if idx is not None:
        return idx
    apis = sd.query_hostapis()
    for i, d in enumerate(sd.query_devices()):
        if d["max_input_channels"] > 0 and "麦克风" in d["name"] and apis[d["hostapi"]]["name"] == "Windows WASAPI":
            return i
    return sd.default.device[0]


def run_live(a):
    loop = a.source == "loop"
    q = queue.Queue()
    stop = threading.Event()
    if loop:
        import warnings
        import soundcard as sc
        warnings.filterwarnings("ignore")
        sp = next((x for x in sc.all_speakers() if a.speaker and a.speaker in x.name), None) if a.speaker else sc.default_speaker()
        sr = 48000
        name = "内录:" + sp.name

        def reader():
            m = sc.get_microphone(sp.name, include_loopback=True)
            with m.recorder(samplerate=sr, channels=2, blocksize=512) as rec:
                while not stop.is_set():
                    q.put(rec.record(numframes=512).mean(axis=1).astype(np.float32))
        threading.Thread(target=reader, daemon=True).start()
        stream = contextlib.nullcontext()
    else:
        import sounddevice as sd
        dev = pick_mic(sd, a.mic)
        info = sd.query_devices(dev)
        sr = int(info["default_samplerate"])
        name = "麦克风:" + info["name"]

        def cb(indata, frames, t, status):
            q.put(indata.mean(axis=1).copy())
        stream = sd.InputStream(device=dev, channels=min(2, info["max_input_channels"]), samplerate=sr, blocksize=512, callback=cb)

    ana = Analyzer(sr, filt=not a.no_filter)
    if loop:
        ana.set_clean()
    dirc = Director(a.seed)
    pad = None if a.no_pad else Pad()
    print(name, sr, "Hz")
    if loop:
        print("内录模式:直接取电脑播放的声音(戴耳机也行),不受风扇和键盘影响,无需校准。")
        print("提示:要播放音乐的输出设备(耳机)需是系统默认输出,或用 --speaker 指定名称。", flush=True)
    else:
        print("先别放音乐、也别敲键盘:正在听 2.5 秒环境噪声(风扇)……", flush=True)
    announced = loop
    t_start = time.perf_counter()
    last = t_start
    locked = None
    stat_t = t_start
    got = 0
    try:
        with stream:
            while time.perf_counter() - t_start < a.seconds:
                now = time.perf_counter() - t_start
                dt = max(1e-3, time.perf_counter() - last)
                last = time.perf_counter()
                try:
                    while True:
                        x = q.get_nowait()
                        got += len(x)
                        ana.push(x)
                except queue.Empty:
                    pass
                if loop and now * sr - got > 0.25 * sr:    # 没在播放时 WASAPI 不出数据:补零,别让画面停在旧声音上
                    z = int(now * sr - got)
                    ana.push(np.zeros(min(z, ana.N), dtype=np.float32))
                    got += z
                F = ana.step(now)
                if not announced and not F["calibrating"]:
                    announced = True
                    print("校准完成,现在可以放音乐了。" if not ana.loose else
                          "校准时检测到已有音乐在播:改用宽松模式(风扇过滤较弱,音乐停顿时会自动学到真正的底噪)。", flush=True)
                img = dirc.render(F, dt)
                if pad:
                    if pad.inp:
                        for m in pad.inp.iter_pending():
                            if m.type == "control_change" and 104 <= m.control <= 111 and m.value == 127:
                                i = m.control - 104
                                locked = None if locked == i else i
                                dirc.locked = SCENES[locked] if locked is not None else None
                                print("场景锁定:", dirc.locked or "自动", flush=True)
                    pad.show(img, min(1.0, F["energy"] * 1.6), SCENES.index(dirc.cur), locked)
                if now - (stat_t - t_start) >= 2.0:
                    stat_t = time.perf_counter()
                    si = F["style_info"]
                    c = ana.inst_cnt
                    print("%5.1fs 风格=%s(速度%s) 心情=%-6s 场景=%-8s 能量=%.2f | 鼓%d 军鼓%d 镲%d 旋律%.2f 低音%.2f" % (
                        now, PROFILES[F["style"]]["name"], si.get("bpm", "-"), F["mood"], dirc.cur, F["energy"],
                        c["kick"], c["snare"], c["hat"], F["lead_lvl"], F["bass_lvl"]), flush=True)
                time.sleep(max(0.0, 1.0 / FPS - (time.perf_counter() - last)))
    finally:
        stop.set()
        if pad:
            pad.close()
    print("场景切换记录:", dirc.log[-12:])


# ───────────────────────── 离线自测 ─────────────────────────
def make_noise(n, sr, rng, fan=True, keys=True, key_rate=5.0, fan_db=-38, key_db=-18):
    x = np.zeros(n, dtype=np.float32)
    if fan:
        from scipy.signal import butter, lfilter
        b, a_ = butter(2, [60 / (sr / 2), 3000 / (sr / 2)], btype="band")
        f = lfilter(b, a_, rng.standard_normal(n)).astype(np.float32)
        f += 0.5 * np.sin(2 * np.pi * 120 * np.arange(n) / sr).astype(np.float32) * f.std()
        x += f / f.std() * 10 ** (fan_db / 20)
    if keys:
        for t in np.cumsum(rng.exponential(1 / key_rate, int(n / sr * key_rate * 1.5))):
            i = int(t * sr)
            if i + 800 >= n:
                break
            k = np.arange(800)
            click = rng.standard_normal(800) * np.exp(-k / 90.0) + 0.6 * np.sin(2 * np.pi * 350 * k / sr) * np.exp(-k / 200.0)
            x[i:i + 800] += (click * 10 ** (key_db / 20) * (0.5 + rng.random())).astype(np.float32)
    return x


def run_pipeline(sig, sr, filt):
    ana = Analyzer(sr, filt=filt)
    hop = sr // FPS
    ana.en = []
    for k in range(len(sig) // hop):
        ana.push(sig[k * hop:(k + 1) * hop])
        F = ana.step(k / FPS)
        ana.en.append((k / FPS, F["energy"], F["mood"]))
    return ana


def selftest(a):
    import soundfile as sf
    from scipy.signal import resample_poly
    rng = np.random.default_rng(1)
    y, sr0 = sf.read(a.selftest, dtype="float32", always_2d=True)
    y = y.mean(axis=1)
    sr = 48000
    g = math.gcd(sr, sr0)
    y = resample_poly(y, sr // g, sr0 // g).astype(np.float32) if sr0 != sr else y
    seg = y[sr * 60:sr * 85]
    seg = seg / np.sqrt(np.mean(seg ** 2)) * 0.05    # 麦克风里的音乐约 -26 dBFS
    lead, tail = int(3 * sr), int(10 * sr)
    total = lead + len(seg) + tail
    music = np.zeros(total, dtype=np.float32)
    music[lead:lead + len(seg)] = seg
    noise = make_noise(total, sr, rng)
    cases = {"干净(无噪声)": (music, True), "有噪声·不过滤": (music + noise, False), "有噪声·过滤": (music + noise, True)}
    t_music = (lead / sr, (lead + len(seg)) / sr)
    ref = None
    for name, (sig, filt) in cases.items():
        ana = run_pipeline(sig, sr, filt)
        bt = np.array(ana.beat_times)
        if ref is None:
            ref = bt[(bt >= t_music[0]) & (bt <= t_music[1])]
        inm = bt[(bt >= t_music[0]) & (bt <= t_music[1])]
        tail_b = bt[bt > t_music[1] + 0.5]
        prec = float(np.mean([np.min(np.abs(ref - b)) < 0.07 for b in inm])) if len(inm) else 0
        rec = float(np.mean([np.min(np.abs(inm - r)) < 0.07 for r in ref])) if len(inm) else 0
        tail_e = [e for t, e, m in ana.en if t > t_music[1] + 1.0]
        tail_idle = float(np.mean([m == "idle" for t, e, m in ana.en if t > t_music[1] + 1.0]))
        print("   纯噪声段:平均能量 %.3f,判为'无音乐'的时间占比 %.0f%%" % (np.mean(tail_e), 100 * tail_idle))
        print("%-14s 音乐段节拍 %3d(干净基准 %d) 精确率 %.2f 召回率 %.2f | 只有风扇+键盘的 10 秒里误触发 %d 次 | 键盘尖峰已滤 %d" % (
            name, len(inm), len(ref), prec, rec, len(tail_b), ana.clicks))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seconds", type=int, default=600)
    ap.add_argument("--mic", type=int)
    ap.add_argument("--source", choices=["mic", "loop"], default="mic", help="mic=麦克风监听  loop=内录电脑播放(戴耳机用)")
    ap.add_argument("--speaker", help="内录的输出设备名称(包含即可)")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--no-pad", action="store_true")
    ap.add_argument("--no-filter", action="store_true")
    ap.add_argument("--seed", type=int)
    ap.add_argument("--selftest")
    a = ap.parse_args()
    if a.list:
        import sounddevice as sd
        apis = sd.query_hostapis()
        for i, d in enumerate(sd.query_devices()):
            if d["max_input_channels"] > 0:
                print(i, apis[d["hostapi"]]["name"], d["name"], int(d["default_samplerate"]))
        return
    if a.selftest:
        return selftest(a)
    run_live(a)


if __name__ == "__main__":
    main()
