"""二分定位:原型收不到按键的原因。分三段各 10 秒,持续按键,统计各段收到的消息数。
段1 仅 MIDI 输入;段2 +sounddevice 输出流;段3 +灯光线程(SysEx 发送)。"""
import sys, threading, time
sys.path.insert(0, __file__.rsplit("tools", 1)[0] + "app")
import mido
import playground as p

inp = mido.open_input([n for n in mido.get_input_names() if "Launchpad" in n][0])
out = mido.open_output([n for n in mido.get_output_names() if "Launchpad" in n][0])
out.send(mido.Message("sysex", data=p.HDR + [0x22, 0x00]))

def count(sec):
    n, t0 = 0, time.perf_counter()
    while time.perf_counter() - t0 < sec:
        for m in inp.iter_pending():
            n += 1
        time.sleep(0.001)
    return n

print("段1: 仅输入,10 秒,请连续按键", flush=True); print("段1 收到", count(10), flush=True)
eng = p.Engine(); eng.start()
print("段2: +音频流,10 秒,请连续按键", flush=True); print("段2 收到", count(10), flush=True)
lights = p.Lights(out); th = threading.Thread(target=lights.run, daemon=True); th.start()
print("段3: +灯光线程,10 秒,请连续按键", flush=True); print("段3 收到", count(10), flush=True)
lights.stop = True; th.join(1); eng.stream.stop()
out.send(mido.Message("sysex", data=p.HDR + [0x0E, 0x00]))
