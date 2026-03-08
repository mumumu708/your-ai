# 系统能力

## 安全方案梳理

可能的参考：ironclaw

## 流式消息处理

done

## agent loop的实现

## 定时任务确认

done

## 自动部署能力

## 多agent构建

# skills

## 信息聚合

核心skills：reddit-readonly, youtube-full, bird, tech-news-digest, web_search

- Daily Reddit Digest — 每日从指定 subreddits 获取热门帖子，通过记忆系统保存用户偏好（如"不包含 memes"），生成定制化摘要推送至 Telegram。使用 reddit-readonly 技能，配合 Cron Job 每日定时执行。复用性极高，仅需修改 subreddit 列表即可适配任意场景。
- Daily YouTube Digest — 解决 YouTube 推荐算法不可靠的痛点。使用 youtube-full 技能获取频道最新视频，通过 TranscriptAPI.com 获取转录，配合 seen-videos.txt 文件避免重复处理。初始配置后完全自动运行，每日输出 2-3 个要点摘要。
- X Account Analysis — 获取 X/Twitter 账户的定性分析（而非统计数据），使用 bird 技能通过 Cookie 认证访问，支持交互式自然语言问答。可替代月费 $10-$50 的付费分析工具。
- Multi-Source Tech News Digest — 从 109+ 来源自动聚合技术新闻，包含 46 个 RSS 源（OpenAI、Hacker News 等）、44 个 Twitter KOL 账户（@karpathy、@sama 等）、19 个 GitHub 仓库的 Releases、4 个主题搜索。内置质量评分算法（优先来源 +3，多来源 +5，时效性 +2，互动 +1）和基于标题相似度的去重机制。
- YouTube Content Pipeline — 为 YouTube 创作者自动化内容侦察：每小时扫描新闻，通过 SQLite + 向量嵌入实现语义级去重，自动创建 Asana 卡片。支持 Slack 链接监控触发自动研究。
- Custom Morning Brief — 每日定时发送完全定制化早间简报，包含新闻、任务、内容草稿、AI 推荐行动项。利用夜间闲置时间准备内容。
- AI Earnings Tracker — 追踪科技/AI 公司财报：每周日扫描财报日历 → 用户选择跟踪对象 → 为每个财报日期创建一次性 Cron Job → 发布后自动生成详细摘要（beat/miss、关键指标、AI 相关亮点）。

## 自主工作

- Goal-Driven Autonomous Tasks — 将 OpenClaw 从"被动响应"转变为"主动工作"模式。用户进行一次性 Brain Dump（输入所有个人和职业目标），Agent 自主生成、调度和完成每日任务。采用 AUTONOMOUS.md（只读）+ tasks-log.md（追加写入）的状态分离模式避免竞态条件。子代理系统支持并行执行，每日产出 4-5 个已完成任务，甚至能在夜间构建惊喜迷你应用 MVP。
- Podcast Production Pipeline — 自动化播客全流程：嘉宾研究、大纲生成、录制后的带时间戳 Show Notes、社交媒体推广套件、SEO 优化描述。子代理并行处理研究和写作任务，将 70% 的生产开销交给 AI。
- Todoist Task Manager — 将 Agent 内部推理和进度日志同步到 Todoist，实现工作流透明化。Agent 自建 bash 脚本（todoist_api.sh、sync_task.sh、add_comment.sh），自动更新状态分区（🟡 In Progress → 🟠 Waiting → 🟢 Done）。
- Market Research & Product Factory — 使用 Last 30 Days 技能挖掘 Reddit 和 X 上的真实痛点，然后让 OpenClaw 直接构建解决这些问题的 MVP。覆盖从"痛点发现"到"产品交付"的完整管道，是创业者的自动化利器。
