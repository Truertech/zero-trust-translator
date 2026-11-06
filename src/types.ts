/** One row of the offline id-to-name list. `id` is always stored lower-case. */
export interface PersonRecord {
  id: string;
  name: string;
}

/** One row the CSV reader skipped, and why. 1-based, counting the header as row 1. */
export interface SkippedRow {
  row: number;
  reason: string;
}

export interface ParsedPeopleCsv {
  imported: PersonRecord[];
  skipped: SkippedRow[];
}

/** Thrown when the CSV has no column the reader can use as the id. */
export class MissingIdColumnError extends Error {
  constructor() {
    super('The file has no "username" or "reference" column.');
    this.name = 'MissingIdColumnError';
  }
}
