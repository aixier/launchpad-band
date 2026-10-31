"""不接硬件的离线测试: 乐队选和弦、拍边界调度、音频回调不抛异常且有声。
运行: .venv/Scripts/python tests/test_band.py"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))
import numpy as np
import band as bm
import playground as p


def run_beats(b, n_beats, melody_by_bar):
    """模拟 n_beats 拍,每小节开头前喂入旋律,返回每小节选的和弦名。"""
    got, sched = [], []
    for i in range(n_beats):
        bib = i % 4
        if bib == 0 and i // 4 < len(melody_by_bar):
            for m in melody_by_bar[i // 4]:
                b.heard(m)
        b.on_beat(bib, lambda *a: sched.append(a))
        if bib == 0:
            got.append(b.info["chord"])
    return got, sched


def test_chord_follows_melody():
    b = bm.BandAgent(); b.set_tonic(60)
    # 弹 F A C(IV 和弦音) -> IV;再弹 G B D -> V;再弹 A C E -> vi
    got, sched = run_beats(b, 16, [[65, 69, 72, 65], [67, 71, 74, 67], [69, 72, 76, 69], [60, 64, 67, 60]])
    print("和弦序列:", got)
    assert got[0] == "IV" and got[1] == "V" and got[2] == "vi" and got[3] == "I", got


def test_silence_returns_to_tonic():
    b = bm.BandAgent(); b.set_tonic(60)
    run_beats(b, 4, [[65, 69, 72]])
    got, _ = run_beats(b, 24, [])
    assert b.info["chord"] == "I", b.info


def test_schedule_per_bar():
    b = bm.BandAgent(); b.set_tonic(60)
    _, sched = run_beats(b, 4, [[60, 64, 67]])
    kinds = [s[0] for s in sched]
    assert kinds.count("bass") == 4 and kinds.count("pad") == 3, kinds
    assert all(s[1] < 60 for s in sched if s[0] == "bass")  # 贝斯在低音区


def test_engine_callback_sound():
    e = p.Engine(); e.band_on = True; e.beat_on = True
    e.band.set_tonic(60); e.band.heard(65)
    out = np.zeros((128, 2), dtype="float32")
    peak = 0.0
    for _ in range(p.BEAT * 8 // 128):  # 8 拍
        e.cb(out, 128, None, None)
        peak = max(peak, float(np.abs(out).max()))
    assert 0.02 < peak <= 1.0, peak
    assert e.band.info["bar"] >= 1
    print("8 拍峰值 %.3f,和弦 %s,活跃音 %d" % (peak, e.band.info["chord"], len(e.voices)))




def test_practice_flow():
    pr = p.Practice(0, intro=True)
    seq = pr.seq
    ov, ex = pr.render(0.0)
    assert ov[seq[0]] in (p.GUIDE, p.GUIDE_OFF) and pr.phase == "ready"   # 起点=统一引导闪烁
    assert ov[seq[-1]] != ov[seq[1]] or len(seq) < 3                # 终点有标记
    assert pr.on_pad(11, 1.0) == "wrong" and pr.pos == 0 and pr.wrong == 0   # 起点前按错不扣分
    for i, note in enumerate(seq):
        ev = pr.on_pad(note, 2.0 + i)
        assert ev == ("finish" if i == len(seq) - 1 else "hit"), (i, ev)
    assert pr.phase == "done" and pr.stars == 3 and pr.results[0] == 3
    ov, ex = pr.render(2.0 + len(seq) + 0.5)
    assert len(ov) == 64 and ex[69] == p.GOLD and ex[89] == p.GOLD   # 庆祝:整盘彩虹 + 3 星
    print("练习流程通过")


def test_practice_wrong_costs_stars():
    pr = p.Practice(1)
    seq = pr.seq
    pr.on_pad(seq[0], 0.0)
    for _ in range(3):
        pr.on_pad(11, 0.5)
    for i, note in enumerate(seq[1:]):
        pr.on_pad(note, 1.0 + i)
    assert pr.wrong == 3 and pr.stars == 1, (pr.wrong, pr.stars)


def test_guide_stages():
    g = p.Guide()
    assert g.stage == 0 and all(c == (0, 0, 0) for c in g.colors(False, False, 104).values())
    g.event("band", True); assert g.stage == 0           # 没完成跟弹,不跳级
    g.event("intro"); assert g.stage == 1
    c = g.colors(False, False, 104)
    assert c[108] == (0, 0, 0) and c[109] in (p.GUIDE, p.GUIDE_OFF)    # 只有乐队键亮(引导闪烁)
    g.event("band", True); assert g.stage == 2
    c = g.colors(True, False, 104)
    assert c[109] == p.Guide.BAND and c[108] in (p.GUIDE, p.GUIDE_OFF)   # 乐队已开=身份色;鼓点键=引导闪烁
    g.event("drums", True); assert g.stage == 3
    g.event("key"); assert g.stage == 4
    c = g.colors(True, True, 106)
    assert c[106] == p.Guide._k(p.Guide.KEYS_C, 1.0) and c[104] != c[106]
    assert c[110] in (p.GUIDE, p.GUIDE_OFF)               # 自由玩阶段:练习键用引导闪烁邀请
    print("引导阶段通过")


def test_guide_language_is_exclusive():
    """引导色(青绿)只用于引导:音名色盘、控制键身份色、庆祝色都不能落在引导色相。"""
    for r in range(1, 9):
        for c in range(1, 9):
            assert not p.is_guide_hue(p.note_rgb(r, c)), (r, c, p.note_rgb(r, c))
    for name in ("BAND", "DRUMS", "KEYS_C", "PRACTICE"):
        assert not p.is_guide_hue(getattr(p.Guide, name)), name
    assert p.is_guide_hue(p.GUIDE)
    # 全局同相:同一时刻所有引导元素同亮同灭
    g = p.Guide(); g.stage = 3
    for now in (0.1, 0.6, 1.1, 1.6):
        cues = {v for k, v in g.colors(True, True, 104, now=now).items() if v in (p.GUIDE, p.GUIDE_OFF)}
        assert len(cues) == 1, (now, cues)
    print("引导语言一致通过")


def test_celebration_rainbow_avoids_guide_hue():
    pr = p.Practice(0)
    for n in pr.seq:
        pr.on_pad(n, 1.0)
    assert pr.phase == "done"
    for age in (0.0, 0.3, 0.7, 1.1, 1.6, 2.2):
        ov, _ = pr.render(pr.t_done + age)
        assert not any(p.is_guide_hue(c) for c in ov.values()), age
    print("庆祝暖彩虹通过")


def test_track_helpers():
    import numpy as np
    import track as tk
    beats = np.array([100, 28900, 57700, 86500])
    assert tk.beats_in_window(beats, 0, 128) == [(100, 0)]
    assert tk.beats_in_window(beats, 28800, 128) == [(100, 1)]
    assert tk.beats_in_window(beats, 200, 128) == []
    root, mode, _ = tk.estimate_key(tk.MAJOR)
    assert (root, mode) == (0, "major")
    root, mode, _ = tk.estimate_key(np.roll(tk.MINOR, 9))
    assert (root, mode) == (9, "minor") and tk.pentatonic_tonic(root, mode) == 0
    print("歌曲辅助函数通过")


def test_engine_with_track_beats():
    import numpy as np
    e = p.Engine(); e.band_on = True
    n = p.SR * 4
    y = np.zeros((n, 2), dtype="float32"); y[::24000, :] = 0.5
    e.load_track(y, np.arange(0, n, 24000, dtype=np.int64), 0)
    e.band.set_tonic(60); e.band.heard(65)
    e.start_track()
    out = np.zeros((128, 2), dtype="float32")
    for _ in range(n // 128 + 2):
        e.cb(out, 128, None, None)
    assert e.band.beat_total >= 7, e.band.beat_total
    assert not e.track_on
    print("引擎按歌的拍点调度乐队通过")


def test_guide_song_key():
    g = p.Guide(); g.stage = 4
    c = g.colors(False, False, 104, now=0.1, has_track=True)
    assert c[111] in (p.GUIDE, p.GUIDE_OFF) and c[110] != c[111]
    c = g.colors(True, False, 104, now=0.1, has_track=True, track_on=True)
    assert c[111] == g._k(p.Guide.SONG, 1.0) and not p.is_guide_hue(c[111])
    print("歌曲键引导通过")


if __name__ == "__main__":
    for k, f in list(globals().items()):
        if k.startswith("test_"):
            f(); print("通过", k)
