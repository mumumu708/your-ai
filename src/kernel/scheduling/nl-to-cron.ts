/**
 * Rule-based natural language to cron expression converter.
 * Supports Chinese and English patterns for common scheduling expressions.
 */

export interface NlToCronResult {
  cron: string | null;
  description: string;
  confidence: number;
  taskContent: string;
}

interface NlRule {
  patterns: RegExp[];
  extract: (match: RegExpMatchArray) => string;
  description: string;
}

const WEEKDAY_MAP_CN: Record<string, string> = {
  一: '1',
  二: '2',
  三: '3',
  四: '4',
  五: '5',
  六: '6',
  日: '0',
  天: '0',
};

const WEEKDAY_MAP_EN: Record<string, string> = {
  monday: '1',
  tuesday: '2',
  wednesday: '3',
  thursday: '4',
  friday: '5',
  saturday: '6',
  sunday: '0',
  mon: '1',
  tue: '2',
  wed: '3',
  thu: '4',
  fri: '5',
  sat: '6',
  sun: '0',
};

// Helper regex fragments for Chinese time-of-day prefixes
const CN_MORNING = '(?:早上|上午)?';
const CN_AFTERNOON = '(?:下午|晚上)';
const CN_TIME_SEP = '[点时:：]';

const NL_RULES: NlRule[] = [
  // --- Simple interval patterns (no digits) ---
  {
    patterns: [/每分钟/, /every\s+minute/i],
    extract: () => '* * * * *',
    description: '每分钟',
  },
  {
    patterns: [/每小?时/, /every\s+hour/i],
    extract: () => '0 * * * *',
    description: '每小时',
  },

  // --- Interval patterns ---
  {
    patterns: [/每隔?(\d+)分钟/, /every\s+(\d+)\s+minutes?/i],
    extract: (m) => `*/${m[1]!} * * * *`,
    description: '每N分钟',
  },
  {
    patterns: [/每半小?时/, /每隔半小?时/, /every\s+half\s+hour/i, /every\s+30\s+minutes?/i],
    extract: () => '*/30 * * * *',
    description: '每30分钟',
  },
  {
    patterns: [/每隔?(\d+)小?时/, /every\s+(\d+)\s+hours?/i],
    extract: (m) => `0 */${m[1]!} * * *`,
    description: '每N小时',
  },

  // --- Daily with afternoon/evening (must be before general daily) ---
  {
    patterns: [new RegExp(`每天${CN_AFTERNOON}(\\d{1,2})${CN_TIME_SEP}(\\d{1,2})?`)],
    extract: (m) => {
      const hour = Number.parseInt(m[1]!, 10);
      const adjustedHour = hour < 12 ? hour + 12 : hour;
      return `${m[2] ? Number.parseInt(m[2], 10) : 0} ${adjustedHour} * * *`;
    },
    description: '每天下午/晚上',
  },

  // --- Daily patterns with time ---
  {
    patterns: [
      new RegExp(`每天${CN_MORNING}(\\d{1,2})${CN_TIME_SEP}(\\d{1,2})?`),
      new RegExp(`每日${CN_MORNING}(\\d{1,2})${CN_TIME_SEP}(\\d{1,2})?`),
    ],
    extract: (m) => `${m[2] ? Number.parseInt(m[2], 10) : 0} ${Number.parseInt(m[1]!, 10)} * * *`,
    description: '每天指定时间',
  },
  {
    patterns: [/every\s+day\s+at\s+(\d{1,2}):(\d{2})/i, /daily\s+at\s+(\d{1,2}):(\d{2})/i],
    extract: (m) => `${Number.parseInt(m[2]!, 10)} ${Number.parseInt(m[1]!, 10)} * * *`,
    description: '每天指定时间',
  },

  // --- Weekly patterns ---
  {
    patterns: [
      new RegExp(
        `每(?:周|星期|礼拜)([一二三四五六日天])${CN_MORNING}(\\d{1,2})${CN_TIME_SEP}?(\\d{1,2})?`,
      ),
    ],
    extract: (m) => {
      const dow = WEEKDAY_MAP_CN[m[1]!] ?? '0';
      const minute = m[3] ? Number.parseInt(m[3], 10) : 0;
      return `${minute} ${Number.parseInt(m[2]!, 10)} * * ${dow}`;
    },
    description: '每周某天指定时间',
  },
  {
    patterns: [
      /every\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\s+at\s+(\d{1,2}):(\d{2})/i,
    ],
    extract: (m) => {
      const dow = WEEKDAY_MAP_EN[m[1]?.toLowerCase() ?? ''] ?? '0';
      return `${Number.parseInt(m[3]!, 10)} ${Number.parseInt(m[2]!, 10)} * * ${dow}`;
    },
    description: '每周某天指定时间',
  },

  // --- Workday patterns ---
  {
    patterns: [new RegExp(`(?:每个?)?工作日${CN_MORNING}(\\d{1,2})${CN_TIME_SEP}?(\\d{1,2})?`)],
    extract: (m) => {
      const minute = m[2] ? Number.parseInt(m[2], 10) : 0;
      return `${minute} ${Number.parseInt(m[1]!, 10)} * * 1-5`;
    },
    description: '工作日指定时间',
  },
  {
    patterns: [/weekdays?\s+at\s+(\d{1,2}):(\d{2})/i, /every\s+weekday\s+at\s+(\d{1,2}):(\d{2})/i],
    extract: (m) => `${Number.parseInt(m[2]!, 10)} ${Number.parseInt(m[1]!, 10)} * * 1-5`,
    description: '工作日指定时间',
  },

  // --- Monthly patterns (with optional time, must be before simple monthly) ---
  {
    patterns: [new RegExp(`每月(\\d{1,2})[号日]${CN_MORNING}(\\d{1,2})${CN_TIME_SEP}?(\\d{1,2})?`)],
    extract: (m) => {
      const hour = Number.parseInt(m[2]!, 10);
      const minute = m[3] ? Number.parseInt(m[3], 10) : 0;
      return `${minute} ${hour} ${Number.parseInt(m[1]!, 10)} * *`;
    },
    description: '每月指定日期和时间',
  },
  {
    patterns: [/每月(\d{1,2})[号日]/],
    extract: (m) => `0 0 ${Number.parseInt(m[1]!, 10)} * *`,
    description: '每月指定日期',
  },
  {
    patterns: [/每月第?一天/],
    extract: () => '0 0 1 * *',
    description: '每月第一天',
  },
];

/**
 * Common prefixes for scheduling commands that should be stripped
 * when extracting the actual task content.
 */
const TASK_PREFIX_PATTERNS: RegExp[] = [
  /^(?:创建|设置|新建|添加)一?个?定时任务[，,]?\s*/,
  /^定时[，,]?\s*/,
  /^(?:帮我|请)\s*/,
];

/**
 * Extract task content from the original text by removing
 * scheduling patterns and common command prefixes.
 */
function extractTaskContent(text: string, matchedPattern: RegExp): string {
  // Remove the matched scheduling pattern
  let content = text.replace(matchedPattern, '').trim();

  // Remove common task prefixes
  for (const prefix of TASK_PREFIX_PATTERNS) {
    content = content.replace(prefix, '').trim();
  }

  // Remove leading punctuation/connectors
  content = content.replace(/^[，,、]\s*/, '').trim();

  // If nothing left after stripping, fall back to original text
  return content || text;
}

/**
 * Convert a natural language scheduling description to a cron expression.
 */
export function nlToCron(text: string): NlToCronResult {
  const trimmed = text.trim();

  for (const rule of NL_RULES) {
    for (const pattern of rule.patterns) {
      const match = trimmed.match(pattern);
      if (match) {
        return {
          cron: rule.extract(match),
          description: rule.description,
          confidence: 0.9,
          taskContent: extractTaskContent(trimmed, pattern),
        };
      }
    }
  }

  return {
    cron: null,
    description: '无法识别的调度模式',
    confidence: 0,
    taskContent: trimmed,
  };
}
