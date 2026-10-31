# 交接(2026-10-27 关机存档)

## 当前状态
- **Python demo 未运行**。Launchpad 当时枚举为空(MIDI 端口列表空,PnP 状态 Unknown),需要重新插 USB。
- 带歌启动命令(设备在线后,用户说"启动"再跑):
  `cd /d/maix_III/home-items/novation-launchpad-mini-mk2 && PYTHONIOENCODING=utf-8 .venv/Scripts/python -W ignore app/playground.py --seconds 600 --debug --track "testdata/born-again/radionarcotix x Decktonic - Born Again - CC BY 4.0/radionarcotix x Decktonic - Born Again.mp3"`
- 桌面原型 v3:`product/desktop-prototype-v3/index.html`(Chrome 打开,键盘 A S D F J K L ; ,"跟打"在顶栏)。系统没有默认浏览器关联,要用 chrome.exe 路径打开。
- 测试:`.venv/Scripts/python tests/test_band.py` 全部通过(最后一次)。

## 本轮新增文档
- `product/跟打模式-设计.md`、`product/首次震撼-大师感设计.md`(产品经理)、`product/首次震撼-视听效果.md` + `master.html`(效果师,**关机时仍在进行,可能未完成**,文末有"进度与未完成清单")。

## 已定的交互思路(待实现到 Python demo)
1. 新手慢/找不到位置:盘面只留一个青绿闪键,提前一小节亮,后一格暗青绿预告;按键在宽窗口内吸附到最近节奏格(只挪时间,无"漏拍");不按就等。
2. 背景(鼓/贝斯/铺底,跟歌的拍点)不依赖用户,没跟上也好听;引导速度自适应(慢则每小节一个音)。
3. 参与感:用户主奏音色独立且比背景亮一档;停手 8 小节主奏消失、背景收成铺底;落重拍额外回报(和弦变厚、绽放更亮);起拍/drop/收尾必须用户按。
- Python demo 现状**尚无**吸附窗口、用户层音色、停手收缩、预告一格。最小版是下一步。

## 已按建议暂定、等用户确认的决定
- 跟打:没叠上的层允许重打本段,没打好保持静默。
- "复刻一首歌"第一步先做 MIDI 导入,再做音频转写。
- 大师包素材路线:先用母带做"结构 DJ"(b),并行争取分轨(a),全自合成不作旗舰(c);对外分享强制"AI 乐队托底"小字幕;首发只做 Born Again + 四键起鼓。(用户尚未回复"按建议")

## 待办/风险
- 音质:自带音源偏玩具,大师包需制作级素材;采样回放延迟要重测。
- Born Again 只有母带无分轨;进产品前更新 `testdata/MANIFEST.md`(现登记"仅本地测试、不分发"),界面署名并标注改动(CC BY 4.0)。
- CC111 在 Python demo 中是歌曲键,与"生成/作品"键规划冲突,需统一;歌曲键颜色 SONG(63,40,12) 还没写进灯光语言规范/skill。
- 所有"会震撼"均为假设,需 5~8 名新手实测。

## 效果师收尾(master.html 大师演出原型,已存档)
- 打开:双击 `product/desktop-prototype-v3/master.html`,按闪着的键(J)或点左下角盘面;A S D F J K L ; 为中排,上下各一排,Shift 抬高四行,空格 = DROP。`?song=synth` 用自合成曲。
- 已完成:Born Again 24 小节片段(Opus,内嵌 assets/born-again-clip.js 约 650 KB),开场仪式、DROP 蓄力→静默 0.3 s→爆发、5 级熟练度。独显 6.2 ms/帧,控制台错误 0,盘面灯审计违规 0(仅独显+原曲跑过)。
- 实测原曲 126.0 BPM(analysis.json 的 123.05 偏差),drop 第一下底鼓在 61.300 s。**Python demo 的拍点若有偏差可参考。**
- 已改代码但未重跑验证:首次按键同步 232 ms、静默亮度比 6.3:1、haze/bloom 叠加;熟练度权重旧值(乱按能到 DJ,待改)。
- 未做:`check_lightlang.js` 的 H 段(需重写)、自合成曲和软渲染自检、人耳验证声音。
- **待你拍板**:原曲片段已内嵌进 assets,但 `testdata/MANIFEST.md` 写"不分发",是否允许随原型分发(署名行已在页面右下角)。
- 详细清单见 `product/首次震撼-视听效果.md` 末尾。
