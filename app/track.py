"""导入一首歌:解码、拍速/拍点/调性分析,供「跟着歌弹」使用。

流程:soundfile 解码 mp3 → 重采样到 48 kHz 立体声(播放用)→ 22.05 kHz 单声道(分析用)
→ librosa 检测拍速与拍点 → 用低频能量估计每小节的第 1 拍 → Krumhansl 模板估计调性。
分析结果缓存为 JSON(与音频同目录),重复启动不再计算。
全部本地处理,不联网、不上传。
"""
import hashlib
import json
import math
from pathlib import Path

import numpy as np

SR = 48000
NOTE_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]
# Krumhansl-Kessler 调性模板
MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


def beats_in_window(beats, pos, frames):
    """beats: 升序的拍点(采样序号,48 kHz)。返回落在 [pos, pos+frames) 的 [(块内偏移, 拍序号)]。"""
    lo = int(np.searchsorted(beats, pos, side="left"))
    hi = int(np.searchsorted(beats, pos + frames, side="left"))
    return [(int(beats[i] - pos), i) for i in range(lo, hi)]


def estimate_key(chroma_mean):
    """chroma_mean: 12 维。返回 (根音 0~11, 'major'|'minor', 相关系数)。"""
    best = (-2.0, 0, "major")
    c = np.asarray(chroma_mean, dtype=float)
    for root in range(12):
        for name, prof in (("major", MAJOR), ("minor", MINOR)):
            r = float(np.corrcoef(c, np.roll(prof, root))[0, 1])
            if r > best[0]:
                best = (r, root, name)
    return best[1], best[2], best[0]


def pentatonic_tonic(root, mode):
    """五声音阶盘面用的主音(0~11):小调取其关系大调的主音,这样大五声音阶恰好是该小调的小五声音阶。"""
    return (root + 3) % 12 if mode == "minor" else root % 12


def load_stereo(path):
    import soundfile as sf
    from scipy.signal import resample_poly

    y, sr = sf.read(str(path), dtype="float32", always_2d=True)
    if y.shape[1] == 1:
        y = np.repeat(y, 2, axis=1)
    y = y[:, :2]
    g = math.gcd(SR, sr)
    if sr != SR:
        y = resample_poly(y, SR // g, sr // g, axis=0).astype("float32")
    peak = float(np.abs(y).max()) or 1.0
    return y * (0.9 / peak) if peak > 0.9 else y


def analyze(path, y48=None, use_cache=True):
    import librosa
    from scipy.signal import resample_poly

    path = Path(path)
    cache = path.with_suffix(".analysis.json")
    key = "%s:%d" % (path.name, path.stat().st_size)
    if use_cache and cache.exists():
        d = json.loads(cache.read_text(encoding="utf-8"))
        if d.get("key") == key:
            return d
    if y48 is None:
        y48 = load_stereo(path)
    mono = y48.mean(axis=1)
    y = resample_poly(mono, 22050, SR).astype("float32")
    sr = 22050
    tempo, bt = librosa.beat.beat_track(y=y, sr=sr, units="time", tightness=120)
    bt = np.asarray(bt, dtype=float)
    tempo = float(np.atleast_1d(tempo)[0])
    # 第 1 拍估计:各拍位置处的低频(<150 Hz)能量,按 mod 4 求平均,取最大者
    S = np.abs(librosa.stft(y, n_fft=2048, hop_length=512)) ** 2
    freqs = librosa.fft_frequencies(sr=sr, n_fft=2048)
    low = S[freqs < 150].sum(axis=0)
    idx = np.clip(librosa.time_to_frames(bt, sr=sr, hop_length=512), 0, len(low) - 1)
    e = low[idx]
    phase = int(np.argmax([e[p::4].mean() if len(e[p::4]) else 0 for p in range(4)])) if len(e) >= 8 else 0
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr).mean(axis=1)
    root, mode, corr = estimate_key(chroma)
    d = {
        "key": key, "file": path.name, "duration": float(len(y) / sr), "bpm": round(tempo, 2),
        "beats": [round(float(x), 4) for x in bt], "downbeat_phase": phase,
        "key_root": root, "key_mode": mode, "key_name": "%s %s" % (NOTE_NAMES[root], mode),
        "key_corr": round(corr, 3), "tonic_pc": pentatonic_tonic(root, mode),
        "beat_regularity": round(float(1 - np.std(np.diff(bt)) / np.mean(np.diff(bt))), 3) if len(bt) > 3 else 0.0,
    }
    cache.write_text(json.dumps(d, ensure_ascii=False), encoding="utf-8")
    return d


def beats_to_samples(beat_times):
    return (np.asarray(beat_times, dtype=float) * SR).astype(np.int64)
