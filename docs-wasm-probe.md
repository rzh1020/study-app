# WASM 神经网络推理可行性实测（2026-08-18）

设备：Xiaomi 15 Ultra / Android 16 / WebView Chrome 150
方式：onnxruntime-web 1.20.1，同源加载（https://appassets.androidplatform.net），
      测试模型 6 层 d=512 ff=2048 的 MatMul+Relu 堆叠（50.3MB fp32），
      规模接近小型 NMT 的一步解码。

| 指标 | 手机 WebView | 桌面 Chrome（对照） |
|---|---|---|
| 模型加载 | 435 ms | 360 ms |
| 单次推理（单线程 SIMD） | **1.32 ms** | 2.32 ms |

环境能力：
- WASM SIMD：**支持**
- SharedArrayBuffer：**不可用**（crossOriginIsolated=false），只能单线程。
  已在 MainActivity 的响应头里加了 COOP/COEP，但 WebView 未因此进入跨源隔离，
  所以多线程这条暂时走不通 —— 不过单线程已经够快，不是瓶颈。

踩过的坑（复现时注意）：
1. 从 https 源 fetch http://localhost 会被混合内容拦截 —— 模型必须同源提供。
2. ort.min.js 是 UMD 包，用 `new Function(js)()` 执行不会挂到 window，必须用 script 标签注入。
3. `ort.env.wasm.wasmPaths` 传相对路径会与文档路径叠加成 `/x/x/`，要给绝对 URL。
4. 必须把 dist 下**全部** .mjs/.wasm 变体都放齐（含 jsep 变体），
   否则报 "Failed to fetch dynamically imported module"。

结论：WebView + onnxruntime-web 是可用路径，推理速度不是问题。
瓶颈在模型体积（APK 大小）和模型可获得性，不在运行时。
