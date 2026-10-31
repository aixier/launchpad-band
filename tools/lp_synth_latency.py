"""自带最小合成器(sounddevice + WASAPI 共享模式小缓冲)的出声延迟,与 GS Wavetable 对比。

测法同 lp_latency.py:WASAPI 环回(soundcard)录扬声器输出,量 trigger -> 首次出声。
合成器: 正弦 + 指数衰减,回调里即时起音(无预渲染)。
用法: python tools/lp_synth_latency.py [blocksize] [次数]
"""
import json
import sys
import threading
import time
from pathlib import Path

import numpy as np
import sounddevice as sd
import soundcard as sc

SR = 48000
THRESH = 0.002
LOG_DIR = Path(__file__).resolve().parent.parent / "logs"


class Synth:
    def __init__(self, block):
        self.voices = []  # [phase_inc, t, amp]
        self.lock = threading.Lock()
        wasapi = [i for i, h in enumerate(sd.query_hostapis()) if "WASAPI" in h["name"]][0]
        dev = sd.query_hostapis(wasapi)["default_output_device"]
        self.stream = sd.OutputStream(samplerate=SR, blocksize=block, device=dev, channels=2,
                                      dtype="float32", latency="low", callback=self.cb)
        self.block = block

    def note_on(self, midi):
        with self.lock:
            self.voices.append([2 * np.pi * 440 * 2 ** ((midi - 69) / 12) / SR, 0, 0.4])

    def cb(self, out, frames, time_info, status):
        out[:] = 0
        with self.lock:
            vs = list(self.voices)
        for v in vs:
            n = np.arange(v[1], v[1] + frames)
            s = np.sin(v[0] * n) * v[2] * np.exp(-n / (SR * 0.4))
            out[:, 0] += s
            out[:, 1] += s
            v[1] += frames
        with self.lock:
            self.voices = [v for v in self.voices if v[1] < SR]


class Loop:
    def __init__(self):
        self.spk = sc.default_speaker()
        self.mic = sc.get_microphone(self.spk.name, include_loopback=True)
        self.blocks, self.stop = [], False

    def start(self):
        def rec():
            import ctypes
            ctypes.windll.ole32.CoInitializeEx(None, 0)  # sounddevice 之后线程需自行初始化 COM
            with self.mic.recorder(samplerate=SR, blocksize=128) as r:
                while not self.stop:
                    d = r.record(numframes=128)
                    self.blocks.append((time.perf_counter(), float(np.abs(d).max())))
        threading.Thread(target=rec, daemon=True).start()
        time.sleep(1)

    def first_over(self, t0, timeout=1.0):
        end = time.perf_counter() + timeout
        while time.perf_counter() < end:
            for t, pk in list(self.blocks):
                if t >= t0 and pk > THRESH:
                    return t
            time.sleep(0.003)


def main():
    block = int(sys.argv[1]) if len(sys.argv) > 1 else 128
    n = int(sys.argv[2]) if len(sys.argv) > 2 else 20
    loop = Loop()
    syn = Synth(block)
    syn.stream.start()  # 先开输出流,环回才有数据
    loop.start()
    log = {"block": block, "stream_latency_s": syn.stream.latency, "time": time.strftime("%Y-%m-%d %H:%M:%S"), "ms": []}
    print("输出流报告延迟: %.1f ms" % (syn.stream.latency * 1000))
    try:
        for i in range(n):
            time.sleep(0.8)
            loop.blocks.clear()
            time.sleep(0.2)
            loop.blocks.clear()
            t0 = time.perf_counter()
            syn.note_on(72)
            t1 = loop.first_over(t0)
            ms = None if t1 is None else (t1 - t0) * 1000
            log["ms"].append(ms)
            print(i + 1, "未检测到" if ms is None else "%.1f ms" % ms, flush=True)
    finally:
        loop.stop = True
        syn.stream.stop()
    ok = sorted(x for x in log["ms"] if x is not None)
    if ok:
        log["stats"] = {"n": len(ok), "min": round(ok[0], 1), "median": round(ok[len(ok) // 2], 1),
                        "p90": round(ok[min(len(ok) - 1, int(len(ok) * .9))], 1), "max": round(ok[-1], 1)}
    print("统计:", log.get("stats"))
    LOG_DIR.mkdir(exist_ok=True)
    p = LOG_DIR / ("synth-latency-b%d-%s.json" % (block, time.strftime("%Y%m%d-%H%M%S")))
    p.write_text(json.dumps(log, ensure_ascii=False, indent=1), encoding="utf-8")
    print("日志:", p)


if __name__ == "__main__":
    main()
