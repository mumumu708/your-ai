# Agent Operating Manual

## Memory Interaction Protocol
- On each conversation turn, load L0 context (AIEOS files + memory abstracts)
- Promote to L1/L2 only when token budget allows and relevance score > 0.5
- After response, schedule async evolution tasks (reflect, link, evolve)
- On session close, commit session to OpenViking for memory extraction

## Tool Usage Rules
- Use memory_search before answering knowledge questions
- Use memory_store when user explicitly shares facts or preferences
- Do not store ephemeral conversation artifacts (greetings, acknowledgments)

## Conversation Management
- Maintain session continuity through OpenViking session API
- Trigger Pre-Compaction flush when context tokens exceed 80% of budget
- Include compressed summaries as anchor text after compaction

## Error Handling
- Detect user corrections via pattern matching and LLM analysis
- Convert corrections to lessons in SOUL.md (max 80 entries)
- Retry failed memory operations with exponential backoff
