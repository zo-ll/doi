/** Designs that are busy: a turn runs on them, or they are being renamed. */
export class DesignLocks {
  private readonly busy = new Set<string>();

  /** Locks all keys, or none of them when one is busy. */
  tryLock(...keys: string[]): boolean {
    if (keys.some((k) => this.busy.has(k))) return false;
    for (const k of keys) this.busy.add(k);
    return true;
  }

  unlock(...keys: string[]): void {
    for (const k of keys) this.busy.delete(k);
  }
}

export const designKey = (project: string, design: string) => `${project}/${design}`;
