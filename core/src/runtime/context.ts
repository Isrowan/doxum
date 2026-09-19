import type { Infer, ObjectNode } from '../schema';
import type { DocumentRuntime } from './contract';
import type { RuntimeWriteDriver } from './driver';
import type { NotificationCenter } from './notification';

export type RuntimeState<TSchema extends ObjectNode> = {
  readonly schema: TSchema;
  document: Infer<TSchema>;
  disposed: boolean;
  projectionLocks?: number;
};

export type RuntimeContext<TSchema extends ObjectNode> = {
  readonly state: RuntimeState<TSchema>;
  readonly owner: DocumentRuntime<TSchema>;
  readonly notifications: NotificationCenter<TSchema>;
  driver: RuntimeWriteDriver | undefined;
  bypassDepth: number;
};

const contexts = new WeakMap<object, RuntimeContext<ObjectNode>>();

export const bindContext = <TSchema extends ObjectNode>(
  subject: object,
  context: RuntimeContext<TSchema>
): void => {
  contexts.set(subject, context as RuntimeContext<ObjectNode>);
};

export function contextOf<TSchema extends ObjectNode>(
  subject: object,
  required?: true
): RuntimeContext<TSchema>;
export function contextOf<TSchema extends ObjectNode>(
  subject: object,
  required: false
): RuntimeContext<TSchema> | undefined;
export function contextOf<TSchema extends ObjectNode>(
  subject: object,
  required = true
): RuntimeContext<TSchema> | undefined {
  const context = contexts.get(subject);
  if (!context && required) throw new Error('Unknown Doxum runtime.');
  return context as RuntimeContext<TSchema> | undefined;
}
