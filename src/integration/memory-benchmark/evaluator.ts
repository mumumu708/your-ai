import type { LightLLMClient } from '../../kernel/agents/light-llm-client';
import type { QAItem } from './data-loader';

export interface EvalResult {
  questionIndex: number;
  question: string;
  expectedAnswer: string;
  actualAnswer: string;
  questionType: string;
  score: number;
  maxScore: number;
  pointScores: Array<{ description: string; maxScore: number; awarded: number }>;
  reasoning: string;
}

export interface BenchmarkReport {
  totalQuestions: number;
  totalScore: number;
  maxPossibleScore: number;
  scorePercent: number;
  byType: Record<string, { count: number; score: number; maxScore: number; percent: number }>;
  results: EvalResult[];
  failedQuestions: EvalResult[];
}

/**
 * Evaluate a single QA pair using LLM-based semantic matching.
 */
export async function evaluateAnswer(
  llm: LightLLMClient,
  qa: QAItem,
  actualAnswer: string,
  index: number,
): Promise<EvalResult> {
  const maxScore = qa.score_points ? qa.score_points.reduce((sum, p) => sum + p.score, 0) : 10;

  // For multiple choice questions, do exact match on option letter
  if (qa.options && qa.options.length > 0) {
    const expectedOption = qa.answer as string;
    // Extract option letter from actual answer (look for A/B/C/D)
    const optionMatch = actualAnswer.match(/\b([A-D])\b/);
    const actualOption = optionMatch?.[1] ?? '';
    const isCorrect = actualOption === expectedOption;

    return {
      questionIndex: index,
      question: qa.question,
      expectedAnswer: `${expectedOption}: ${qa.options.find((o) => o.option === expectedOption)?.content ?? ''}`,
      actualAnswer,
      questionType: qa.question_type,
      score: isCorrect ? maxScore : 0,
      maxScore,
      pointScores: [
        {
          description: '选择正确选项',
          maxScore,
          awarded: isCorrect ? maxScore : 0,
        },
      ],
      reasoning: isCorrect
        ? `正确选择了${expectedOption}`
        : `期望${expectedOption}，实际回答了${actualOption || '未识别到选项'}`,
    };
  }

  // For free-text answers, use LLM-based evaluation
  const scorePoints = qa.score_points ?? [{ description: '回答准确性', score: 10 }];

  const evalPrompt = `你是一个评分助手。请根据评分标准，对AI助手的回答进行打分。

问题：${qa.question}

标准答案：${qa.answer}

AI助手的回答：${actualAnswer}

评分标准（每个得分点独立判断）：
${scorePoints.map((p, i) => `${i + 1}. ${p.description}（${p.score}分）`).join('\n')}

请对每个得分点判断AI回答是否满足，输出JSON格式：
{
  "points": [
    {"index": 0, "awarded": <得分>, "reason": "<简要原因>"},
    ...
  ],
  "overall_reasoning": "<总体评价>"
}

注意：
- 如果AI回答包含了得分点要求的信息，即使表述不同也应给分
- 如果AI明确说"不知道"或"无法回答"，且标准答案也是"无法回答"，应给满分
- 只输出JSON，不要其他内容`;

  try {
    const result = await llm.complete({
      messages: [{ role: 'user', content: evalPrompt }],
    });

    const jsonMatch = result.content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return {
        questionIndex: index,
        question: qa.question,
        expectedAnswer: String(qa.answer),
        actualAnswer,
        questionType: qa.question_type,
        score: 0,
        maxScore,
        pointScores: scorePoints.map((p) => ({
          description: p.description,
          maxScore: p.score,
          awarded: 0,
        })),
        reasoning: `评分LLM输出无法解析: ${result.content.slice(0, 200)}`,
      };
    }

    const evalJson = JSON.parse(jsonMatch[0]) as {
      points: Array<{ index: number; awarded: number; reason: string }>;
      overall_reasoning: string;
    };

    const pointScores = scorePoints.map((p, i) => {
      const evalPoint = evalJson.points.find((ep) => ep.index === i);
      return {
        description: p.description,
        maxScore: p.score,
        awarded: Math.min(evalPoint?.awarded ?? 0, p.score),
      };
    });

    const totalAwarded = pointScores.reduce((sum, p) => sum + p.awarded, 0);

    return {
      questionIndex: index,
      question: qa.question,
      expectedAnswer: String(qa.answer),
      actualAnswer,
      questionType: qa.question_type,
      score: totalAwarded,
      maxScore,
      pointScores,
      reasoning: evalJson.overall_reasoning,
    };
  } catch (err) {
    return {
      questionIndex: index,
      question: qa.question,
      expectedAnswer: String(qa.answer),
      actualAnswer,
      questionType: qa.question_type,
      score: 0,
      maxScore,
      pointScores: scorePoints.map((p) => ({
        description: p.description,
        maxScore: p.score,
        awarded: 0,
      })),
      reasoning: `评分失败: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Generate a summary report from individual evaluation results.
 */
export function generateReport(results: EvalResult[]): BenchmarkReport {
  const totalScore = results.reduce((sum, r) => sum + r.score, 0);
  const maxPossibleScore = results.reduce((sum, r) => sum + r.maxScore, 0);

  const byType: BenchmarkReport['byType'] = {};
  for (const r of results) {
    if (!byType[r.questionType]) {
      byType[r.questionType] = { count: 0, score: 0, maxScore: 0, percent: 0 };
    }
    byType[r.questionType].count++;
    byType[r.questionType].score += r.score;
    byType[r.questionType].maxScore += r.maxScore;
  }
  for (const entry of Object.values(byType)) {
    entry.percent = entry.maxScore > 0 ? (entry.score / entry.maxScore) * 100 : 0;
  }

  const failedQuestions = results.filter((r) => r.score < r.maxScore * 0.5);

  return {
    totalQuestions: results.length,
    totalScore,
    maxPossibleScore,
    scorePercent: maxPossibleScore > 0 ? (totalScore / maxPossibleScore) * 100 : 0,
    byType,
    results,
    failedQuestions,
  };
}

/**
 * Format the benchmark report as a readable string.
 */
export function formatReport(report: BenchmarkReport): string {
  const lines: string[] = [];

  lines.push('═══════════════════════════════════════════');
  lines.push('        Memory Benchmark Report');
  lines.push('═══════════════════════════════════════════');
  lines.push('');
  lines.push(`总题数: ${report.totalQuestions}`);
  lines.push(
    `总得分: ${report.totalScore} / ${report.maxPossibleScore} (${report.scorePercent.toFixed(1)}%)`,
  );
  lines.push('');
  lines.push('── 按题型分 ──');
  for (const [type, stats] of Object.entries(report.byType)) {
    lines.push(
      `  ${type}: ${stats.score}/${stats.maxScore} (${stats.percent.toFixed(1)}%) [${stats.count}题]`,
    );
  }

  if (report.failedQuestions.length > 0) {
    lines.push('');
    lines.push(`── 低分题 (得分<50%) [${report.failedQuestions.length}题] ──`);
    for (const r of report.failedQuestions.slice(0, 20)) {
      lines.push(`  Q${r.questionIndex}: ${r.question.slice(0, 60)}...`);
      lines.push(`    得分: ${r.score}/${r.maxScore} | 类型: ${r.questionType}`);
      lines.push(`    期望: ${r.expectedAnswer.slice(0, 80)}`);
      lines.push(`    实际: ${r.actualAnswer.slice(0, 80)}`);
      lines.push(`    原因: ${r.reasoning.slice(0, 80)}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}
