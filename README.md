# OpenClaw Rocket.Chat Plugin

Rocket.Chat channel plugin for OpenClaw.

## 已实现能力

- 原生 OpenClaw channel plugin 包结构
- 支持 `openclaw plugins install` 安装
- 支持两种鉴权方式
  - `token`: `userId + accessToken`
  - `password`: `username + password`
- 支持单聊
- 支持群聊和频道，仅在明确 `@机器人` 时响应
- 回复阶段先发送一次 `思考中...` 占位消息，并将 `tool` / `block` / `final` 可见输出持续更新到同一条消息
- 入站附件支持图片、常见文档和主流视频格式
- 公网可访问附件直接透传为上游 `MediaUrl` / `MediaUrls`
- 需要 Rocket.Chat 鉴权的文件会临时下载为本地路径，再透传为 `MediaPath` / `MediaPaths`
- 保留 Markdown fenced code block，不主动破坏代码块
- 入站接入支持 REST 轮询和 WebSocket/DDP
- 传输层已抽象，可按账号切换 transport

## 当前限制

- `capabilities.media` 仍保持 `false`，因为当前只支持入站附件入模，不支持 Rocket.Chat 出站媒体发送
- 不支持线程、反应、消息编辑/撤回同步
- 不支持 OCR、PDF 渲染、视频转码、音频转写等重处理流程
- 非图片/文档/视频的附件会被标记为 `unknown`，可能被上游忽略或仅保留元数据
- 受保护附件下载失败时不会阻断文本分发，但失败附件不会进入上游 media context
- 没有真实 Rocket.Chat E2E 测试，当前以单元测试和模块集成测试为主

## 安装

本地目录安装：

```bash
openclaw plugins install ./
```

后续发布到 npm 后，也可以按包名安装。

```bash
openclaw plugins install @laevateinzzl/openclaw-rocketchat-bot
```

如果使用本地目录联调，修改插件源码后记得重启 gateway 让 OpenClaw 重新加载：

```bash
openclaw gateway restart
```

## 配置示例

下面的示例表达的是 `channels.rocketchat` 这段配置结构：

```yaml
channels:
  rocketchat:
    accounts:
      main:
        enabled: true
        serverUrl: "https://chat.example.com"
        auth:
          mode: "token"
          userId: "rocket-user-id"
          accessToken: "rocket-access-token"
        transport:
          mode: "websocket"
          reconnectDelayMs: 5000
        mentionNames:
          - "rocketbot"
          - "assistant"
```

密码登录模式：

```yaml
channels:
  rocketchat:
    accounts:
      main:
        enabled: true
        serverUrl: "https://chat.example.com"
        auth:
          mode: "password"
          username: "rocketbot"
          password: "your-password"
        transport:
          mode: "polling"
          pollIntervalMs: 30000
        mentionNames:
          - "rocketbot"
```

如果你希望机器人读取较大的 PDF，可以同时调高 OpenClaw 的 PDF 读取上限。默认上限通常是 `10 MB`，像扫描版教材或技术书很容易超限。

```yaml
agents:
  defaults:
    pdfMaxBytesMb: 32
```

也可以直接用 CLI 设置：

```bash
openclaw config set agents.defaults.pdfMaxBytesMb 32
openclaw gateway restart
```

## 行为说明

- 单聊消息默认接入 OpenClaw
- 群聊和频道消息只有在明确提及机器人时才接入
- 提及判断优先用 Rocket.Chat 的 mention metadata
- 如果服务端 payload 没带 mentions，会回退到文本里的 `@alias` 匹配
- `mentionNames` 用于补充别名，不需要重复写主用户名也能工作
- `transport.mode: "websocket"` 会用 DDP 接收入站消息，并在房间列表变化时用一次 REST 刷新订阅
- `transport.mode: "polling"` 继续保留，适合作为兼容回退
- legacy `handleInboundMessage(...)` 回调和 `channelRuntime` 路径都会收到标准化后的 `attachments`
- 可见回复阶段现在会按 `tool` / `block` / `final` 逐步更新同一条 Rocket.Chat 消息；如果中途失败，占位消息会替换成错误提示

## 附件支持说明

- 图片：
  - `image/*`
  - 常见扩展名：`.png`、`.jpg`、`.jpeg`、`.gif`、`.webp`、`.bmp`、`.tiff`
- 文档：
  - `application/pdf`
  - Office：`.doc`、`.docx`、`.ppt`、`.pptx`、`.xls`、`.xlsx`
  - 文本：`.txt`、`.md`、`.csv`、`.json`
- 视频：
  - `video/*`
  - 常见扩展名：`.mp4`、`.mov`、`.mkv`、`.webm`、`.avi`、`.m4v`
- MIME 存在时优先按 MIME 分类；缺失时回退到文件扩展名
- 传输层会统一标准化 `attachments`、`file`、`files` 三类 Rocket.Chat payload
- 对 `file` 类附件，插件会优先视为需要鉴权的 Rocket.Chat 文件，并在 dispatch 完成后清理临时文件
- 大于 OpenClaw 默认 PDF 上限的文档，即使附件链路正常，也可能在上游 PDF 工具阶段失败；这时需要调高 `agents.defaults.pdfMaxBytesMb`

## 开发命令

```bash
npm install
npm test
npm run typecheck
npm run build
```

## 调试

`debug:client` 和 `debug:poll` 会先读取项目根目录的 `.env`，再用命令行显式传入的环境变量覆盖同名字段。
当前调试脚本主要覆盖 REST 连通性和轮询链路，WebSocket 入站没有单独脚本。

### 1. 调试 Rocket.Chat 登录和接口连通性

```bash
ROCKETCHAT_SERVER_URL="https://chat.example.com" \
ROCKETCHAT_AUTH_MODE="token" \
ROCKETCHAT_USER_ID="rocket-user-id" \
ROCKETCHAT_ACCESS_TOKEN="rocket-access-token" \
npm run debug:client
```

密码模式：

```bash
ROCKETCHAT_SERVER_URL="https://chat.example.com" \
ROCKETCHAT_AUTH_MODE="password" \
ROCKETCHAT_USERNAME="rocketbot" \
ROCKETCHAT_PASSWORD="your-password" \
npm run debug:client
```

输出会打印：

- 当前账号身份信息
- 当前可见订阅数量
- 鉴权失败时的错误信息

### 2. 调试单次轮询和入站事件

```bash
ROCKETCHAT_SERVER_URL="https://chat.example.com" \
ROCKETCHAT_AUTH_MODE="token" \
ROCKETCHAT_USER_ID="rocket-user-id" \
ROCKETCHAT_ACCESS_TOKEN="rocket-access-token" \
ROCKETCHAT_UPDATED_SINCE="2026-03-26T00:00:00.000Z" \
npm run debug:poll
```

可选环境变量：

- `ROCKETCHAT_ACCOUNT_ID`
- `ROCKETCHAT_MENTION_NAMES`
- `ROCKETCHAT_POLL_INTERVAL_MS`
- `ROCKETCHAT_UPDATED_SINCE`

`debug:poll` 会打印每条标准化后的入站事件，以及本次轮询结束后的 checkpoint。

## 项目结构

```text
src/
  index.ts
  plugin.ts
  client.ts
  config.ts
  channel.ts
  format.ts
  checkpoints.ts
  inbound/
    attachments.ts
    types.ts
    polling.ts
    websocket.ts
tests/
openclaw.plugin.json
```

## 后续扩展

- 为 WebSocket transport 增加独立调试脚本
- 为 websocket 断线重连增加更细粒度的 backoff 策略
- 评估是否将 `capabilities.media` 与未来的出站媒体发送能力一起升级
