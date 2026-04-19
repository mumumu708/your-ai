export interface ReflectionConfig {
  minHoursSinceLastReflection: number; // default 24
  minSessionsSinceLastReflection: number; // default 5
}

export const DEFAULT_REFLECTION_CONFIG: ReflectionConfig = {
  minHoursSinceLastReflection: 24,
  minSessionsSinceLastReflection: 5,
};

export class ReflectionTrigger {
  // biome-ignore lint/complexity/noUselessConstructor: explicit for bun coverage
  constructor() {}

  shouldReflect(params: {
    lastReflectionAt: number | null; // Unix ms, null = never reflected
    unreflectedSessionCount: number;
    config?: ReflectionConfig;
  }): boolean {
    const config = params.config || DEFAULT_REFLECTION_CONFIG;

    // Never reflected → trigger if enough sessions
    if (params.lastReflectionAt === null) {
      return params.unreflectedSessionCount >= config.minSessionsSinceLastReflection;
    }

    // Check both conditions
    const hoursSince = (Date.now() - params.lastReflectionAt) / 3_600_000;
    return (
      hoursSince >= config.minHoursSinceLastReflection &&
      params.unreflectedSessionCount >= config.minSessionsSinceLastReflection
    );
  }
}
