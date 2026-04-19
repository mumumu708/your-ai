import { describe, expect, test } from 'bun:test';
import { parseFrontmatter, parseSimpleYaml } from './skill-frontmatter';

describe('parseFrontmatter', () => {
  test('parses valid frontmatter with name and description', () => {
    const content = `---
name: rss-digest
description: RSS 源定时消化
---
# RSS Digest

Body content here.`;

    const { frontmatter, body } = parseFrontmatter(content);

    expect(frontmatter).not.toBeNull();
    expect(frontmatter?.name).toBe('rss-digest');
    expect(frontmatter?.description).toBe('RSS 源定时消化');
    expect(body).toBe('# RSS Digest\n\nBody content here.');
  });

  test('returns null frontmatter when no delimiters', () => {
    const content = '# Just a Skill\n\nNo frontmatter here.';
    const { frontmatter, body } = parseFrontmatter(content);

    expect(frontmatter).toBeNull();
    expect(body).toBe(content);
  });

  test('returns null frontmatter when only opening delimiter', () => {
    const content = '---\nname: test\nno closing delimiter';
    const { frontmatter, body } = parseFrontmatter(content);

    expect(frontmatter).toBeNull();
    expect(body).toBe(content);
  });

  test('returns null frontmatter when missing required name field', () => {
    const content = `---
description: only description
---
Body`;

    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter).toBeNull();
  });

  test('returns null frontmatter when missing required description field', () => {
    const content = `---
name: only-name
---
Body`;

    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter).toBeNull();
  });

  test('parses optional fields', () => {
    const content = `---
name: commit
description: Git commit helper
version: 1.0.0
author: Agent
---
Body`;

    const { frontmatter } = parseFrontmatter(content);

    expect(frontmatter?.version).toBe('1.0.0');
    expect(frontmatter?.author).toBe('Agent');
  });

  test('parses inline array platforms', () => {
    const content = `---
name: rss-digest
description: RSS digest
platforms: [feishu, telegram, web]
---
Body`;

    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter?.platforms).toEqual(['feishu', 'telegram', 'web']);
  });

  test('parses readiness with env vars', () => {
    const content = `---
name: rss-digest
description: RSS digest
readiness:
  env:
    - RSS_FEED_URLS
    - OPENAI_API_KEY
  tools:
    - web_fetch
  credentials: []
---
Body`;

    const { frontmatter } = parseFrontmatter(content);

    expect(frontmatter?.readiness).toBeDefined();
    expect(frontmatter?.readiness?.env).toEqual(['RSS_FEED_URLS', 'OPENAI_API_KEY']);
    expect(frontmatter?.readiness?.tools).toEqual(['web_fetch']);
    expect(frontmatter?.readiness?.credentials).toEqual([]);
  });

  test('parses metadata with tags and related_skills', () => {
    const content = `---
name: rss-digest
description: RSS digest
metadata:
  tags:
    - 信息消化
    - RSS
  related_skills:
    - deep-research
  fallback_for:
    - 信息摘要
    - 内容消化
---
Body`;

    const { frontmatter } = parseFrontmatter(content);

    expect(frontmatter?.metadata?.tags).toEqual(['信息消化', 'RSS']);
    expect(frontmatter?.metadata?.related_skills).toEqual(['deep-research']);
    expect(frontmatter?.metadata?.fallback_for).toEqual(['信息摘要', '内容消化']);
  });

  test('handles leading whitespace before frontmatter', () => {
    const content = `  ---
name: test
description: test skill
---
Body`;

    // trimStart removes leading whitespace
    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter?.name).toBe('test');
  });

  test('handles empty body after frontmatter', () => {
    const content = `---
name: test
description: test skill
---`;

    const { frontmatter, body } = parseFrontmatter(content);
    expect(frontmatter?.name).toBe('test');
    expect(body).toBe('');
  });
});

describe('parseSimpleYaml', () => {
  test('parses simple key-value pairs', () => {
    const result = parseSimpleYaml('name: hello\nversion: 1.0');
    expect(result?.name).toBe('hello');
    expect(result?.version).toBe('1.0');
  });

  test('parses quoted values', () => {
    const result = parseSimpleYaml('name: "quoted value"\nother: \'single\'');
    expect(result?.name).toBe('quoted value');
    expect(result?.other).toBe('single');
  });

  test('parses inline arrays', () => {
    const result = parseSimpleYaml('items: [a, b, c]');
    expect(result?.items).toEqual(['a', 'b', 'c']);
  });

  test('parses empty inline array', () => {
    const result = parseSimpleYaml('items: []');
    expect(result?.items).toEqual([]);
  });

  test('skips comment lines', () => {
    const result = parseSimpleYaml('# comment\nname: test');
    expect(result?.name).toBe('test');
  });

  test('skips empty lines', () => {
    const result = parseSimpleYaml('name: test\n\nversion: 1.0');
    expect(result?.name).toBe('test');
    expect(result?.version).toBe('1.0');
  });

  test('returns null for malformed yaml', () => {
    // Completely unparseable should still return an object (possibly empty)
    const result = parseSimpleYaml('just plain text without colons');
    expect(result).toEqual({});
  });

  test('parses nested objects', () => {
    const yaml = `readiness:
  env:
    - VAR1
    - VAR2`;
    const result = parseSimpleYaml(yaml);
    expect(result?.readiness).toEqual({ env: ['VAR1', 'VAR2'] });
  });

  test('parses multiline scalar with pipe', () => {
    const yaml = `description: |
  This is a multi-line
  description text`;
    const result = parseSimpleYaml(yaml);
    expect(result?.description).toBe('This is a multi-line\ndescription text');
  });

  test('handles key with no following content (end of file)', () => {
    const yaml = 'name: test\nempty_key:';
    const result = parseSimpleYaml(yaml);
    expect(result?.name).toBe('test');
    expect(result?.empty_key).toBe('');
  });

  test('handles key with next line at same indent (not nested)', () => {
    const yaml = 'first:\nsecond: value';
    const result = parseSimpleYaml(yaml);
    expect(result?.first).toBe('');
    expect(result?.second).toBe('value');
  });

  test('parses sequence with object items (- key: value)', () => {
    const yaml = `config:
  - key: schedule
    description: cron expression
  - key: max_items
    description: max count`;
    const result = parseSimpleYaml(yaml);
    expect(result?.config).toEqual([
      { key: 'schedule', description: 'cron expression' },
      { key: 'max_items', description: 'max count' },
    ]);
  });

  test('handles comments in sequences', () => {
    const yaml = `items:
  # a comment
  - first
  - second`;
    const result = parseSimpleYaml(yaml);
    expect(result?.items).toEqual(['first', 'second']);
  });

  test('handles empty sequence items gracefully', () => {
    const yaml = `items:
  - alpha

  - beta`;
    const result = parseSimpleYaml(yaml);
    expect(result?.items).toEqual(['alpha', 'beta']);
  });

  test('parses single object item at end of sequence', () => {
    const yaml = `items:
  - key: only`;
    const result = parseSimpleYaml(yaml);
    expect(result?.items).toEqual([{ key: 'only' }]);
  });

  test('parses object items followed by next sequence item', () => {
    const yaml = `items:
  - name: first
  - name: second`;
    const result = parseSimpleYaml(yaml);
    expect(result?.items).toEqual([{ name: 'first' }, { name: 'second' }]);
  });

  test('handles nested object followed by sequence at same level', () => {
    // This tests the block sequence break path where parseBlock
    // encounters a `- item` line at the same indent level
    const yaml = `parent:
  child: value
  - item1
  - item2`;
    const result = parseSimpleYaml(yaml);
    // The parser should parse child: value and stop at the sequence items
    expect(result?.parent).toEqual({ child: 'value' });
  });
});
