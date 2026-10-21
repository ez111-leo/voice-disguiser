# 语音伪装器 — Voice Disguiser

> 信号分析与处理课程演示 · 上海大学 中欧工程技术学院 王天钰 · 2026

浏览器内运行的语音变调与信号可视化演示。通过重采样移动音高和共振峰，再使用 SOLA 时域拉伸恢复音频长度。无需后端或构建工具。

[在线体验](https://ez111-leo.github.io/voice-disguiser/)

## 使用方法

1. 用现代桌面浏览器打开演示，可先试听预置的合成信号。
2. 点击“录音”并允许麦克风访问，结束后点击“停止”；或上传浏览器能解码的音频，推荐 PCM WAV。
3. 选择预设，等待“音频已就绪”，对比“原始”和“变声”。
4. 按需选择带通滤波或旁路，再点击“导出”下载 16 位 PCM WAV。

麦克风需要 HTTPS 或 localhost。权限、设备或解码问题会显示在状态栏。

## 已实现的功能

- 录音、音频导入，以及录音/播放时的波形、频谱和语谱图。
- 四种教学预设：男→女（α=1.6）、女→男（α=0.625）、男→童（α=2.2）、女→童（α=1.5）。
- 可选 80–4000 Hz 高通与低通 IIR 滤波；旁路时不执行滤波，试听不重复滤波。
- 0.6×、1×、1.6×播放速度，以及保留声道的 WAV 导出。
- 处理期间禁用试听和导出，快速切换设置时仅保留最新结果。

“原始”播放当前滤波设置下、尚未变调的音频；旁路可试听未经滤波的输入。导出保存当前变声结果，不包含播放速度设置。变速通过 playbackRate 实现，也会影响听到的音高。

## 算法与限制

重采样按 α 同时移动基频和共振峰；SOLA 使用重叠加窗和相关性匹配调整时长。滤波器使用 BiquadFilterNode，不是 FIR。当前未实现 LPC、独立共振峰控制、神经网络变声或实时变声监听：录音完成后才生成变声结果。

预设名称仅表示教学效果方向，不保证转换为特定性别、年龄或身份。变调可能产生失真，不能保证声音匿名。基频读数是局部信号的粗略估计，不适合身份或性别识别。带通滤波只能衰减带外信号，无法消除全部噪声。

音频处理在主线程执行，长文件和较大的伸缩倍数可能使界面暂时卡顿，建议先用短片段。不同浏览器的录音格式、解码支持及设备行为可能不同。当前主要面向单声道和立体声语音。

当前代码在本地浏览器内处理音频，不上传录音或文件。托管服务仍会接收普通页面访问请求。

## 项目结构

```text
voice-disguiser/
├── .nojekyll
├── index.html           # 单文件主程序
├── README.md
├── LICENSE
└── tests/
    ├── audio.test.cjs   # Node 内置测试，无第三方依赖
    └── browser_smoke.py # Playwright 浏览器集成验证
```

仓库未包含 Python 或 MATLAB 版本。

## 本地运行与验证

用静态服务器运行，再打开 http://localhost:8000 ：

```sh
python -m http.server 8000
```

回归测试（Node.js 20 或更新版本）：

```sh
node --test tests/audio.test.cjs
```

浏览器验证需要 Python Playwright 和 Chromium：

```sh
python -m pip install playwright
python -m playwright install chromium
python tests/browser_smoke.py
```

测试启动临时本地服务器和无界面浏览器，使用合成音频与模拟麦克风，不采集真实麦克风。可设置 BROWSER_EXECUTABLE 指向现有 Chromium/Edge；可选 EVIDENCE_DIR 保存截图和导出样本。

## 参考

- [MDN Web Audio 变声示例](https://github.com/mdn/webaudio-examples/tree/main/voice-change-o-matic)：浏览器音频与可视化参考。
- [SoundTouchJS](https://github.com/cutterbl/SoundTouchJS)：可供后续算法比较的实现；当前未引入此依赖。

## License

[MIT](LICENSE) © 2026

