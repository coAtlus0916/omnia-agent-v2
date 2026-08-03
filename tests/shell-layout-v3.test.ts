import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CoreDatabase } from '../src/main/database.ts';
import { createTestContentCipher } from '../src/main/content-cipher.ts';

test('shell.main v3 persists only menu splitter and feature-menu collapse', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-layout-v3-'));
  const database = new CoreDatabase(path.join(root, 'core.sqlite'), createTestContentCipher());
  try {
    const initial = database.getLayout();
    assert.equal(initial.layoutVersion, 3);
    assert.equal(initial.schemaVersion, 'omnia.layout-preference/v1');
    assert.equal(initial.collapsedPanels['feature-menu'], false);
    const collapsed = database.saveLayout(3200, true, initial.stateVersion);
    assert.equal(collapsed.featureNavigationBasisPoints, 3200);
    assert.equal(collapsed.collapsedPanels['feature-menu'], true);
    const restored = database.saveLayout(3200, false, collapsed.stateVersion);
    assert.equal(restored.collapsedPanels['feature-menu'], false);
    assert.equal(restored.layoutVersion, 3);
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('settings.main persists an independent navigation/content splitter', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-settings-layout-'));
  const database = new CoreDatabase(path.join(root, 'core.sqlite'), createTestContentCipher());
  try {
    const initial = database.getSettingsLayout();
    assert.equal(initial.surfaceId, 'settings.main');
    assert.equal(initial.settingsNavigationBasisPoints, 2200);
    const saved = database.saveSettingsLayout(2700, initial.stateVersion);
    assert.equal(saved.splitters['settings-navigation-content'], 2700);
    assert.throws(() => database.saveSettingsLayout(1200, saved.stateVersion), /设置导航宽度/);
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});
