import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import { Logger } from '../../shared/logging/logger';
import { SkillDeployer, type SkillFileOps } from '../skills/skill-deployer';
import { McpConfigGenerator, type WorkspaceContext } from './mcp-config-generator';

export interface WorkspacePath {
  /** User root directory (user-space/{userId}/), used as cwd for Claude CLI */
  absolutePath: string;
  claudeDir: string;
  settingsPath: string;
  memoryDir: string;
  mcpJsonPath: string;
  skillsDir: string;
}

export interface WorkspaceManagerOptions {
  baseDir?: string;
}

const DEFAULT_BASE_DIR = process.env.USER_SPACE_ROOT ?? 'user-space';

const CLAUDE_MD_TEMPLATE = `You have just been awakened by your user.

First read \`SOUL.md\` to recall who you are, your identity, principles, and capabilities.

@memory/SOUL.md

Then read \`USER.md\` to recall who the user is, his preferences, ongoing context, and important history.

@memory/USER.md

# CLAUDE.md

## Capabilities

- As Claude Code, you are the smartest coding agent in the world. You can code in any language, and you can use any library or framework. Use context7 to get the latest information.
- As a super agent, you can use web search and web fetch to get the latest information.
- Try your very best to use the any skills you could find or create to archive the goal of the user. Use \`find-skills\` to find the skills you need. Or use \`skill-creator\` to create a new skill to meet the user's needs.
- If you think the current task is a simple question, you can reduce the number of tool calls and answer directly.

## Folder Structure

\`\`\`
├── CLAUDE.md              # This file; workspace rules and conventions
├── .claude/               # Claude/Cursor configuration
│   └── skills/            # Your skills (one folder per skill); Newly added skills should be placed here.
├── memory/                # Session-loaded context (keep SOUL.md, USER.md under 1000 tokens each)
│   ├── SOUL.md            # Your identity, principles, capabilities
│   └── USER.md            # User preferences, context, history
├── wikis/                 # Knowledge base (Obsidian-style; see wiki skill)
└── workspace/             # Workspace root. All your work and outputs should be stored here.
    ├── projects/          # Git repos and code projects
    ├── uploads/           # Uploaded files: images, videos, audio, documents, etc.
    └── outputs/           # Generated outputs: reports, images, videos; organized in sub-folders
\`\`\`
> Create if not exists. Create subdirectories as needed.

### Conventions

- **memory/**: All UPPERCASE \`.md\` files here must be in English. Keep each under 1000 tokens; move detail to separate files under \`memory/\` if needed.
- **wikis/**: Local-first Markdown, bidirectional links, atomic notes. Refactoring requires explicit user approval; log changes in \`refactor-history.log\`.

## Session End Protocol

Before the session ends, **update \`memory/USER.md\`** and \`memory/SOUL.md\` if necessary:

- Memories and lessons you've learned are up-to-date with the latest context.
- Important details are not forgotten across sessions.
- Outdated or irrelevant information is cleaned up.

## Writing Style for \`memory/\` Files

Dense, telegraphic short sentences. No filler words ("You are", "You should", "Your goal is to"). Comma/semicolon-joined facts, not bullet lists. \`**Bold**\` paragraph titles instead of \`##\` headers. Prioritize information density and low token count.

## Notes

- All UPPERCASE \`.md\` files under \`memory/\` (e.g., \`SOUL.md\`, \`USER.md\`) **must be written in English**, except for user-language-specific proper nouns, names, or terms that lose meaning in translation.
- \`SOUL.md\` and \`USER.md\` are loaded into context every session. **Keep each file under 1000 tokens.** Be ruthless about deduplication and conciseness. Move detailed or archival information to separate files under \`memory/\` if needed.
`;

export class WorkspaceManager {
  private readonly logger = new Logger('WorkspaceManager');
  private readonly baseDir: string;
  private readonly mcpConfigGenerator = new McpConfigGenerator();

  constructor(options: WorkspaceManagerOptions = {}) {
    this.baseDir = resolve(options.baseDir ?? DEFAULT_BASE_DIR);
  }

  ensureWorkspace(userId: string): WorkspacePath {
    const paths = this.getWorkspacePath(userId);

    const dirs = [
      paths.absolutePath,
      paths.claudeDir,
      paths.skillsDir,
      paths.memoryDir,
      join(paths.absolutePath, 'wikis'),
      // workspace subdirectories for file uploads/outputs
      join(paths.absolutePath, 'workspace', 'uploads', 'images'),
      join(paths.absolutePath, 'workspace', 'uploads', 'documents'),
      join(paths.absolutePath, 'workspace', 'uploads', 'temp'),
      join(paths.absolutePath, 'workspace', 'outputs', 'generated'),
      join(paths.absolutePath, 'workspace', 'outputs', 'exports'),
      join(paths.absolutePath, 'workspace', 'projects'),
    ];

    for (const dir of dirs) {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
        this.logger.info('目录创建', { dir });
      }
    }

    // Generate CLAUDE.md if not present
    const claudeMdPath = join(paths.absolutePath, 'CLAUDE.md');
    if (!existsSync(claudeMdPath)) {
      writeFileSync(claudeMdPath, CLAUDE_MD_TEMPLATE, 'utf-8');
      this.logger.info('CLAUDE.md 生成', { path: claudeMdPath });
    }

    // Generate claude settings if not present
    if (!existsSync(paths.settingsPath)) {
      this.generateClaudeSettings(paths.settingsPath);
    }

    this.logger.info('工作空间就绪', { userId, path: paths.absolutePath });
    return paths;
  }

  /**
   * Initialize workspace with MCP configuration and skill deployment.
   * Called on first user message when session has no workspacePath.
   */
  initializeWithMcp(context: WorkspaceContext): WorkspacePath {
    const paths = this.ensureWorkspace(context.userId);

    // Generate MCP config files (.mcp.json + .claude/settings.json)
    const mcpContext: WorkspaceContext = {
      ...context,
      workspaceDir: paths.absolutePath,
    };
    this.mcpConfigGenerator.generate(mcpContext);

    // Deploy all skills (builtin + marketplace + custom) via SkillDeployer
    try {
      const fileOps: SkillFileOps = {
        existsSync: fs.existsSync,
        mkdirSync: (p, opts) => fs.mkdirSync(p, opts),
        cpSync: (src, dest, opts) => fs.cpSync(src, dest, opts),
        readdirSync: (p) =>
          fs.readdirSync(p, { withFileTypes: true }).map((e) => ({
            name: e.name,
            isFile: () => e.isFile(),
            isDirectory: () => e.isDirectory(),
          })),
        statSync: (p) => {
          const s = fs.statSync(p);
          return { isDirectory: () => s.isDirectory() };
        },
      };
      const builtinSkillsDir = resolve(import.meta.dir, '../../../skills/builtin');
      const deployer = new SkillDeployer({ builtinSkillsDir }, fileOps);
      deployer.deploy(paths.absolutePath, {
        userId: context.userId,
        tenantConfig: { enabledSkills: [] },
      });
    } catch (error) {
      this.logger.warn('SkillDeployer 执行失败', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    this.logger.info('MCP 配置已初始化', { userId: context.userId });
    return paths;
  }

  getWorkspacePath(userId: string): WorkspacePath {
    const absolutePath = join(this.baseDir, userId);
    const claudeDir = join(absolutePath, '.claude');
    const settingsPath = join(claudeDir, 'settings.json');
    const memoryDir = join(absolutePath, 'memory');
    const mcpJsonPath = join(absolutePath, '.mcp.json');
    const skillsDir = join(claudeDir, 'skills');

    return { absolutePath, claudeDir, settingsPath, memoryDir, mcpJsonPath, skillsDir };
  }

  generateClaudeSettings(settingsPath: string): void {
    const settings = {
      permissions: {
        allow: ['Read', 'Write', 'Edit'],
        deny: ['Bash(rm -rf /)', 'Bash(sudo *)'],
      },
      model: 'claude-sonnet-4-20250514',
      maxTokens: 4096,
    };

    const dir = join(settingsPath, '..');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
    this.logger.info('Claude settings 生成', { path: settingsPath });
  }
}
