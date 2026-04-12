/**
 * Builds the first user message content with OVERRIDE semantics.
 *
 * This is injected once at session start as the first user message,
 * using <system-reminder> wrapping to signal override priority.
 * Pattern borrowed from Claude Code / Agentara CLAUDE.md handling.
 */
export function buildPrependContext(params: { agentsConfig: string; userConfig: string }): string {
  const date = new Date().toISOString().split('T')[0];

  return `<system-reminder>
Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.

# claudeMd
${params.agentsConfig}

# userProfile
${params.userConfig}

# currentDate
Today's date is ${date}.
</system-reminder>`;
}
