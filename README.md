# duru-daily-digest

本项目 **fork 自** [HarrisHan/ai-daily-digest](https://github.com/HarrisHan/ai-daily-digest)，并在此基础上做了三类关键改造：
1) 订阅源从“每天全量抓取”改为 **6 天轮巡（15/15/15/15/15/17）**；
2) 增加 **本地 Ollama 2B 预压缩**，先把文章压成短摘要再交给主模型；
3) 增加 **strict 硬链路**（rotation → fetch → compress），避免主模型回退到长文本输入。  
这么改的目的很直接：**降低 token 消耗、减少超时/卡死概率、提高每天定时推送稳定性**。

## 项目用途

`duru-daily-digest` 用于从技术博客 RSS 源中自动生成每日简报：
- 抓取最近 24/48/72 小时文章
- 进行筛选、聚合与摘要
- 输出适合 Telegram/OpenClaw 的日报内容（Top3 + 更多精选 + 统计）

适合想持续追踪 AI / 工程 / 安全动态，但不想手动刷大量信息源的场景。

## 工作流（当前版本）

```text
Rotating Sources (15 or 17/day)
  -> fetch-rss.mjs
  -> compress-with-ollama.mjs (local qwen3.5:2b, strict)
  -> compact JSON
  -> main model writes final digest
```

## 安装方式（无 ClawHub 版本）

> 本项目当前未发布到 ClawHub，请使用手动安装。

```bash
git clone https://github.com/DuruGY/duru-daily-digest.git
mkdir -p ~/.openclaw/workspace/skills
cp -r duru-daily-digest ~/.openclaw/workspace/skills/
```

建议目录结构：

```text
~/.openclaw/workspace/skills/duru-daily-digest
```

## 使用方式

### 1) 手动运行（测试）

在 OpenClaw 对话中触发：

```text
/digest
```

### 2) 预处理硬链路（推荐）

```bash
bash ~/.openclaw/workspace/skills/duru-daily-digest/scripts/run-digest-hard.sh 24 15 Asia/Shanghai qwen3.5:2b 6
```

参数含义：
- `24`：时间窗（小时）
- `15`：目标精选数
- `Asia/Shanghai`：时区
- `qwen3.5:2b`：本地压缩模型
- `6`：并发压缩 worker 数

### 3) 定时任务（每天 08:00）

可在 OpenClaw cron 中配置固定消息，让 agent 先执行硬链路，再只读取 `out.compact.json` 生成日报。

## 关键文件

```text
duru-daily-digest/
├── SKILL.md
├── README.md
├── CHANGELOG.md
├── LICENSE
├── scripts/
│   ├── fetch-rss.mjs
│   ├── select-sources-rotation.mjs
│   ├── compress-with-ollama.mjs
│   └── run-digest-hard.sh
└── references/
    └── sources.json
```

## License

MIT（沿用上游许可）

## Credits

- Upstream: [HarrisHan/ai-daily-digest](https://github.com/HarrisHan/ai-daily-digest)
- RSS sources from [Hacker News Popularity Contest 2025](https://refactoringenglish.com/tools/hn-popularity/)
- Built for OpenClaw
