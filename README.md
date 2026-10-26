# AI 面试助手

我希望技术是服务于广大群众，也希望你能顺利通过，当然技术为王的前提下，希望你真正拥有。

---

## 配置信息详情

所有配置都在应用内 **高级设置** 里填写。密钥保存在系统的应用数据目录，**不会进代码仓库**：

| 系统 | 位置 |
| --- | --- |
| macOS | `~/Library/Application Support/suisi-local/data/settings.json` |
| Windows | `%APPDATA%\suisi-local\data\settings.json` |

### 1. 模型网关（必填）

「高级设置 → 模型网关」新增一个网关：

| 字段 | 说明 |
| --- | --- |
| Base URL | 任意 **OpenAI 兼容** 网关地址，例如 `https://your-gateway.com/v1` |
| API Key | 该网关的密钥 |
| 模型 | 模型名，例如 `gpt-4o-mini`、`deepseek-chat`、`qwen-plus` |

填完点 **测试连接** 确认可用。

> **截图解题需要多模态模型**。如果你选的模型不支持图片输入，请在网关配置里把
> 「支持图片输入」关掉——否则识题会提示模型不支持图片。

### 2. 语音识别（听会 / 听题需要）

「高级设置 → 语音识别」四选一：

| 通道 | 说明 |
| --- | --- |
| **阿里云百炼 实时识别** | 流式，边说边出字，延迟最低。填 DashScope API Key，模型 `paraformer-realtime-v2` |
| **本地 whisper.cpp 常驻服务** | 隐私最好、零成本，首次识别约 1 秒。需本机有 `whisper-server` 与模型文件 |
| **云端 / 自建（OpenAI 兼容）** | 任何提供 `POST /v1/audio/transcriptions` 的服务 |
| **本地 whisper-cli** | 每次调用重新加载模型，约 15 秒，只适合验证链路 |

本地通道需要自行准备模型（如 `ggml-small.bin`、`ggml-silero-v5.1.2.bin`）和
`whisper-server` 可执行文件，把路径填进对应输入框即可。**程序不会自动下载任何东西。**

### 3. 系统权限（macOS）

| 权限 | 用途 | 在哪开 |
| --- | --- | --- |
| **屏幕录制** | 截图解题；采集电脑音频（会议里对方的声音） | 系统设置 → 隐私与安全性 → 屏幕与系统音频录制 |
| **麦克风** | 采集你自己的声音 | 系统设置 → 隐私与安全性 → 麦克风 |
| **辅助功能** | 键盘防护（可选） | 系统设置 → 隐私与安全性 → 辅助功能 |

> 权限改完**必须完全退出应用再重新打开**才生效。关闭窗口不等于退出应用。

「采音设置」里有 **检测电脑音频** 按钮，点一下就能确认采集链路通不通。

### 4. 运行

需要 Node.js 22.12 或更高版本及 npm；macOS 原生组件还需要 Xcode Command Line Tools。

```bash
npm ci
npm exec --no -- install-electron # 首次安装 Electron 可执行文件
npm run build:native   # 仅 macOS：编译原生 helper（用系统自带 swiftc，无第三方依赖）
npm run dev
```

其它命令：

```bash
npm run build      # 构建
npm start          # 启动构建后的应用
npm run typecheck  # 类型检查
npm run test       # 全部自测（含原生采集实测，缺权限会自动跳过）
npm run verify     # 类型检查 + 自测 + 构建
```

如果启动时报 `Electron uninstall`，先执行 `npm exec --no -- install-electron`，再重新启动。
macOS/Linux 终端若注入了 Electron 不支持的 `NODE_OPTIONS`，可用 `env -u NODE_OPTIONS npm start` 启动。

原生 helper 源码在 `native/`（Swift + 系统框架），编译产物不入库，换机器后重新跑一次
`npm run build:native` 即可。

---

## 功能

- **实时助答**：听会议 / 面试里对方的问题，实时给出可以直接照着念的答案
- **截图解题**：快捷键整屏截图 → OCR → 答题（含笔试模式与代码题）
- **AI 面试**：模拟面试官出题、追问、评分与复盘
- **知识库**：挂载自己的资料，回答时优先引用
- **会议记录**：转写落库、历史检索、待办提取

## 隐私

- 密钥只存在本机应用数据目录，仓库里不含任何密钥
- 音频与截图**只发往你自己配置的服务**（模型网关 / 语音识别通道），本程序没有自己的服务器

## 免责

本项目用于辅助表达与复习。**技术能力始终来自你自己的积累**，请不要用它替代真实的学习与思考。
