"""AI 乐队成员(第 1 版:本地规则 agent)。

职责: 听你弹的旋律,每小节选一个和弦(I/IV/V/vi),让贝斯与和弦垫音跟上。
- 实时路径只用本地规则,不调网络、不阻塞(按键到出声的延迟优先)。
- 将来的 LLM 只放异步环节:例如根据用户一句话(“忧伤一点”)换和弦进行、换风格,
  通过 BandAgent.set_progression_bias()/set_style() 注入,不进音频回调。

时间: 以音频采样时钟为准(与鼓点同一时钟,保证对拍)。4/4,每小节 4 拍。
"""
import threading

# 候选和弦: (名字, 根音相对主音半音数, 和弦音相对主音半音数集合, 三和弦偏移)
CHORDS = [
    ("I", 0, {0, 4, 7}, (0, 4, 7)),
    ("IV", 5, {5, 9, 0}, (0, 4, 7)),
    ("V", 7, {7, 11, 2}, (0, 4, 7)),
    ("vi", 9, {9, 0, 4}, (0, 3, 7)),
]


class BandAgent:
    def __init__(self, bpm=100):
        self.bpm = bpm
        self.tonic = 60
        self.lock = threading.Lock()
        self.recent = []            # [(pitch_class_rel, age_in_beats)] 最近弹的音
        self.chord_idx = 0          # 当前和弦
        self.prev_idx = 0
        self.bias = [0.3, 0.0, 0.0, 0.0]  # 先验:偏爱 I;LLM 之后可改
        self.last_input_beat = -999
        self.beat_total = 0
        self.info = {"chord": "I", "beat": 0, "bar": 0}  # 供灯光/界面读取
        self.style = "pop"

    # ---- 主线程调用 ----
    def heard(self, midi):
        with self.lock:
            self.recent.append((((midi - self.tonic) % 12), self.beat_total))
            self.recent = self.recent[-24:]
            self.last_input_beat = self.beat_total

    def set_tonic(self, tonic):
        with self.lock:
            self.tonic = tonic

    def set_progression_bias(self, bias):
        with self.lock:
            self.bias = list(bias)

    # ---- 音频线程在每拍调用(必须很快)----
    def on_beat(self, beat_in_bar, schedule):
        """schedule(kind, midi, gain, dur_s) 由引擎提供,用于在本拍起音。"""
        with self.lock:
            self.beat_total += 1
            tonic = self.tonic
            if beat_in_bar == 0:
                self._choose_chord()
            name, root, tones, tri = CHORDS[self.chord_idx]
            self.info = {"chord": name, "beat": beat_in_bar, "bar": self.beat_total // 4, "idx": self.chord_idx}
        base = tonic - 12 + root           # 贝斯音区
        fifth = base + 7
        if beat_in_bar == 0:
            schedule("bass", base, 0.9, 0.9)
            for off in tri:                 # 和弦垫音(高八度,柔)
                schedule("pad", tonic + root + off, 0.55, 2.4)
        elif beat_in_bar == 1:
            schedule("bass", base, 0.5, 0.35)
        elif beat_in_bar == 2:
            schedule("bass", fifth, 0.75, 0.6)
        elif beat_in_bar == 3:
            schedule("bass", base + 12 if self.beat_total % 8 < 4 else base, 0.55, 0.4)

    def _choose_chord(self):
        """每小节开头:按最近 8 拍内弹的音给每个和弦打分,带滞回。"""
        silent = self.beat_total - self.last_input_beat > 16
        if silent or not self.recent:
            self.chord_idx = 0 if silent else self.chord_idx
            return
        scores = []
        for i, (_, _, tones, _) in enumerate(CHORDS):
            s = self.bias[i]
            for pc, born in self.recent:
                age = self.beat_total - born
                if age > 6:
                    continue
                w = 1.0 - age / 7.0          # 越新权重越大
                s += w if pc in tones else -0.15 * w
            if i == self.chord_idx:
                s += 0.25                      # 滞回:没明显更好就别换
            scores.append(s)
        self.prev_idx = self.chord_idx
        self.chord_idx = max(range(len(scores)), key=scores.__getitem__)
