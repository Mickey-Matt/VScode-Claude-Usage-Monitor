# VScode Claude Usage Monitor
 [English](./README.md) | [中文](./README_zh.md) 
 
 实时显示 VScode 插件 Claude 会话的上下文窗口占用和会话活跃时间。

## 提示框详情

![](./images/img1.png)


- **Token 分解**  ： 将上下文拆分为 System overhead / Messages / Total / Free space 四项，一目了然。
- **活跃时间**  ： 统计 Claude 实际工作（思考/回复）的时间，自动跳过闲置期（>15 分钟无交互视为离开）
- **模型和窗口** ： 显示当前模型名和上下文窗口大小，覆盖 46 个主流模型，同时支持自定义，新模型可通过 `settings.json` 自行添加
- **增量更新** ： 每次轮询只读文件新增部分，不重复解析已处理内容，对系统零负担
- **会话自动匹配** — 多工作区/多会话场景下自动识别当前活动会话

>注意：切换会话时可能由于缓存原因导致提示框不会立即更新，此时只要在会话中发送新消息或重新加载窗口即可）

## 与 /context 命令的比较

<div align="center">
  <img src="./images/img2.png" alt="示例图片" width="400" />
</div>

  
## 区别
- 由于原插件通过 Claude 的`statusline`命令来获取上下文数据，导致无法安装其他 Statusline 工具，例如`ccometixline`、`ccstatusline` 等，而本 fork 直接从 Claude 自动在工作区生成的 .jsonl 文件中解析数据，不会与其他 statusline 工具发生冲突；
- 加上了四项不同类型的token占用、会话活跃时间以及主流模型的识别，同时也支持模型名和上下文长度自定义
-  bridge 脚本已弃用，仅依靠 extension.js 实现所有功能 

## 性能

- **零外部依赖** ： 纯 Node.js 内置模块（`fs`、`path`、`os`），不需要 Python 3，不需要 bridge 脚本
- **尾部扫描**  ： 只读取文件末尾 512KB 中 assistant 行，不扫描全文件
- **15 秒轮询**  ： 默认间隔可配置（`fuel-gauge.pollInterval`），轮询更新耗时 < 1ms
-  **增量读取**  ： 活跃时间计算仅在文件内容变化时读取增量部分，同文件大小未变化时零 I/O


## 安装
1. VScode 中安装原插件 Claude Code Fuel Gauge
2. 下载本仓库的 `dist/extension.js`，替换到 `~/.vscode/extensions/makingaipractical.claude-code-fuel-gauge-0.5.1/out/extension.js`

如需自定义 `systemOverhead`、模型名、上下文长度，在 `settings.json` 中添加即可（见[配置](#配置)）。

## 配置

在 VSCode `settings.json` 中配置 ：

| 设置项                             | 默认值     | 说明           |
| ------------------------------- | ------- | ------------ |
| `fuel-gauge.systemOverhead`     | `18000` | 系统开销 token 数 |
| `fuel-gauge.pollInterval`       | `15`    | 轮询间隔（秒）      |
| `fuel-gauge.warningThreshold`   | `60`    | 黄色警告阈值（%）    |
| `fuel-gauge.dangerThreshold`    | `80`    | 红色警告阈值（%）    |
| `fuel-gauge.model`              | `""`    | 自定义模型名       |
| `fuel-gauge.modelContextLength` | `{}`    | 自定义模型上下文大小   |

示例：

```json
{
    "fuel-gauge.systemOverhead": 24100,
    "fuel-gauge.model":"my-new-model",
    "fuel-gauge.modelContextLength": {
        "my-new-model": 500000
    }
}
```

>`systemOverhead`默认值18000，需根据 /context 命令中 System prompt 和 System tools 两项自行配置

> `fuel-gauge.model` 以及 `fuel-gauge.modelContextLength` 两项由于未在 VScode 中注册，setting.json中会显示为灰色，但这仅仅是 VScode 的静态校验提示，完全不影响正常工作
## 系统要求

- VS Code 1.93+
- 安装原版 Claude Code Fuel Gauge 插件

## 致谢

从 [makingaipractical/claude-code-fuel-gauge](https://github.com/makingaipractical/claude-code-fuel-gauge)复刻，感谢原作者对开源社区的贡献。

## 许可证

MIT License — 详见 [LICENSE](LICENSE)。Copyright (c) 2026 MakingAIPractical。

