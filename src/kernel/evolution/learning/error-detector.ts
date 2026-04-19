import type { ConversationMessage } from '../../../shared/agents/agent-instance.types';

export interface ErrorSignal {
  type: 'correction' | 'repetition' | 'frustration';
  text: string;
  confidence: number;
  category: 'preference' | 'fact' | 'instruction';
}

const CORRECTION_PATTERNS: { pattern: RegExp; category: ErrorSignal['category'] }[] = [
  { pattern: /^\s*(?:我(?:说的)?是|我的意思是|应该是)[,，\s]*(.{3,60})/, category: 'instruction' },
  { pattern: /^\s*(?:不是|不对|错了|纠正)[,，\s]*(.{3,60})/, category: 'instruction' },
  { pattern: /^\s*(?:no,|wrong|incorrect|actually)[,，\s]+(.{3,60})/i, category: 'instruction' },
  { pattern: /^\s*(?:i (?:said|meant|want(?:ed)?))[,，\s]*(.{3,60})/i, category: 'instruction' },
  { pattern: /^\s*(?:不要|别|请不要)(.{3,40})/, category: 'preference' },
  { pattern: /^\s*(?:以后|下次|记住)(.{3,60})/, category: 'preference' },
];

const FRUSTRATION_KEYWORDS = /(?:又错了|还是不对|说了很多次|already told you|again|stop doing)/i;
const FALSE_POSITIVES = /^no\s+(?:problem|worries|thanks|thank|way|idea|doubt)/i;

/**
 * Detects error signals from user messages: corrections, repetitions, frustration.
 * Replaces the old CorrectionDetector with richer signal detection.
 */
export function detectErrorSignal(
  userMsg: string,
  history: ConversationMessage[],
): ErrorSignal | null {
  const trimmed = userMsg.trim();

  // Filter false positives
  if (FALSE_POSITIVES.test(trimmed)) return null;

  // 1. Pattern-based correction detection
  for (const { pattern, category } of CORRECTION_PATTERNS) {
    const match = pattern.exec(trimmed);
    if (match) {
      return {
        type: 'correction',
        text: (match[1] ?? match[0]).trim(),
        confidence: 0.8,
        category,
      };
    }
  }

  // 2. Frustration detection
  if (FRUSTRATION_KEYWORDS.test(trimmed)) {
    return {
      type: 'frustration',
      text: trimmed,
      confidence: 0.7,
      category: 'instruction',
    };
  }

  // 3. Repetition detection — user repeats same request within recent history
  // Skip short/trivial messages (greetings, single words, etc.)
  if (trimmed.length < 10) return null;

  // Only compare with truly previous messages (exclude the current one)
  const userMessages = history.filter((m) => m.role === 'user' && m.content !== trimmed).slice(-5);
  const currentTokens = new Set(tokenize(trimmed));
  for (const prev of userMessages) {
    const prevTokens = new Set(tokenize(prev.content));
    const overlap = jaccardSimilarity(currentTokens, prevTokens);
    if (overlap > 0.8) {
      return {
        type: 'repetition',
        text: trimmed,
        confidence: 0.6,
        category: 'instruction',
      };
    }
  }

  return null;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fff]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  let intersection = 0;
  for (const t of a) {
    if (b.has(t)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
