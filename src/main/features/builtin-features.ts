import path from 'node:path';
import type { FeaturePackageManager, FeatureInstallResult } from './package-manager.js';
import {
  BUILTIN_FEATURE_RELEASE_PROJECTION,
  verifyBuiltinFeatureReleaseFile
} from './builtin-release-inventory.js';

export const BUILTIN_FEATURES = BUILTIN_FEATURE_RELEASE_PROJECTION.runtimeCatalog;

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
    const verified = verifyBuiltinFeatureReleaseFile(filename, builtin);
    const existing = manager.installedVersion(builtin.featureId, builtin.version);
    const active = manager.list().find((item) => item.featureId === builtin.featureId);
    if (existing && active?.featureVersion !== builtin.version) {
      if (verified.packageDigest !== existing.packageDigest) {
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
    if (
      result.featureId !== builtin.featureId
      || result.featureVersion !== builtin.version
      || result.packageDigest !== builtin.packageDigest
    ) {
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
