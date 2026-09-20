import type { Infer, ObjectSchema, RootNodeOf } from '../schema/model';
import type { DocumentRuntime } from './contract';
import type { RuntimeWriteDriver } from './driver';
import type { NotificationCenter } from './notification';

export type RuntimeState<TSchema extends ObjectSchema<object>> = {
  readonly schema: RootNodeOf<TSchema>;
  document: Infer<TSchema>;
  disposed: boolean;
  projectionLocks: number;
};

export type RuntimeContext<TSchema extends ObjectSchema<object>> = {
  readonly state: RuntimeState<TSchema>;
  readonly owner: DocumentRuntime<TSchema>;
  readonly notifications: NotificationCenter<TSchema>;
  driver: RuntimeWriteDriver | undefined;
  bypassDepth: number;
};

const contexts = new WeakMap<object, RuntimeContext<ObjectSchema<object>>>();

export const bindContext = <TSchema extends ObjectSchema<object>>(
  subject: object,
  context: RuntimeContext<TSchema>
): void => {
  contexts.set(subject, context as unknown as RuntimeContext<ObjectSchema<object>>);
};

export function contextOf<TSchema extends ObjectSchema<object>>(
  subject: object,
  required?: true
): RuntimeContext<TSchema>;
export function contextOf<TSchema extends ObjectSchema<object>>(
  subject: object,
  required: false
): RuntimeContext<TSchema> | undefined;
export function contextOf<TSchema extends ObjectSchema<object>>(
  subject: object,
  required = true
): RuntimeContext<TSchema> | undefined {
  const context = contexts.get(subject);
  if (!context && required) throw new Error('Unknown Doxum runtime.');
  return context as unknown as RuntimeContext<TSchema> | undefined;
}
