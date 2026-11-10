/**
 * Injectable ID generator.
 */
export interface IdGenerator {
  generate(): string;
}

export class UuidIdGenerator implements IdGenerator {
  generate(): string {
    return crypto.randomUUID();
  }
}
