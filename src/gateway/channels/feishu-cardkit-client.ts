import type * as lark from '@larksuiteoapi/node-sdk';
import { ERROR_CODES } from '../../shared/errors/error-codes';
import { YourBotError } from '../../shared/errors/yourbot-error';
import { Logger } from '../../shared/logging/logger';

const CONTENT_ELEMENT_ID = 'md_content';

export class FeishuCardKitClient {
  private readonly logger = new Logger('FeishuCardKitClient');

  constructor(private readonly client: lark.Client) {}

  async createStreamingCard(initialText: string, headerTitle = 'Your AI'): Promise<string> {
    const cardJson = {
      schema: '2.0',
      config: {
        streaming_mode: true,
        streaming_config: {
          print_frequency_ms: { default: 70 },
          print_step: { default: 1 },
          print_strategy: 'fast',
        },
        summary: { content: '[生成中...]' },
      },
      header: { title: { tag: 'plain_text', content: headerTitle } },
      body: {
        elements: [{ tag: 'markdown', content: initialText, element_id: CONTENT_ELEMENT_ID }],
      },
    };

    const resp = await this.client.cardkit.v1.card.create({
      data: { type: 'card_json', data: JSON.stringify(cardJson) },
    });

    const cardId = resp?.data?.card_id;
    if (!cardId) {
      throw new YourBotError(ERROR_CODES.INVALID_CHANNEL, 'CardKit create returned no card_id');
    }

    this.logger.info('流式卡片已创建', { cardId });
    return cardId;
  }

  async sendCardMessage(chatId: string, cardId: string): Promise<string> {
    const resp = await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'interactive',
        content: JSON.stringify({ type: 'card', data: { card_id: cardId } }),
      },
    });

    const messageId = (resp as Record<string, unknown>)?.data as
      | Record<string, unknown>
      | undefined;
    const msgId = (messageId?.message_id as string) ?? '';
    this.logger.info('卡片消息已发送', { chatId, cardId, messageId: msgId });
    return msgId;
  }

  async streamUpdateText(
    cardId: string,
    elementId: string,
    fullText: string,
    sequence: number,
  ): Promise<void> {
    await this.client.cardkit.v1.cardElement.content({
      data: { content: fullText, sequence },
      path: { card_id: cardId, element_id: elementId },
    });
  }

  async closeStreamingMode(cardId: string, sequence: number): Promise<void> {
    await this.client.cardkit.v1.card.settings({
      data: {
        settings: JSON.stringify({ config: { streaming_mode: false } }),
        sequence,
      },
      path: { card_id: cardId },
    });
    this.logger.info('流式模式已关闭', { cardId });
  }

  async addActionButtons(
    cardId: string,
    afterElementId: string,
    buttons: string[],
    sequence: number,
  ): Promise<void> {
    const elements = [
      {
        tag: 'action',
        actions: buttons.map((text, i) => ({
          tag: 'button',
          text: { tag: 'plain_text', content: text },
          type: 'default',
          value: { action: text },
          action_type: 'link',
          element_id: `btn_${i}`,
        })),
      },
    ];

    await this.client.cardkit.v1.cardElement.create({
      data: {
        type: 'insert_after',
        target_element_id: afterElementId,
        sequence,
        elements: JSON.stringify(elements),
      },
      path: { card_id: cardId },
    });
    this.logger.info('操作按钮已添加', { cardId, buttons });
  }
}

export { CONTENT_ELEMENT_ID };
