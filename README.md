# 随手乐队 · Novation Launchpad Mini MK2

用一台 Novation Launchpad Mini MK2,做面向零基础用户的音乐玩具:AI 乐队伴奏、灯光引导跟弹、跟着歌弹,以及**用电脑麦克风/内录听音乐、让 Launchpad 的 RGB 灯阵表达音乐**的效果板。

> **开源协议:MIT**(见 `LICENSE`)。第三方内容(Three.js、CC BY 4.0 测试曲目、Novation 驱动与文档)的归属和获取方式见 `NOTICE.md`。

## 快速开始(Windows 10/11,从驱动到启动)

### 0. 你需要
- Novation Launchpad Mini **MK2**(USB 枚举为 `Launchpad MK2`,`VID_1235 PID_0069`)和一根能传数据的 USB 线。
- Windows 电脑,Python **3.10**。
- 效果板的麦克风模式需要电脑有麦克风;内录模式不需要。

### 1. 安装驱动
1. 以管理员身份运行仓库自带的 `drivers/novationusbmidi_2.30.0_84.exe`(Novation 原厂驱动,说明见 `drivers/README.md`;最新版可到 Novation 官网下载)。
   - 校验(PowerShell):`Get-FileHash <安装包> -Algorithm SHA256`;仓库自带的 `novationusbmidi_2.30.0_84.exe` 应为 `1D783456CDBD46F3E9595F60C2C6A247BFAF13BA7C50567910AD5A9214C6A134`。
   - 本项目是在装了这个驱动之后验证的;Windows 自带的 USB-MIDI 驱动理论上也能识别,但**没有单独验证过**。
2. 安装后**重新拔插 USB**。设备管理器里应出现 `Launchpad MK2`(声音、视频和游戏控制器),没有黄色感叹号。
3. 若设备显示为 **VMware 的黄色感叹号设备(错误 43)**:是 VMware USB 仲裁服务把它抢走了。以管理员身份停止 `VMUSBArbService`(必要时设为手动),再拔插 USB。

### 2. 准备 Python 环境
```powershell
cd home-items\novation-launchpad-mini-mk2
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
```

### 3. 确认电脑能看到 Launchpad
```powershell
.venv\Scripts\python -c "import mido; print(mido.get_input_names(), mido.get_output_names())"
```
输出里要有 `... Launchpad MK2 ...`。看不到:换 USB 口/线,再看第 1 步。再做一次亮灯测试(完成后自动熄灯):
```powershell
.venv\Scripts\python tools\lp_probe.py light
```
**注意**:不要向设备发送引导加载程序(bootloader)类 SysEx,会让它进入固件升级模式。

### 4. 启动
**效果板**(麦克风或内录听音乐,Launchpad 变成音乐灯光):
- 双击 `launchers\mic.bat`(监听外放的音乐)或 `launchers\loopback.bat`(内录电脑播放的声音,戴耳机用)。也可在桌面建这两个文件的快捷方式,起始位置设为本目录。
- 麦克风模式:**先别放音乐、别敲键盘,等 Launchpad 上橙色扫描条消失**(约 2.5 秒,在听风扇底噪),再放音乐。音乐一直在播也能用,会自动改用宽松模式。
- 顶排 8 个键锁定场景(再按一次回到自动),右列是音量表。
- 命令行:`.venv\Scripts\python app\visualizer.py [--source loop] [--list] [--mic 编号]`;离线自测:`app\visualizer.py --selftest 歌曲.mp3`。

**随手乐队演示**(AI 乐队 + 灯光引导跟弹):
```powershell
.venv\Scripts\python app\playground.py --seconds 600
# 跟着歌弹(自带测试曲目):
.venv\Scripts\python app\playground.py --seconds 600 --track "testdata\born-again\radionarcotix x Decktonic - Born Again - CC BY 4.0\radionarcotix x Decktonic - Born Again.mp3"
```
开始时整盘是白的,**青绿色慢闪的键就是下一步要按的键**。

**桌面原型**(不需要设备,Chrome/Edge 双击打开,无需联网):`product\desktop-prototype-v3\index.html`(舞台、跟打),`master.html`(大师演出,键盘 `A S D F J K L ;`,空格 = DROP)。

### 5. 测试
```powershell
.venv\Scripts\python tests\test_band.py
```

### 常见问题
| 现象 | 原因与处理 |
|---|---|
| 找不到 Launchpad / MIDI 端口为空 | 重新拔插;换口;确认第 1 步驱动;设备管理器里有无感叹号 |
| 发 MIDI 时报 `error preparing sysex header` | USB 瞬断。效果板会自动重开端口;仍失败就重新拔插 |
| 没声音 | Windows 自带 GS 音源延迟约 258 ms,本项目用自带合成器;检查系统默认输出设备 |
| 效果板一直很暗 | 校准时若有大声噪声会偏暗;安静时重启一次 |
| 内录没反应 | 内录取的是**系统默认输出设备**;外放的声音请用麦克风模式 |

## 文档导航
- `HANDOFF.md`:当前状态与待办。
- `product/`:产品方案、体验设计、虚拟舞台与跟打模式设计。
- 下面的「Novation Launchpad Mini MK2」及后文是**设备资料与实测总账**(协议、延迟、灯光语言规范)。

---

# Novation Launchpad Mini MK2

8x8 网格 + 右侧 8 个场景键(▶◀▲▼ 上部四个方向键、Session/User 1/User 2/Mixer)+ 底部 8 个圆键。
建档日期:2026-10-26。

## 本机信息
| 项 | 值 |
|---|---|
| 序列号 | A677085102714(底部标签) |
| 生产日期 | 03/2017 |
| 标签 | Nemko(US/UL)、CE、RCM;Designed in England / Made in China |
| 机身 | 橙色底壳,顶面贴有白色装饰贴膜(非原厂) |
| 型号依据 | 顶面丝印 + USB 枚举:`VID_1235 PID_0069`,总线上报名 `Launchpad MK2`(2026-10-26 实测)。**设备按 MK2 协议(RGB)枚举** |
| 外观 | 左起第 4 列第 4、5 行附近有几颗键帽缺角(见 photos/top-view.jpg) |

## 目录
| 目录/文件 | 内容 | 来源 |
|---|---|---|
| `photos/label-bottom.jpg` | 底部标签 | 用户拍摄(原件 D:\maix_III\10-25) |
| `photos/top-view.jpg` | 顶面全貌 | 同上 |
| `docs/launchpad-programmers-reference.pdf` | Launchpad 原版 MIDI 协议(bi-colour LED、双缓冲、快速刷新) | https://fael-downloads-prod.focusrite.com/customer/prod/downloads/launchpad-programmers-reference.pdf |
| `docs/launchpad-mini-user-guide-v2-en.pdf` | Mini 用户手册 v2(英文) | https://fael-downloads-prod.focusrite.com/customer/prod/downloads/launchpad_mini_user_guide_v2-pdf-en.pdf |
| `docs/launchpad-mk2-programmers-reference-v1.03.pdf` | **全尺寸 Launchpad MK2**(RGB)编程手册,仅作对照,不是本机的 | https://fael-downloads-prod.focusrite.com/customer/prod/s3fs-public/downloads/Launchpad%20MK2%20Programmers%20Reference%20Manual%20v1.03.pdf |
| `refs/` | 预留:开源库/示例 | — |

## 要点(取自上面的 programmer's reference)
- 80 个键,每键红/绿双色 LED(两色同亮为琥珀),不是 RGB。
- 全部通信为 MIDI note-on/off 与 CC,**通道 1**,恒 3 字节,不支持 running status。
- 低速 USB,最多约 400 条/秒;刷新整盘 80 颗约 200 ms。加速办法:通道 3 note-on(`92h`)一次更新两颗;双缓冲后一次切换。

## [待验证]
- 本机确为 Mini MK2 而非 Mini MK1/Launchpad S:MK2 Mini 是否沿用此原版协议,需读 USB 描述符或上机实测。
- Mini MK2 专用的官方 Programmer's Reference 未找到;已下载的是原版协议,全尺寸 MK2 手册是 RGB 协议,二者不能混用。

## 实测记录 2026-10-26
- 枚举成功:`USB\VID_1235&PID_0069`(Novation,REV 0001),复合设备,接口 MI_00 为 USB Audio/MIDI 类,Windows 自带 `usbaudio` 驱动即可;MIDI 端口 `IN 0 Launchpad MK2` / `OUT 1 Launchpad MK2`。
- 插入后整盘亮灯自检。
- 踩坑:首次插入被 VMware USB 仲裁器(vmusb,VID_0E0F)接管 → 错误码 43;已把 `VMUSBArbService` 改为手动并停止;重新插拔后同口曾报 `VID_0000 描述符请求失败`,装 Novation USB Driver 2.30.0.84(`drivers/`,Focusrite 签名有效)并重插后正常。
- 修正:此前 README 写"双色 LED、原版协议"。设备实际以 **Launchpad MK2** 枚举,应以 `docs/launchpad-mk2-programmers-reference-v1.03.pdf`(RGB,SysEx)为准;`launchpad-programmers-reference.pdf` 仅为原版对照。[待验证] 上机点灯确认 RGB。
- 驱动:2026-10-26 静默安装 Novation USB Driver 2.30.0.84(`/S`,退出码 0,oem150.inf);设备绑定由微软 usbaudio 切换为 Novation 驱动。装前设备已能用微软自带驱动枚举为 `Launchpad MK2`;装驱动后的 MIDI 端口行为 [待验证]。

## 脚本验证 2026-10-26(tools/lp_probe.py,结果在 logs/)
环境:`.venv`(mido 1.3.3 + python-rtmidi 1.5.8),端口 `2- Launchpad MK2 0`(入)/`2- Launchpad MK2 1`(出)。
| 能力 | 结果 |
|---|---|
| RGB 点灯(SysEx 0Bh,0~63) | 通过:四角红绿蓝白、整盘彩虹、顶排/右列圆键、8 级亮度梯度,用户目视确认与预期一致 |
| 单条 SysEx 同刷 64~80 键 | 通过(目视);主机侧发送约 141 帧/秒,**设备端实际刷新率未测** [待验证] |
| 读取按键 | 通过:8 个目标键编号全部符合 Session 布局(11/88/81/18 为网格四角,19/89 右列,CC104/111 顶排),通道 1 |
| 力度 | 按下恒为 127,**无力度感应**(与手册一致) |
| 灯状态回读 | 无;设备不回报灯色 |
说明:guided 日志里的 rtt_ms 是人按键的反应时间,不是延迟。按键到电脑的 MIDI 延迟、到出声的音频延迟仍未测 [待验证]。

## 出声延迟实测 2026-10-26(tools/lp_latency.py,logs/latency-*.json)
方法:WASAPI 环回录下默认扬声器(Synaptics Audio,笔记本扬声器),脚本向 Microsoft GS Wavetable Synth 发 note_on,量到环回里首次出声的时间。
| 项 | 结果 |
|---|---|
| GS Wavetable 发出 note_on → 声音进系统混音 | 20 次:最小 252 / 中位 258.5 / p90 263 / 最大 275 ms,抖动很小 |
| 测量链自身偏差(click 校准) | 10 次只检出 4 次,50~81 ms,含每次开流的启动开销,**不可靠** [待验证] |
结论:即使扣掉最多约 60 ms 的测量偏差,GS Wavetable 仍 ≥ 190 ms,**不能用于演奏类玩法**(可接受上限一般认为约 20~30 ms [待验证])。MVP 必须自带低延迟音源(自研合成器/采样回放,走 WASAPI 小缓冲或 ASIO),不能依赖系统 GS 音源。
未测:USB 按键→主机的 MIDI 延迟、自带音源的实际延迟、蓝牙耳机(通常更高)。`key` 模式脚本已写但未跑。

## 自带最小合成器延迟 2026-10-26(tools/lp_synth_latency.py)
sounddevice + WASAPI **共享模式**、`latency=low`,回调内即时起音(正弦+衰减);同样用环回量 trigger→出声。
| 缓冲块 | 15 次 min / 中位 / p90 / max (ms) | 流报告延迟 |
|---|---|---|
| 128 帧 | 1.1 / 6.8 / 8.2 / 72.2 | 22 ms |
| 480 帧 | 0.1 / 8.2 / 10.3 / 62.2 | 22 ms |
解读:
- 对比 GS Wavetable 的 258 ms,自带合成器进入系统混音只要约 7~8 ms,**差了约 30 倍**,结论成立:MVP 必须自带音源。
- 注意环回取自 Windows 音频引擎的混音点,**不含**之后到扬声器/耳机的设备缓冲;流报告延迟 22 ms 可视为到耳朵的估计量级(约 20~30 ms),蓝牙耳机另加 100 ms 以上 [待验证]。
- 偶发 60~70 ms 的离群值(15 次里各约 1 次),可能是 Python 回调/GC 或环回块对齐,需要在真实玩法里再测;正式产品建议用 C++/Rust 做音频线程 [待验证]。
- 128 与 480 帧差别不显著(流延迟都按 22 ms 报告,WASAPI 共享模式有引擎最小周期),想再低需独占模式/ASIO,但独占模式下环回量不到,需换测法。
- 仍未测:USB 按键→主机延迟(`lp_latency.py key` 已写未跑)。

## 原型「随手乐队」v0 试玩 2026-10-26(app/playground.py)
- 五声音阶盘面 + 按键即发声 + 白闪渐变灯光 + 顶排切调(C/D/F/G)+ 鼓点开关。
- 诊断记录(--debug):用户试玩约 40 次按键、4 次切调、鼓点开关,按键全部被收到,音频回调持续运行,输出峰值 0.19~0.57,**无音频欠载/错误状态**。
- 之前几轮"0 次按键/无声"的诊断是用户当时不在场,不是设备或程序故障(曾误判为驱动/端口问题,已排除:`lp_probe guided` 对照可收到按键)。
- 教训:需要人按键的测试必须先确认用户在场,长时间监听比定时窗口更稳。
- 待用户主观反馈:延迟手感、灯光观感、是否好听 [待验证]。

## 原型「随手乐队」v1 现状 2026-10-26(用户试玩反馈"很好")
- 玩法:五声音阶盘面;整盘白底,按键绽放音名颜色并涟漪;AI 乐队成员(app/band.py 本地规则,贝斯+和弦随旋律选 I/IV/V/vi);鼓点;切调。
- 灯色引导(Guide):跟弹小练习(绿色慢闪起点→蓝色慢闪目标→暗金终点,完成彩虹+琶音+星星)→ 绿键呼吸开乐队 → 橙键呼吸开鼓点 → 蓝键跑马换调 → 自由玩;紫键(CC110)进入「指法练习」3 课,右列下方显示各课最好成绩。
- 用户反馈沉淀:① 小白不知道按哪个键 → 一律用灯色引导,任何时刻只有"下一步要按的键"在呼吸/慢闪;② 起始与完成都要有明确指引,完成要有成就感(彩虹+音+星);③ 初始整盘白,对比更好。
- 测试:`tests/test_band.py`(离线,7 项通过);`.venv/Scripts/python app/playground.py --seconds 600 --debug`。
- 下一步候选:弹完用 MiniMax 生成整首歌(异步);升级乐队 agent(评估 Anticipatory Music Transformer);录音变乐器;更多课与节奏评分。调研见 product/开源音乐AI调研-20261026.md。

### 真人试玩记录(2026-10-26 晚,logs 见任务输出,63 次按键)
- 无任何文字说明,仅靠灯色引导,用户**独立走完整条引导链**:开场跟弹(3 星 0 错)→ 开乐队 → 开鼓点 → 关闭 → 换调(F)→ 进入指法练习。
- 练习成绩:第 1 次「热身·小羊」1 星(错 5 次)→ 「上行下行」3 星 → 「跳进」3 星 → 重玩「热身」3 星 → 「上行下行」3 星 → 「跳进」2 星。同一课从 1 星提升到 3 星,说明"重复练习 + 星级"有效。
- 音频:全程回调无欠载状态,峰值 0.19~0.79。
- 注意:乐队只开了一小段,该时段几乎没有弹奏,和弦配合的效果没有被验证 [待验证]。

## 灯光语言规范(引导色规范)2026-10-26,用户要求"引导色/效果一致,与演示区隔,别在一片演示里找"
1. **引导 = 青绿 `GUIDE(0,63,40)` + 1 Hz 硬闪烁**(暗相 `GUIDE_OFF(0,6,4)`),全产品唯一的"请按这里"语言;所有引导元素**全局同相**。下一步预告 = 暗青绿常亮 `GUIDE_NEXT`;路线 = 中性灰。
2. **色相独占**:HSV 色相 0.40~0.55 只给引导。音名色盘 = 红橙黄紫粉;控制键身份色 = 乐队粉/鼓点橙/换调黄/练习紫;和弦指示 = 红橙紫粉。蓝、绿、青不用于演奏/身份。
3. **安静模式**:引导期间(跟弹、开乐队、开鼓点、换调、练习)按键只绽放被按的键,不涟漪,乐队侧边灯不亮;自由玩才恢复。
4. **奖励 ≠ 引导**:完成用彩虹扫过 + 琶音 + 金星,与引导的青绿闪烁区隔;终点用暗金标记。
5. 测试:`tests/test_band.py::test_guide_language_is_exclusive`(色盘/身份色不落入引导色相、引导全局同相)。

## 文档索引(product/)
- `体验设计文档.md`:熟练用户视角、光声配合为何"酷"、17 条好体验、10 条设计原则(带依据)、与现状对照、路线图建议(2026-10-26)
- `产品设计方案-v3.md`:当前有效的产品方案(v1 已否决,旧 `产品设计方案.md` 为 v2)
- `开源音乐AI调研-20261026.md`、`desktop-prototype/`(桌面端 HTML 原型)

## 决策记录 2026-10-26
- **虚拟舞台进 MVP**(Three.js r149 UMD,`product/虚拟舞台-选型与设计.md`、`product/desktop-prototype-v2/`):3D 盘面 + 对拍灯光 + AI 乐队成员 + 表演模式 + 录制。Blender 仅后期离线资产;Unreal 不用。
- **家庭灯光(ESP32 + WS2812 / ESP-NOW / WLED)暂缓**:用户当前不做 ESP32 板和灯带,只保留接口预留(v2 设置页模拟灯)。恢复前须:用户指定空闲 ESP32 板与灯带规格;不动无人机 ESP-NOW 链路(COM16 网关、信道 1/9);每次烧录先问。
- **完成彩虹改暖彩虹**(紫粉红橙黄),避开引导青绿色相;测试 `test_celebration_rainbow_avoids_guide_hue`。
- 待办:v2 自适应降档可回升;真人试玩(Python 版 + 桌面 v2 各一遍);乐队和弦配合的持续弹奏验证。

## 舞台理解的修订 2026-10-26(用户纠正,v3)
- **纠正**:此前(v2)把 Launchpad 放在舞台正中、做成 3D 英雄物体,是误解。**舞台是给 Launchpad 用的**:Launchpad 是指挥棒/控制台,画面主角是一整个真实感的演出舞台(桁架摇头灯、雾中光束、LED 屏墙、地面反射、乐队剪影、观众席);玩家的每一次按键、横扫,都在**指挥**这个舞台;盘面只在屏幕左下角作小镜像(引导的青绿 1 Hz 闪烁仍只在这里)。视觉目标:演奏时的灯光效果超过专业灯光预演/渲染软件的观感(**目标,未经真人盲评验证**)。
- **新原型**:`product/desktop-prototype-v3/`(双击 `index.html`;v1、v2 保留不动)。指挥映射(列 = 哪盏灯、行 = 光束抬升、音名 = 光色、横扫 = 光浪、鼓点 = 冲击波、和弦 = 色调转移、能量 = 风格档/镜头/烟雾/灯数)与"AI 灯光导演"规则见 `product/虚拟舞台-选型与设计.md`(已重写,开头有修订说明)。
- **灯光语言不变且更严**:青绿色相在舞台里完全不出现(静态扫描含 GLSL、色盘/渐变采样、3600 帧逐帧审计、读渲染像素);引导期间舞台安静模式(灯全灭);奖励(暖彩虹 + 金)与引导区隔。自检:`node product/desktop-prototype-v3/tools/check_lightlang.js`、`node .../tools/headless_check.mjs --gpu`。
- **性能(本机实测)**:独显 Quadro RTX 5000 约 6 ms/帧;集成显卡 UHD 630 均衡档 7~19 ms/帧(动态分辨率兜底);纯软件渲染自动降级到 2D 版(8~17 ms)。
- **待拍板**:舞台是否允许冷色(蓝紫);"超过专业软件"的并排盲评如何组织。

## 清理记录 2026-10-26
- 按用户指示删除桌面端原型 v1(`product/desktop-prototype/`)与 v2(`product/desktop-prototype-v2/`);v3(`product/desktop-prototype-v3/`)无任何指向 v1/v2 的引用,自带 vendor/、灯光语言自检(`tools/check_lightlang.js`)。文档中提到 v1/v2 之处均为历史说明,不再有对应目录。

## 产品洞察 2026-10-26(用户):最大的成就感 = 听到一首好听的电音,能在 Launchpad 上快速复刻,并亲手控制节奏
- 用户原话要点:"听到一首好听的电音去找,能快速在 Launchpad 上实现是最大的成就感,并能通过自己的手控制节奏,打碟师的节奏控制感也是很重要的。"
- 含义:核心回路从"随手弹"扩展为 **找歌 → AI 拆成可玩的盘面(鼓/贝斯/和弦/主旋律)→ 灯光引导一层层打出来 → 手控节奏(DJ 感)**。
- 待办(见产品方案后续版本):可行性验证(节拍/调性检测、分轨、MIDI 转写、切片到键位);跟打模式的灯光语言扩展(下落的音符如何与"引导=青绿 1 Hz 闪烁"规范共存,需修订规范);DJ 手感(量化触发、节奏同步、循环、滤波/速度控制,无力度感应时用位置与组合替代);版权与本地处理边界 [待验证]。

## 灯光语言修订 2026-10-26(跟打模式例外条款;追加,不改上面的旧条文)
背景:跟打模式(`product/desktop-prototype-v3/` 里的 rhythm highway,设计见 `product/跟打模式-设计.md`)需要"光条下坠 + 精确到几十毫秒的节奏提示",1 Hz 闪烁的引导无法表达"几时按"。修订如下,**旧的第 1~5 条在跟打模式之外一字不改**:
1. **跟打例外(只此一处)**:跟打模式期间,盘面(真实设备与屏幕镜像)上"光条进入判定前窗口(0.4 s)的目标键"亮 **青绿 `GUIDE(0,63,40)` 常亮,不闪**;命中或漏掉后立刻熄灭(命中后改绽放声部色)。为什么常亮:节奏提示需要精确的"几时按",时间由屏幕上的光条/追光/接近圈表达,灯只回答"按哪一格";1 Hz 闪烁的相位会让"亮的那一刻"与"该按的那一刻"对不上。
2. **为什么不破坏一致性**:仍是"青绿 = 下一步请按这里",且仍**只**给该按的键(色相 0.40~0.55 照旧独占);跟打期间盘面上**没有任何闪烁的引导**(开场引导链/练习/顶排引导键全部让位),所以不会出现"闪的"和"常亮的"两种青绿语言同时存在;其余全产品的引导仍是 1 Hz 同相闪烁。
3. **瀑布/追光/光柱不用青绿**:光条颜色 = 声部色(鼓 橙 / 贝斯 粉 / 和弦 紫 / 旋律按音名:红橙黄紫粉);判定提示 = 暖白;舞台灯 = 声部色/音名色;青绿只出现在"该按的格子"的预备描边(屏幕格阵里)与同一格的盘面预备灯。
4. **舞台**:跟打期间舞台不再"安静",它被命中驱动(命中越准、连击越高、叠上的层越多 → 灯越盛;漏拍 → 约 1.6 s 内收敛),无命中时不自走特效。完成奖励沿用暖彩虹 + 金星 + 琶音。
5. **盘面其余键**:顶排前 4 个键 = 4 个声部的"叠上了几层"指示(声部色,暗=没叠上,亮=已叠上);右列 = 歌曲进度;底色整盘暗(10/63)以衬托预备青绿。
6. 自检:`node product/desktop-prototype-v3/tools/check_lightlang.js` 新增 G 段(盘面青绿逐帧等于"该按的键"集合、无闪烁暗相、画布录制里引导色相只出现在 prep 描边、舞台长跑审计、命中驱动与漏拍收敛的可量化检查);`tools/check_highway.js`(判定/评分/锁定逻辑)、`tools/headless_highway.mjs`(无头 Chrome 整流程 + 截图 + 帧耗时)、`tools/readability.js`(提示方式的可读性几何指标)。

## 跟打模式 2026-10-26(用户洞察落地:听到好听的电音,能快速在 Launchpad 上复刻并亲手控制节奏)
- 入口:`product/desktop-prototype-v3/index.html` 顶栏「跟打」。内置自合成演示谱面《电音小样》(120 BPM,约 48 s + 倒数,鼓 → 贝斯 → 和弦 → 旋律 四层,每打好一层它就自己接着响)。
- **第一问题 = 一维琴键 vs 二维盘面,"按哪里"**:默认「追光落点」(用户选定):盘面画成透视格阵,对应列的摇头灯扫向目标格,光斑落在哪格就按哪格,光条沿所在列下坠落进光斑,长度 = 按住时长。备选「光柱」「经典瀑布」可在开始卡片里切换比较。取舍与可读性指标见设计文档。
- 键盘:A S D F J K L ; = 8 列(不用管行);原四排键位仍可按具体格;空格暂停,Esc 退出。
- 判定:按下时间窗(完美/不错/漏拍)与按住时长(松得准/还行/早松/拖长)分开计;轻松/严格两档;延迟校准;亮灯提示自动淡出(全部 → 每小节第一个 → 不亮)。
- 自检(本机):逻辑 `check_highway.js` 全过;灯光语言 `check_lightlang.js`(A~G)全过;无头 Chrome 整流程见设计文档第 9 节。

## 效果板应用(桌面快捷方式)
- 双击桌面「随手乐队效果板(麦克风)」监听外放的音乐;「随手乐队效果板(内录)」直接取电脑播放的声音(戴耳机用)。
- 快捷方式指向 `launchers/mic.bat`、`launchers/loopback.bat`(纯 ASCII,避免 cmd 乱码);需要先用 `.venv` 装好依赖。
- 重新建快捷方式:指向这两个 bat,起始位置设为本目录。
