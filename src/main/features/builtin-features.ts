import fs from 'node:fs';
import path from 'node:path';
import type { FeaturePackageManager, FeatureInstallResult } from './package-manager.js';
import { packageDigest, verifyOfficialPackage } from './official-package.js';

export const BUILTIN_FEATURES = Object.freeze([
  { featureId: 'omnia.recording', version: '0.3.0', filename: 'recording-0.3.0.ofp', sourceDirectory: 'recording' },
  { featureId: 'omnia.create-associate', version: '0.2.36', filename: 'create-associate-0.2.36.ofp', sourceDirectory: 'create-associate' },
  { featureId: 'omnia.delete-elements', version: '0.2.1', filename: 'delete-elements-0.2.1.ofp', sourceDirectory: 'delete-elements' }
]);

export interface BuiltinFeatureBootstrapResult {
  featureId: string;
  targetVersion: string;
  activeVersion: string;
  packageDigest: string;
  action: 'installed' | 'already-active' | 'preserved-rollback';
  installResult: FeatureInstallResult | null;
}

export function installBuiltinFeaturePackages(
  manager: FeaturePackageManager,
  applicationRoot: string,
  packaged: boolean
): BuiltinFeatureBootstrapResult[] {
  return BUILTIN_FEATURES.map((builtin) => {
    const filename = packaged
      ? path.join(applicationRoot, 'builtins', builtin.filename)
      : path.join(applicationRoot, 'feature-packages', builtin.sourceDirectory, 'candidates', builtin.filename);
    if (!fs.existsSync(filename)) throw new Error(`Built-in Feature package is missing: ${filename}`);
    const existing = manager.installedVersion(builtin.featureId, builtin.version);
    const active = manager.list().find((item) => item.featureId === builtin.featureId);
    if (existing && active?.featureVersion !== builtin.version) {
      const envelope = verifyOfficialPackage(JSON.parse(fs.readFileSync(filename, 'utf8')) as unknown, 'omnia-feature');
      if (packageDigest(envelope) !== existing.packageDigest) {
        throw new Error(`Built-in Feature immutable bytes mismatch: ${filename}`);
      }
      return {
        featureId: builtin.featureId,
        targetVersion: builtin.version,
        activeVersion: active?.featureVersion || '',
        packageDigest: existing.packageDigest,
        action: 'preserved-rollback',
        installResult: null
      };
    }
    const result = manager.install(filename);
    if (result.featureId !== builtin.featureId || result.featureVersion !== builtin.version) {
      throw new Error(`Built-in Feature identity mismatch: ${filename}`);
    }
    return {
      featureId: result.featureId,
      targetVersion: result.featureVersion,
      activeVersion: result.featureVersion,
      packageDigest: result.packageDigest,
      action: result.idempotent ? 'already-active' : 'installed',
      installResult: result
    };
  });
}
