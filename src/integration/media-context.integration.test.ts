/**
 * 集成测试: 多轮图片上下文保持
 *
 * 验证场景: 用户先发图片 → 再发文字追问 → AI 能看到之前的图片
 *
 * 完整管道:
 *   handleIncomingMessage → MediaProcessor → SessionManager → AgentRuntime
 *   第1轮: 图片消息 → 下载写磁盘 → complex 路径（有附件强制 complex）→ 调用后清空 base64 → localPath 保留
 *   第2轮: 纯文字 → simple 路径 → 上下文中历史图片消息从 localPath 恢复 base64 → multimodal 构造成功
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CentralController } from '../kernel/central-controller';
import { TaskClassifier } from '../kernel/classifier/task-classifier';
import { MediaDownloader } from '../kernel/media/media-downloader';
import { MediaProcessor } from '../kernel/media/media-processor';
import type { MediaUnderstanding } from '../kernel/media/media-understanding';
import { SessionManager } from '../kernel/sessioning/session-manager';
import type { BotMessage } from '../shared/messaging';
import type { MediaAttachment } from '../shared/messaging/media-attachment.types';
import type { createMockLightLLM } from '../test-utils/mock-light-llm';
import { createMockOVDeps } from '../test-utils/mock-ov-deps';

// ── Fixtures ──

// Valid JPEG magic bytes
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Array(100).fill(0)]);

function createMessage(overrides?: Partial<BotMessage>): BotMessage {
  return {
    id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    channel: 'web',
    userId: 'user_media_test',
    userName: 'Media Tester',
    conversationId: 'conv_media',
    content: '',
    contentType: 'text',
    timestamp: Date.now(),
    metadata: {},
    ...overrides,
  };
}

describe('多轮图片上下文集成测试', () => {
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;
  let tmpUploadsDir: string;

  beforeEach(() => {
    CentralController.resetInstance();
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    tmpUploadsDir = mkdtempSync(join(tmpdir(), 'media-integ-'));
  });

  afterEach(() => {
    CentralController.resetInstance();
    logSpy.mockRestore();
    errorSpy.mockRestore();
    if (existsSync(tmpUploadsDir)) {
      rmSync(tmpUploadsDir, { recursive: true, force: true });
    }
  });

  test('先发图片再发文字，图片应持久化到磁盘，第二轮应从 localPath 恢复 multimodal', async () => {
    // 捕获 LightLLM.complete 的调用（第2轮 simple 路径）
    const capturedSimpleCalls: Array<{ messages: unknown[] }> = [];
    const lightLLM = {
      complete: mock(async (req: { messages: unknown[] }) => {
        capturedSimpleCalls.push({ messages: [...req.messages] });
        return {
          content: '看到图片了',
          model: 'deepseek-chat',
          usage: { promptTokens: 10, completionTokens: 5, totalCost: 0.001 },
        };
      }),
      stream: mock(async function* () {
        yield { content: '看到图片了', done: false };
        yield { content: '', done: true };
      }),
      getDefaultModel: () => 'deepseek-chat',
    };

    // 不传 agentBridge → 不启用 IntelligenceGateway
    // 第1轮(complex)返回占位文本，但 mediaRefs 的持久化生命周期不受影响
    // 第2轮(simple)走 LightLLM，验证从 localPath 恢复 multimodal

    // 真实 MediaDownloader（uploadsDir 由 orchestrate 的 setUploadsDir 动态设置）
    const downloader = new MediaDownloader({});
    const mockUnderstanding = {
      describeImage: async () => '一张测试图片',
    } as unknown as MediaUnderstanding;
    const mediaProcessor = new MediaProcessor({
      downloader,
      understanding: mockUnderstanding,
    });

    const sessionManager = new SessionManager();
    const classifier = new TaskClassifier(lightLLM as ReturnType<typeof createMockLightLLM>);

    const controller = CentralController.getInstance({
      lightLLM: lightLLM as ReturnType<typeof createMockLightLLM>,
      classifier,
      sessionManager,
      mediaProcessor,
      ...createMockOVDeps(),
    });

    // ── 第1轮: 发送带图片的消息（走 complex，因为 classifyIntent 对有附件的消息强制 complex）──
    const imageAttachment: MediaAttachment = {
      id: 'img_001',
      mediaType: 'image',
      state: 'pending',
      sourceRef: { channel: 'web', base64: JPEG_BYTES.toString('base64') },
    };

    const msg1 = createMessage({
      content: '看看这张图',
      attachments: [imageAttachment],
    });

    const result1 = await controller.handleIncomingMessage(msg1);
    expect(result1.success).toBe(true);

    // 验证: session 中 mediaRef 的 base64Data 已被清空，但 localPath 保留
    const sessionKey = 'user_media_test:web:conv_media';
    const recentMsgs = sessionManager.getRecentMessages(sessionKey, 5);
    const imgMsg = recentMsgs.find((m) => m.mediaRefs?.length);
    expect(imgMsg).toBeDefined();
    expect(imgMsg!.mediaRefs![0].base64Data).toBeUndefined();
    expect(imgMsg!.mediaRefs![0].localPath).toBeDefined();
    // 图片文件应存在于磁盘
    expect(existsSync(imgMsg!.mediaRefs![0].localPath!)).toBe(true);

    // ── 第2轮: 发送纯文字追问（走 simple，因为短消息命中 simple 规则）──
    const msg2 = createMessage({
      content: '啥？',
      timestamp: Date.now() + 1000,
    });

    const result2 = await controller.handleIncomingMessage(msg2);
    expect(result2.success).toBe(true);

    // 验证: 第二轮走了 LightLLM simple 路径
    expect(capturedSimpleCalls.length).toBeGreaterThanOrEqual(1);

    // 验证: 最后一次 LightLLM 调用中，历史图片消息被恢复为 multimodal
    const lastCall = capturedSimpleCalls[capturedSimpleCalls.length - 1];
    const userMsgs = lastCall.messages.filter(
      (m: unknown) => (m as { role: string }).role === 'user',
    ) as Array<{ content: unknown }>;

    // 应该有包含图片的历史消息（content 是数组，含 image_url）
    const hasMultimodal = userMsgs.some((msg) => {
      if (!Array.isArray(msg.content)) return false;
      return (msg.content as Array<{ type: string }>).some((p) => p.type === 'image_url');
    });
    expect(hasMultimodal).toBe(true);
  });

  test('无图片的纯文字多轮不应触发 multimodal 构造', async () => {
    const capturedCalls: Array<{ messages: unknown[] }> = [];
    const lightLLM = {
      complete: mock(async (req: { messages: unknown[] }) => {
        capturedCalls.push({ messages: [...req.messages] });
        return {
          content: '纯文字回复',
          model: 'deepseek-chat',
          usage: { promptTokens: 5, completionTokens: 3, totalCost: 0.0001 },
        };
      }),
      stream: mock(async function* () {
        yield { content: '', done: true };
      }),
      getDefaultModel: () => 'deepseek-chat',
    };

    const classifier = new TaskClassifier(lightLLM as ReturnType<typeof createMockLightLLM>);

    const controller = CentralController.getInstance({
      lightLLM: lightLLM as ReturnType<typeof createMockLightLLM>,
      classifier,
      ...createMockOVDeps(),
    });

    // "你好" (3 chars) 命中 simple rule: ^.{1,10}$
    await controller.handleIncomingMessage(createMessage({ content: '你好' }));
    // "天气？" (3 chars) 也命中 simple rule
    await controller.handleIncomingMessage(
      createMessage({ content: '天气？', timestamp: Date.now() + 1000 }),
    );

    // 两轮的 user 消息都应该是纯字符串
    expect(capturedCalls.length).toBeGreaterThanOrEqual(2);
    for (const call of capturedCalls) {
      const userMsgs = call.messages.filter(
        (m: unknown) => (m as { role: string }).role === 'user',
      );
      for (const msg of userMsgs) {
        const content = (msg as { content: unknown }).content;
        expect(typeof content).toBe('string');
      }
    }
  });
});
