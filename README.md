# dsh-loop-guard

在 `llm/stream` 上装一道刹车：模型把思考（或正文）退化成重复循环时，立刻中断本次请求，而不是一直吐到用户手动放弃。

## 为什么要它

一次真实会话（DeepSeek flash 档模型，经第三方兼容网关接入）里的两次卡死：

| 位置 | reasoning 产出 | 耗时 | 结局 |
|---|---|---|---|
| turn 56 step 2 | 26,021 字符 / 8,604 行 | 32 s | 用户中断 |
| turn 57 step 1 | 82,524 字符 / 28,512 行 | 96 s | 用户中断 |

turn 57 那一轮的行内容里只有 47 种不同行，约 87% 是 `写。` / `执行。` / `**写 pwsh**。` / `好，执行。` 这类无内容标记。它全程只发生在 `reasoning-delta` 里，正文与工具调用都是 0，因此：

- `repeat-tool-reminder` 只看「同名工具 + 相同参数」，永不触发；
- `maxTokens` 是 50,000 且有巨大余额，不会命中；
- `agent-loop` 不做流内重复检测。

唯一的刹车是用户点中断。这个插件补上这一环。

## 两道检测器

1. **行级塌缩（主力）**：按行切开增量，维护最近 `lineWindow` 条「有内容的行」。窗口塞满后，若不同行的种类数 ≤ `maxUniqueLines`，判定塌缩。本次故障几百行内就会撞线。
2. **字符周期重复**：把末尾 `probeChars` 个字符当指纹，在最近 `regionChars` 字符里数它出现几次，达到 `minOccurrences` 判定退化。用于抓没有换行的循环。
3. **绝对上限**（默认关）：单次请求累计输出超过 `maxTotalChars` 字符直接掐断。

空行与 trim 后长度 < `lineMinChars` 的行（单个 `}` 之类）不计入行统计，避免代码文件被误判。

## 命中之后

抛出一个 `code: 'repetition-loop'` 的错误（`onDetect: 'throw'`，默认）。agent-loop 本来就有「流中途出错」的完整清理路径（网络断流天天发生），会把它收成 `error finish`；`code` 用自定义值可以避免落进 `llm-retry` 的可重试码表，免得在同一个退化点上反复重试烧 token。

`onDetect: 'end'` 则静默结束流（不伪造 `block-end` / `finish`）。

## 配置

| 键 | 默认 | 含义 |
|---|---|---|
| `providers` / `models` | `[]` | 空 = 全部；非空则只对列出的生效 |
| `lineWindow` | `400` | 行级检测窗口（行数） |
| `maxUniqueLines` | `40` | 窗口内不同行数上限 |
| `lineMinChars` | `2` | 短于它的行不计入 |
| `lineCheckEvery` | `20` | 每新增多少行判一次 |
| `probeChars` | `96` | 指纹长度 |
| `regionChars` | `3072` | 回看窗口 |
| `minOccurrences` | `5` | 指纹重复几次算退化 |
| `minTotalChars` | `2048` | 累计输出超过这个量才开始字符检测 |
| `checkEveryChars` | `128` | 每累计多少字符判一次 |
| `maxTotalChars` | `0` | 绝对上限，0 = 关 |
| `onDetect` | `'throw'` | `throw` \| `end` |
| `dryRun` | `false` | `true` = 只记日志不掐断（校准用） |
| `logFile` | `''` | 非空则把命中追加写进该文件 |

## 验证

`node lib/index.js` 跑内置用例（含「长清单 / 长代码样文本不得误杀」）。

用原始会话数据离线回放（回放脚本依赖该会话归档，不随包发布）：

- seq 1670（82,524 字符 / 96 s）：**2,304 字符处掐断**，占全长 2.8%，≈2.7 s 生成量。
- seq 1662（26,021 字符 / 32 s）：4,736 字符处掐断，≈5.5 s。
- 同一会话另外 327 个正常块（reasoning + 正文，共 588,930 字符）：**0 误杀**。
- 把 5 个正常块各自放大到 20 万字符：仍 0 误杀。

## 安装 / 回滚

```
plugin_manager set_plugin  target=dsh-loop-guard  enabled=false
```

改动只在 `llm/stream` 一条水位线上，且每次请求独立状态，禁用后立即恢复原样。
