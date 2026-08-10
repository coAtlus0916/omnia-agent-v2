import fs from 'node:fs';
import { writeJsonAtomic, type RemoteConnectorPaths } from './managed-state.js';

export interface BaselineAdmissionJournal {
  schemaVersion: 'omnia.v5.connector-baseline-admission/v2';
  phase: 'prepared' | 'promoted' | 'admitted';
  version: string;
  sequence: number;
  epoch: string;
  executionGeneration: string;
  admittedAt: string;
  updatedAt: string;
}

export function validateBaselineAdmission(value: unknown): BaselineAdmissionJournal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Cold baseline admission journal is invalid.');
  }
  const journal = value as BaselineAdmissionJournal;
  if (journal.schemaVersion !== 'omnia.v5.connector-baseline-admission/v2'
    || !['prepared', 'promoted', 'admitted'].includes(journal.phase)
    || !/^\d+\.\d+\.\d+$/u.test(journal.version)
    || !Number.isSafeInteger(journal.sequence) || journal.sequence < 1
    || !/^[a-f0-9]{48}$/u.test(journal.epoch)
    || !/^[a-f0-9]{48}$/u.test(journal.executionGeneration)
    || (journal.phase === 'admitted' && !Number.isFinite(Date.parse(journal.admittedAt)))
    || (journal.phase !== 'admitted' && journal.admittedAt !== '')
    || !Number.isFinite(Date.parse(journal.updatedAt))) {
    throw new Error('Cold baseline admission journal is invalid.');
  }
  return journal;
}

export function readBaselineAdmission(paths: Pick<RemoteConnectorPaths, 'baselineAdmission'>): BaselineAdmissionJournal | null {
  try {
    return validateBaselineAdmission(JSON.parse(fs.readFileSync(paths.baselineAdmission, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error('Cold baseline admission journal is corrupt; Worker admission is fail-closed.');
  }
}

export function writeBaselineAdmission(
  paths: Pick<RemoteConnectorPaths, 'baselineAdmission'>,
  value: Omit<BaselineAdmissionJournal, 'schemaVersion'|'updatedAt'>
): BaselineAdmissionJournal {
  const journal = validateBaselineAdmission({
    schemaVersion: 'omnia.v5.connector-baseline-admission/v2',
    ...value,
    updatedAt: new Date().toISOString()
  });
  writeJsonAtomic(paths.baselineAdmission, journal);
  return journal;
}

export function requiresSealedBaselineRestart(
  journal: BaselineAdmissionJournal | null,
  managedCurrentVersion: string
): boolean {
  return Boolean(journal && journal.version === managedCurrentVersion && journal.phase !== 'admitted');
}
