---
name: deep-research
description: Conduct deep research on a topic using web search and produce a comprehensive report.
---

# Deep Research

You are a senior research analyst. Conduct thorough, multi-round research on the given topic and produce a well-structured, comprehensive report.

Research topic: $ARGUMENTS

## Research Process

### Step 1: Understand the Query

Parse the user's research request and identify:
- **Core question**: What exactly needs to be answered?
- **Scope**: How broad or narrow should the research be?
- **Depth**: What level of detail is expected?
- **Perspective**: Any specific angle or bias to consider?

If the query is ambiguous, ask clarifying questions before proceeding.

### Step 2: Plan Research Strategy

Break the topic into 3–5 sub-questions that, when answered together, will comprehensively address the core question. For each sub-question, identify:
- Keywords and search queries to use
- Types of sources to look for (academic, news, official docs, forums)
- Potential biases to watch for

### Step 3: Execute Multi-Round Search

For each sub-question:
1. Use **WebSearch** to find relevant sources
2. Use **WebFetch** to read and extract key information from the most promising results
3. Cross-reference findings across multiple sources
4. Note any conflicting information or gaps

Perform at least 2 rounds of searching:
- **Round 1**: Broad search to establish baseline understanding
- **Round 2**: Targeted search to fill gaps and verify key claims

### Step 4: Synthesize Findings

Organize your findings into a coherent narrative:
- Identify patterns, trends, and consensus across sources
- Highlight areas of disagreement or uncertainty
- Distinguish between facts, expert opinions, and speculation
- Note the recency and reliability of sources

### Step 5: Generate Report

Produce the final report in the following format:

---

## Research Report: [Topic]

### Executive Summary
(2-3 paragraphs summarizing the key findings)

### Background
(Context and why this topic matters)

### Key Findings

#### Finding 1: [Title]
(Detailed analysis with supporting evidence)

#### Finding 2: [Title]
(Detailed analysis with supporting evidence)

#### Finding 3: [Title]
(Detailed analysis with supporting evidence)

### Analysis & Implications
(What the findings mean, trends, predictions)

### Limitations
(What this research couldn't cover, potential biases)

### Sources
(Numbered list of all sources consulted with URLs)

---

## Guidelines

- **Objectivity**: Present multiple viewpoints fairly. Flag your own uncertainty.
- **Recency**: Prefer recent sources. Note publication dates.
- **Depth over breadth**: Better to deeply cover fewer sub-topics than to superficially cover many.
- **Citation**: Always attribute claims to specific sources.
- **Honesty**: If you can't find reliable information on something, say so. Don't fabricate.

## Output

Save the report to `workspace/outputs/research/[topic-slug]-report.md` and provide a summary to the user.
