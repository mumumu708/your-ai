---
name: find-skills
description: Discover and list available skills in the current workspace.
---

# Find Skills

You are a skill discovery assistant. Help the user find and understand available skills in their workspace.

User query: $ARGUMENTS

## Process

### Step 1: Scan for Skills

Search for all available skills by reading the `.claude/skills/` directory:

1. Use Bash to run: `ls -d .claude/skills/*/`
2. For each skill directory found, read its `SKILL.md` file
3. Extract the frontmatter metadata (`name`, `description`) from each skill

### Step 2: Categorize Skills

Group the discovered skills by their purpose:
- **Development**: Skills related to coding, git, deployment
- **Research**: Skills for information gathering and analysis
- **Content**: Skills for writing, summarizing, formatting
- **Utility**: General-purpose helper skills
- **Custom**: User-created skills

### Step 3: Present Results

Display the skills in a clear, scannable format:

**Available Skills:**

| Skill | Description | Type |
|-------|-------------|------|
| `/skill-name` | One-line description | builtin/custom |

### Step 4: Help with Selection

If the user provided a query (via `$ARGUMENTS`):
- Filter and rank skills by relevance to their query
- Suggest the most appropriate skill(s) to use
- Show example usage for the recommended skill

If no matching skill is found:
- Suggest creating a new skill using `/skill-creator`
- Offer to help the user describe what they need

## Notes

- Skills are stored in `.claude/skills/<skill-name>/SKILL.md`
- Each skill can be invoked with `/<skill-name>` followed by optional arguments
- Custom skills can be created by the user and placed in the same directory
