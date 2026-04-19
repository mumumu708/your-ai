export interface AnalysisItem {
  content: string;
  type: 'fact' | 'preference' | 'constraint' | 'lesson' | 'method' | 'template' | 'troubleshooting';
}

export interface RoutedAnalysis {
  memories: AnalysisItem[]; // facts, preferences, constraints, lessons → memory
  skillCandidates: AnalysisItem[]; // methods, templates, troubleshooting → skill
}

export function routeAnalysis(items: AnalysisItem[]): RoutedAnalysis {
  const memories: AnalysisItem[] = [];
  const skillCandidates: AnalysisItem[] = [];

  for (const item of items) {
    switch (item.type) {
      case 'fact':
      case 'preference':
      case 'constraint':
      case 'lesson':
        memories.push(item);
        break;
      case 'method':
      case 'template':
      case 'troubleshooting':
        skillCandidates.push(item);
        break;
    }
  }

  return { memories, skillCandidates };
}
