const VERB_MAP: Record<string, string> = {
  // Chinese verbs
  修复: 'fix',
  修改: 'fix',
  解决: 'fix',
  添加: 'feat',
  新增: 'feat',
  增加: 'feat',
  实现: 'feat',
  创建: 'feat',
  重构: 'refactor',
  优化: 'refactor',
  整理: 'refactor',
  更新: 'feat',
  迁移: 'refactor',
  删除: 'refactor',
  移除: 'refactor',
  // English verbs
  fix: 'fix',
  repair: 'fix',
  resolve: 'fix',
  add: 'feat',
  create: 'feat',
  implement: 'feat',
  build: 'feat',
  refactor: 'refactor',
  optimize: 'refactor',
  clean: 'refactor',
  update: 'feat',
  migrate: 'refactor',
  remove: 'refactor',
  delete: 'refactor',
};

const HARNESS_PREFIX_RE = /^(?:\/harness\s+|harness[:\s]+)/i;
const MAX_SLUG_LENGTH = 40;

/**
 * Generate a git branch name from a harness message.
 *
 * "/harness 修复 telegram 超时 bug" → "agent/fix/telegram-bug-abc123"
 * "/harness add memory cache"       → "agent/feat/add-memory-cache-abc123"
 * "harness: 重构 classifier"        → "agent/refactor/classifier-abc123"
 */
export function generateBranchName(message: string): string {
  // Strip harness prefix
  const stripped = message.replace(HARNESS_PREFIX_RE, '').trim();

  // Detect verb type
  const verbType = detectVerbType(stripped);

  // Slugify the message
  const slug = slugify(stripped);

  // Append short hash for uniqueness
  const hash = Date.now().toString(36);

  const branchSlug = slug ? `${slug}-${hash}` : hash;
  return `agent/${verbType}/${branchSlug}`;
}

function detectVerbType(text: string): string {
  // Check if the text starts with a known verb
  for (const [verb, type] of Object.entries(VERB_MAP)) {
    if (text.startsWith(verb)) {
      return type;
    }
  }
  // Default to feat
  return 'feat';
}

function slugify(text: string): string {
  return (
    text
      // Remove Chinese characters (they don't work well in branch names)
      .replace(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g, ' ')
      // Replace non-alphanumeric with spaces
      .replace(/[^a-zA-Z0-9\s-]/g, ' ')
      // Collapse whitespace
      .replace(/\s+/g, ' ')
      .trim()
      // Replace spaces with hyphens
      .replace(/\s/g, '-')
      .toLowerCase()
      // Truncate
      .slice(0, MAX_SLUG_LENGTH)
      // Remove trailing hyphen
      .replace(/-$/, '')
  );
}
