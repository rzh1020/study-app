# 学习台 — 日语 + 声乐的自用碎片化学习 App

Android APK（WebView 外壳 + 本地网页应用），也能当纯网页跑。
**无后端、无账号、无联网权限**，内容打包在 APK 内，数据全部存在本机。

设计前提：日语零基础但长期看听动漫；声乐零基础，目标唱歌好听 + 懂原理；
可用时间是地铁/吃饭的碎片时间 + 家里 15 分钟能出声。

```
./android/build.sh run      # 构建 + 安装 + 启动（约 20 秒，不走 Gradle）
npm test                    # 核心算法单测
node tools/e2e.mjs          # 浏览器端到端
node android/verify_device.mjs   # 真机验证（需 App 在前台）
```

## 为什么是这几个模块

碎片时间能做的和不能做的差别很大，所以按「能否出声」而不是按学科来分：

| 场景 | 模块 |
|---|---|
| 地铁、吃饭（不能出声） | 日语卡片（假名/词汇/语法）、练耳、声乐乐理科普 |
| 家里 15 分钟（能出声） | 引导练声流程、音准实时反馈、音域测试 |
| 每周一次（约 6 分钟） | 回归体检套件 |

练耳是唯一能塞进碎片时间的声乐训练，占整体训练量的一半，容易被忽略。

## 四个可量化的回归指标

把学习当 CI 跑：每周同条件复测，指标存档画曲线。这是市面练唱 App 都不做、
而平台期唯一能判断「到底有没有进步」的东西。

| 指标 | 含义 | 参考值 |
|---|---|---|
| 音阶音准 | 五度音阶相对最近半音的中位偏差 | < 20 音分听众听不出，< 10 算好 |
| 曲目音准 | 固定曲目片段的中位偏差 | 同上 |
| 最长发声 | 一口气稳定发声的最长连续秒数 | 男性 20-30s，女性 15-25s |
| 音域 | 能稳定发声的最低/最高音 | 看自己的趋势，不比别人 |

前提是固定四个变量：同素材、同调、同时段、同设备距离。否则曲线里的变化来自条件而不是能力。

## 内容与数据

| 文件 | 内容 |
|---|---|
| `data/kana.json` | 104 个假名（清音 46 + 浊音/半浊音 25 + 拗音 33）+ 8 条发音规则 |
| `data/vocab.json` | 185 个高频词，含假名读音、罗马音、词性、48 条例句 |
| `data/grammar.json` | 42 个 N5 语法点，含句型、例句、易错提示 |
| `data/theory.json` | 45 张声乐/乐理/记忆原理科普卡 |
| `data/plan.json` | 12 周计划，每周含日语/声乐/练耳内容与过关判据 |

共 673 张卡（词汇按「日→中」「中→日」各生成一张）。

**内容加载**：APK 首次启动时把 JSON 种进 IndexedDB，之后不再读文件。
种卡是**合并**而非覆盖 —— 以后往 `data/` 里加词，「重新种卡」只补新增条目，
已有卡的 stability/difficulty/due 全部保留，不会把几个月的复习进度清零。

**数据保存**：写在 App 私有目录 `/data/user/0/com.rzh.studyhub/`，
杀进程、重启、灭屏都不丢。**卸载 App 会一并删除**，所以要定期用数据页的「导出 JSON」备份。

**扩内容的两条路**：
1. 数据页粘 TSV（`正面⇥背面`，Tab 分隔）直接导入 —— 看动漫记下的台词贴进去就行。
   1000+ 词主要靠这个积累，孤立单词的迁移效果远不如带语境的句子。
2. 改 `data/*.json` → 重新构建 → App 内「重新种卡」。

假名表和罗马音不是手打的：`tools/gen_kana.mjs` 生成假名表并自检数量，
`tools/gen_vocab.mjs` 从假名表推导罗马音（处理促音加倍、长音、撥音 `n'`），
并用 15 个易错样例校验转写器。手打罗马音是最容易出错的一环，这样能消掉一整类错误。

## 构建与安装

需要 Android SDK（build-tools + platform）和 JDK 17。脚本会自动探测
`$ANDROID_HOME` 或 `~/Android/Sdk`，选用最高版本的 build-tools。

```bash
./android/build.sh            # 只构建 -> android/build/study-hub.apk
./android/build.sh install    # 构建 + 覆盖安装（保留数据）
./android/build.sh run        # 构建 + 安装 + 启动
```

**不用 Gradle**：这个工程零第三方依赖，直接调 aapt2 / javac / d8 / apksigner 就够了，
省掉 Gradle 拉依赖的网络需求和启动时间，全程约 20 秒。

首次构建会生成 `android/debug.keystore`（已 gitignore）。
**这个文件要自己异地备份**：丢了就无法覆盖安装，只能卸载重装，而卸载会清掉学习数据。
换机或重装前先在 App 内导出 JSON。

### 也可以当纯网页跑

```bash
./serve.sh      # 检测到 adb 设备会自动建立 adb reverse
```

但网页方式有个硬约束（实测见 `node tools/check_deploy.mjs`）：

```
origin                          secureContext  mediaDevices  serviceWorker  getUserMedia
http://127.0.0.1                true           true          true           OK
http://localhost                true           true          true           OK
http://10.192.36.81 (局域网IP)   false          false         false          API 不存在
```

`getUserMedia` 要求安全上下文，局域网 IP 不算 —— `navigator.mediaDevices` 这个对象
**根本不存在**，练声模块和离线缓存会静默失效。所以网页方式只有
`http://localhost`（配合 `adb reverse`）或 HTTPS 托管两条路。
APK 方式不受此限（见下）。

## 技术选择

**资源走 `https://appassets.androidplatform.net/` 而不是 `file:///android_asset/`**：
`getUserMedia` 要求安全上下文，而 `file://` 在不同 WebView 版本上是否被视为可信并不一致；
拦截一个 https 源的请求可以稳定得到安全上下文。`androidplatform.net` 是 Google 保留给
这个用途的域名，永远不会解析到公网。等价于 `androidx.webkit` 的 `WebViewAssetLoader`，
这里手写以保持零依赖。

**FSRS-5 而不是 SM-2**：把记忆拆成 stability（能记多久）和 difficulty（这张卡多难）
两个状态量，用可提取性 R(t,S) 反推复习时机，实测比 SM-2 少 20-30% 复习量。
注意 4.5 和 5 的初始难度公式不同（线性 vs 指数），参数不能混用。

**MPM (McLeod Pitch Method) 而不是裸自相关**：NSDF 归一到 [-1,1]，
配合「第一个达阈值的峰」策略压住八度错误（人声 2 次谐波常比基频还强）。
两个必须做对的细节：NSDF 要从 tau=0 开始算（靠第一次负向过零跳过平凡主峰），
阈值取 0.85 而不是 0.2。

**降采样 3 倍再算**：NSDF 开销是 O(n × tauMax)，48kHz 下单帧 1.5ms，
降到 16kHz 后 0.2ms（快 7.5 倍），精度损失可忽略（人声基频 < 1.2kHz）。

**指标用时间戳而不是帧数换算**：分析循环是 rAF 节流的，实际帧间隔大于设定值
（40ms 设定在 60Hz 下实测约 46ms），按固定系数换算会把「最长发声秒数」系统性低估 10-20%。

**保持率只统计已毕业卡片**：初学阶段点「忘了」是正常摸索，混进去会把保持率压到 60% 以下，
让「是否该调整目标保持率」失去判断依据。与 Anki 的 true retention 口径一致。

**关掉浏览器语音增强**：`echoCancellation`/`noiseSuppression`/`autoGainControl` 全设 false，
否则测出来的音高抖动和动态是算法处理的结果，不是你的。

**备份导出走原生 SAF 而不是 `<a download>`**：WebView 里 `blob:` URL 的下载会
**静默失败**（没有 DownloadManager 能处理 `blob:`），点了没反应也不报错。
而这个 App 唯一的数据丢失风险就是没有备份，这条链路不能悄悄坏掉。

**resize 只重绘画布，不重渲染视图**：canvas 尺寸是按 `clientWidth × devicePixelRatio`
在渲染那一刻定的，旋转后不重绘会被拉伸模糊；但整页重渲染会销毁正在进行的状态 ——
练声倒计时归零、回归体检正在采集的音频帧丢失。所以视图暴露 `resize()` 钩子。

无框架、无构建步骤（网页侧）：自用单页，依赖越少越好维护，改完刷新就生效。

## 测试

三层，都能在本机跑完：

```bash
npm test                          # 64 项：FSRS 状态机 + 音高检测 + 乐理换算 + 性能
node tools/e2e.mjs                # 106 项：真 Chrome 端到端，含麦克风链路、离线、IndexedDB
node android/verify_device.mjs    # 41 项：真机 APK 内验证（adb + WebView DevTools）
node tools/check_deploy.mjs       # 各 origin 下麦克风/SW 可用性实测
```

`tools/e2e.mjs` 用 `--use-file-for-fake-audio-capture` 喂一段合成的 196Hz(G3) 类人声波形
当麦克风输入，端到端验证 getUserMedia → Analyser → 降采样 → 检测 → UI 显示 G3 且偏差 < 20 音分。
（Chrome 自带的 `--use-fake-device-for-media-stream` 只发满幅脉冲，实测 40 帧里仅 6 帧有信号
且无周期性，没法用来验证音高检测。）

`android/verify_device.mjs` 通过 `adb forward` 连上 App 内 WebView 的 DevTools 协议，
在真机上跑断言。**headless Chrome 全绿不代表 APK 里能跑** —— WebView 与 Chrome
在 Service Worker 支持、权限模型、`shouldInterceptRequest` 响应处理、MediaRecorder
编码支持上都有实质差异。实际就是靠它抓出了下面这个只在真机出现的问题。

> **只有真机才能发现的坑**：Chromium 采集音频要求**同时**具备 `RECORD_AUDIO` 和
> `MODIFY_AUDIO_SETTINGS`。只声明前者时，系统权限页显示「麦克风已授予」、AppOps 是
> `foreground`、App 是 `topResumedActivity`，但 `getUserMedia` 一律返回
> `NotReadableError: Could not start audio source`。7 种约束组合（含最基础的
> `{audio:true}`）全部失败，排除了约束问题；抓原生日志才看到
> `cr_media: Requires MODIFY_AUDIO_SETTINGS and RECORD_AUDIO`。

## 迭代流程

```bash
# 1. 改网页侧（js/ css/ data/）
npm test && node tools/e2e.mjs     # 先过这两层，快

# 2. 上真机
./android/build.sh run
adb shell svc power stayon true     # 屏幕别灭，否则 HyperOS 会冻结后台进程
node android/verify_device.mjs      # App 必须在前台，否则 devtools 不响应

# 3. 提交
git add -A && git commit && git push
```

改 `data/*.json` 后除了重新构建，还要在 App 内「数据 → 重新种卡」把新条目补进本机库。
新增卡不会影响已有卡的记忆状态。

改 `android/` 下的 Java/资源必须重新构建；只改网页侧的话，网页版刷新即可，但 APK 仍需重建
（assets 是打包进去的）。

## 已知边界

- 日语 TTS 依赖系统语音。没装日语 TTS 时朗读按钮静默降级，不影响复习。
- Android 14+ 禁止非前台应用采集麦克风，切后台时练声会停（已加 `onNativePause` 主动停采集
  循环，避免留一个僵死音轨）。正常使用不受影响。
- 导出备份不含录音 Blob（体积太大），录音只在本机。
- 机器能测音准、气息、音域，测不出音色审美和肌肉代偿。练满 3 个月后上一次真人课，
  收益远大于第一天就上课。
- 目标校准：N5 大约是「日常简单句能懂」；看懂无字幕动漫大致需要 N3 词汇量（约 3700 词）
  + 大量听力时长，按每天 20 新词算约 6-9 个月。

## 目录

```
index.html  check.html        应用入口 / 环境自检页
css/ js/ data/ icons/         网页应用本体（也是 APK 的 assets）
  js/fsrs.js                  FSRS-5 调度器（纯函数，可单测）
  js/pitch.js                 MPM 音高检测 + 乐理换算（纯函数，可单测）
  js/audio.js                 Web Audio：合成音 + 麦克风
  js/native.js                原生桥（浏览器下自动降级）
  js/views/                   今日 / 日语 / 练耳 / 练声 / 数据 / 计划
android/
  AndroidManifest.xml         权限与 activity 配置
  src/.../MainActivity.java   WebView 外壳 + 资源拦截 + 权限 + SAF 桥
  build.sh                    Gradle-free 构建
  verify_device.mjs           真机验证
tools/                        数据生成、单测、e2e、部署自检
```
