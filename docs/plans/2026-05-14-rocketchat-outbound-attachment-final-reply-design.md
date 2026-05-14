# Rocket.Chat 最终回复附件发送设计

## 背景

当前插件支持：
- 入站附件接收与标准化
- 回复生命周期中的占位消息与逐步文本更新
- outbound 纯文本发送

当前不支持将本地文件作为 Rocket.Chat 真正附件发给用户。

## 目标

为回复生命周期增加“最终回复携带单个本地附件”的能力。

约束：
- 仅支持最终阶段（`final`）发送附件
- 仅支持单个本地文件路径
- 若上游产生多个文件，由上游先打包为单个压缩包
- 不在本次范围内支持 URL 下载后再上传、Buffer 上传、多附件排版

## 方案选择

采用“占位消息文本更新 + 单独发送附件消息”的方案：

1. `tool` / `block` 阶段保持现状，仅更新占位消息文本
2. `final` 阶段若仅有文本，保持现状，更新同一条消息
3. `final` 阶段若带附件：
   - 先将占位消息更新为最终文本（或默认文案）
   - 再额外发送一条真正的 Rocket.Chat 附件消息

## 选择原因

相比尝试把附件直接塞进既有占位消息更新流程，这个方案更符合 Rocket.Chat 的上传模型，风险更低：
- 避免把文件上传和 `chat.update` 强绑定
- 保留现有“思考中...”到最终文本的用户体验
- 附件发送失败时，至少最终文本仍可成功呈现

代价是最终会出现两条消息：
- 一条为占位消息演化出的最终文本
- 一条为真实附件消息

这是当前约束下最稳妥的折中。

## API 与类型变更

### `src/channel.ts`

扩展 `ReplyStagePayload`：

- `attachmentPath?: string`

扩展 `ReplyClient`：

- `uploadAttachment(roomId: string, filePath: string, text?: string): Promise<string>`

行为规则：
- 非 `final` 阶段忽略 `attachmentPath`
- `final` 阶段若存在 `attachmentPath`：
  - 先执行 `updateMessage(...)`
  - 再执行 `uploadAttachment(...)`

### `src/client.ts`

新增上传接口：

- `uploadAttachment(roomId: string, filePath: string, text?: string): Promise<string>`

预期职责：
- 校验文件存在且可读
- 从路径提取文件名
- 调用 Rocket.Chat 文件上传 API
- 返回附件消息的 message id
- 对失败场景抛出 `RocketChatClientError`

## 数据流

1. 上游在 `final` payload 中传入：
   - `text?: string`
   - `attachmentPath?: string`
2. `sendReplyLifecycle()` 收到 final 更新
3. 先按现有格式规则更新占位消息
4. 若存在 `attachmentPath`，调用 `client.uploadAttachment(...)`
5. 插件完成最终回复

## 错误处理

### 文本更新成功，附件上传失败

- 保留最终文本
- 上传错误向上抛出
- 由现有调用链决定记录日志/失败处理

这样可以保证：即使附件失败，用户至少能看到最终文本结果。

### 本地路径不存在或不可读

- 立即抛错
- 不做静默跳过

### 非 final 阶段传入附件

- 当前设计下不支持
- 实现上应忽略，避免破坏中间阶段行为

## 测试策略

### `tests/channel.test.ts`

新增覆盖：
- `final` 仅文本：保持现有行为
- `final` 带 `attachmentPath`：
  - 先 `updateMessage`
  - 再 `uploadAttachment`
- `tool` / `block` 带 `attachmentPath`：不触发上传
- 附件上传失败：错误向上抛出，且最终文本已更新

### `tests/client.test.ts`

新增覆盖：
- 使用本地文件路径上传时，请求命中 Rocket.Chat 上传接口
- 正确携带 roomId、文件名与可选文本
- 文件不存在时报错
- Rocket.Chat 非 2xx 时抛出 `RocketChatClientError`

## 非目标

本次不实现：
- outbound 通用附件发送 API
- 多附件发送
- 远程 URL 下载后再上传
- 二进制内容直接上传
- 将附件合并进同一条被 `chat.update` 的消息

## 后续演进

如果后续需要扩展，可按以下顺序演进：
1. 将 `attachmentPath` 能力抽象为通用 outbound media 接口
2. 支持 zip 之外的更丰富附件类型
3. 支持多附件发送
4. 统一附件发送与生命周期回执模型
