import { Logger } from '../../../shared/logging/logger';
import type { OpenVikingClient } from '../openviking/openviking-client';

export interface GraphQueryResult {
  entity: string;
  relations: {
    target: string;
    reason: string;
    abstract: string;
    via?: string;
  }[];
}

/**
 * Light graph layer using OpenViking's link/relations + VikingFS files.
 * No separate graph database needed.
 */
export class EntityManager {
  private readonly logger = new Logger('EntityManager');

  constructor(private readonly ov: OpenVikingClient) {}

  /** Create or update an entity */
  async upsertEntity(
    name: string,
    description: string,
    properties?: Record<string, string>,
  ): Promise<string> {
    const slug = name.replace(/\s+/g, '-').toLowerCase();
    const uri = `viking://agent/graph/entities/${slug}`;

    const content = [
      `# ${name}`,
      '',
      description,
      '',
      properties
        ? Object.entries(properties)
            .map(([k, v]) => `- **${k}**: ${v}`)
            .join('\n')
        : '',
    ].join('\n');

    await this.ov.write(`${uri}/content.md`, content);
    this.logger.info('实体更新', { name, slug });
    return uri;
  }

  /** Add a relation between two entities */
  async addRelation(
    fromEntity: string,
    toEntity: string,
    relationType: string,
  ): Promise<void> {
    await this.ov.link(
      `viking://agent/graph/entities/${fromEntity}`,
      [`viking://agent/graph/entities/${toEntity}`],
      relationType,
    );
  }

  /** Link an entity to a memory URI */
  async linkToMemory(
    entitySlug: string,
    memoryUri: string,
    reason: string,
  ): Promise<void> {
    await this.ov.link(
      `viking://agent/graph/entities/${entitySlug}`,
      [memoryUri],
      `related_memory:${reason}`,
    );
  }

  /** Query an entity's relations up to given depth */
  async query(entitySlug: string, depth = 2): Promise<GraphQueryResult> {
    const uri = `viking://agent/graph/entities/${entitySlug}`;
    const result: GraphQueryResult = { entity: entitySlug, relations: [] };

    const relations = await this.ov.relations(uri);
    for (const rel of relations) {
      const abstract = await this.ov.abstract(rel.uri);
      result.relations.push({
        target: rel.uri,
        reason: rel.reason,
        abstract,
      });

      if (depth > 1) {
        const subRelations = await this.ov.relations(rel.uri);
        for (const sub of subRelations) {
          const subAbstract = await this.ov.abstract(sub.uri);
          result.relations.push({
            target: sub.uri,
            reason: sub.reason,
            abstract: subAbstract,
            via: rel.uri,
          });
        }
      }
    }

    return result;
  }
}
