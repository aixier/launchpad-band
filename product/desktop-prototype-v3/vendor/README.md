# vendor/ 第三方库清单(v3 与 v2 相同:只有 three.js 一个库,文件原样复制,SHA-256 可与 v2 核对)

| 文件 | 库 | 版本 | 许可 | 来源(下载日期 2026-10-26) | SHA-256 |
|---|---|---|---|---|---|
| `three.min.js` | three.js(UMD 构建,挂在全局 `THREE`) | r149 (0.149.0) | MIT,见 `LICENSE-three.txt` | https://cdn.jsdelivr.net/npm/three@0.149.0/build/three.min.js(npm 包 `three@0.149.0` 的 `build/three.min.js`) | `8a5f7249903b54d30f79f708699d2fed2d6a1d0741a4cd41377d1f01bb5a2271` |
| `LICENSE-three.txt` | three.js 许可证 | 同上 | MIT | https://cdn.jsdelivr.net/npm/three@0.149.0/LICENSE | — |

## 为什么是 r149
- 之后的版本(r150+)逐步取消 `build/three.min.js` 这类全局构建,只提供 ES module;ES module 在 `file://` 下会被浏览器拦截,双击打不开。r149 是仍带 UMD 压缩包的最后几个版本之一,体积约 600 KB。
- 升级路径:需要新版本时,改用打包器(esbuild/Vite)把 stage.js + three 打成一个 IIFE 文件放进 vendor/,页面仍然 `<script src>` 引入,不依赖服务器。
- r149 的色彩管理还是旧式(`outputEncoding`,`ColorManagement.legacyMode`);stage.js 里所有颜色经 `setRGB255()` 自己做 sRGB→线性换算,与版本无关。

## 运行时不联网
页面不引用任何 CDN、字体、图片或网络资源(`grep -R "http" *.html *.js *.css` 只会在本文件与注释里出现)。字体用系统字体栈。

## v3 补充说明
- v3 的体积光束、屏墙、地面反射、观众席、辉光、色彩分级都是**自写 GLSL**(`stage.js` 内的着色器字符串),不依赖 three 的示例/后处理库(`EffectComposer` 等在 r149 里是 ES module 示例文件,file:// 下无法加载),因此仍然只需要 `build/three.min.js` 一个文件。
- 用到的 three API 只有:`WebGLRenderer / WebGLRenderTarget(HalfFloatType) / ShaderMaterial / DataTexture / BufferGeometry / Points / Mesh / PerspectiveCamera`,升级版本时这些接口稳定。
- 离线核对:`grep -rn "http" ../*.html ../*.js ../*.css` 只会命中注释里的说明。
