import type { SourceDefinition } from '@/projection/definition';
import type { Scheduler } from '@/projection/graph/scheduler';
import type { SourceMaterialization } from './boundary';
import { createDocumentSourceRegistry } from './document';
import { createExternalSourceRegistry } from './external';
import { materializeInputSource } from './input';

export const createSourceRegistry = (scheduler: Scheduler) => {
  const documents = createDocumentSourceRegistry(scheduler);
  const external = createExternalSourceRegistry(scheduler, documents);

  return {
    materialize(definition: SourceDefinition): SourceMaterialization {
      switch (definition.source.kind) {
        case 'value-input':
        case 'collection-input':
          return materializeInputSource(scheduler, definition);
        case 'document':
          return documents.materialize(definition);
        case 'readable':
        case 'external-value':
        case 'external-collection':
          return external.materialize(definition);
      }
    },
    dispose() {
      const failures: unknown[] = [];
      try {
        external.dispose();
      } catch (error) {
        failures.push(error);
      }
      try {
        documents.dispose();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length) throw failures[0];
    },
  };
};
