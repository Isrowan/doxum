import type { ChangeSet } from '../changes';
import type { DocumentAddress, DocumentNode } from '../schema';
import {
  createAddressResolver,
  resolveContainer,
  memberKey,
  type CompiledMember,
  type ResolvedContainer,
} from '../address';
import { checkKey, checkValue, copyValue } from '../schema-value';
import { ChangeRecorder } from './recorder';
import { installMember, type CanonicalState } from './state';
import { fail, invalidValue } from './issue';
import * as tree from './tree';

export class MutationSession {
  readonly identity = {};
  generation = 0;
  readonly recorder: ChangeRecorder;
  private resolver;
  private resolvedRoot: unknown;
  constructor(readonly state: CanonicalState) {
    this.recorder = new ChangeRecorder(state);
    this.resolver = createAddressResolver(state.schema, state.document);
    this.resolvedRoot = state.document;
  }
  validate(node: DocumentNode, value: unknown, at: DocumentAddress): void {
    const issue = checkValue(node, value, at);
    if (issue) invalidValue(issue);
  }
  resolveContainer(at: DocumentAddress): ResolvedContainer {
    return (
      this.resolver.container(this.identity, this.generation, at) ??
      fail(at, 'invalid-address', 'Container does not exist.')
    );
  }
  /** Bind access-resolved canonical facts without walking the address again. */
  bind(at: DocumentAddress, node: DocumentNode | undefined, value: unknown): ResolvedContainer {
    return (
      resolveContainer(this.identity, this.generation, at, node, value) ??
      fail(at, 'invalid-address', 'Container does not exist.')
    );
  }
  replace(at: DocumentAddress, value: unknown): void {
    if (!at.length) {
      this.validate(this.state.schema, value, at);
      if (Object.is(this.state.document, value)) return;
      this.recorder.reset();
      this.state.document = copyValue(this.state.schema, value);
      this.invalidate();
      return;
    }
    this.writeMember(this.resolveContainer(at.slice(0, -1)), at[at.length - 1], value, 'set');
  }
  assignMember(container: ResolvedContainer, key: string, value: unknown): void {
    container = this.refresh(container);
    const member = this.definition(container, key);
    if (
      container.layout.kind === 'fixed' &&
      member.node.kind !== 'field' &&
      member.node.kind !== 'variant' &&
      !member.node.optional
    )
      return fail(
        container.at.concat(key),
        'invalid-value',
        'Replace fields, variants, or collection entries; edit object members individually.'
      );
    this.writeLocatedMember(container, key, member, memberKey(container, key), value, 'set');
  }
  removeMember(container: ResolvedContainer, key: string): void {
    this.writeMember(container, key, undefined, 'remove');
  }
  private refresh(container: ResolvedContainer): ResolvedContainer {
    if (container.owner !== this.identity)
      return fail(
        container.at,
        'invalid-address',
        'Container belongs to another mutation session.'
      );
    return container.generation === this.generation
      ? container
      : this.resolveContainer(container.at);
  }
  definition(container: ResolvedContainer, key: string): CompiledMember {
    const layout = container.layout;
    const member = layout.kind === 'dynamic' ? layout.entry : layout.members.get(key);
    if (!member)
      return fail(container.at.concat(key), 'invalid-address', 'Address does not exist.');
    return member;
  }
  private writeMember(
    container: ResolvedContainer,
    key: string,
    value: unknown,
    operation: 'set' | 'remove'
  ): boolean {
    container = this.refresh(container);
    const member = this.definition(container, key);
    return this.writeLocatedMember(
      container,
      key,
      member,
      memberKey(container, key),
      value,
      operation
    );
  }
  /** Location and definition are resolved once by the calling operation. */
  writeLocatedMember(
    container: ResolvedContainer,
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
      return fail(
        container.at.concat(key),
        'invalid-value',
        'Variant discriminants are read-only.'
      );
    const entry = container.layout.kind === 'dynamic';
    if (!present && !node.optional && !entry)
      return fail(
        container.at.concat(key),
        'required-field',
        'A required value cannot be removed.'
      );
    const existed = Object.hasOwn(container.parent, physicalKey);
    const previous = (container.parent as Record<string | number, unknown>)[physicalKey];
    if (existed === present && (!present || Object.is(previous, value))) return false;
    if (parentNode.kind === 'map' || parentNode.kind === 'table') {
      const issue = checkKey(parentNode.key, key, []);
      if (issue)
        return fail(container.at.concat(key, ...issue.address), 'invalid-key', issue.message);
    }
    if (present) {
      if (node.kind === 'field') {
        const issue = checkValue(node, value, []);
        if (issue) return invalidValue(issue, container.at.concat(key, ...issue.address));
      } else this.validate(node, value, container.at.concat(key));
      if (parentNode.kind === 'list' && parentNode.keyOf(value) !== key)
        return fail(
          container.at.concat(key),
          'invalid-list-key',
          'Replacing an item must retain its addressed key.'
        );
    }
    const membershipChanged = entry && existed !== present;
    if (membershipChanged && (parentNode.kind === 'list' || parentNode.kind === 'table'))
      this.recorder.order(container.at, parentNode, container.value);
    this.recorder.member(container, key, member, physicalKey);
    const next = present ? (node.kind === 'field' ? value : copyValue(node, value)) : undefined;
    installMember(container.parent, physicalKey, present, next);
    if (node.kind !== 'field' || membershipChanged) this.invalidate();
    return membershipChanged;
  }
  invalidate(): void {
    this.generation++;
    if (this.resolvedRoot !== this.state.document) {
      this.resolvedRoot = this.state.document;
      this.resolver = createAddressResolver(this.state.schema, this.state.document);
    } else this.resolver.invalidate();
  }
  resolveValue(at: DocumentAddress) {
    const location = this.resolver.read(at);
    if (!location || location.value === undefined)
      return fail(at, 'invalid-address', 'Container does not exist.');
    return location;
  }
  editTree(
    at: DocumentAddress,
    run: (
      value: tree.MutableTree,
      node: Extract<DocumentNode, { kind: 'tree' }>,
      capture: (ids: readonly string[]) => void
    ) => void
  ): void {
    const { node, value } = this.resolveValue(at);
    if (node.kind !== 'tree' || !tree.is(value))
      return fail(at, 'invalid-tree', 'Expected a tree.');
    run(value, node, ids => this.recorder.tree(at, value, ids));
    this.invalidate();
  }
  finish(): ChangeSet {
    return this.recorder.seal();
  }
  rollback(): void {
    this.recorder.rollback();
    this.invalidate();
  }
}
