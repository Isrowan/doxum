import type { DocumentAddress } from '../schema/model';

type AddressIndexNode<T> = {
  readonly children: Map<string, AddressIndexNode<T>>;
  readonly values: Set<T>;
};

export class AddressIndex<T> {
  private readonly root: AddressIndexNode<T> = { children: new Map(), values: new Set() };

  add(address: DocumentAddress, value: T, member?: string): void {
    let node = this.root;
    for (let index = 0; index < address.length + (member === undefined ? 0 : 1); index++) {
      const segment = index < address.length ? address[index] : member!;
      let child = node.children.get(segment);
      if (!child) {
        child = { children: new Map(), values: new Set() };
        node.children.set(segment, child);
      }
      node = child;
    }
    node.values.add(value);
  }

  delete(address: DocumentAddress, value: T, member?: string): void {
    const parents: AddressIndexNode<T>[] = [];
    let node = this.root;
    const segments = member === undefined ? address : [...address, member];
    for (const segment of segments) {
      const child = node.children.get(segment);
      if (!child) return;
      parents.push(node);
      node = child;
    }
    node.values.delete(value);
    for (
      let index = segments.length - 1;
      index >= 0 && !node.values.size && !node.children.size;
      index--
    ) {
      node = parents[index];
      node.children.delete(segments[index]);
    }
  }

  exact(address: DocumentAddress): ReadonlySet<T> | undefined {
    let node = this.root;
    for (const segment of address) {
      const child = node.children.get(segment);
      if (!child) return undefined;
      node = child;
    }
    return node.values;
  }

  hasAncestor(address: DocumentAddress, strict = false): boolean {
    let node = this.root;
    for (let index = 0; index < address.length; index++) {
      if (node.values.size) return true;
      const child = node.children.get(address[index]);
      if (!child) return false;
      node = child;
    }
    return !strict && node.values.size > 0;
  }

  someAncestor(address: DocumentAddress, predicate: (value: T) => boolean): boolean {
    let node = this.root;
    for (let index = 0; ; index++) {
      for (const value of node.values) if (predicate(value)) return true;
      if (index === address.length) return false;
      const child = node.children.get(address[index]);
      if (!child) return false;
      node = child;
    }
  }

  overlaps(address: DocumentAddress): boolean {
    let node = this.root;
    for (const segment of address) {
      if (node.values.size) return true;
      const child = node.children.get(segment);
      if (!child) return false;
      node = child;
    }
    return node.values.size > 0 || node.children.size > 0;
  }

  hasDescendant(address: DocumentAddress): boolean {
    let node = this.root;
    for (const segment of address) {
      const child = node.children.get(segment);
      if (!child) return false;
      node = child;
    }
    return node.values.size > 0 || node.children.size > 0;
  }

  query(
    visit: (value: T) => void,
    relation: 'overlap' | 'ancestors' | 'descendants' = 'overlap'
  ): (address: DocumentAddress, members?: readonly { readonly key: string }[]) => void {
    const visited = new Set<AddressIndexNode<T>>();
    const subtrees = new Set<AddressIndexNode<T>>();
    const values = (node: AddressIndexNode<T>) => {
      if (visited.has(node)) return;
      visited.add(node);
      node.values.forEach(visit);
    };
    const descend = (current: AddressIndexNode<T>): void => {
      if (subtrees.has(current)) return;
      subtrees.add(current);
      values(current);
      current.children.forEach(descend);
    };
    const terminal = (node: AddressIndexNode<T>) =>
      relation === 'ancestors' ? values(node) : descend(node);
    return (address, members) => {
      let node = this.root;
      for (const segment of address) {
        if (subtrees.has(node)) return;
        if (relation !== 'descendants') values(node);
        const child = node.children.get(segment);
        if (!child) return;
        node = child;
      }
      if (!members) terminal(node);
      else {
        if (relation !== 'descendants') values(node);
        for (const member of members) {
          const child = node.children.get(member.key);
          if (child) terminal(child);
        }
      }
    };
  }

  clear(): void {
    this.root.values.clear();
    this.root.children.clear();
  }
}
