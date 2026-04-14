import { Hono } from 'hono';
import { closeSessionDatabase, getSessionDatabase } from '../../infra/database/session-db';
import { ClaudeAgentBridge } from '../kernel/agents/claude-agent-bridge';
import { LightLLMClient } from '../kernel/agents/light-llm-client';
import { CentralController } from '../kernel/central-controller';
import { TaskClassifier } from '../kernel/classifier/task-classifier';
import { SessionStore } from '../kernel/memory/session-store';
import { TaskStore } from '../kernel/tasking/task-store';
import { WorkspaceManager } from '../kernel/workspace';
import { Logger } from '../shared/logging/logger';
import type { ChannelType } from '../shared/messaging';
import { isValidBotMessage } from '../shared/utils/validators';
import { ChannelManager } from './channel-manager';
import { FeishuStreamAdapter } from './channels/adapters/feishu-stream-adapter';
import { FeishuCardKitClient } from './channels/feishu-cardkit-client';
import { FeishuChannel } from './channels/feishu.gateway';
import { TelegramChannel } from './channels/telegram.gateway';
import { WebChannel } from './channels/web.gateway';
import { MessageRouter } from './message-router';
import {
  createApiAuthMiddleware,
  createApiRateLimitMiddleware,
  createAuthMiddleware,
  createRateLimitMiddleware,
  createTransformMiddleware,
  createWebSocketAuthHandler,
} from './middleware';

const app = new Hono();
const logger = new Logger('Gateway');
const port = Number(process.env.PORT) || 3000;
const wsPort = Number(process.env.WS_PORT) || 3001;

// --- Bootstrap LLM clients ---

function bootstrapClaudeBridge(): ClaudeAgentBridge | undefined {
  const claudePath = process.env.CLAUDE_PATH ?? 'claude';
  const model = process.env.CLAUDE_MODEL ?? 'sonnet';
  logger.info('Claude Code Bridge 初始化', { claudePath, model });
  return new ClaudeAgentBridge({ claudePath, defaultModel: model });
}

function bootstrapLightLLM(): LightLLMClient | undefined {
  const apiKey = process.env.LIGHT_LLM_API_KEY;
  if (!apiKey) {
    logger.info('LightLLM 跳过: 缺少 LIGHT_LLM_API_KEY');
    return undefined;
  }
  logger.info('LightLLM 初始化', {
    baseUrl: process.env.LIGHT_LLM_BASE_URL ?? 'https://api.openai.com/v1',
    model: process.env.LIGHT_LLM_MODEL ?? 'gpt-4o-mini',
  });
  return new LightLLMClient();
}

// --- Create core instances ---

const claudeBridge = bootstrapClaudeBridge();
const lightLLM = bootstrapLightLLM();
const classifier = new TaskClassifier(lightLLM);
const workspaceManager = new WorkspaceManager();

// Initialize session database and persistence stores
const sessionDb = getSessionDatabase();
const sessionStore = new SessionStore(sessionDb);
const taskStore = new TaskStore(sessionDb);

// Mark any tasks that were 'running' in a previous process as interrupted
const interrupted = taskStore.markInterruptedOnStartup();
if (interrupted > 0) {
  logger.warn(`Marked ${interrupted} running tasks as interrupted on startup`);
}

// Create controller first (singleton), channelResolver will be set after channelManager is created
const controller = CentralController.getInstance({
  claudeBridge,
  lightLLM,
  classifier,
  workspaceManager,
  sessionStore,
  taskStore,
});

const router = new MessageRouter(controller);

// --- Middleware pipeline ---
const middlewarePipeline = [
  createAuthMiddleware(),
  createRateLimitMiddleware(),
  createTransformMiddleware(),
];
const channelManager = new ChannelManager(router, middlewarePipeline);

// Wire channelResolver now that channelManager exists
controller.setChannelResolver((channelType: string) =>
  channelManager.getChannel(channelType as ChannelType),
);

// Initialize scheduler (loads persisted jobs, wires executor, starts timers)
controller.initScheduler().catch((error) => {
  logger.error('Scheduler 初始化失败', {
    error: error instanceof Error ? error.message : String(error),
  });
});

// Wire response dispatcher: routes responses back through channels
router.setResponseDispatcher(async (channel: ChannelType, userId: string, content) => {
  const ch = channelManager.getChannel(channel);
  if (ch) {
    await ch.sendMessage(userId, content);
  } else {
    logger.warn('响应分发: 通道未找到', { channel, userId });
  }
});

// --- HTTP routes ---

app.get('/health', async (c) => {
  const channelHealth = await channelManager.healthCheck();
  return c.json({
    status: channelHealth.status,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    channels: channelHealth.details,
    registeredChannels: channelManager.getRegisteredTypes(),
    llm: {
      claude: claudeBridge ? 'enabled' : 'disabled',
      lightLLM: lightLLM ? 'enabled' : 'disabled',
    },
  });
});

// API auth & rate-limit middleware
app.use('/api/messages', createApiAuthMiddleware());
app.use('/api/messages', createApiRateLimitMiddleware());

app.post('/api/messages', async (c) => {
  const body = await c.req.json();

  if (!isValidBotMessage(body)) {
    return c.json({ success: false, error: 'Invalid message format' }, 400);
  }

  try {
    const result = await controller.handleIncomingMessage(body);
    return c.json({ success: true, data: result.data });
  } catch (error) {
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      500,
    );
  }
});

// Serve debug page
app.get('/debug', (c) => {
  return c.html(DEBUG_PAGE_HTML);
});

// --- Channel registration ---

const enabledChannels = new Set(
  (process.env.ENABLED_CHANNELS ?? 'feishu')
    .split(',')
    .map((ch) => ch.trim().toLowerCase())
    .filter(Boolean),
);

async function registerChannels(): Promise<void> {
  logger.info('启用通道', { channels: Array.from(enabledChannels) });

  // Feishu
  if (enabledChannels.has('feishu')) {
    const feishuAppId = process.env.FEISHU_APP_ID;
    const feishuAppSecret = process.env.FEISHU_APP_SECRET;
    if (feishuAppId && feishuAppSecret) {
      try {
        await channelManager.registerChannel(
          new FeishuChannel({ appId: feishuAppId, appSecret: feishuAppSecret }),
        );
        logger.info('飞书通道已注册');
      } catch (error) {
        logger.error('飞书通道注册失败', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } else {
      logger.warn('飞书通道已启用但缺少 FEISHU_APP_ID / FEISHU_APP_SECRET');
    }
  }

  // Telegram
  if (enabledChannels.has('telegram')) {
    const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
    if (telegramToken) {
      try {
        await channelManager.registerChannel(new TelegramChannel({ botToken: telegramToken }));
        logger.info('Telegram 通道已注册');
      } catch (error) {
        logger.error('Telegram 通道注册失败', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } else {
      logger.warn('Telegram 通道已启用但缺少 TELEGRAM_BOT_TOKEN');
    }
  }

  // Web
  if (enabledChannels.has('web')) {
    try {
      await channelManager.registerChannel(
        new WebChannel({ port: wsPort, path: '/ws', wsAuthHandler: createWebSocketAuthHandler() }),
      );
      logger.info('Web 通道已注册', { wsPort });
    } catch (error) {
      logger.error('Web 通道注册失败', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

// --- Graceful shutdown ---

function setupGracefulShutdown(): void {
  const shutdown = async (signal: string) => {
    logger.info(`收到 ${signal} 信号，正在关闭...`);
    controller.stopScheduler();
    await channelManager.shutdownAll();
    await controller.shutdown();
    CentralController.resetInstance();
    closeSessionDatabase();
    logger.info('所有通道已关闭，进程退出');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// --- Debug page ---

const DEBUG_PAGE_HTML = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>YourBot Debug</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, system-ui, sans-serif; background: #1a1a2e; color: #eee; height: 100vh; display: flex; flex-direction: column; }
header { padding: 12px 20px; background: #16213e; border-bottom: 1px solid #333; display: flex; align-items: center; gap: 12px; }
header h1 { font-size: 16px; font-weight: 600; }
#status { font-size: 12px; padding: 2px 8px; border-radius: 10px; }
.connected { background: #2d6a4f; }
.disconnected { background: #9b2226; }
#chat { flex: 1; overflow-y: auto; padding: 20px; display: flex; flex-direction: column; gap: 12px; }
.msg { max-width: 80%; padding: 10px 14px; border-radius: 12px; font-size: 14px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
.msg.user { align-self: flex-end; background: #0077b6; }
.msg.bot { align-self: flex-start; background: #2a2a4a; border: 1px solid #444; }
.msg.system { align-self: center; background: transparent; color: #888; font-size: 12px; }
#input-bar { padding: 12px 20px; background: #16213e; border-top: 1px solid #333; display: flex; gap: 8px; }
#input { flex: 1; padding: 10px 14px; border-radius: 8px; border: 1px solid #444; background: #1a1a2e; color: #eee; font-size: 14px; outline: none; }
#input:focus { border-color: #0077b6; }
#send { padding: 10px 20px; border-radius: 8px; border: none; background: #0077b6; color: #fff; font-size: 14px; cursor: pointer; }
#send:hover { background: #005f99; }
#send:disabled { background: #444; cursor: not-allowed; }
</style>
</head>
<body>
<header>
  <h1>YourBot Debug Console</h1>
  <span id="status" class="disconnected">Disconnected</span>
</header>
<div id="chat"></div>
<div id="input-bar">
  <input id="input" placeholder="输入消息..." autocomplete="off" />
  <button id="send">发送</button>
</div>
<script>
const chat = document.getElementById('chat');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send');
const status = document.getElementById('status');
let ws;

function addMsg(text, cls) {
  const div = document.createElement('div');
  div.className = 'msg ' + cls;
  div.textContent = text;
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
  return div;
}

function connect() {
  const wsUrl = 'ws://' + location.hostname + ':${wsPort}/ws?userId=debug_user';
  ws = new WebSocket(wsUrl);
  ws.onopen = () => {
    status.textContent = 'Connected';
    status.className = 'connected';
    addMsg('WebSocket 已连接 (' + wsUrl + ')', 'system');
  };
  ws.onclose = () => {
    status.textContent = 'Disconnected';
    status.className = 'disconnected';
    addMsg('连接断开，3秒后重连...', 'system');
    setTimeout(connect, 3000);
  };
  ws.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.type === 'connected') {
        addMsg('Session: ' + data.connectionId, 'system');
      } else if (data.type === 'message') {
        const text = data.data?.text ?? JSON.stringify(data.data);
        addMsg(text, 'bot');
        sendBtn.disabled = false;
      } else if (data.type === 'stream') {
        // Handle streaming chunks
        let last = chat.querySelector('.msg.bot.streaming');
        if (!last) {
          last = addMsg('', 'bot');
          last.classList.add('streaming');
        }
        if (data.data?.type === 'text_delta') {
          last.textContent += data.data.text;
          chat.scrollTop = chat.scrollHeight;
        } else if (data.data?.type === 'done') {
          last.classList.remove('streaming');
          sendBtn.disabled = false;
        }
      } else if (data.type === 'error') {
        addMsg('错误: ' + (data.message || JSON.stringify(data)), 'system');
        sendBtn.disabled = false;
      }
    } catch { addMsg(e.data, 'bot'); }
  };
}

function send() {
  const text = input.value.trim();
  if (!text || !ws || ws.readyState !== 1) return;
  addMsg(text, 'user');
  ws.send(JSON.stringify({ content: text }));
  input.value = '';
  sendBtn.disabled = true;
}

input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
sendBtn.addEventListener('click', send);
connect();
</script>
</body>
</html>`;

// --- Bootstrap ---

logger.info('Gateway 启动中', { port, wsPort });
logger.info('LLM 配置', {
  claude: claudeBridge ? 'enabled' : 'disabled',
  lightLLM: lightLLM ? 'enabled' : 'disabled',
});

registerChannels()
  .then(() => {
    // Inject streamAdapterFactory after channels are registered
    const feishuChannel = channelManager.getChannel('feishu') as FeishuChannel | undefined;
    if (feishuChannel) {
      const cardKitClient = new FeishuCardKitClient(feishuChannel.getClient());

      // DD-021: Wire placeholder sender for Feishu channel
      controller.setPlaceholderSender((chatId) => cardKitClient.sendPlaceholder(chatId));

      controller.setStreamAdapterFactory((userId, channel, conversationId, options) => {
        if (channel === 'feishu') {
          return [
            new FeishuStreamAdapter(
              conversationId,
              {
                createStreamingCard: (text) => cardKitClient.createStreamingCard(text),
                sendCardMessage: (chatId, cardId) => cardKitClient.sendCardMessage(chatId, cardId),
                streamUpdateText: (cardId, elemId, text, seq) =>
                  cardKitClient.streamUpdateText(cardId, elemId, text, seq),
                closeStreamingMode: (cardId, seq) => cardKitClient.closeStreamingMode(cardId, seq),
                addActionButtons: (cardId, afterId, btns, seq) =>
                  cardKitClient.addActionButtons(cardId, afterId, btns, seq),
                sendTextMessage: (_chatId, text) =>
                  feishuChannel.sendMessage(userId, { type: 'text', text }),
              },
              300,
              options?.existingCardId,
            ),
          ];
        }
        return [];
      });
      logger.info('飞书 CardKit 流式适配器已注入');
    }
  })
  .catch((error) => {
    logger.error('通道注册异常', {
      error: error instanceof Error ? error.message : String(error),
    });
  });
setupGracefulShutdown();

export { channelManager, router };

// Explicit Bun.serve() for PM2 compatibility
// (Bun's export-default auto-serve only works when running the file directly)
const server = Bun.serve({
  port,
  fetch: app.fetch,
});

logger.info('HTTP 服务已启动', { port: server.port });

export default server;
