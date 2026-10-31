"""Launchpad MK2 (Mini MK2) 能力探测:控制(点灯)+ 读取(按键)。

依据 docs/launchpad-mk2-programmers-reference-v1.03.pdf:
- Session 布局下 note = 行*10 + 列(行 1~8 自下而上,列 1~8 自左而右),顶排圆键 CC 104~111。
- RGB 点灯 SysEx: F0 00 20 29 02 18 0B <LED> <R> <G> <B> F7,各色 0~63,单条可重复至 80 个。
- 全部熄灭: F0 00 20 29 02 18 0E 00 F7。

用法:  python tools/lp_probe.py light | throughput | read [秒] | guided
结果写入 logs/probe-<时间>.json。无论怎样退出都会熄灯。
"""
import json
import sys
import time
from pathlib import Path

import mido

HDR = [0x00, 0x20, 0x29, 0x02, 0x18]
LOG_DIR = Path(__file__).resolve().parent.parent / "logs"


def open_ports():
    ins = [n for n in mido.get_input_names() if "Launchpad" in n]
    outs = [n for n in mido.get_output_names() if "Launchpad" in n]
    if not ins or not outs:
        raise SystemExit("找不到 Launchpad MIDI 端口: in=%s out=%s" % (ins, outs))
    return mido.open_input(ins[0]), mido.open_output(outs[0]), ins[0], outs[0]


def sysex(out, body):
    out.send(mido.Message("sysex", data=HDR + body))


def all_off(out):
    sysex(out, [0x0E, 0x00])


def set_session_layout(out):
    sysex(out, [0x22, 0x00])


def rgb(out, leds):
    """leds: [(led, r, g, b), ...] 一条 SysEx 最多 80 个。"""
    body = [0x0B]
    for led, r, g, b in leds:
        body += [led, r, g, b]
    sysex(out, body)


def pad(row, col):
    return row * 10 + col


def hsv(h):
    """h in [0,1) -> (r,g,b) 0~63"""
    i = int(h * 6) % 6
    f = h * 6 - int(h * 6)
    q, t = 1 - f, f
    r, g, b = [(1, t, 0), (q, 1, 0), (0, 1, t), (0, q, 1), (t, 0, 1), (1, 0, q)][i]
    return int(r * 63), int(g * 63), int(b * 63)


def all_leds():
    return [pad(r, c) for r in range(1, 9) for c in range(1, 9)] + list(range(104, 112)) + [
        pad(r, 9) for r in range(1, 9)]


def test_light(out):
    res = {}
    all_off(out)
    set_session_layout(out)
    time.sleep(0.3)
    # 1) 四角红绿蓝白
    rgb(out, [(pad(1, 1), 63, 0, 0), (pad(1, 8), 0, 63, 0), (pad(8, 1), 0, 0, 63), (pad(8, 8), 63, 63, 63)])
    print("四角: 左下红 右下绿 左上蓝 右上白(2 秒)")
    time.sleep(2)
    # 2) 单条 SysEx 彩虹渲染整盘 64 键
    rgb(out, [(pad(r, c), *hsv(((r - 1) * 8 + (c - 1)) / 64)) for r in range(1, 9) for c in range(1, 9)])
    print("整盘彩虹(单条 SysEx,3 秒)")
    time.sleep(3)
    # 3) 顶排与右列
    rgb(out, [(led, 0, 40, 63) for led in range(104, 112)] + [(pad(r, 9), 63, 20, 0) for r in range(1, 9)])
    print("顶排圆键蓝、右列圆键橙(2 秒)")
    time.sleep(2)
    # 4) 亮度梯度
    rgb(out, [(pad(1, c), 8 * c - 1, 0, 0) for c in range(1, 9)])
    print("最下一排红色 8 级亮度梯度(2 秒)")
    time.sleep(2)
    all_off(out)
    res["note"] = "目视确认颜色/位置;设备不回读灯状态"
    return res


def test_throughput(out):
    res = {}
    for label, frames in (("整盘80键/条", 50), ("单键/条", 20)):
        t0 = time.perf_counter()
        for i in range(frames):
            if label.startswith("整盘"):
                rgb(out, [(led, *hsv(((j + i) % 80) / 80)) for j, led in enumerate(all_leds())])
            else:
                rgb(out, [(pad(1 + i % 8, 1 + (i // 8) % 8), 63, 0, 0)])
            time.sleep(0)  # 让出线程
        dt = time.perf_counter() - t0
        res[label] = {"frames": frames, "seconds": round(dt, 4), "fps": round(frames / dt, 1)}
        print(label, res[label])
        time.sleep(1)
        all_off(out)
    # 注:这里测的是主机侧发送完成时间;是否被设备丢弃需目视看动画是否平滑
    return res


def test_read(inp, seconds):
    print("请按键(任意键,含顶排/右列),监听 %s 秒..." % seconds)
    events, t0 = [], time.perf_counter()
    while time.perf_counter() - t0 < seconds:
        for m in inp.iter_pending():
            e = {"t": round(time.perf_counter() - t0, 3), "type": m.type}
            if m.type in ("note_on", "note_off"):
                e.update(note=m.note, velocity=m.velocity, ch=m.channel + 1)
            elif m.type == "control_change":
                e.update(control=m.control, value=m.value, ch=m.channel + 1)
            else:
                e["raw"] = str(m)
            events.append(e)
            print(e)
        time.sleep(0.001)
    return {"events": events}


def test_guided(inp, out):
    targets = [("左下角", pad(1, 1), "note"), ("右上角", pad(8, 8), "note"), ("左上角", pad(8, 1), "note"),
               ("右下角", pad(1, 8), "note"), ("顶排第 1 个圆键", 104, "cc"), ("顶排第 8 个圆键", 111, "cc"),
               ("右列最上圆键", pad(8, 9), "note"), ("右列最下圆键", pad(1, 9), "note")]
    res = []
    for name, led, kind in targets:
        all_off(out)
        rgb(out, [(led, 63, 63, 0)])
        print("请按亮着的键: %s(预期编号 %d,25 秒内)" % (name, led), flush=True)
        for _ in inp.iter_pending():
            pass
        got, t0 = None, time.perf_counter()
        while time.perf_counter() - t0 < 25 and got is None:
            for m in inp.iter_pending():
                if m.type == "note_on" and m.velocity > 0 or m.type == "control_change" and m.value > 0:
                    got = {"type": m.type, "num": getattr(m, "note", getattr(m, "control", None)),
                           "value": getattr(m, "velocity", getattr(m, "value", None)),
                           "ch": m.channel + 1, "rtt_ms": round((time.perf_counter() - t0) * 1000)}
                    break
            time.sleep(0.001)
        res.append({"target": name, "expected": led, "got": got})
        print("  ->", got, flush=True)
        if got:
            rgb(out, [(led, 0, 63, 0)])
            time.sleep(0.4)
    return {"results": res}


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "light"
    inp, out, iname, oname = open_ports()
    log = {"mode": mode, "in": iname, "out": oname, "time": time.strftime("%Y-%m-%d %H:%M:%S")}
    try:
        if mode == "light":
            log["result"] = test_light(out)
        elif mode == "throughput":
            log["result"] = test_throughput(out)
        elif mode == "read":
            log["result"] = test_read(inp, float(sys.argv[2]) if len(sys.argv) > 2 else 10)
        elif mode == "guided":
            set_session_layout(out)
            log["result"] = test_guided(inp, out)
        else:
            raise SystemExit(__doc__)
    finally:
        all_off(out)
        inp.close()
        out.close()
    LOG_DIR.mkdir(exist_ok=True)
    p = LOG_DIR / ("probe-%s-%s.json" % (mode, time.strftime("%Y%m%d-%H%M%S")))
    p.write_text(json.dumps(log, ensure_ascii=False, indent=1), encoding="utf-8")
    print("日志:", p)


if __name__ == "__main__":
    main()
