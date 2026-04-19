import type {
  ConflictResolution,
  KnowledgeFragment,
  RuleClassification,
} from '../evolution/evolution-types';

interface ConflictPair {
  a: RegExp;
  b: RegExp;
}

const CONFLICT_PAIRS: ConflictPair[] = [
  { a: /简洁|concise|brief/i, b: /详细|detailed|verbose/i },
  { a: /正式|formal/i, b: /随意|casual|informal/i },
  { a: /保守|conservative/i, b: /积极|proactive|aggressive/i },
  { a: /中文/i, b: /english|英文/i },
];

const SAFETY_KEYWORDS = /安全|危险|禁止|不允许|不可以|safety|dangerous|forbidden|never|prohibited/i;
const COMPLIANCE_KEYWORDS = /合规|法律|法规|政策|compliance|legal|regulation|policy/i;
const STYLE_KEYWORDS =
  /风格|语气|格式|简洁|详细|正式|随意|style|tone|format|concise|verbose|formal|casual/i;
const PREFERENCE_KEYWORDS = /偏好|喜欢|习惯|prefer|like|always|usually|want/i;

// Default source priorities
const SOURCE_PRIORITY: Record<string, number> = {
  identity: 10,
  'soul.safety': 10,
  'soul.compliance': 10,
  'soul.style': 6,
  'soul.general': 8,
  'user.preference': 8,
  'user.style': 8,
  'user.general': 7,
  memory: 4,
  session: 2,
};

export class ConflictResolver {
  classifyRule(content: string): RuleClassification {
    if (SAFETY_KEYWORDS.test(content)) return 'safety';
    if (COMPLIANCE_KEYWORDS.test(content)) return 'compliance';
    if (STYLE_KEYWORDS.test(content)) return 'style';
    if (PREFERENCE_KEYWORDS.test(content)) return 'preference';
    return 'general';
  }

  detectConflict(a: KnowledgeFragment, b: KnowledgeFragment): boolean {
    for (const pair of CONFLICT_PAIRS) {
      if (
        (pair.a.test(a.content) && pair.b.test(b.content)) ||
        (pair.b.test(a.content) && pair.a.test(b.content))
      ) {
        return true;
      }
    }
    return false;
  }

  resolveConflict(a: KnowledgeFragment, b: KnowledgeFragment): ConflictResolution {
    const aClass = a.ruleClass ?? this.classifyRule(a.content);
    const bClass = b.ruleClass ?? this.classifyRule(b.content);

    // Safety/compliance rules: SOUL always wins
    if (
      (aClass === 'safety' || aClass === 'compliance') &&
      (a.source === 'soul' || a.source === 'identity')
    ) {
      return {
        winner: a,
        loser: b,
        reason: `Safety/compliance rule from ${a.source} takes precedence`,
      };
    }
    if (
      (bClass === 'safety' || bClass === 'compliance') &&
      (b.source === 'soul' || b.source === 'identity')
    ) {
      return {
        winner: b,
        loser: a,
        reason: `Safety/compliance rule from ${b.source} takes precedence`,
      };
    }

    // Style/preference rules: USER wins over SOUL
    if (
      aClass === 'style' ||
      aClass === 'preference' ||
      bClass === 'style' ||
      bClass === 'preference'
    ) {
      if (a.source === 'user' && b.source === 'soul') {
        return { winner: a, loser: b, reason: 'User style/preference overrides soul' };
      }
      if (b.source === 'user' && a.source === 'soul') {
        return { winner: b, loser: a, reason: 'User style/preference overrides soul' };
      }
    }

    // Same class: higher priority wins
    const aPriority = this.getEffectivePriority(a);
    const bPriority = this.getEffectivePriority(b);

    if (aPriority !== bPriority) {
      return aPriority > bPriority
        ? { winner: a, loser: b, reason: `Higher priority (${aPriority} > ${bPriority})` }
        : { winner: b, loser: a, reason: `Higher priority (${bPriority} > ${aPriority})` };
    }

    // Equal priority: default to first fragment (stable sort)
    return { winner: a, loser: b, reason: 'Equal priority, keeping first' };
  }

  resolve(fragments: KnowledgeFragment[]): {
    resolved: KnowledgeFragment[];
    conflicts: ConflictResolution[];
  } {
    if (fragments.length <= 1) {
      return { resolved: [...fragments], conflicts: [] };
    }

    const conflicts: ConflictResolution[] = [];
    const excluded = new Set<KnowledgeFragment>();

    // Check all pairs for conflicts
    for (let i = 0; i < fragments.length; i++) {
      for (let j = i + 1; j < fragments.length; j++) {
        const a = fragments[i]!;
        const b = fragments[j]!;

        if (excluded.has(a) || excluded.has(b)) continue;

        if (this.detectConflict(a, b)) {
          const resolution = this.resolveConflict(a, b);
          conflicts.push(resolution);
          excluded.add(resolution.loser);
        }
      }
    }

    const resolved = fragments.filter((f) => !excluded.has(f));
    return { resolved, conflicts };
  }

  private getEffectivePriority(fragment: KnowledgeFragment): number {
    const ruleClass = fragment.ruleClass ?? this.classifyRule(fragment.content);
    const key = `${fragment.source}.${ruleClass}`;
    return SOURCE_PRIORITY[key] ?? fragment.priority;
  }
}
