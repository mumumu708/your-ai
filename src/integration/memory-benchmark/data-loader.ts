/**
 * Memory Benchmark — Data Loader
 *
 * Reads yuxiaowen test dataset and converts into conversation messages
 * grouped by topic for ingestion through the real chat pipeline.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DATA_ROOT = join(import.meta.dir, '../../../test-data/yuxiaowen');

// ── Types ──────────────────────────────────────────────────

export interface ConversationBatch {
  /** Unique conversation ID for session grouping */
  conversationId: string;
  /** Human-readable label */
  label: string;
  /** Messages to send (user role only — agent response doesn't matter for memory storage) */
  messages: string[];
}

export interface QAItem {
  question: string;
  answer: string;
  options?: Array<{ option: string; content: string }>;
  score_points?: Array<{ description: string; score: number }>;
  question_type: string;
  ask_time?: string;
  evidence?: Array<{ type: string; id: string | number }>;
}

// ── Helpers ────────────────────────────────────────────────

function loadJson<T>(relativePath: string): T {
  const raw = readFileSync(join(DATA_ROOT, relativePath), 'utf-8');
  return JSON.parse(raw) as T;
}

/** Chunk an array into groups of at most `size` */
function chunk<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}

// ── Persona & Location (one-time user profile) ────────────

function loadPersonaBatch(): ConversationBatch {
  const persona = loadJson<Record<string, unknown>>('persona.json');
  const location = loadJson<Array<Record<string, unknown>>>('location.json');

  const profileLines = [
    `我叫${persona.name}，${persona.gender}，${persona.birth}出生，今年${persona.age}岁。`,
    `民族：${persona.nationality}，学历：${persona.education}。`,
    `职业：${persona.job}，工作单位：${persona.occupation}。`,
    `家庭状况：${persona.family}。`,
    persona.body
      ? `身高${(persona.body as Record<string, unknown>).height}cm，体重${(persona.body as Record<string, unknown>).weight}kg。`
      : '',
    persona.hobbies ? `我的爱好有：${(persona.hobbies as string[]).join('、')}。` : '',
    persona.favorite_foods ? `我喜欢吃：${(persona.favorite_foods as string[]).join('、')}。` : '',
    persona.personality
      ? `我的MBTI是${(persona.personality as Record<string, unknown>).mbti}，性格特点：${((persona.personality as Record<string, unknown>).traits as string[]).join('、')}。`
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  const homeAddr = persona.home_address as Record<string, string> | undefined;
  const workAddr = persona.workplace as Record<string, string> | undefined;
  const addressInfo = [
    homeAddr
      ? `我家住在${homeAddr.province}${homeAddr.city}${homeAddr.district}${homeAddr.street_name}${homeAddr.street_number}。`
      : '',
    workAddr
      ? `我的工作地点在${workAddr.province}${workAddr.city}${workAddr.district}${workAddr.street_name}${workAddr.street_number}。`
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  const locationInfo = location.map((l) => `${l.name}：${l.description}`).join('\n');

  return {
    conversationId: 'bench_persona',
    label: '用户画像 & 常去地点',
    messages: [
      `请帮我记住我的个人信息：\n${profileLines}`,
      `这是我的地址信息：\n${addressInfo}`,
      `这些是我常去的地方，帮我记住：\n${locationInfo}`,
    ],
  };
}

// ── Contact ───────────────────────────────────────────────

function loadContactBatch(): ConversationBatch {
  const contacts = loadJson<Array<Record<string, unknown>>>('phone_data/contact.json');
  const lines = contacts.map(
    (c) =>
      `${c.name}（${c.relation}）${c.nickname ? `，昵称"${c.nickname}"` : ''}，电话${c.phoneNumber}`,
  );
  return {
    conversationId: 'bench_contact',
    label: '联系人',
    messages: [`这是我的通讯录，请帮我记住：\n${lines.join('\n')}`],
  };
}

// ── Daily Draft (grouped by month — daily_draft.json has month-keyed structure) ──

function loadDailyDraftBatches(): ConversationBatch[] {
  const daily = loadJson<Record<string, Array<Record<string, unknown>>>>('daily_draft.json');
  const batches: ConversationBatch[] = [];

  for (const [month, days] of Object.entries(daily)) {
    const messages: string[] = [];
    for (const day of days) {
      const date = day.date as string;
      const weather = (day.date_attribute as Record<string, string>)?.weather ?? '';
      const overview = day.daily_overview as string;
      const events = (day.events as Array<Record<string, string>>) ?? [];
      const state = day.state as Record<string, unknown> | undefined;

      let dayText = `【${date}】${weather ? `天气：${weather}。` : ''}${overview}`;
      if (events.length > 0) {
        dayText += `\n具体事件：\n${events.map((e) => `- ${e.name}：${e.description}`).join('\n')}`;
      }
      if (state) {
        const parts: string[] = [];
        if (state.起床时间) parts.push(`起床${state.起床时间}`);
        if (state.睡觉时间) parts.push(`睡觉${state.睡觉时间}`);
        if (state.今日运动 && state.今日运动 !== '无') parts.push(`运动：${state.今日运动}`);
        if (parts.length) dayText += `\n状态：${parts.join('，')}`;
      }
      messages.push(dayText);
    }

    const chunked = chunk(messages, 5);
    for (let i = 0; i < chunked.length; i++) {
      batches.push({
        conversationId: `bench_daily_${month}_${i}`,
        label: `日常概览 ${month} (${i + 1}/${chunked.length})`,
        messages: [`这是我${month}的日常记录，请帮我记住：\n\n${chunked[i].join('\n\n')}`],
      });
    }
  }

  return batches;
}

// ── Daily Events (daily_event.json — flat array of events) ──

function loadDailyEventBatches(): ConversationBatch[] {
  const events = loadJson<Array<Record<string, unknown>>>('daily_event.json');
  // Group by date (extracted from the date array field)
  const byMonth = new Map<string, Array<Record<string, unknown>>>();

  for (const evt of events) {
    const dateArr = evt.date as string[] | undefined;
    const dateStr = dateArr?.[0]?.slice(0, 7) ?? 'unknown'; // "2025-01"
    if (!byMonth.has(dateStr)) byMonth.set(dateStr, []);
    byMonth.get(dateStr)?.push(evt);
  }

  const batches: ConversationBatch[] = [];
  for (const [month, records] of byMonth) {
    const chunked = chunk(records, 30);
    for (let i = 0; i < chunked.length; i++) {
      const lines = chunked[i].map((e) => {
        const dateArr = e.date as string[] | undefined;
        const timeRange = dateArr?.[0] ?? '';
        return `[${timeRange}] ${e.name}（${e.type}）：${e.description}`;
      });
      batches.push({
        conversationId: `bench_event_${month}_${i}`,
        label: `详细事件 ${month} (${i + 1}/${chunked.length})`,
        messages: [`这是我${month}的详细事件记录：\n${lines.join('\n')}`],
      });
    }
  }

  return batches;
}

// ── SMS (grouped by month based on datetime) ─────────────

function loadSmsBatches(): ConversationBatch[] {
  const smsData = loadJson<Array<Record<string, unknown>>>('phone_data/sms.json');
  const byMonth = new Map<string, Array<Record<string, unknown>>>();

  for (const sms of smsData) {
    const dt = sms.datetime as string;
    const month = dt.slice(0, 7); // "2025-01"
    if (!byMonth.has(month)) byMonth.set(month, []);
    byMonth.get(month)?.push(sms);
  }

  const batches: ConversationBatch[] = [];
  for (const [month, records] of byMonth) {
    const chunked = chunk(records, 30);
    for (let i = 0; i < chunked.length; i++) {
      const lines = chunked[i].map((s) => {
        const dir = s.message_type === '发送' ? '我发给' : '收到来自';
        return `[${s.datetime}] ${dir}${s.contactName}：${s.message_content}`;
      });
      batches.push({
        conversationId: `bench_sms_${month}_${i}`,
        label: `短信记录 ${month} (${i + 1}/${chunked.length})`,
        messages: [`这是我${month}的短信记录：\n${lines.join('\n')}`],
      });
    }
  }
  return batches;
}

// ── Notes ────────────────────────────────────────────────

function loadNoteBatches(): ConversationBatch[] {
  const notes = loadJson<Array<Record<string, unknown>>>('phone_data/note.json');
  const chunked = chunk(notes, 10);
  return chunked.map((group, i) => {
    const lines = group.map((n) => `[${n.datetime}] 标题：${n.title}\n内容：${n.content}`);
    return {
      conversationId: `bench_note_${i}`,
      label: `笔记 (${i + 1}/${chunked.length})`,
      messages: [`这是我的笔记记录，请帮我记住：\n\n${lines.join('\n\n')}`],
    };
  });
}

// ── Push Notifications ───────────────────────────────────

function loadPushBatches(): ConversationBatch[] {
  const pushData = loadJson<Array<Record<string, unknown>>>('phone_data/push.json');
  const byMonth = new Map<string, Array<Record<string, unknown>>>();

  for (const p of pushData) {
    const dt = p.datetime as string;
    const month = dt.slice(0, 7);
    if (!byMonth.has(month)) byMonth.set(month, []);
    byMonth.get(month)?.push(p);
  }

  const batches: ConversationBatch[] = [];
  for (const [month, records] of byMonth) {
    const chunked = chunk(records, 40);
    for (let i = 0; i < chunked.length; i++) {
      const lines = chunked[i].map((p) => `[${p.datetime}] ${p.source}：${p.title} — ${p.content}`);
      batches.push({
        conversationId: `bench_push_${month}_${i}`,
        label: `推送通知 ${month} (${i + 1}/${chunked.length})`,
        messages: [`这是我${month}的手机推送通知：\n${lines.join('\n')}`],
      });
    }
  }
  return batches;
}

// ── Calendar ─────────────────────────────────────────────

function loadCalendarBatch(): ConversationBatch[] {
  const cal = loadJson<Array<Record<string, unknown>>>('phone_data/calendar.json');
  const chunked = chunk(cal, 20);
  return chunked.map((group, i) => {
    const lines = group.map((c) => `[${c.start_time}~${c.end_time}] ${c.title}：${c.description}`);
    return {
      conversationId: `bench_cal_${i}`,
      label: `日历 (${i + 1}/${chunked.length})`,
      messages: [`这是我的日历日程：\n${lines.join('\n')}`],
    };
  });
}

// ── Call Records ─────────────────────────────────────────

function loadCallBatches(): ConversationBatch[] {
  const calls = loadJson<Array<Record<string, unknown>>>('phone_data/call.json');
  const chunked = chunk(calls, 50);
  return chunked.map((group, i) => {
    const lines = group.map((c) => {
      const dir = c.direction === 1 ? '拨出' : '接入';
      return `[${c.datetime}] ${dir} ${c.contactName}（${c.phoneNumber}），${c.call_result}`;
    });
    return {
      conversationId: `bench_call_${i}`,
      label: `通话记录 (${i + 1}/${chunked.length})`,
      messages: [`这是我的通话记录：\n${lines.join('\n')}`],
    };
  });
}

// ── Fitness & Health ─────────────────────────────────────

function loadFitnessBatches(): ConversationBatch[] {
  const fitness = loadJson<Array<Record<string, unknown>>>('phone_data/fitness_health.json');
  const chunked = chunk(fitness, 15);
  return chunked.map((group, i) => {
    const lines = group.map((f) => {
      const daily = f.日常活动 as Record<string, string> | undefined;
      const sleep = f.睡眠 as Record<string, string> | undefined;
      let text = `[${f.日期}]`;
      if (daily) text += ` 步数${daily.步数}，距离${daily.距离}，热量${daily.热量}`;
      if (sleep) text += `，睡眠${sleep.总时长 ?? ''}`;
      return text;
    });
    return {
      conversationId: `bench_fitness_${i}`,
      label: `健康数据 (${i + 1}/${chunked.length})`,
      messages: [`这是我的运动健康数据：\n${lines.join('\n')}`],
    };
  });
}

// ── Photo Metadata ───────────────────────────────────────

function loadPhotoBatches(): ConversationBatch[] {
  const photos = loadJson<Array<Record<string, unknown>>>('phone_data/photo.json');
  const chunked = chunk(photos, 20);
  return chunked.map((group, i) => {
    const lines = group.map((p) => {
      const loc = p.location as Record<string, string> | undefined;
      const locStr = loc ? `${loc.poi || loc.district || ''}` : '';
      return `[${p.datetime}] ${p.caption}${locStr ? `（地点：${locStr}）` : ''}`;
    });
    return {
      conversationId: `bench_photo_${i}`,
      label: `照片记录 (${i + 1}/${chunked.length})`,
      messages: [`这是我的照片记录（描述）：\n${lines.join('\n')}`],
    };
  });
}

// ── Agent Chat (replay existing conversations) ──────────

function loadAgentChatBatches(): ConversationBatch[] {
  const chats = loadJson<Array<Record<string, unknown>>>('phone_data/agent_chat.json');
  const batches: ConversationBatch[] = [];

  for (let i = 0; i < chats.length; i++) {
    const chat = chats[i];
    const conv = chat.conversation as Record<string, Record<string, Record<string, string>>>;
    const messages: string[] = [];

    // Extract user turns as messages to send
    const turnKeys = Object.keys(conv).sort(
      (a, b) => Number.parseInt(a.replace('turn ', '')) - Number.parseInt(b.replace('turn ', '')),
    );
    for (const key of turnKeys) {
      const turn = conv[key];
      if (turn.user?.content) {
        messages.push(turn.user.content);
      }
    }

    if (messages.length > 0) {
      batches.push({
        conversationId: `bench_chat_${chat.event_id ?? i}`,
        label: `AI对话 #${chat.event_id ?? i} (${chat.date ?? ''})`,
        messages,
      });
    }
  }

  return batches;
}

// ── QA Dataset ───────────────────────────────────────────

/**
 * Load QA dataset with optional train/val split filtering.
 * Set BENCH_SPLIT=train or BENCH_SPLIT=val to select a subset.
 * Split files (train_indices.json / val_indices.json) are generated
 * with seed=42 stratified sampling by question_type.
 */
export function loadQADataset(): QAItem[] {
  const all = loadJson<QAItem[]>('QA/QA_clean.json');
  const split = process.env.BENCH_SPLIT;
  if (split === 'train' || split === 'val') {
    const indices = loadJson<number[]>(`QA/${split}_indices.json`);
    const indexSet = new Set(indices);
    return all.filter((_, i) => indexSet.has(i));
  }
  return all;
}

// ── Main Loader ──────────────────────────────────────────

export function loadAllBatches(): ConversationBatch[] {
  const batches: ConversationBatch[] = [];

  // 1. User profile (highest priority — foundational context)
  batches.push(loadPersonaBatch());
  batches.push(loadContactBatch());

  // 2. Calendar events
  batches.push(...loadCalendarBatch());

  // 3. Daily overview (daily_draft.json — month-keyed with date/weather/events/state)
  batches.push(...loadDailyDraftBatches());

  // 4. High-value evidence types (SMS, Notes, Push) — prioritized over daily_event
  //    because QA questions heavily depend on these data sources
  batches.push(...loadSmsBatches());
  batches.push(...loadNoteBatches());
  batches.push(...loadPushBatches());

  // 5. Communication records
  batches.push(...loadCallBatches());

  // 6. Detailed events (daily_event.json — large volume, lower priority)
  batches.push(...loadDailyEventBatches());

  // 7. Health data
  batches.push(...loadFitnessBatches());

  // 8. Photo metadata
  batches.push(...loadPhotoBatches());

  // 9. Agent chat history (replay)
  batches.push(...loadAgentChatBatches());

  return batches;
}

/** Load a subset of batches for quick testing */
export function loadMinimalBatches(): ConversationBatch[] {
  return [loadPersonaBatch(), loadContactBatch()];
}

/** Get total message count across all batches */
export function countMessages(batches: ConversationBatch[]): number {
  return batches.reduce((sum, b) => sum + b.messages.length, 0);
}
