import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { BotMessage } from '../../shared/messaging';
import { WebChannel } from './web.gateway';

// Use a random high port to avoid conflicts
const TEST_PORT = 19876;

describe('WebChannel', () => {
  let channel: WebChannel;

  beforeEach(() => {
    channel = new WebChannel({ port: TEST_PORT, path: '/ws' });
  });

  afterEach(async () => {
    await channel.shutdown();
  });

  test('has correct type and name', () => {
    expect(channel.type).toBe('web');
    expect(channel.name).toBe('web');
  });

  test('initialize starts a WebSocket server', async () => {
    await channel.initialize();
    // Server should be running — verify with a fetch to the port
    const res = await fetch(`http://localhost:${TEST_PORT}/health`);
    expect(res.status).toBe(404); // non-ws path returns 404
  });

  test('WebSocket connection lifecycle works', async () => {
    await channel.initialize();

    const _receivedMessages: string[] = [];
    const ws = new WebSocket(`ws://localhost:${TEST_PORT}/ws?userId=test_user`);

    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = (e) => reject(e);
    });

    // Should have received connected message
    const connectedMsg = await new Promise<string>((resolve) => {
      ws.onmessage = (e) => resolve(e.data as string);
    });
    const parsed = JSON.parse(connectedMsg);
    expect(parsed.type).toBe('connected');
    expect(parsed.connectionId).toBeDefined();

    expect(channel.getConnectionCount()).toBe(1);

    ws.close();
    // Give time for close handler
    await new Promise((r) => setTimeout(r, 50));
    expect(channel.getConnectionCount()).toBe(0);
  });

  test('incoming WebSocket messages are forwarded to handler', async () => {
    await channel.initialize();

    const received: BotMessage[] = [];
    channel.onMessage(async (msg) => {
      received.push(msg);
    });

    const ws = new WebSocket(`ws://localhost:${TEST_PORT}/ws?userId=user_42`);
    await new Promise<void>((resolve) => {
      ws.onopen = () => resolve();
    });
    // Consume the connected message
    await new Promise<void>((resolve) => {
      ws.onmessage = () => resolve();
    });

    ws.send(JSON.stringify({ content: 'hello from web', contentType: 'text' }));

    await new Promise((r) => setTimeout(r, 100));

    expect(received.length).toBe(1);
    expect(received[0]?.content).toBe('hello from web');
    expect(received[0]?.userId).toBe('user_42');
    expect(received[0]?.channel).toBe('web');

    ws.close();
  });

  test('sendMessage pushes to connected client', async () => {
    await channel.initialize();

    const ws = new WebSocket(`ws://localhost:${TEST_PORT}/ws?userId=user_send`);
    await new Promise<void>((resolve) => {
      ws.onopen = () => resolve();
    });
    // Consume connected message
    await new Promise<void>((resolve) => {
      ws.onmessage = () => resolve();
    });

    // Set up listener for the message we'll send
    const messagePromise = new Promise<string>((resolve) => {
      ws.onmessage = (e) => resolve(e.data as string);
    });

    await channel.sendMessage('user_send', { type: 'text', text: 'server says hi' });

    const data = JSON.parse(await messagePromise);
    expect(data.type).toBe('message');
    expect(data.data.text).toBe('server says hi');

    ws.close();
  });

  test('updateMessage sends update to connected client', async () => {
    await channel.initialize();

    const ws = new WebSocket(`ws://localhost:${TEST_PORT}/ws?userId=user_upd`);
    await new Promise<void>((resolve) => {
      ws.onopen = () => resolve();
    });
    // Consume connected message and capture connectionId
    const connMsg = await new Promise<string>((resolve) => {
      ws.onmessage = (e) => resolve(e.data as string);
    });
    const { connectionId } = JSON.parse(connMsg);

    const updatePromise = new Promise<string>((resolve) => {
      ws.onmessage = (e) => resolve(e.data as string);
    });

    await channel.updateMessage(`${connectionId}:msg_123`, { type: 'text', text: 'updated' });

    const data = JSON.parse(await updatePromise);
    expect(data.type).toBe('update');
    expect(data.data.text).toBe('updated');

    ws.close();
  });

  test('updateMessage throws when connection not found', async () => {
    await channel.initialize();
    try {
      await channel.updateMessage('nonexistent:msg_1', { type: 'text', text: 'fail' });
      expect(true).toBe(false);
    } catch (error) {
      expect((error as Error).message).toContain('未找到');
    }
  });

  test('sendStreamChunk pushes stream events to client', async () => {
    await channel.initialize();

    const ws = new WebSocket(`ws://localhost:${TEST_PORT}/ws?userId=user_stream`);
    await new Promise<void>((resolve) => {
      ws.onopen = () => resolve();
    });
    // Consume connected message
    await new Promise<void>((resolve) => {
      ws.onmessage = () => resolve();
    });

    const messagePromise = new Promise<string>((resolve) => {
      ws.onmessage = (e) => resolve(e.data as string);
    });

    await channel.sendStreamChunk('user_stream', {
      type: 'text_delta',
      text: 'streaming...',
    });

    const data = JSON.parse(await messagePromise);
    expect(data.type).toBe('stream');
    expect(data.data.type).toBe('text_delta');
    expect(data.data.text).toBe('streaming...');

    ws.close();
  });

  test('sendMessage throws when user not connected', async () => {
    await channel.initialize();
    try {
      await channel.sendMessage('nonexistent', { type: 'text', text: 'fail' });
      expect(true).toBe(false); // should not reach
    } catch (error) {
      expect((error as Error).message).toContain('未找到');
    }
  });

  test('transformToStandardMessage converts raw data', async () => {
    const msg = await channel.transformToStandardMessage({
      userId: 'u1',
      userName: 'Web User',
      content: 'test',
      contentType: 'text',
    });
    expect(msg.channel).toBe('web');
    expect(msg.userId).toBe('u1');
    expect(msg.content).toBe('test');
    expect(msg.attachments).toBeUndefined();
  });

  test('transformToStandardMessage creates attachment for image', async () => {
    const msg = await channel.transformToStandardMessage({
      userId: 'u1',
      contentType: 'image',
      fileContent: 'base64data',
      mimeType: 'image/png',
      fileName: 'photo.png',
    });
    expect(msg.contentType).toBe('image');
    expect(msg.attachments).toBeDefined();
    expect(msg.attachments).toHaveLength(1);
    const att = msg.attachments?.[0] as NonNullable<typeof msg.attachments>[0];
    expect(att.mediaType).toBe('image');
    expect(att.state).toBe('pending');
    expect(att.mimeType).toBe('image/png');
    expect(att.sourceRef).toEqual({
      channel: 'web',
      base64: 'base64data',
      fileName: 'photo.png',
    });
  });

  test('transformToStandardMessage no attachment when image without fileContent', async () => {
    const msg = await channel.transformToStandardMessage({
      userId: 'u1',
      contentType: 'image',
    });
    expect(msg.contentType).toBe('image');
    expect(msg.attachments).toBeUndefined();
  });
});
