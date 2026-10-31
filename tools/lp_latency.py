"""按键 -> 出声 延迟测量(Windows 自带 Microsoft GS Wavetable Synth 路径)。

原理:WASAPI 环回(loopback)录下默认扬声器的输出,脚本在时刻 t_send 向 GS Wavetable
发 note_on,取环回里首次超过阈值的时刻 t_hear,延迟 = t_hear - t_send。
  synth  : 脚本直接发 note_on(不含 USB/按键),测"MIDI 发出 -> 声音出现在系统混音"
  key    : 用户按 Launchpad 键,收到即转发 note_on,测"主机收到按键 -> 出声"(不含 USB 传输)
校准(click): 用同一条路径播放一个已知时刻的短脉冲,测出测量链自身的偏差,从结果里扣除。
误差约 ±(环回块长 + 调度),仅作量级判断;不含扬声器/耳机本身的物理与蓝牙延迟。

用法: python tools/lp_latency.py synth|click|key [次数]
"""
import json
import sys
import threading
import time
from pathlib import Path

import mido
import numpy as np
import soundcard as sc

SR = 48000
BLOCK = 128  # ~2.7 ms
THRESH = 0.002
LOG_DIR = Path(__file__).resolve().parent.parent / "logs"


class Loop:
    """持续环回录音,记录每块到达时刻(perf_counter)与峰值。"""

    def __init__(self):
        self.spk = sc.default_speaker()
        self.mic = sc.get_microphone(self.spk.name, include_loopback=True)
        self.blocks = []  # (t_arrive, peak)
        self.stop = False

    def _keep_alive(self):  # 环回在无输出时可能不出数据,持续播放静音
        with self.spk.player(samplerate=SR, blocksize=1024) as p:
            z = np.zeros((1024, 2), dtype=np.float32)
            while not self.stop:
                p.play(z)

    def _rec(self):
        with self.mic.recorder(samplerate=SR, blocksize=BLOCK) as r:
            while not self.stop:
                d = r.record(numframes=BLOCK)
                self.blocks.append((time.perf_counter(), float(np.abs(d).max())))

    def start(self):
        for f in (self._keep_alive, self._rec):
            threading.Thread(target=f, daemon=True).start()
        time.sleep(1.0)

    def first_over(self, t_after, timeout=1.0):
        t_end = time.perf_counter() + timeout
        seen = 0
        while time.perf_counter() < t_end:
            snap = self.blocks[seen:]
            for i, (t, pk) in enumerate(snap):
                if t >= t_after and pk > THRESH:
                    return t
            time.sleep(0.005)
        return None


def stats(xs):
    xs = sorted(xs)
    if not xs:
        return {}
    n = len(xs)
    return {"n": n, "min": round(xs[0], 1), "median": round(xs[n // 2], 1),
            "p90": round(xs[min(n - 1, int(n * 0.9))], 1), "max": round(xs[-1], 1)}


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "synth"
    n = int(sys.argv[2]) if len(sys.argv) > 2 else 20
    loop = Loop()
    loop.start()
    log = {"mode": mode, "speaker": loop.spk.name, "time": time.strftime("%Y-%m-%d %H:%M:%S"), "ms": []}
    gs = [x for x in mido.get_output_names() if "GS Wavetable" in x]
    out = mido.open_output(gs[0]) if gs else None
    out.send(mido.Message("program_change", program=0))  # 钢琴
    try:
        for i in range(n):
            loop.blocks.clear()
            time.sleep(0.4)
            loop.blocks.clear()
            if mode == "click":
                z = np.zeros((2048, 2), dtype=np.float32)
                z[0:48] = 0.5
                with loop.spk.player(samplerate=SR, blocksize=512) as p:
                    t0 = time.perf_counter()
                    p.play(z)
            elif mode == "synth":
                t0 = time.perf_counter()
                out.send(mido.Message("note_on", note=72, velocity=100))
            else:  # key
                inp = mido.open_input([x for x in mido.get_input_names() if "Launchpad" in x][0])
                print("请按任意 Launchpad 键 (%d/%d)" % (i + 1, n), flush=True)
                msg = inp.receive()
                while not (msg.type == "note_on" and msg.velocity > 0):
                    msg = inp.receive()
                t0 = time.perf_counter()
                out.send(mido.Message("note_on", note=72, velocity=100))
                inp.close()
            t1 = loop.first_over(t0)
            out.send(mido.Message("note_off", note=72, velocity=0))
            ms = None if t1 is None else (t1 - t0) * 1000
            log["ms"].append(ms)
            print(i + 1, "未检测到声音" if ms is None else "%.1f ms" % ms, flush=True)
            time.sleep(0.5)
    finally:
        loop.stop = True
        out.send(mido.Message("control_change", control=123, value=0))
        out.close()
    ok = [x for x in log["ms"] if x is not None]
    log["stats"] = stats(ok)
    print("统计:", log["stats"])
    LOG_DIR.mkdir(exist_ok=True)
    p = LOG_DIR / ("latency-%s-%s.json" % (mode, time.strftime("%Y%m%d-%H%M%S")))
    p.write_text(json.dumps(log, ensure_ascii=False, indent=1), encoding="utf-8")
    print("日志:", p)


if __name__ == "__main__":
    main()
