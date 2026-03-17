#!/usr/bin/env -S npx tsx
/**
 * RSS Tech Digest v2 — RSS 抓取与数据处理工具
 *
 * 职责：RSS 抓取 → XML 解析 → 时间过滤 → 去重 → 预评分过滤 → 输出 JSON
 *
 * 纯数据处理，不涉及 AI 调用。AI 评分/分类/摘要/翻译/趋势由 Agent 完成。
 * 零依赖，基于 Bun/tsx 运行时的原生 fetch。
 *
 * 用法:
 *   bun run rss-digest.ts [--hours 48] [--output articles.json] [--concurrency 10] [--timeout 15000] [--top 80] [--min-desc-length 60]
 */

import { writeFileSync } from "fs";

// ============================================================================
// 类型定义
// ============================================================================

interface FeedItem {
  title: string;
  link: string;
  pubDate: string;        // ISO 8601
  pubDateRelative: string; // "3 小时前"
  description: string;     // 纯文本，截断至 500 字符
  source: string;          // 域名
  sourceCategory: string;  // 源分类（tech_blog, financial_news, tech_news, current_affairs_news 等）
  preScore: number;        // 规则化预评分
}

interface FetchResult {
  totalFeeds: number;
  successFeeds: number;
  failedFeeds: number;
  totalArticles: number;
  filteredByTime: number;    // 时间过滤后的数量
  filteredByPreScore: number; // 预评分过滤后的数量
  hoursWindow: number;
  fetchedAt: string;
  articles: FeedItem[];
}

// ============================================================================
// RSS 源列表 — HN Top 100 + 补充源
// ============================================================================

const RSS_FEEDS: { url: string; domain: string; sourceCategory?: string }[] = [
  // === HN Popularity Contest Top 100 ===
  // 来源: https://refactoringenglish.com/tools/hn-popularity/
  { url: "http://www.aaronsw.com/2002/feeds/pgessays.rss", domain: "paulgraham.com" },
  { url: "https://krebsonsecurity.com/feed/", domain: "krebsonsecurity.com" },
  { url: "https://simonwillison.net/atom/everything/", domain: "simonwillison.net" },
  { url: "https://daringfireball.net/feeds/main", domain: "daringfireball.net" },
  { url: "https://jvns.ca/atom.xml", domain: "jvns.ca" },
  { url: "https://danluu.com/atom.xml", domain: "danluu.com" },
  { url: "https://www.righto.com/feeds/posts/default", domain: "righto.com" },
  { url: "https://stratechery.com/feed/", domain: "stratechery.com" },
  { url: "https://www.troyhunt.com/rss/", domain: "troyhunt.com" },
  { url: "https://rachelbythebay.com/w/atom.xml", domain: "rachelbythebay.com" },
  { url: "https://shkspr.mobi/blog/feed/", domain: "shkspr.mobi" },
  { url: "https://www.schneier.com/feed/atom/", domain: "schneier.com" },
  { url: "https://www.kalzumeus.com/feed/", domain: "kalzumeus.com" },
  { url: "https://jacquesmattheij.com/feed.xml", domain: "jacquesmattheij.com" },
  { url: "https://www.jeffgeerling.com/blog.xml", domain: "jeffgeerling.com" },
  { url: "https://utcc.utoronto.ca/~cks/space/blog/?atom", domain: "utcc.utoronto.ca" },
  { url: "https://blog.samaltman.com/feed", domain: "blog.samaltman.com" },
  { url: "http://antirez.com/rss", domain: "antirez.com" },
  { url: "https://marco.org/rss", domain: "marco.org" },
  { url: "https://blog.codinghorror.com/rss/", domain: "blog.codinghorror.com" },
  { url: "https://drewdevault.com/blog/index.xml", domain: "drewdevault.com" },
  { url: "https://ciechanow.ski/atom.xml", domain: "ciechanow.ski" },
  { url: "https://www.tbray.org/ongoing/ongoing.atom", domain: "tbray.org" },
  { url: "https://sive.rs/en.atom", domain: "sive.rs" },
  { url: "https://devblogs.microsoft.com/oldnewthing/feed", domain: "devblogs.microsoft.com" },
  { url: "https://fabiensanglard.net/rss.xml", domain: "fabiensanglard.net" },
  { url: "https://gwern.net/feed.xml", domain: "gwern.net" },
  { url: "https://blog.jgc.org/feeds/posts/default", domain: "jgc.org" },
  { url: "https://daniel.haxx.se/blog/feed/", domain: "daniel.haxx.se" },
  { url: "https://www.johndcook.com/blog/feed/", domain: "johndcook.com" },
  { url: "https://steveblank.com/feed/", domain: "steveblank.com" },
  { url: "https://pluralistic.net/feed/", domain: "pluralistic.net" },
  { url: "https://martinfowler.com/feed.atom", domain: "martinfowler.com" },
  { url: "https://tonsky.me/blog/atom.xml", domain: "tonsky.me" },
  { url: "https://lemire.me/blog/feed/", domain: "lemire.me" },
  { url: "https://hanselman.com/blog/feed/rss", domain: "hanselman.com" },
  { url: "https://neal.fun/rss.xml", domain: "neal.fun" },
  { url: "https://www.gatesnotes.com/rss", domain: "gatesnotes.com" },
  { url: "https://dynomight.net/feed.xml", domain: "dynomight.net" },
  { url: "https://www.filfre.net/feed/", domain: "filfre.net" },
  { url: "https://nullprogram.com/feed/", domain: "nullprogram.com" },
  { url: "https://www.antipope.org/charlie/blog-static/atom.xml", domain: "antipope.org" },
  { url: "https://blog.plover.com/index.atom", domain: "blog.plover.com" },
  { url: "https://xeiaso.net/blog.rss", domain: "xeiaso.net" },
  { url: "https://www.brendangregg.com/blog/rss.xml", domain: "brendangregg.com" },
  { url: "https://mjg59.dreamwidth.org/data/atom", domain: "mjg59.dreamwidth.org" },
  { url: "https://blog.acolyer.org/feed/", domain: "blog.acolyer.org" },
  { url: "https://idlewords.com/index.xml", domain: "idlewords.com" },
  { url: "https://lucumr.pocoo.org/feed.atom", domain: "lucumr.pocoo.org" },
  { url: "https://slatestarcodex.com/feed/", domain: "slatestarcodex.com" },
  { url: "https://mtlynch.io/feed.xml", domain: "mtlynch.io" },
  { url: "https://blog.pragmaticengineer.com/rss/", domain: "pragmaticengineer.com" },
  { url: "https://www.daemonology.net/blog/atom.xml", domain: "daemonology.net" },
  { url: "https://blog.cryptographyengineering.com/feed/", domain: "blog.cryptographyengineering.com" },
  { url: "https://scottaaronson.com/?feed=rss2", domain: "scottaaronson.com" },
  { url: "https://justine.lol/rss.xml", domain: "justine.lol" },
  { url: "https://buttondown.com/hillelwayne/rss", domain: "buttondown.com/hillelwayne" },
  { url: "https://astralcodexten.substack.com/feed", domain: "astralcodexten.com" },
  { url: "https://www.joelonsoftware.com/feed/", domain: "joelonsoftware.com" },
  { url: "https://prog21.dadgum.com/atom.xml", domain: "prog21.dadgum.com" },
  { url: "https://seangoedecke.com/rss.xml", domain: "seangoedecke.com" },
  { url: "https://randomascii.wordpress.com/feed/", domain: "randomascii.wordpress.com" },
  { url: "https://zachholman.com/feed.xml", domain: "zachholman.com" },
  { url: "https://acoup.blog/feed/", domain: "acoup.blog" },
  { url: "https://www.hillelwayne.com/index.xml", domain: "hillelwayne.com" },
  { url: "https://eli.thegreenplace.net/feeds/all.atom.xml", domain: "eli.thegreenplace.net" },
  { url: "https://www.marginalia.nu/feed.xml", domain: "marginalia.nu" },
  { url: "https://worrydream.com/feed.xml", domain: "worrydream.com" },
  { url: "https://catonmat.net/feed", domain: "catonmat.net" },
  { url: "https://www.bunniestudios.com/blog/?feed=rss2", domain: "bunniestudios.com" },
  { url: "https://filippo.io/index.xml", domain: "filippo.io" },
  { url: "https://www.gabrielweinberg.com/blog?format=rss", domain: "gabrielweinberg.com" },
  { url: "https://apenwarr.ca/log/rss.php", domain: "apenwarr.ca" },
  { url: "https://matklad.github.io/feed.xml", domain: "matklad.github.io" },
  { url: "https://xkcd.com/atom.xml", domain: "xkcd.com" },
  { url: "https://austinhenley.com/blog/feed.rss", domain: "austinhenley.com" },
  { url: "https://matt.might.net/articles/feed.rss", domain: "matt.might.net" },
  { url: "https://lcamtuf.substack.com/feed", domain: "lcamtuf.substack.com" },
  { url: "https://longform.asmartbear.com/feed.rss", domain: "asmartbear.com" },
  { url: "https://www.stephendiehl.com/feed.rss", domain: "stephendiehl.com" },
  { url: "https://blog.regehr.org/feed", domain: "blog.regehr.org" },
  { url: "https://robertheaton.com/feed.xml", domain: "robertheaton.com" },
  { url: "https://aphyr.com/posts.atom", domain: "aphyr.com" },
  { url: "https://idiallo.com/blog/rss", domain: "idiallo.com" },
  { url: "https://lapcatsoftware.com/articles/feed.xml", domain: "lapcatsoftware.com" },
  { url: "https://www.jwz.org/blog/feed/", domain: "jwz.org" },
  { url: "https://bellard.org/rss.xml", domain: "bellard.org" },
  { url: "https://www.joshwcomeau.com/rss.xml", domain: "joshwcomeau.com" },
  { url: "https://tedium.co/rss/", domain: "tedium.co" },
  { url: "https://www.tedunangst.com/flak/rss", domain: "tedunangst.com" },
  { url: "https://yosefk.com/blog/feed", domain: "yosefk.com" },
  { url: "https://blog.jim-nielsen.com/feed.xml", domain: "blog.jim-nielsen.com" },
  { url: "https://blog.benjojo.co.uk/rss.xml", domain: "blog.benjojo.co.uk" },
  { url: "https://calnewport.com/feed/", domain: "calnewport.com" },
  { url: "https://blog.fogus.me/feed/", domain: "blog.fogus.me" },
  { url: "https://fasterthanli.me/index.xml", domain: "fasterthanli.me" },
  { url: "https://berthub.eu/articles/index.xml", domain: "berthub.eu" },
  { url: "https://minimaxir.com/atom.xml", domain: "minimaxir.com" },
  { url: "https://robert.ocallahan.org/feeds/posts/default", domain: "robert.ocallahan.org" },
  { url: "https://research.swtch.com/feed.atom", domain: "research.swtch.com" },

  // === 补充源：AI 资讯 + GitHub Trending ===
  { url: "https://justlovemaki.github.io/CloudFlare-AI-Insight-Daily/rss.xml", domain: "cloudflare-ai-insight" },
  { url: "https://news.smol.ai/rss.xml", domain: "news.smol.ai" },
  { url: "https://mshibanami.github.io/GitHubTrendingRSS/daily/all.xml", domain: "github-trending" },

  // === 中文博客（6个） ===
  { url: "https://www.qbitai.com/feed", domain: "qbitai.com" },
  { url: "https://baoyu.io/feed.xml", domain: "baoyu.io" },
  { url: "http://www.ifanr.com/feed", domain: "ifanr.com" },
  { url: "http://feeds.feedburner.com/ruanyifeng", domain: "ruanyifeng.com" },
  { url: "https://tech.meituan.com/feed/", domain: "tech.meituan.com" },
  { url: "https://www.supertechfans.com/cn/index.xml", domain: "supertechfans.com" },

  // === 中文聚合（1个） ===
  { url: "https://rsshub.bestblogs.dev/juejin/trending/all/weekly", domain: "juejin.cn" },

  // === 中文Twitter博主（15个） ===
  { url: "https://api.xgo.ing/rss/user/ca2fa444b6ea4b8b974fe148056e497a", domain: "lijigang.com" },
  { url: "https://api.xgo.ing/rss/user/97f1484ae48c430fbbf3438099743674", domain: "dotey.dev" },
  { url: "https://api.xgo.ing/rss/user/831fac36aa0a49a9af79f35dc1c9b5d9", domain: "guizang.ai" },
  { url: "https://api.xgo.ing/rss/user/74e542992cf7441390c708f5601071d4", domain: "imxiaohu.com" },
  { url: "https://api.xgo.ing/rss/user/9de19c78f7454ad08c956c1a00d237fe", domain: "vista8.dev" },
  { url: "https://api.xgo.ing/rss/user/5b632b7fba274f62928cdcc9d3db4c5e", domain: "pmbackttfuture.dev" },
  { url: "https://api.xgo.ing/rss/user/3d72acd51d21414ea39871fc01982a65", domain: "idoubicc.dev" },
  { url: "https://api.xgo.ing/rss/user/aab44cb2665a49258cd81f63b0b55192", domain: "vikingmute.dev" },
  { url: "https://api.xgo.ing/rss/user/9cb3b60e689e4445a7fbdfd0be144126", domain: "geekbb.dev" },
  { url: "https://api.xgo.ing/rss/user/665fc88440fd4436acbc2e630d824926", domain: "hitw93.dev" },
  { url: "https://api.xgo.ing/rss/user/66c40de71a9842fda4853b7d9d1d20da", domain: "yangyixxxx.dev" },
  { url: "https://api.xgo.ing/rss/user/23d41992b29340788aa3d09d8364c5f5", domain: "hidecloud.dev" },
  { url: "https://api.xgo.ing/rss/user/66a6b39ddcfa42e39621e0ab293c1bdd", domain: "catwu.dev" },
  { url: "https://api.xgo.ing/rss/user/48aae530e0bf413aa7d44380f418e2e3", domain: "shao__meng.dev" },
  { url: "https://api.xgo.ing/rss/user/ddfdcdd4e390495c942f0b5da62af0fb", domain: "ericjing.ai" },

  // === 中国AI公司（11个） ===
  { url: "https://api.xgo.ing/rss/user/80032d016d654eb4afe741ff34b7643d", domain: "qwen.ai" },
  { url: "https://api.xgo.ing/rss/user/68b610deb24b47ae9a236811563cda86", domain: "deepseek.ai" },
  { url: "https://api.xgo.ing/rss/user/6e8e7b42cb434818810f87bcf77d86fb", domain: "hunyuan.ai" },
  { url: "https://api.xgo.ing/rss/user/6d7d398dd80b48d79669c92745d32cf6", domain: "skywork.ai" },
  { url: "https://api.xgo.ing/rss/user/564237c3de274d58a04f064920817888", domain: "kling.ai" },
  { url: "https://api.xgo.ing/rss/user/e65b5e59fcb544918c1ba17f5758f0f8", domain: "hailuo.ai" },
  { url: "https://api.xgo.ing/rss/user/4900b3dcd592424687582ff9e0f148ea", domain: "fishaudio.com" },
  { url: "https://api.xgo.ing/rss/user/5d749cc613ec4069bb2a47334739e1b6", domain: "monica.im" },
  { url: "https://api.xgo.ing/rss/user/0be252fedbe84ad7bea21be44b18da89", domain: "dify.ai" },
  { url: "https://api.xgo.ing/rss/user/f510f6e7eecf456ca7e2895a46752888", domain: "jina.ai" },
  { url: "https://api.xgo.ing/rss/user/424e67b19eed4500b7a440976bbd2ade", domain: "milvus.io" },

  // === 华人AI研究者（8个） ===
  { url: "https://api.xgo.ing/rss/user/a4bfe44bfc0d4c949da21ebd3f5f42a5", domain: "drfeifei.dev" },
  { url: "https://api.xgo.ing/rss/user/082097117b4543e9a741cd2580f936d3", domain: "justinlin.dev" },
  { url: "https://api.xgo.ing/rss/user/f54b2b40185943ce8f48a880110b7bc2", domain: "huybery.dev" },
  { url: "https://api.xgo.ing/rss/user/c6cfe7c0d6b74849997073233fdea840", domain: "drjimfan.dev" },
  { url: "https://api.xgo.ing/rss/user/b3d904c0d7c446558ef3a1e7f2eb362b", domain: "jerryjliu.dev" },
  { url: "https://api.xgo.ing/rss/user/a8f7e2238039461cbc8bf55f5f194498", domain: "lilianweng.dev" },
  { url: "https://api.xgo.ing/rss/user/08b5488b20bc437c8bfc317a52e5c26d", domain: "andrewng.dev" },
  { url: "https://www.youtube.com/feeds/videos.xml?channel_id=UC2ggjtuuWvxrHHHiaDH1dlQ", domain: "hungyilee.youtube" },

  // === AI Companies（17个） ===
  { url: "https://api.xgo.ing/rss/user/0c0856a69f9f49cf961018c32a0b0049", domain: "openai.com" },
  { url: "https://api.xgo.ing/rss/user/971dc1fc90da449bac23e5fad8a33d55", domain: "openaidevs.com" },
  { url: "https://api.xgo.ing/rss/user/f7992687b8d74b14bf2341eb3a0a5ec4", domain: "chatgptapp.com" },
  { url: "https://api.xgo.ing/rss/user/fc28a211471b496682feff329ec616e5", domain: "anthropic.ai" },
  { url: "https://api.xgo.ing/rss/user/01f60d63a61b44d692cc35c7feb0b4a4", domain: "claudeai.com" },
  { url: "https://api.xgo.ing/rss/user/4de0bd2d5cef4333a0260dc8157054a7", domain: "googleai.com" },
  { url: "https://api.xgo.ing/rss/user/a99538443a484fcc846bdcc8f50745ec", domain: "googledeepmind.com" },
  { url: "https://api.xgo.ing/rss/user/6fb337feeec44ca38b79491b971d868d", domain: "geminiapp.com" },
  { url: "https://api.xgo.ing/rss/user/3953aa71e87a422eb9d7bf6ff1c7c43e", domain: "x.ai" },
  { url: "https://api.xgo.ing/rss/user/fc16750ce50741f1b1f05ea1fb29436f", domain: "huggingface.co" },
  { url: "https://api.xgo.ing/rss/user/05f1492e43514dc3862a076d3697c390", domain: "nvidia.ai" },
  { url: "https://api.xgo.ing/rss/user/ef7c70f9568d45f4915169fef4ce90b4", domain: "aiatmeta.com" },
  { url: "https://api.xgo.ing/rss/user/61f4b78554fb4b8fa5653ec5d924d15a", domain: "msftresearch.com" },
  { url: "https://api.xgo.ing/rss/user/771b32075fe54a83bdb6966de9647b4f", domain: "groq.com" },
  { url: "https://api.xgo.ing/rss/user/5287b4e0e13a4ab7ab7b1d56f9d88960", domain: "cursor.so" },
  { url: "https://api.xgo.ing/rss/user/4a8273800ed34a069eecdb6c5c1b9ccf", domain: "windsurf.com" },
  { url: "https://api.xgo.ing/rss/user/760ab7cd9708452c9ce1f9144b92a430", domain: "bolt.new" },

  // === Dev Tools（12个） ===
  { url: "https://api.xgo.ing/rss/user/862fee50a745423c87e2633b274caf1d", domain: "langchain.com" },
  { url: "https://api.xgo.ing/rss/user/67e259bd5be544ce84bbc867eace54c2", domain: "llamaindex.ai" },
  { url: "https://api.xgo.ing/rss/user/6326c63a2dfa445bbde88bea0c3112c2", domain: "ollama.com" },
  { url: "https://api.xgo.ing/rss/user/c04abb206bbf4f91b22795024d6c0614", domain: "firecrawl.dev" },
  { url: "https://api.xgo.ing/rss/user/b8d7530f0b294405825013bbc1cc198f", domain: "browseruse.dev" },
  { url: "https://api.xgo.ing/rss/user/e503a90c035c4b1d8f8dd34907d15bf4", domain: "openrouter.ai" },
  { url: "https://api.xgo.ing/rss/user/22af005b21ec45b1a4503acca777b7f0", domain: "aisdk.dev" },
  { url: "https://api.xgo.ing/rss/user/42e6b4901b97498eab2ab64c07d56177", domain: "deeplearning.ai" },
  { url: "https://api.xgo.ing/rss/user/fa5b15f68a2e4df1ab301e26a4ab9190", domain: "github.com" },
  { url: "https://api.xgo.ing/rss/user/f8a106a09a7d404fb8de7eb0c5ddd2a2", domain: "figma.com" },
  { url: "https://api.xgo.ing/rss/user/f97a26863aec4425b021720d4f8e4ede", domain: "notion.so" },
  { url: "https://api.xgo.ing/rss/user/221a88341acb475db221a12fed8208d0", domain: "notebooklm.google" },

  // === AI 研究与新闻（16个） ===
  { url: "https://research.google/blog/rss/", domain: "research.google" },
  { url: "https://www.nasdaq.com/feed/rssoutbound?category=Artificial+Intelligence", domain: "nasdaq.com" },
  { url: "https://www.wired.com/feed/tag/ai/latest/rss", domain: "wired.com" },
  { url: "https://www.theguardian.com/technology/artificialintelligenceai/rss", domain: "theguardian.com" },
  { url: "https://machinelearningmastery.com/blog/feed/", domain: "machinelearningmastery.com" },
  { url: "https://github.com/Hannibal046/Awesome-LLM/commits.atom", domain: "awesome-llm" },
  { url: "https://huggingface.co/blog/feed.xml", domain: "huggingface.co/blog" },
  { url: "https://github.com/teodorgross/awesome-ai/commits/main.atom", domain: "awesome-ai" },
  { url: "https://deepmind.google/blog/rss.xml", domain: "deepmind.google" },
  { url: "https://openai.com/news/rss.xml", domain: "openai.com/news" },
  { url: "https://raw.githubusercontent.com/Olshansk/rss-feeds/main/feeds/feed_anthropic_news.xml", domain: "anthropic.news" },
  { url: "https://raw.githubusercontent.com/Olshansk/rss-feeds/main/feeds/feed_anthropic_research.xml", domain: "anthropic.research" },
  { url: "https://raw.githubusercontent.com/Olshansk/rss-feeds/main/feeds/feed_anthropic_engineering.xml", domain: "anthropic.engineering" },
  { url: "https://www.microsoft.com/en-us/research/feed/", domain: "microsoft.research" },

  // === 微信公众号 RSS 源（53个） ===
  { url: "https://decemberpei.cyou/rssbox/wechat-jiqizhixin.xml", domain: "jiqizhixin" },
  { url: "https://decemberpei.cyou/rssbox/wechat-liangziwei.xml", domain: "liangziwei" },
  { url: "https://decemberpei.cyou/rssbox/wechat-xinzhiyuan.xml", domain: "xinzhiyuan" },
  { url: "https://decemberpei.cyou/rssbox/wechat-shenkeji.xml", domain: "shenkeji" },
  { url: "https://decemberpei.cyou/rssbox/wechat-aiqianxian.xml", domain: "aiqianxian" },
  { url: "https://decemberpei.cyou/rssbox/wechat-xixiaoyaokejishuo.xml", domain: "xixiaoyaokejishuo" },
  { url: "https://decemberpei.cyou/rssbox/wechat-paperweekly.xml", domain: "paperweekly" },
  { url: "https://decemberpei.cyou/rssbox/wechat-jisuanjishijuelife.xml", domain: "jisuanjishijuelife" },
  { url: "https://decemberpei.cyou/rssbox/wechat-jizhijvlebu.xml", domain: "jizhijvlebu" },
  { url: "https://decemberpei.cyou/rssbox/wechat-jiaziguangnian.xml", domain: "jiaziguangnian" },
  { url: "https://decemberpei.cyou/rssbox/wechat-haiwaidujiaoshou.xml", domain: "haiwaidujiaoshou" },
  { url: "https://decemberpei.cyou/rssbox/wechat-datafuntalk.xml", domain: "datafuntalk" },
  { url: "https://decemberpei.cyou/rssbox/wechat-lingruizhixin.xml", domain: "lingruizhixin" },
  { url: "https://decemberpei.cyou/rssbox/wechat-zhejiangtulingsuanliyanjiusuo.xml", domain: "zhejiangtulingsuanliyanjiusuo" },
  { url: "https://decemberpei.cyou/rssbox/wechat-founderpark.xml", domain: "founderpark" },
  { url: "https://decemberpei.cyou/rssbox/wechat-gaogongzhinengqiche.xml", domain: "gaogongzhinengqiche" },
  { url: "https://decemberpei.cyou/rssbox/wechat-caozdemengyi.xml", domain: "caozdemengyi" },
  { url: "https://decemberpei.cyou/rssbox/wechat-lxianshengshuo.xml", domain: "lxianshengshuo" },
  { url: "https://decemberpei.cyou/rssbox/wechat-caobianwangshi.xml", domain: "caobianwangshi" },
  { url: "https://decemberpei.cyou/rssbox/wechat-mengyan.xml", domain: "mengyan" },
  { url: "https://decemberpei.cyou/rssbox/wechat-liurun.xml", domain: "liurun" },
  { url: "https://decemberpei.cyou/rssbox/wechat-huigeqitan.xml", domain: "huigeqitan" },
  { url: "https://decemberpei.cyou/rssbox/wechat-warfalcon.xml", domain: "warfalcon" },
  { url: "https://decemberpei.cyou/rssbox/wechat-yushuzhilan.xml", domain: "yushuzhilan" },
  { url: "https://decemberpei.cyou/rssbox/wechat-jiubian.xml", domain: "jiubian" },
  { url: "https://decemberpei.cyou/rssbox/wechat-yetanqian.xml", domain: "yetanqian" },
  { url: "https://decemberpei.cyou/rssbox/wechat-kesozenmekan.xml", domain: "kesozenmekan" },
  { url: "https://decemberpei.cyou/rssbox/wechat-lanxi.xml", domain: "lanxi" },
  { url: "https://decemberpei.cyou/rssbox/wechat-renrendoushichanpinjingli.xml", domain: "renrendoushichanpinjingli" },
  { url: "https://decemberpei.cyou/rssbox/wechat-hulianwangguaidaotuan.xml", domain: "hulianwangguaidaotuan" },
  { url: "https://decemberpei.cyou/rssbox/wechat-luanfanshu.xml", domain: "luanfanshu" },
  { url: "https://decemberpei.cyou/rssbox/wechat-liuyanfeiyu.xml", domain: "liuyanfeiyu" },
  { url: "https://decemberpei.cyou/rssbox/wechat-chanpinquanshe.xml", domain: "chanpinquanshe" },
  { url: "https://decemberpei.cyou/rssbox/wechat-infoq.xml", domain: "infoq" },
  { url: "https://decemberpei.cyou/rssbox/wechat-aliyunkaifazhe.xml", domain: "aliyunkaifazhe" },
  { url: "https://decemberpei.cyou/rssbox/wechat-tengxunjishugongcheng.xml", domain: "tengxunjishugongcheng" },
  { url: "https://decemberpei.cyou/rssbox/wechat-qianduanzhidian.xml", domain: "qianduanzhidian" },
  { url: "https://decemberpei.cyou/rssbox/wechat-jiagoushizhilu.xml", domain: "jiagoushizhilu" },
  { url: "https://decemberpei.cyou/rssbox/wechat-githubdaily.xml", domain: "githubdaily" },
  { url: "https://decemberpei.cyou/rssbox/wechat-wandian.xml", domain: "wandian" },
  { url: "https://decemberpei.cyou/rssbox/wechat-36ke.xml", domain: "36ke" },
  { url: "https://decemberpei.cyou/rssbox/wechat-sanliukepro.xml", domain: "sanliukepro" },
  { url: "https://decemberpei.cyou/rssbox/wechat-huxiuapp.xml", domain: "huxiuapp" },
  { url: "https://decemberpei.cyou/rssbox/wechat-jikegongyuan.xml", domain: "jikegongyuan" },
  { url: "https://decemberpei.cyou/rssbox/wechat-shaoshupai.xml", domain: "shaoshupai" },
  { url: "https://decemberpei.cyou/rssbox/wechat-appso.xml", domain: "appso" },
  { url: "https://decemberpei.cyou/rssbox/wechat-anfaner.xml", domain: "anfaner" },
  { url: "https://decemberpei.cyou/rssbox/wechat-chaping.xml", domain: "chaping" },
  { url: "https://decemberpei.cyou/rssbox/wechat-taimeiti.xml", domain: "taimeiti" },
  { url: "https://decemberpei.cyou/rssbox/wechat-huaerjiejianwen.xml", domain: "huaerjiejianwen" },
  { url: "https://decemberpei.cyou/rssbox/wechat-caijingzazhi.xml", domain: "caijingzazhi" },
  { url: "https://decemberpei.cyou/rssbox/wechat-diyicaijing.xml", domain: "diyicaijing" },
  { url: "https://decemberpei.cyou/rssbox/wechat-jingweichuangtou.xml", domain: "jingweichuangtou" },
  { url: "https://decemberpei.cyou/rssbox/wechat-hongshanhui.xml", domain: "hongshanhui" },
  { url: "https://decemberpei.cyou/rssbox/wechat-sierzhangjing.xml", domain: "sierzhangjing" },
  { url: "https://decemberpei.cyou/rssbox/wechat-chuanyuanyouzipinglun.xml", domain: "chuanyuanyouzipinglun" },
  { url: "https://decemberpei.cyou/rssbox/wechat-zepinghongguanzhanwang.xml", domain: "zepinghongguanzhanwang" },

  // === 财经资讯 ===
  { url: "https://www.spglobal.com/content/spglobal/energy/us/en/rss/metals.xml", domain: "spglobal-metals", sourceCategory: "financial_news" },
  { url: "https://www.spglobal.com/content/spglobal/energy/us/en/rss/coal.xml", domain: "spglobal-coal", sourceCategory: "financial_news" },
  { url: "https://www.commodity-tv.com/ondemand/channel/copper/rss.xml", domain: "commodity-tv-copper", sourceCategory: "financial_news" },
  { url: "https://economictimes.indiatimes.com/markets/commodities/rssfeeds/1808152121.cms", domain: "economictimes", sourceCategory: "financial_news" },
  { url: "https://cmi-gold-silver.com/feed/", domain: "cmi-gold-silver", sourceCategory: "financial_news" },
  { url: "https://oilprice.com/rss/main", domain: "oilprice.com", sourceCategory: "financial_news" },
  { url: "https://www.nasdaq.com/feed/rssoutbound?category=Technology", domain: "nasdaq-tech", sourceCategory: "financial_news" },
  { url: "https://www.nasdaq.com/feed/rssoutbound?category=Stocks", domain: "nasdaq-stocks", sourceCategory: "financial_news" },
  { url: "https://www.nasdaq.com/feed/nasdaq-original/rss.xml", domain: "nasdaq-original", sourceCategory: "financial_news" },
  { url: "https://seekingalpha.com/feed.xml", domain: "seekingalpha.com", sourceCategory: "financial_news" },
  { url: "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss", domain: "cnbc.com", sourceCategory: "financial_news" },
  { url: "https://feeds.content.dowjones.io/public/rss/mw_topstories", domain: "marketwatch.com", sourceCategory: "financial_news" },
  { url: "http://finance.ifeng.com/rss/headnews.xml", domain: "ifeng-finance", sourceCategory: "financial_news" },
  { url: "http://finance.ifeng.com/rss/stocknews.xml", domain: "ifeng-stock", sourceCategory: "financial_news" },

  // === 科技媒体 ===
  { url: "https://feeds.arstechnica.com/arstechnica/index/", domain: "arstechnica.com", sourceCategory: "tech_news" },
  { url: "https://sspai.com/feed", domain: "sspai.com", sourceCategory: "tech_news" },
  { url: "https://www.wired.com/feed/rss", domain: "wired.com/all", sourceCategory: "tech_news" },
  { url: "https://techcrunch.com/feed/", domain: "techcrunch.com", sourceCategory: "tech_news" },
  { url: "https://www.theverge.com/rss/index.xml", domain: "theverge.com", sourceCategory: "tech_news" },
  { url: "https://www.huxiu.com/rss/0.xml", domain: "huxiu.com", sourceCategory: "tech_news" },
  { url: "https://36kr.com/feed", domain: "36kr.com", sourceCategory: "tech_news" },

  // === 时事新闻 ===
  { url: "https://rsshub.app/latepost", domain: "latepost.com", sourceCategory: "current_affairs_news" },
  { url: "https://www.chinanews.com.cn/rss/world.xml", domain: "chinanews-world", sourceCategory: "current_affairs_news" },
  { url: "https://www.reutersagency.com/en/reutersbest/reuters-best-rss-feeds/", domain: "reuters.com", sourceCategory: "current_affairs_news" },
  { url: "https://feeds.bbci.co.uk/news/world/rss.xml", domain: "bbc.com", sourceCategory: "current_affairs_news" },
  { url: "https://www.chinanews.com.cn/rss/china.xml", domain: "chinanews-china", sourceCategory: "current_affairs_news" },
];

// ============================================================================
// 高质量源域名（用于 preScore 加分和描述长度豁免）
// ============================================================================

const premiumSources = [
  "simonwillison.net", "jvns.ca", "pragmaticengineer.com",
  "microsoft.research", "huggingface.co/blog", "deepmind.google",
  "openai.com/news", "anthropic.news", "anthropic.research",
  "anthropic.engineering", "research.google", "krebsonsecurity.com",
  "schneier.com", "ruanyifeng.com", "qbitai.com", "fasterthanli.me",
  "matklad.github.io", "tonsky.me", "lemire.me", "drewdevault.com",
  "brendangregg.com", "martinfowler.com", "research.swtch.com",
  // 财经与科技媒体
  "cnbc.com", "marketwatch.com", "arstechnica.com", "techcrunch.com",
  "theverge.com", "bbc.com", "sspai.com", "huxiu.com", "36kr.com",
  "latepost.com",
];

// ============================================================================
// 预评分函数（规则化，不使用 AI）
// ============================================================================

function preScore(item: FeedItem): number {
  let score = 0;
  const text = (item.title + " " + item.description).toLowerCase();

  // 技术信号词加分（每命中一个 +2，最多 +10）
  const techSignals = [
    // 技术信号
    "api", "llm", "agent", "benchmark", "open source", "framework",
    "architecture", "security", "vulnerability", "performance",
    "kubernetes", "docker", "rust", "typescript", "python",
    "database", "compiler", "distributed", "concurrency", "algorithm",
    "gpu", "inference", "fine-tuning", "rag", "embedding",
    "transformer", "diffusion", "neural", "training", "model",
    "开源", "漏洞", "架构", "性能", "模型", "训练", "推理",
    "框架", "算法", "部署", "微调", "向量", "数据库",
    // 财经信号
    "stock", "market", "trading", "commodity", "earnings", "financial",
    "nasdaq", "s&p", "fed", "gdp", "ipo", "merger", "acquisition",
    "金融", "股票", "市场", "商品", "原油", "黄金", "期货",
    "财报", "收购", "上市", "融资", "估值",
    // 新闻信号
    "breaking", "regulation", "policy", "geopolitical",
    "突发", "重大", "监管", "政策", "制裁",
  ];
  let techHits = 0;
  for (const kw of techSignals) {
    if (text.includes(kw)) techHits++;
  }
  score += Math.min(techHits * 2, 10);

  // 描述长度加分
  if (item.description.length > 200) score += 2;
  if (item.description.length > 400) score += 1;

  // 高质量源域名加分 +3
  if (premiumSources.includes(item.source)) score += 3;

  // 纯链接/无描述的推文扣分
  if (item.description.length < 60) score -= 5;

  // 非技术信号词扣分
  const noiseSignals = ["小龙虾", "旅游", "美食", "养生", "星座", "娱乐八卦", "追剧", "减肥"];
  for (const kw of noiseSignals) {
    if (text.includes(kw)) score -= 5;
  }

  return score;
}

// ============================================================================
// XML 解析（零依赖）
// ============================================================================

function extractTag(xml: string, tag: string): string {
  const cdataRe = new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`, "i");
  const cdataMatch = xml.match(cdataRe);
  if (cdataMatch) return cdataMatch[1].trim();

  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const match = xml.match(re);
  return match ? match[1].trim().replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1") : "";
}

function extractAttr(xml: string, tag: string, attr: string): string {
  const re = new RegExp(`<${tag}[^>]*${attr}="([^"]*)"`, "i");
  const match = xml.match(re);
  return match ? match[1] : "";
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseDate(dateStr: string): Date {
  if (!dateStr) return new Date(0);
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? new Date(0) : d;
}

function relativeTime(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const diffH = Math.floor(diffMs / (1000 * 60 * 60));
  if (diffH < 1) return "刚刚";
  if (diffH < 24) return `${diffH} 小时前`;
  const diffD = Math.floor(diffH / 24);
  return `${diffD} 天前`;
}

function parseFeed(xml: string, sourceDomain: string, sourceCategory: string): FeedItem[] {
  const items: FeedItem[] = [];

  // RSS 2.0
  const rssItems = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
  for (const itemXml of rssItems) {
    const title = stripHtml(extractTag(itemXml, "title"));
    const link = extractTag(itemXml, "link") || extractAttr(itemXml, "link", "href");
    const pubDate = parseDate(extractTag(itemXml, "pubDate") || extractTag(itemXml, "dc:date"));
    const description = stripHtml(
      extractTag(itemXml, "description") || extractTag(itemXml, "content:encoded")
    ).slice(0, 500);

    if (title && link) {
      items.push({
        title, link,
        pubDate: pubDate.toISOString(),
        pubDateRelative: relativeTime(pubDate),
        description, source: sourceDomain,
        sourceCategory,
        preScore: 0,
      });
    }
  }

  // Atom
  if (items.length === 0) {
    const atomEntries = xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
    for (const entryXml of atomEntries) {
      const title = stripHtml(extractTag(entryXml, "title"));
      const link =
        extractAttr(entryXml, 'link[rel="alternate"]', "href") ||
        extractAttr(entryXml, "link", "href");
      const pubDate = parseDate(
        extractTag(entryXml, "published") || extractTag(entryXml, "updated")
      );
      const description = stripHtml(
        extractTag(entryXml, "summary") || extractTag(entryXml, "content")
      ).slice(0, 500);

      if (title && link) {
        items.push({
          title, link,
          pubDate: pubDate.toISOString(),
          pubDateRelative: relativeTime(pubDate),
          description, source: sourceDomain,
          sourceCategory,
          preScore: 0,
        });
      }
    }
  }

  return items;
}

// ============================================================================
// 并发控制
// ============================================================================

async function pooled<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      try { results[i] = await fn(items[i]); }
      catch { results[i] = undefined as any; }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  );
  return results;
}

// ============================================================================
// 抓取
// ============================================================================

async function fetchFeed(
  feed: { url: string; domain: string; sourceCategory?: string },
  timeout: number
): Promise<FeedItem[]> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const res = await fetch(feed.url, {
      signal: controller.signal,
      headers: { "User-Agent": "RSS-Tech-Digest/2.0" },
    });
    clearTimeout(timer);
    if (!res.ok) return [];
    const xml = await res.text();
    return parseFeed(xml, feed.domain, feed.sourceCategory || "tech_blog");
  } catch {
    return [];
  }
}

// ============================================================================
// 主流程
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      const val = args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : "true";
      flags[key] = val;
      if (val !== "true") i++;
    }
  }

  if (flags.help) {
    console.log(`
RSS Tech Digest v2 — RSS 抓取与数据处理（含预评分过滤）

用法: bun run rss-digest.ts [选项]
      npx tsx rss-digest.ts [选项]

选项:
  --hours <N>              时间窗口，小时（默认: 48）
  --output <file>          输出 JSON 文件路径（默认: stdout）
  --concurrency <N>        并发数（默认: 10）
  --timeout <ms>           单源超时毫秒数（默认: 15000）
  --top <N>                预评分后保留的文章数（默认: 80）
  --min-desc-length <N>    最短描述长度（默认: 60）
  --help                   显示帮助

输出 JSON 结构:
  {
    totalFeeds, successFeeds, failedFeeds,
    totalArticles, filteredByTime, filteredByPreScore,
    hoursWindow, fetchedAt,
    articles: [{ title, link, pubDate, pubDateRelative, description, source, preScore }]
  }
`);
    process.exit(0);
  }

  const hoursWindow = parseInt(flags.hours || "48");
  const concurrency = parseInt(flags.concurrency || "10");
  const timeout = parseInt(flags.timeout || "15000");
  const outputFile = flags.output || "";
  const topN = parseInt(flags.top || "80");
  const minDescLength = parseInt(flags["min-desc-length"] || "60");

  console.error(`📡 抓取 ${RSS_FEEDS.length} 个 RSS 源（${concurrency} 路并发, ${timeout / 1000}s 超时）...`);

  // 抓取
  const allResults = await pooled(RSS_FEEDS, concurrency, (feed) => fetchFeed(feed, timeout));

  const allItems: FeedItem[] = [];
  let successCount = 0;
  for (const items of allResults) {
    if (items && items.length > 0) {
      successCount++;
      allItems.push(...items);
    }
  }

  console.error(`✅ 成功 ${successCount}/${RSS_FEEDS.length} 个源, 共 ${allItems.length} 篇`);

  // 时间过滤
  const cutoff = new Date(Date.now() - hoursWindow * 60 * 60 * 1000);
  let filtered = allItems.filter((item) => new Date(item.pubDate) > cutoff);
  console.error(`🕐 时间过滤（${hoursWindow}h）: ${allItems.length} → ${filtered.length} 篇`);

  // 如果太少，自动扩大
  if (filtered.length < 5) {
    const expanded = hoursWindow * 2;
    const cutoff2 = new Date(Date.now() - expanded * 60 * 60 * 1000);
    filtered = allItems.filter((item) => new Date(item.pubDate) > cutoff2);
    console.error(`⚠️ 文章不足, 扩大至 ${expanded}h: ${filtered.length} 篇`);
  }

  if (filtered.length === 0) {
    console.error("⚠️ 过滤后无文章, 使用全部已抓取文章");
    filtered = allItems;
  }

  // 去重（按 link）
  const seen = new Set<string>();
  filtered = filtered.filter((item) => {
    if (seen.has(item.link)) return false;
    seen.add(item.link);
    return true;
  });

  // 过滤最短描述长度（高质量源即使描述短也保留）
  filtered = filtered.filter(
    (item) => item.description.length >= minDescLength || premiumSources.includes(item.source)
  );

  // 计算预评分
  for (const item of filtered) {
    item.preScore = preScore(item);
  }

  // 按预评分降序排序
  filtered.sort((a, b) => b.preScore - a.preScore);

  const filteredByTime = filtered.length; // 记录时间过滤 + 去重 + 描述长度过滤后数量

  // 截取 top N
  const beforeTop = filtered.length;
  if (filtered.length > topN) {
    filtered = filtered.slice(0, topN);
  }

  console.error(`🎯 预评分过滤: ${beforeTop} → ${filtered.length} 篇 (top ${topN})`);
  console.error(`📦 最终输出: ${filtered.length} 篇文章`);

  const result: FetchResult = {
    totalFeeds: RSS_FEEDS.length,
    successFeeds: successCount,
    failedFeeds: RSS_FEEDS.length - successCount,
    totalArticles: allItems.length,
    filteredByTime: filteredByTime,
    filteredByPreScore: filtered.length,
    hoursWindow,
    fetchedAt: new Date().toISOString(),
    articles: filtered,
  };

  const json = JSON.stringify(result, null, 2);

  if (outputFile) {
    writeFileSync(outputFile, json);
    console.error(`💾 已写入: ${outputFile} (${(Buffer.byteLength(json) / 1024).toFixed(1)} KB)`);
  } else {
    // 输出到 stdout，进度日志已走 stderr
    console.log(json);
  }
}

main().catch((e) => {
  console.error("❌ 致命错误:", e);
  process.exit(1);
});
