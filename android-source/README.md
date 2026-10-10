# VINYL FIELD 0.2.0 — 网易云数据接口修复版

**修复目标**：2026-10-10 用户报告 APK 没有真实歌词、专辑封面、无法获得登录二维码。

## 已修复的确定性问题

- 之前错误地将第三方 API 封装路由 `/api/login/qr/key`、`/api/login/qr/check` 直接发送给网易云。现经原生 NeteaseBridge 路由到实际 `weapi/login/qrcode/unikey` / `weapi/login/qrcode/client/login`；二维码由 ZXing 在本机生成，无须请求不存在的 create 上游路由。
- 之前将 `/api/lyric` 当成上游接口。现映射至 `/api/song/lyric`，带歌词版本参数，前端解析 `lrc.lyric` 和 `klyric.lyric`，错误会以诊断文字显示而非假歌词。
- 搜索结果中 `album.picUrl` 并不保证存在。现在播放时独立调用 `weapi/v3/song/detail` 补齐正式专辑封面，使用异步 ID 校验避免过期结果覆盖当前歌曲。
- 网易云的封面 CDN 不一定允许 WebView/Canvas 直接读图。Android 使用限定 `p*.music.126.net` 的原生下载+缩放，然后以 data URI 交给本地 WebView 显示，同时做主题取色。
- 网易云扫码成功时，原生层从 HTTP `Set-Cookie` 读取和加密保存 `MUSIC_U` 会话（不返回前端）；若未获取到会话不再误报“已登录”。

## 尚需真机及在线验证

无法从本构建环境访问网易云官方服务，也没有连接 Android 设备。由于这是非官方兼容接口，仍可能受版本、风控、区域或版权限制；**APK 编译成功不代表扫码登录和云端播放已得到真机验证**。可通过 App 的失败信息识别 API 层错误。不得把本地模拟通过当成真实 API 成功。

## 编译

JDK 17，Android SDK 35，Gradle 8.11.1，执行 `gradle --no-daemon :app:assembleDebug`。
GitHub Actions 采用独立构建分支，输出 `VinylField-debug-apk` Artifact。

## 离线测试

`node --check app/src/main/assets/app.js` 与 `python tests/test_real_paths.py`：搜索无封面后补详情、歌词、原生回传封面和扫码本地生成的契约模拟测试通过。

---

# VINYL FIELD / 全屏自适应彩胶播放器

独立设计的 Android 横屏彩胶播放器原型。它是**可构建的源代码工程**，不是已经通过真机验证的发布版 APK。

> 设计参考：QQ 音乐横屏彩胶模式的左右分栏形式；工程流程参考 [MineRadio Android](https://github.com/zhengziyi220-wq/Mineradio-Android) 所公开的接口设计和原生音频桥接思路。本工程未拷贝 MineRadio 的代码或美术资源，也与 QQ 音乐、网易云音乐无隶属关系。

## 设计原则（2026-10-10 全屏动效版）

**唱片与背景颜色从当前专辑封面中提取，不是固定橙色。** 读取封面后提取主色相，生成协调的浅色背景、彩胶半透明材质、歌词高亮、播放按钮及 Android 状态栏/导航栏；切换歌曲自动更新。如果封面缺失或取色失败，则回退到中性主题。网易云封面常不支持浏览器 Canvas 跨域取色，因此 Android 原生层专门对 `p*.music.126.net` 图片进行有限尺寸取色，返回颜色而非图像数据。浏览器预览对本地/允许 CORS 的封面可取色。

本应用追求截图中**左歌词、右半透明彩胶、真正占满屏幕、低干扰布局**的视觉结构，但不是 QQ 音乐的品牌/美术资产复制。

**全屏模式**：横屏页面采用一整张随专辑封面变色的画布；隐藏顶栏、品牌标识、格式参数、唱机底座和重复的歌曲信息。仅显示歌曲、歌词、彩胶、进度与上一首/暂停/下一首。右上角的 **···** 菜单按需展开搜索、队列、随机/循环、横屏切换、账号。竖屏也采用同一沉浸式布局。

**动效系统**：旋转角度由 `requestAnimationFrame` 积分，播放时加速、暂停时惯性减速，不重置唱片相位；切曲时歌曲信息与歌词渐入，色彩变量用可插值 CSS 自定义属性平滑过渡。切歌保留旧封面配色直至新取色到达，消除回退中性配色时的闪屏。歌词对当前句的时间区间做连续着色（仅句级时间戳，不伪造逐字时间戳）。系统设置“减少动态效果”时禁用旋转与非必要动画。

## 当前实现

| 子系统 | 状态 | 备注 |
| --- | --- | --- |
| 自适应彩胶播放舞台 | 已实现前端 | 全屏左歌词/右彩胶，折叠工具菜单，随专辑封面提取主色；支持横竖屏 |
| 歌词舞台 | 已实现前端 | LRC 时间戳解析、逐句高亮、句级渐进填色和平滑滚动 |
| 竖屏浏览 | 已实现前端 | 搜索、歌单、本地音乐抽屉 |
| 网易云搜索 | 接口已接线，未经在线验证 | `/api/search/get`，依赖网易云接口稳定性 |
| 网易云音源 | 接口已接线，未经在线验证 | `/api/song/enhance/player/url`，仅播放账户有权访问的 URL |
| 网易云歌词 | 接口已接线，未经在线验证 | `/api/lyric` |
| 网易云扫码登录 | 接口已接线，未经在线验证 | QR key/create/check；部分账号或地区可能不可用 |
| 网易云个人歌单 | 接口已接线，未经在线验证 | `/api/user/account`、`/api/user/playlist`、`/api/playlist/detail` |
| 本地音频 | 已实现 Android 接口 + 浏览器预览 | 原生 SAF 文件选取/持久授权；浏览器可选择本地文件 |
| 原生播放 | 代码已实现，未经 APK 构建/真机测试 | Media3 ExoPlayer + MediaSessionService，后台/锁屏媒体控件 |
| 账号会话 | 代码已实现，未经真机测试 | Android Keystore AES-GCM 加密保存 Cookie |
| APK | 尚未产出 | 当前环境缺少 Android SDK/Gradle 缓存且无法拉取依赖 |

## 运行 / 构建

**方式 A：Android Studio**

1. 安装 JDK 17、Android Studio、Android SDK Platform 35。
2. 打开 `VinylField/` 根目录，让 Android Studio 同步 Gradle（AGP 8.9.2 / Gradle 8.11.1）。
3. 在 Build 中执行 `assembleDebug`；生成 `app/build/outputs/apk/debug/app-debug.apk`。
4. 用 `adb install -r app/build/outputs/apk/debug/app-debug.apk` 安装到 Android 8.0+ 设备。

**方式 B：GitHub Actions（不需要本地 Android Studio）**

将整个工程推送到你自己的 GitHub 仓库。在 Actions 中运行 `Build Android debug APK`，然后从该运行的 Artifacts 下载 `VinylField-debug-apk`。工作流只编译一个 debug APK，没有访问账户的密钥。

**方式 C：网页预览 / 本地音频**

直接打开交付的 `VinylField-preview.html`。它是单文件设计预览，支持界面交互，以及通过「探索音乐 → 本地音乐 → 导入」播放浏览器允许的本地音频。浏览器模式**不具备网易云登录/搜索**；完整接入需要 Android 原生网络桥。

## 使用流程

1. 安装 App。首页是彩胶全屏听歌舞台，点击右上角「···」，再点击放大镜进入「探索音乐」。
2. 搜索歌名并选择曲目；App 向网易云官方域名发起请求取得**账号实际有播放权**的 URL，交由 Media3 播放。
3. 如需个人歌单，点击 `N` 进入账号页，生成二维码用网易云 App 扫码。扫码返回 Cookie 之后以 Android Keystore 加密保存。
4. 网易云二维码流程失败时，可选使用**自己**的 MUSIC_U Cookie。不要把 Cookie 发给别人；它可用于访问你的账号。
5. 打开「···」菜单，点击横屏图标切换横屏；系统旋转开关也受设备当前方向设置影响。
6. 无网络时，使用本地导入功能。来自网页预览的文件并不写入 Android 本地歌单。

## 技术架构

```
WebViewAssetLoader -> 本地 index.html / style.css / app.js
             |                        |
        Javascript Bridge        NeteaseBridge
             |                     | 
       MediaController          OkHttp -> music.163.com/api/*
             |                     |
       MediaSessionService     Android Keystore AES-GCM
             |
       Media3 ExoPlayer -> HTTPS 音源 / SAF content URI
```

系统音量、媒体焦点及播放通知由 Media3 管理；歌曲下一首队列由前端管理，所以**蓝牙耳机的上一首/下一首远程按钮、进程被杀死后的队列恢复**还需要真机测试与进一步实现，不能算作已完成。

## 合规与隐私

- 本 App 不是网易云音乐官方客户端，不破解或绕过 DRM、会员权益、版权/地域限制。
- 账号 Cookie 存储在本机 Android Keystore 加密的 SharedPreferences 中，应用不包含中转服务器、不做埋点。
- 不建议向不信任的第三方提供 Cookie。网易云接口未提供稳定的官方第三方兼容性保证，账号授权可能随时失效。
- UI 是参考视觉交互类型的原创实现，不包含 QQ 音乐商标、软件源代码、美术贴图或原始界面素材。
- 本工程采用 MIT 许可（见 LICENSE）；第三方依赖遵循各自许可证。

## 已执行测试与限制

- JS：`node --check app/src/main/assets/app.js` 通过。
- Chromium 无网络注入式渲染：1280×720 横屏、390×844 竖屏已截图检查，并修复了横屏布局溢出。
- Headless 浏览器交互：LRC 多时间戳解析、打开搜索抽屉、切换本地音乐 Tab、关闭面板通过。
- 尚未执行 Gradle 编译、Android Emulator/真机测试、网易云真实接口播放或扫码登录。

对真机开发可按以下顺序验证：本地 MP3 → 切横屏 → 切后台 → 锁屏控制 → 搜索免费歌曲 → 获取歌词 → 扫码登录 → 歌单。尤其注意部分网易云 API 已调整或可能触发 403/风控；如需长期稳定使用，优先考虑平台许可的官方开放接口。

## 主题取色的验证

- 本地生成两幅测试专辑封面，经过同一套浏览器取色逻辑：暖色样张得到色相 24°，蓝色样张得到色相 205°。
- 两种取色都能使背景、唱片纹理、播放键及歌词强调色同步变化；切歌请求带序列号，过期的异步取色结果会被丢弃。
- 浏览器 Canvas 可能无法读取无 CORS 授权的远程封面；Android 改用受限于网易云封面 CDN 的原生取色。该原生路径尚未进行 APK/真机验证。
- 参考截图只用于设计方向，没有嵌入 QQ 音乐素材，也没有把橙色作为固定主题。

## 动效版检查记录

- Chromium 实际浏览器渲染：1280×720、850×393 与 390×844，无控制栏越界；菜单展开后可以进入搜索/本地文件，返回全屏时不遗留导航。
- 使用生成的本地 WAV 文件在 Chromium 播放、暂停，验证彩胶持续转动与暂停后的惯性减速（非单纯 CSS 暂停）。
- 模拟原生网易云桥接：搜索曲目、获取 URL、歌词、专辑封面取色及播放器状态联动；暖色和蓝色测试封面分别应用了不同色相。*测试桥接模拟成功不意味着网易云线上接口已验证。*
- 支持 `prefers-reduced-motion`；浏览器预览仍必须用户选择音频文件才能真实播放。
- 不承诺 APK 已编译或真机已验收；请先使用 GitHub Actions 编译、然后实测蓝牙、锁屏、扫码、云音乐线路。
