import type { ChangeSet } from '../changes';
import type { DocumentAddress, DocumentNode } from '../schema';
import * as address from '../address/resolve';
import type { CompiledMember } from '../schema/layout';
import * as schemaValue from '../schema/value';
import { ChangeRecorder } from './recorder';
import * as state from './state';
import * as issue from './issue';

export class MutationSession {
  readonly identity = {};
  generation = 0;
  readonly recorder: ChangeRecorder;
  private resolver;
  private resolvedRoot: unknown;
  constructor(readonly state: state.CanonicalState) {
    this.recorder = new ChangeRecorder(state);
    this.resolver = address.createAddressResolver(state.schema, state.document);
    this.resolvedRoot = state.document;
  }
  validate(node: DocumentNode, value: unknown, at: DocumentAddress): void {
    const failure = schemaValue.checkValue(node, value, at);
    if (failure) issue.invalidValue(failure);
  }
  resolveContainer(at: DocumentAddress): address.ResolvedContainer {
    return (
      this.resolver.container(this.identity, this.generation, at) ??
      issue.fail(at, 'invalid-address', 'Container does not exist.')
    );
  }
  /** Bind access-resolved canonical facts without walking the address again. */
  bind(
    at: DocumentAddress,
    node: DocumentNode | undefined,
    value: unknown
  ): address.ResolvedContainer {
    return (
      address.resolveContainer(this.identity, this.generation, at, node, value) ??
      issue.fail(at, 'invalid-address', 'Container does not exist.')
    );
  }
  bindTree(
    at: DocumentAddress,
    node: DocumentNode | undefined,
    value: unknown
  ): address.ResolvedTreeContainer {
    return (
      address.resolveTreeContainer(this.identity, this.generation, at, node, value) ??
      issue.fail(at, 'invalid-tree', 'Expected a tree.')
    );
  }
  resolveTree(at: DocumentAddress): address.ResolvedTreeContainer {
    const location = address.resolveValue(this.state.schema, this.state.document, at);
    return this.bindTree(at, location?.node, location?.value);
  }
  replace(at: DocumentAddress, value: unknown): void {
    if (!at.length) {
      this.validate(this.state.schema, value, at);
      if (Object.is(this.state.document, value)) return;
      this.recorder.reset();
      this.state.document = schemaValue.copyValue(this.state.schema, value);
      this.invalidate();
      return;
    }
    this.writeMember(this.resolveContainer(at.slice(0, -1)), at[at.length - 1], value, 'set');
  }
  assignMember(container: address.ResolvedContainer, key: string, value: unknown): void {
    container = this.refresh(container);
    const member = this.definition(container, key);
    if (
      container.layout.kind === 'fixed' &&
      member.node.kind !== 'field' &&
      member.node.kind !== 'variant' &&
      !member.node.optional
    )
      return issue.fail(
        container.at.concat(key),
        'invalid-value',
        'Replace fields, variants, or collection entries; edit object members individually.'
      );
    this.writeLocatedMember(
      container,
      key,
      member,
      address.memberKey(container, key),
      value,
      'set'
    );
  }
  removeMember(container: address.ResolvedContainer, key: string): void {
    this.writeMember(this.refresh(container), key, undefined, 'remove');
  }
  private refresh(container: address.ResolvedContainer): address.ResolvedContainer {
    if (container.owner !== this.identity)
      return issue.fail(
        container.at,
        'invalid-address',
        'Container belongs to another mutation session.'
      );
    return container.generation === this.generation
      ? container
      : this.resolveContainer(container.at);
  }
  definition(container: address.ResolvedContainer, key: string): CompiledMember {
    const layout = container.layout;
    const member = layout.kind === 'dynamic' ? layout.entry : layout.members.get(key);
    if (!member)
      return issue.fail(container.at.concat(key), 'invalid-address', 'Address does not exist.');
    return member;
  }
  /** Consume a current command-local container; bulk writes retain its storage. */
  writeMember(
    container: address.ResolvedContainer,
    key: string,
    value: unknown,
    operation: 'set' | 'remove',
    physicalKey = address.memberKey(container, key)
  ): boolean {
    const member = this.definition(container, key);
    return this.writeLocatedMember(container, key, member, physicalKey, value, operation);
  }
  /** Location and definition are resolved once by the calling operation. */
  private writeLocatedMember(
    container: address.ResolvedContainer,
    key: string,
    member: CompiledMember,
    physicalKey: string | number,
    value: unknown,
    operation: 'set' | 'remove'
  ): boolean {
    const parentNode = container.node;
    const node = member.node;
    const present = operation === 'set';
    if (parentNode.kind === 'variant' && parentNode.tag === key)
      return issue.fail(
        container.at.concat(key),
        'invalid-value',
        'Variant discriminants are read-only.'
      );
    const entry = container.layout.kind === 'dynamic';
    if (!present && !node.optional && !entry)
      return issue.fail(
        container.at.concat(key),
        'required-field',
        'A required value cannot be removed.'
      );
    const existed = Object.hasOwn(container.parent, physicalKey);
    const previous = (container.parent as Record<string | number, unknown>)[physicalKey];
    if (existed === present && (!present || Object.is(previous, value))) return false;
    if (parentNode.kind === 'map' || parentNode.kind === 'table') {
      const failure = schemaValue.checkKey(parentNode.key, key, []);
      if (failure)
        return issue.fail(
          container.at.concat(key, ...failure.address),
          'invalid-key',
          failure.message
        );
    }
    if (present) {
      if (node.kind === 'field') {
        const failure = schemaValue.checkValue(node, value, []);
        if (failure)
          return issue.invalidValue(failure, container.at.concat(key, ...failure.address));
      } else this.validate(node, value, container.at.concat(key));
      if (parentNode.kind === 'list' && parentNode.keyOf(value) !== key)
        return issue.fail(
          container.at.concat(key),
          'invalid-list-key',
          'Replacing an item must retain its addressed key.'
        );
    }
    const membershipChanged = entry && existed !== present;
    if (membershipChanged && (parentNode.kind === 'list' || parentNode.kind === 'table'))
      this.recorder.order(container);
    this.recorder.member(container, key, member, physicalKey);
    const next = present
      ? node.kind === 'field'
        ? value
        : schemaValue.copyValue(node, value)
      : undefined;
    state.installMember(container.parent, physicalKey, present, next);
    if (node.kind !== 'field' || membershipChanged) this.invalidate();
    return membershipChanged;
  }
  invalidate(): void {
    this.generation++;
    if (this.resolvedRoot !== this.state.document) {
      this.resolvedRoot = this.state.document;
      this.resolver = address.createAddressResolver(this.state.schema, this.state.document);
    } else this.resolver.invalidate();
  }
  finish(): ChangeSet {
    return this.recorder.seal();
  }
  rollback(): void {
    this.recorder.rollback();
    this.invalidate();
  }
}
