/**
 * Parses YAML frontmatter from SKILL.md files.
 *
 * Uses a minimal hand-rolled parser — no external YAML dependency.
 * Handles the specific frontmatter format used by skills:
 * simple key-value pairs, string arrays, and one level of nesting.
 */

import type { SkillReadiness } from './skill-readiness';

export interface SkillFrontmatter {
  name: string;
  description: string;
  version?: string;
  author?: string;
  platforms?: string[];
  readiness?: SkillReadiness;
  metadata?: {
    tags?: string[];
    related_skills?: string[];
    fallback_for?: string[];
    config?: Array<{
      key: string;
      description: string;
      default?: string;
    }>;
  };
}

export interface ParseResult {
  frontmatter: SkillFrontmatter | null;
  body: string;
}

/**
 * Parse YAML frontmatter delimited by `---` from a SKILL.md string.
 * Returns the parsed frontmatter object and the remaining body text.
 */
export function parseFrontmatter(content: string): ParseResult {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('---')) {
    return { frontmatter: null, body: content };
  }

  const endIndex = trimmed.indexOf('---', 3);
  if (endIndex === -1) {
    return { frontmatter: null, body: content };
  }

  const yamlBlock = trimmed.slice(3, endIndex).trim();
  const body = trimmed.slice(endIndex + 3).trim();

  const parsed = parseSimpleYaml(yamlBlock);
  if (!parsed || typeof parsed.name !== 'string' || typeof parsed.description !== 'string') {
    return { frontmatter: null, body: content };
  }

  const frontmatter: SkillFrontmatter = {
    name: parsed.name as string,
    description: parsed.description as string,
  };

  if (parsed.version !== undefined) frontmatter.version = String(parsed.version);
  if (parsed.author !== undefined) frontmatter.author = String(parsed.author);
  if (Array.isArray(parsed.platforms)) frontmatter.platforms = parsed.platforms as string[];
  if (parsed.readiness && typeof parsed.readiness === 'object') {
    frontmatter.readiness = parsed.readiness as SkillReadiness;
  }
  if (parsed.metadata && typeof parsed.metadata === 'object') {
    frontmatter.metadata = parsed.metadata as SkillFrontmatter['metadata'];
  }

  return { frontmatter, body };
}

// ── Minimal YAML parser ──

interface YamlObject {
  [key: string]: YamlValue;
}
type YamlValue = string | string[] | YamlObject | YamlValue[];

/**
 * Parse a simple YAML block into a nested object.
 * Supports: scalar values, inline arrays `[a, b]`, nested objects via indentation,
 * and block sequence items `- key: value`.
 */
export function parseSimpleYaml(yaml: string): YamlObject | null {
  const lines = yaml.split('\n');
  const { result } = parseBlock(lines, 0, 0);
  return result;
}

interface BlockResult {
  result: YamlObject;
  nextLine: number;
}

function parseBlock(lines: string[], startLine: number, minIndent: number): BlockResult {
  const result: YamlObject = {};
  let i = startLine;

  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined) break;

    // Skip empty lines and comments
    if (line.trim() === '' || line.trim().startsWith('#')) {
      i++;
      continue;
    }

    const indent = line.length - line.trimStart().length;
    if (indent < minIndent) break;

    const trimmedLine = line.trim();

    // Block sequence item at current level: `- something` (no colon = scalar, not object)
    // This is part of a sequence being collected by the parent — stop here.
    const isScalarSeqItem = trimmedLine.startsWith('- ') && !trimmedLine.includes(':');
    if (isScalarSeqItem) break;

    // Key-value pair
    const colonIdx = trimmedLine.indexOf(':');
    if (colonIdx === -1) {
      i++;
      continue;
    }

    const key = trimmedLine.slice(0, colonIdx).trim();
    const rawValue = trimmedLine.slice(colonIdx + 1).trim();

    if (rawValue === '|') {
      // Multi-line scalar block
      const { text, nextLine: afterText } = parseMultilineScalar(lines, i + 1, indent);
      result[key] = text;
      i = afterText;
    } else if (rawValue === '') {
      // Check if next lines are indented (nested object or block sequence)
      const nextNonEmpty = findNextNonEmptyLine(lines, i + 1);
      if (nextNonEmpty === -1) {
        result[key] = '';
        i++;
        continue;
      }

      // nextNonEmpty is valid index since findNextNonEmptyLine returned >= 0
      const nextLine = lines[nextNonEmpty] as string;
      const nextIndent = nextLine.length - nextLine.trimStart().length;

      if (nextIndent > indent) {
        if (nextLine.trim().startsWith('- ')) {
          // Block sequence
          const { items, nextLine: afterSeq } = parseSequence(lines, nextNonEmpty, nextIndent);
          // Check if items are objects or scalars
          if (items.length > 0 && typeof items[0] === 'object' && !Array.isArray(items[0])) {
            result[key] = items;
          } else {
            result[key] = items as string[];
          }
          i = afterSeq;
        } else {
          // Nested object
          const { result: nested, nextLine: afterBlock } = parseBlock(
            lines,
            nextNonEmpty,
            nextIndent,
          );
          result[key] = nested;
          i = afterBlock;
        }
      } else {
        result[key] = '';
        i++;
      }
    } else if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
      // Inline array
      result[key] = parseInlineArray(rawValue);
      i++;
    } else {
      // Simple scalar
      result[key] = unquote(rawValue);
      i++;
    }
  }

  return { result, nextLine: i };
}

interface SequenceResult {
  items: YamlValue[];
  nextLine: number;
}

function parseSequence(lines: string[], startLine: number, minIndent: number): SequenceResult {
  const items: YamlValue[] = [];
  let i = startLine;

  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined) break;
    if (line.trim() === '' || line.trim().startsWith('#')) {
      i++;
      continue;
    }

    const indent = line.length - line.trimStart().length;
    if (indent < minIndent) break;

    const trimmedLine = line.trim();
    if (!trimmedLine.startsWith('- ')) break;

    const itemContent = trimmedLine.slice(2).trim();

    if (itemContent.includes(':')) {
      // Object item like `- key: value`
      const obj: YamlObject = {};
      const colonIdx = itemContent.indexOf(':');
      const k = itemContent.slice(0, colonIdx).trim();
      const v = itemContent.slice(colonIdx + 1).trim();
      obj[k] = unquote(v);

      // Check for continuation lines at deeper indent
      const nextNonEmpty = findNextNonEmptyLine(lines, i + 1);
      if (nextNonEmpty !== -1) {
        const nextLine = lines[nextNonEmpty];
        if (nextLine !== undefined) {
          const nextIndent = nextLine.length - nextLine.trimStart().length;
          if (nextIndent >= indent + 2 && !nextLine.trim().startsWith('- ')) {
            const { result: nested, nextLine: afterNested } = parseBlock(
              lines,
              nextNonEmpty,
              nextIndent,
            );
            Object.assign(obj, nested);
            i = afterNested;
            items.push(obj);
            continue;
          }
        }
      }

      items.push(obj);
      i++;
    } else {
      items.push(unquote(itemContent));
      i++;
    }
  }

  return { items, nextLine: i };
}

function parseMultilineScalar(
  lines: string[],
  startLine: number,
  parentIndent: number,
): { text: string; nextLine: number } {
  const parts: string[] = [];
  let i = startLine;

  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined) break;
    const indent = line.length - line.trimStart().length;
    if (line.trim() !== '' && indent <= parentIndent) break;
    parts.push(line.trim());
    i++;
  }

  return { text: parts.join('\n').trim(), nextLine: i };
}

function findNextNonEmptyLine(lines: string[], start: number): number {
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (line !== undefined && line.trim() !== '' && !line.trim().startsWith('#')) {
      return i;
    }
  }
  return -1;
}

function parseInlineArray(raw: string): string[] {
  const inner = raw.slice(1, -1).trim();
  if (inner === '') return [];
  return inner.split(',').map((item) => unquote(item.trim()));
}

function unquote(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}
