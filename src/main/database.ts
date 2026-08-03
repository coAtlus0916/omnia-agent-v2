import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type {
  AiAttachmentCapability,
  AiProviderKind,
  AiSettingsSnapshot,
  ChatAttachment,
  ChatMessage,
  ConnectionSettingsSnapshot,
  LayoutPreference,
  SettingsLayoutPreference,
  UserViewPreference,
  WorkspaceObservation,
  WorkspaceSafetySnapshot
} from '../shared/contracts.js';
import { AppError } from '../shared/errors.js';
import type { ContentCipher } from './content-cipher.js';

const utcNow = () => new Date().toISOString();

export class CoreDatabase {
  readonly db: DatabaseSync;

  constructor(filename: string, private readonly contentCipher: ContentCipher) {
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;');
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
    const applied = new Set(
      (this.db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>)
        .map((row) => row.version)
    );
    const migrations: Array<[number, string]> = [
      [1, `
        CREATE TABLE user_preferences (
          profile_id TEXT PRIMARY KEY,
          ui_scale_percent INTEGER NOT NULL CHECK(ui_scale_percent BETWEEN 80 AND 130),
          state_version INTEGER NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE layout_preferences (
          profile_id TEXT NOT NULL,
          surface_id TEXT NOT NULL,
          layout_version INTEGER NOT NULL,
          rail_basis_points INTEGER NOT NULL CHECK(rail_basis_points BETWEEN 450 AND 1200),
          middle_basis_points INTEGER NOT NULL CHECK(middle_basis_points BETWEEN 1800 AND 4800),
          state_version INTEGER NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(profile_id, surface_id, layout_version)
        );
        CREATE TABLE connection_state (
          singleton INTEGER PRIMARY KEY CHECK(singleton=1),
          payload_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE keepalive_state (
          singleton INTEGER PRIMARY KEY CHECK(singleton=1),
          enabled INTEGER NOT NULL,
          interval_seconds INTEGER NOT NULL,
          enabled_at TEXT NOT NULL,
          last_attempt_at TEXT NOT NULL,
          last_success_at TEXT NOT NULL,
          last_error TEXT NOT NULL,
          next_attempt_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE workspace_observations (
          observation_id TEXT PRIMARY KEY,
          engagement_id TEXT NOT NULL,
          captured_at TEXT NOT NULL,
          payload_json TEXT NOT NULL
        );
        CREATE TABLE workspace_safety (
          singleton INTEGER PRIMARY KEY CHECK(singleton=1),
          enabled INTEGER NOT NULL,
          engagement_id TEXT NOT NULL,
          workspace_ids_json TEXT NOT NULL,
          authority_observation_id TEXT NOT NULL,
          state_version INTEGER NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE chat_sessions (
          session_id TEXT PRIMARY KEY,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE chat_messages (
          message_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES chat_sessions(session_id) ON DELETE CASCADE,
          role TEXT NOT NULL CHECK(role IN ('user','assistant')),
          content TEXT NOT NULL,
          status TEXT NOT NULL,
          error TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX chat_messages_session_created ON chat_messages(session_id, created_at, message_id);
      `],
      [2, `
        CREATE TABLE feature_registry (
          feature_id TEXT NOT NULL,
          feature_version TEXT NOT NULL,
          lifecycle TEXT NOT NULL CHECK(lifecycle IN ('candidate','active','disabled','previous','removed','rejected')),
          package_digest TEXT NOT NULL,
          publisher_key_id TEXT NOT NULL,
          health TEXT NOT NULL,
          activated_at TEXT NOT NULL,
          PRIMARY KEY(feature_id, feature_version)
        );
        CREATE TABLE documentation_registry (
          feature_id TEXT NOT NULL,
          feature_version TEXT NOT NULL,
          documentation_digest TEXT NOT NULL,
          lifecycle TEXT NOT NULL,
          activated_at TEXT NOT NULL,
          PRIMARY KEY(feature_id, feature_version),
          FOREIGN KEY(feature_id, feature_version) REFERENCES feature_registry(feature_id, feature_version)
        );
      `],
      [3, `
        ALTER TABLE user_preferences ADD COLUMN composer_height_px INTEGER NOT NULL DEFAULT 96
          CHECK(composer_height_px BETWEEN 72 AND 360);
        CREATE TABLE ai_provider_settings (
          singleton INTEGER PRIMARY KEY CHECK(singleton=1),
          provider TEXT NOT NULL CHECK(provider IN ('deepseek','custom')),
          base_url TEXT NOT NULL,
          model TEXT NOT NULL,
          attachment_capability TEXT NOT NULL CHECK(attachment_capability IN ('text_only','images','images_and_text')),
          api_key_ciphertext TEXT NOT NULL,
          state_version INTEGER NOT NULL,
          test_status TEXT NOT NULL CHECK(test_status IN ('untested','testing','success','failed')),
          test_message TEXT NOT NULL,
          tested_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE connection_settings (
          singleton INTEGER PRIMARY KEY CHECK(singleton=1),
          mode TEXT NOT NULL CHECK(mode IN ('local','remote')),
          remote_bridge_url TEXT NOT NULL,
          remote_pair_id TEXT NOT NULL,
          remote_token_ciphertext TEXT NOT NULL,
          state_version INTEGER NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE chat_attachments (
          attachment_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES chat_sessions(session_id) ON DELETE CASCADE,
          message_id TEXT REFERENCES chat_messages(message_id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          media_type TEXT NOT NULL,
          size INTEGER NOT NULL CHECK(size >= 0),
          sha256 TEXT NOT NULL,
          stored_path_ciphertext TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('staged','attached','removed','failed')),
          model_delivery TEXT NOT NULL DEFAULT 'not_attempted'
            CHECK(model_delivery IN ('not_attempted','sent','blocked','unconfirmed')),
          error TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX chat_attachments_session_status ON chat_attachments(session_id, status, created_at);
      `],
      [4, `
        CREATE TABLE feature_install_attempts (
          attempt_id TEXT PRIMARY KEY,
          package_path TEXT NOT NULL,
          package_digest TEXT NOT NULL,
          feature_id TEXT NOT NULL,
          feature_version TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('validating','staging','committing','completed','rejected','failed')),
          reason_code TEXT NOT NULL,
          reason TEXT NOT NULL,
          started_at TEXT NOT NULL,
          completed_at TEXT NOT NULL
        );
        CREATE TABLE feature_activation_heads (
          feature_id TEXT PRIMARY KEY,
          feature_version TEXT NOT NULL,
          activation_generation INTEGER NOT NULL,
          runtime_enabled INTEGER NOT NULL CHECK(runtime_enabled IN (0,1)),
          runtime_reason TEXT NOT NULL,
          package_path TEXT NOT NULL,
          package_digest TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(feature_id, feature_version) REFERENCES feature_registry(feature_id, feature_version)
        );
        CREATE TABLE feature_activation_events (
          event_id TEXT PRIMARY KEY,
          feature_id TEXT NOT NULL,
          from_version TEXT NOT NULL,
          to_version TEXT NOT NULL,
          event_type TEXT NOT NULL CHECK(event_type IN ('install','upgrade','rollback','disable')),
          activation_generation INTEGER NOT NULL,
          package_digest TEXT NOT NULL,
          occurred_at TEXT NOT NULL
        );
        CREATE TABLE feature_publisher_sequences (
          feature_id TEXT PRIMARY KEY,
          highest_sequence INTEGER NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE feature_runtime_messages (
          message_id TEXT PRIMARY KEY,
          feature_id TEXT NOT NULL,
          feature_version TEXT NOT NULL,
          surface_id TEXT NOT NULL,
          state_version INTEGER NOT NULL,
          payload_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `],
      [5, `
        ALTER TABLE documentation_registry ADD COLUMN physical_path TEXT NOT NULL DEFAULT '';
        ALTER TABLE feature_activation_heads ADD COLUMN documentation_path TEXT NOT NULL DEFAULT '';
      `],
      [6, `
        CREATE TABLE feature_runtime_events (
          event_id TEXT PRIMARY KEY,
          feature_id TEXT NOT NULL,
          feature_version TEXT NOT NULL,
          event_type TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('pending','completed','failed')),
          created_at TEXT NOT NULL,
          completed_at TEXT NOT NULL,
          error TEXT NOT NULL
        );
        CREATE TABLE managed_content_records (
          engagement_id TEXT NOT NULL,
          object_type TEXT NOT NULL,
          object_id TEXT NOT NULL,
          status TEXT NOT NULL,
          feature_id TEXT NOT NULL,
          feature_version TEXT NOT NULL,
          plan_id TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(engagement_id, object_type, object_id)
        );
        CREATE TABLE managed_content_changes (
          change_id TEXT PRIMARY KEY,
          engagement_id TEXT NOT NULL,
          object_type TEXT NOT NULL,
          object_id TEXT NOT NULL,
          change_type TEXT NOT NULL,
          feature_id TEXT NOT NULL,
          feature_version TEXT NOT NULL,
          plan_id TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          occurred_at TEXT NOT NULL
        );
      `],
      [7, `
        ALTER TABLE layout_preferences ADD COLUMN feature_navigation_collapsed INTEGER NOT NULL DEFAULT 0
          CHECK(feature_navigation_collapsed IN (0,1));
      `],
      [8, `
        INSERT OR IGNORE INTO layout_preferences(
          profile_id, surface_id, layout_version, rail_basis_points, middle_basis_points,
          feature_navigation_collapsed, state_version, updated_at
        )
        SELECT profile_id, surface_id, 3, rail_basis_points, middle_basis_points,
          feature_navigation_collapsed, state_version, updated_at
        FROM layout_preferences
        WHERE profile_id='local-user' AND surface_id='shell.main' AND layout_version=1;
      `]
    ];
    for (const [version, sql] of migrations) {
      if (applied.has(version)) continue;
      this.db.exec('BEGIN IMMEDIATE;');
      try {
        this.db.exec(sql);
        this.db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(version, utcNow());
        this.db.exec('COMMIT;');
      } catch (error) {
        this.db.exec('ROLLBACK;');
        throw error;
      }
    }
    this.ensureDefaults();
  }

  private ensureDefaults(): void {
    const now = utcNow();
    this.db.prepare(`
      INSERT OR IGNORE INTO user_preferences(profile_id, ui_scale_percent, state_version, updated_at)
      VALUES ('local-user', 100, 1, ?)
    `).run(now);
    this.db.prepare(`
      INSERT OR IGNORE INTO layout_preferences(
        profile_id, surface_id, layout_version, rail_basis_points, middle_basis_points,
        feature_navigation_collapsed, state_version, updated_at
      ) VALUES ('local-user', 'shell.main', 3, 650, 2850, 0, 1, ?)
    `).run(now);
    this.db.prepare(`
      INSERT OR IGNORE INTO layout_preferences(
        profile_id, surface_id, layout_version, rail_basis_points, middle_basis_points,
        feature_navigation_collapsed, state_version, updated_at
      ) VALUES ('local-user', 'settings.main', 1, 650, 2200, 0, 1, ?)
    `).run(now);
    this.db.prepare(`
      INSERT OR IGNORE INTO keepalive_state(
        singleton, enabled, interval_seconds, enabled_at, last_attempt_at, last_success_at, last_error, next_attempt_at, updated_at
      ) VALUES (1, 0, ?, '', '', '', '', '', ?)
    `).run(Math.max(30, Number(process.env.OMNIA_KEEPALIVE_INTERVAL_SECONDS) || 300), now);
    this.db.prepare(`
      INSERT OR IGNORE INTO workspace_safety(
        singleton, enabled, engagement_id, workspace_ids_json, authority_observation_id, state_version, updated_at
      ) VALUES (1, 0, '', '[]', '', 1, ?)
    `).run(now);
    const existing = this.db.prepare('SELECT session_id FROM chat_sessions ORDER BY created_at LIMIT 1').get() as
      | { session_id: string }
      | undefined;
    if (!existing) {
      const sessionId = randomUUID();
      this.db.prepare('INSERT INTO chat_sessions(session_id, created_at, updated_at) VALUES (?, ?, ?)').run(sessionId, now, now);
    }
    this.db.prepare(`
      INSERT OR IGNORE INTO ai_provider_settings(
        singleton, provider, base_url, model, attachment_capability, api_key_ciphertext,
        state_version, test_status, test_message, tested_at, updated_at
      ) VALUES(1, 'deepseek', 'https://api.deepseek.com/v1/', 'deepseek-chat', 'text_only', '', 1, 'untested', '', '', ?)
    `).run(now);
    this.db.prepare(`
      INSERT OR IGNORE INTO connection_settings(
        singleton, mode, remote_bridge_url, remote_pair_id, remote_token_ciphertext, state_version, updated_at
      ) VALUES(1, 'local', 'https://agent.labcaspian.com/v5-bridge/', '', '', 1, ?)
    `).run(now);
  }

  getPreference(): UserViewPreference {
    const row = this.db.prepare(`
      SELECT ui_scale_percent, state_version, updated_at FROM user_preferences WHERE profile_id='local-user'
    `).get() as { ui_scale_percent: number; state_version: number; updated_at: string };
    return {
      uiScalePercent: row.ui_scale_percent,
      stateVersion: row.state_version,
      updatedAt: row.updated_at
    };
  }

  getComposerHeight(): number {
    const row = this.db.prepare(`SELECT composer_height_px FROM user_preferences WHERE profile_id='local-user'`).get() as
      { composer_height_px: number };
    return Number(row.composer_height_px);
  }

  saveComposerHeight(heightPx: number): number {
    const normalized = Math.round(heightPx);
    if (!Number.isFinite(normalized) || normalized < 72 || normalized > 360) {
      throw new AppError('CHAT.INVALID_COMPOSER_HEIGHT', '输入区高度必须在 72 到 360 像素之间。');
    }
    this.db.prepare(`UPDATE user_preferences SET composer_height_px=?, updated_at=? WHERE profile_id='local-user'`)
      .run(normalized, utcNow());
    return normalized;
  }

  activeFeatureCount(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM feature_registry WHERE lifecycle='active'`).get() as { count: number };
    return Number(row.count);
  }

  savePreference(percent: number, expectedStateVersion: number): UserViewPreference {
    if (!Number.isInteger(percent) || percent < 80 || percent > 130 || percent % 5 !== 0) {
      throw new AppError('PREFERENCE.INVALID_SCALE', '缩放值必须是 80%–130% 之间的 5% 档位。');
    }
    const now = utcNow();
    const result = this.db.prepare(`
      UPDATE user_preferences
      SET ui_scale_percent=?, state_version=state_version+1, updated_at=?
      WHERE profile_id='local-user' AND state_version=?
    `).run(percent, now, expectedStateVersion);
    if (result.changes !== 1) throw new AppError('PREFERENCE.CONFLICT', '界面缩放已在另一个窗口更新，请刷新后重试。', true);
    return this.getPreference();
  }

  getLayout(): LayoutPreference {
    const row = this.db.prepare(`
      SELECT surface_id, layout_version, rail_basis_points, middle_basis_points,
        feature_navigation_collapsed, state_version, updated_at
      FROM layout_preferences WHERE profile_id='local-user' AND surface_id='shell.main' AND layout_version=3
    `).get() as {
      surface_id: 'shell.main';
      layout_version: 3;
      rail_basis_points: number;
      middle_basis_points: number;
      feature_navigation_collapsed: number;
      state_version: number;
      updated_at: string;
    };
    return {
      schemaVersion: 'omnia.layout-preference/v1',
      surfaceId: row.surface_id,
      layoutVersion: 3,
      splitters: { 'feature-menu-host': row.middle_basis_points },
      collapsedPanels: { 'feature-menu': row.feature_navigation_collapsed === 1 },
      featureNavigationBasisPoints: row.middle_basis_points,
      railBasisPoints: row.rail_basis_points,
      middleBasisPoints: row.middle_basis_points,
      featureNavigationCollapsed: row.feature_navigation_collapsed === 1,
      stateVersion: row.state_version,
      updatedAt: row.updated_at
    };
  }

  saveLayout(
    featureNavigationBasisPoints: number,
    featureNavigationCollapsedOrLegacyMiddle: boolean | number,
    expectedStateVersion: number
  ): LayoutPreference {
    const legacyCall = typeof featureNavigationCollapsedOrLegacyMiddle === 'number';
    const middle = legacyCall ? featureNavigationCollapsedOrLegacyMiddle : featureNavigationBasisPoints;
    const collapsed = legacyCall
      ? this.getLayout().collapsedPanels['feature-menu']
      : featureNavigationCollapsedOrLegacyMiddle;
    if (false) {
      throw new AppError('LAYOUT.INVALID_RAIL', '应用栏宽度超出允许范围。');
    }
    if (!Number.isInteger(middle) || middle < 1800 || middle > 4800) {
      throw new AppError('LAYOUT.INVALID_MIDDLE', '功能区宽度超出允许范围。');
    }
    const now = utcNow();
    const result = legacyCall
      ? this.db.prepare(`
          UPDATE layout_preferences
          SET rail_basis_points=?, middle_basis_points=?, feature_navigation_collapsed=?,
              state_version=state_version+1, updated_at=?
          WHERE profile_id='local-user' AND surface_id='shell.main' AND layout_version=3 AND state_version=?
        `).run(featureNavigationBasisPoints, middle, collapsed ? 1 : 0, now, expectedStateVersion)
      : this.db.prepare(`
          UPDATE layout_preferences
          SET middle_basis_points=?, feature_navigation_collapsed=?,
              state_version=state_version+1, updated_at=?
          WHERE profile_id='local-user' AND surface_id='shell.main' AND layout_version=3 AND state_version=?
        `).run(middle, collapsed ? 1 : 0, now, expectedStateVersion);
    if (result.changes !== 1) throw new AppError('LAYOUT.CONFLICT', '布局已在另一个窗口更新，请刷新后重试。', true);
    return this.getLayout();
  }

  getSettingsLayout(): SettingsLayoutPreference {
    const row = this.db.prepare(`
      SELECT middle_basis_points, state_version, updated_at
      FROM layout_preferences WHERE profile_id='local-user' AND surface_id='settings.main' AND layout_version=1
    `).get() as { middle_basis_points: number; state_version: number; updated_at: string };
    return {
      schemaVersion: 'omnia.layout-preference/v1',
      surfaceId: 'settings.main',
      layoutVersion: 1,
      splitters: { 'settings-navigation-content': row.middle_basis_points },
      settingsNavigationBasisPoints: row.middle_basis_points,
      stateVersion: row.state_version,
      updatedAt: row.updated_at
    };
  }

  saveSettingsLayout(settingsNavigationBasisPoints: number, expectedStateVersion: number): SettingsLayoutPreference {
    if (!Number.isInteger(settingsNavigationBasisPoints) || settingsNavigationBasisPoints < 1600 || settingsNavigationBasisPoints > 3600) {
      throw new AppError('LAYOUT.INVALID_SETTINGS_NAVIGATION', '设置导航宽度超出允许范围。');
    }
    const result = this.db.prepare(`
      UPDATE layout_preferences
      SET middle_basis_points=?, state_version=state_version+1, updated_at=?
      WHERE profile_id='local-user' AND surface_id='settings.main' AND layout_version=1 AND state_version=?
    `).run(settingsNavigationBasisPoints, utcNow(), expectedStateVersion);
    if (result.changes !== 1) throw new AppError('LAYOUT.CONFLICT', '设置布局已在另一个窗口更新，请刷新后重试。', true);
    return this.getSettingsLayout();
  }

  getConnectionPayload<T>(): T | null {
    const row = this.db.prepare('SELECT payload_json FROM connection_state WHERE singleton=1').get() as
      | { payload_json: string }
      | undefined;
    return row ? JSON.parse(this.contentCipher.decrypt(row.payload_json)) as T : null;
  }

  saveConnectionPayload(payload: unknown): void {
    const now = utcNow();
    this.db.prepare(`
      INSERT INTO connection_state(singleton, payload_json, updated_at) VALUES(1, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET payload_json=excluded.payload_json, updated_at=excluded.updated_at
    `).run(this.contentCipher.encrypt(JSON.stringify(payload)), now);
  }

  getKeepalive(): Omit<import('../shared/contracts.js').KeepaliveSnapshot, 'running'> {
    const row = this.db.prepare('SELECT * FROM keepalive_state WHERE singleton=1').get() as Record<string, any>;
    return {
      enabled: row.enabled === 1,
      intervalSeconds: Number(row.interval_seconds),
      enabledAt: String(row.enabled_at),
      lastAttemptAt: String(row.last_attempt_at),
      lastSuccessAt: String(row.last_success_at),
      lastError: String(row.last_error),
      nextAttemptAt: String(row.next_attempt_at)
    };
  }

  updateKeepalive(input: Partial<{
    enabled: boolean;
    enabledAt: string;
    lastAttemptAt: string;
    lastSuccessAt: string;
    lastError: string;
    nextAttemptAt: string;
  }>): void {
    const current = this.getKeepalive();
    const next = { ...current, ...input };
    this.db.prepare(`
      UPDATE keepalive_state SET
        enabled=?, enabled_at=?, last_attempt_at=?, last_success_at=?, last_error=?, next_attempt_at=?, updated_at=?
      WHERE singleton=1
    `).run(
      next.enabled ? 1 : 0,
      next.enabledAt,
      next.lastAttemptAt,
      next.lastSuccessAt,
      next.lastError,
      next.nextAttemptAt,
      utcNow()
    );
  }

  saveWorkspaceObservation(observation: WorkspaceObservation): void {
    this.db.prepare(`
      INSERT INTO workspace_observations(observation_id, engagement_id, captured_at, payload_json)
      VALUES (?, ?, ?, ?)
    `).run(
      observation.observationId,
      observation.engagementId,
      observation.capturedAt,
      this.contentCipher.encrypt(JSON.stringify(observation))
    );
  }

  getLatestWorkspaceObservation(engagementId: string): WorkspaceObservation | null {
    const row = this.db.prepare(`
      SELECT payload_json FROM workspace_observations
      WHERE engagement_id=? ORDER BY captured_at DESC, rowid DESC LIMIT 1
    `).get(engagementId) as { payload_json: string } | undefined;
    return row ? JSON.parse(this.contentCipher.decrypt(row.payload_json)) as WorkspaceObservation : null;
  }

  getSafety(): WorkspaceSafetySnapshot {
    const row = this.db.prepare('SELECT * FROM workspace_safety WHERE singleton=1').get() as Record<string, any>;
    return {
      enabled: row.enabled === 1,
      engagementId: String(row.engagement_id),
      workspaceIds: JSON.parse(String(row.workspace_ids_json)) as string[],
      authorityObservationId: String(row.authority_observation_id),
      stateVersion: Number(row.state_version),
      updatedAt: String(row.updated_at),
      validForCurrentConnection: false,
      invalidReason: ''
    };
  }

  saveSafety(input: {
    enabled: boolean;
    engagementId: string;
    workspaceIds: string[];
    authorityObservationId: string;
    expectedStateVersion: number;
  }): WorkspaceSafetySnapshot {
    const now = utcNow();
    const result = this.db.prepare(`
      UPDATE workspace_safety SET
        enabled=?, engagement_id=?, workspace_ids_json=?, authority_observation_id=?,
        state_version=state_version+1, updated_at=?
      WHERE singleton=1 AND state_version=?
    `).run(
      input.enabled ? 1 : 0,
      input.engagementId,
      JSON.stringify(input.workspaceIds),
      input.authorityObservationId,
      now,
      input.expectedStateVersion
    );
    if (result.changes !== 1) throw new AppError('SAFETY.CONFLICT', '安全锁已被更新，请刷新后重试。', true);
    return this.getSafety();
  }

  getChatSessionId(): string {
    const row = this.db.prepare('SELECT session_id FROM chat_sessions ORDER BY created_at LIMIT 1').get() as { session_id: string };
    return row.session_id;
  }

  createMessage(input: {
    sessionId: string;
    role: 'user' | 'assistant';
    content: string;
    status: ChatMessage['status'];
    error?: string;
  }): ChatMessage {
    const message: ChatMessage = {
      id: randomUUID(),
      sessionId: input.sessionId,
      role: input.role,
      content: input.content,
      status: input.status,
      error: input.error || '',
      createdAt: utcNow(),
      attachments: []
    };
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db.prepare(`
        INSERT INTO chat_messages(message_id, session_id, role, content, status, error, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        message.id,
        message.sessionId,
        message.role,
        this.contentCipher.encrypt(message.content),
        message.status,
        message.error,
        message.createdAt
      );
      this.db.prepare('UPDATE chat_sessions SET updated_at=? WHERE session_id=?').run(message.createdAt, message.sessionId);
      this.db.exec('COMMIT;');
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
    return message;
  }

  createAttachment(input: {
    sessionId: string;
    name: string;
    mediaType: string;
    size: number;
    sha256: string;
    storedPath: string;
    status?: ChatAttachment['status'];
    error?: string;
  }): ChatAttachment {
    const now = utcNow();
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO chat_attachments(
        attachment_id, session_id, message_id, name, media_type, size, sha256,
        stored_path_ciphertext, status, error, created_at, updated_at
      ) VALUES(?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.sessionId, input.name, input.mediaType, input.size, input.sha256,
      this.contentCipher.encrypt(input.storedPath), input.status || 'staged', input.error || '', now, now
    );
    return this.getAttachment(id)!;
  }

  getAttachment(id: string): (ChatAttachment & { storedPath: string; sessionId: string }) | null {
    const row = this.db.prepare(`SELECT * FROM chat_attachments WHERE attachment_id=?`).get(id) as
      Record<string, any> | undefined;
    if (!row) return null;
    return this.mapAttachment(row);
  }

  listStagedAttachments(sessionId: string): ChatAttachment[] {
    return (this.db.prepare(`
      SELECT * FROM chat_attachments
      WHERE session_id=? AND status IN ('staged','failed')
      ORDER BY created_at, attachment_id
    `).all(sessionId) as Array<Record<string, any>>).map((row) => this.mapAttachment(row));
  }

  private mapAttachment(row: Record<string, any>): ChatAttachment & { storedPath: string; sessionId: string } {
    const mediaType = String(row.media_type);
    return {
      id: String(row.attachment_id),
      sessionId: String(row.session_id),
      messageId: String(row.message_id || ''),
      name: String(row.name),
      mediaType,
      size: Number(row.size),
      sha256: String(row.sha256),
      status: row.status as ChatAttachment['status'],
      modelDelivery: row.model_delivery as ChatAttachment['modelDelivery'],
      error: String(row.error),
      previewable: mediaType.startsWith('image/') || mediaType.startsWith('text/') || mediaType === 'application/pdf',
      createdAt: String(row.created_at),
      storedPath: this.contentCipher.decrypt(String(row.stored_path_ciphertext))
    };
  }

  attachToMessage(sessionId: string, messageId: string, attachmentIds: string[]): void {
    if (attachmentIds.length === 0) return;
    const update = this.db.prepare(`
      UPDATE chat_attachments SET message_id=?, status='attached', error='', updated_at=?
      WHERE attachment_id=? AND session_id=? AND status='staged'
    `);
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      for (const id of attachmentIds) {
        const result = update.run(messageId, utcNow(), id, sessionId);
        if (result.changes !== 1) throw new AppError('CHAT.ATTACHMENT_NOT_STAGED', '附件已被移除或不属于当前会话。');
      }
      this.db.exec('COMMIT;');
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }

  updateAttachment(id: string, status: ChatAttachment['status'], error = ''): void {
    this.db.prepare(`UPDATE chat_attachments SET status=?, error=?, updated_at=? WHERE attachment_id=?`)
      .run(status, error, utcNow(), id);
  }

  updateAttachmentDelivery(id: string, delivery: ChatAttachment['modelDelivery'], error = ''): void {
    this.db.prepare(`UPDATE chat_attachments SET model_delivery=?, error=?, updated_at=? WHERE attachment_id=?`)
      .run(delivery, error, utcNow(), id);
  }

  listMessageAttachments(messageId: string): ChatAttachment[] {
    return (this.db.prepare(`
      SELECT * FROM chat_attachments WHERE message_id=? AND status='attached' ORDER BY created_at, attachment_id
    `).all(messageId) as Array<Record<string, any>>).map((row) => this.mapAttachment(row));
  }

  getAiSettings(): AiSettingsSnapshot & { apiKey: string } {
    const row = this.db.prepare(`SELECT * FROM ai_provider_settings WHERE singleton=1`).get() as Record<string, any>;
    const apiKey = row.api_key_ciphertext ? this.contentCipher.decrypt(String(row.api_key_ciphertext)) : '';
    return {
      provider: row.provider as AiProviderKind,
      baseUrl: String(row.base_url),
      model: String(row.model),
      attachmentCapability: row.attachment_capability as AiAttachmentCapability,
      hasApiKey: Boolean(apiKey),
      apiKey,
      stateVersion: Number(row.state_version),
      updatedAt: String(row.updated_at),
      testStatus: row.test_status,
      testMessage: String(row.test_message),
      testedAt: String(row.tested_at)
    };
  }

  saveAiSettings(input: {
    provider: AiProviderKind;
    baseUrl: string;
    model: string;
    attachmentCapability: AiAttachmentCapability;
    apiKey?: string;
    clearApiKey?: boolean;
    expectedStateVersion: number;
  }): AiSettingsSnapshot {
    const current = this.getAiSettings();
    const apiKey = input.clearApiKey ? '' : input.apiKey === undefined ? current.apiKey : input.apiKey.trim();
    const now = utcNow();
    const result = this.db.prepare(`
      UPDATE ai_provider_settings SET provider=?, base_url=?, model=?, attachment_capability=?,
        api_key_ciphertext=?, state_version=state_version+1, test_status='untested',
        test_message='', tested_at='', updated_at=?
      WHERE singleton=1 AND state_version=?
    `).run(
      input.provider, input.baseUrl, input.model, input.attachmentCapability,
      apiKey ? this.contentCipher.encrypt(apiKey) : '', now, input.expectedStateVersion
    );
    if (result.changes !== 1) throw new AppError('SETTINGS.CONFLICT', '设置已在其他窗口更新，请刷新后重试。', true);
    const { apiKey: _secret, ...snapshot } = this.getAiSettings();
    return snapshot;
  }

  updateAiTest(status: AiSettingsSnapshot['testStatus'], message: string): void {
    const now = utcNow();
    this.db.prepare(`
      UPDATE ai_provider_settings SET test_status=?, test_message=?, tested_at=?, updated_at=? WHERE singleton=1
    `).run(status, message.slice(0, 1000), now, now);
  }

  publicAiSettings(): AiSettingsSnapshot {
    const { apiKey: _secret, ...snapshot } = this.getAiSettings();
    return snapshot;
  }

  getConnectionSettings(): ConnectionSettingsSnapshot & { remoteToken: string } {
    const row = this.db.prepare(`SELECT * FROM connection_settings WHERE singleton=1`).get() as Record<string, any>;
    const remoteToken = row.remote_token_ciphertext
      ? this.contentCipher.decrypt(String(row.remote_token_ciphertext))
      : '';
    return {
      mode: row.mode,
      remoteBridgeUrl: String(row.remote_bridge_url),
      remotePairId: String(row.remote_pair_id),
      remotePaired: Boolean(remoteToken),
      remoteToken,
      stateVersion: Number(row.state_version),
      updatedAt: String(row.updated_at)
    };
  }

  saveRemotePairing(input: {
    bridgeUrl: string;
    pairId: string;
    token: string;
    expectedStateVersion: number;
  }): ConnectionSettingsSnapshot {
    const now = utcNow();
    const result = this.db.prepare(`
      UPDATE connection_settings SET remote_bridge_url=?, remote_pair_id=?, remote_token_ciphertext=?,
        state_version=state_version+1, updated_at=? WHERE singleton=1 AND state_version=?
    `).run(
      input.bridgeUrl, input.pairId, this.contentCipher.encrypt(input.token), now, input.expectedStateVersion
    );
    if (result.changes !== 1) throw new AppError('SETTINGS.CONFLICT', '连接设置已在其他窗口更新，请刷新后重试。', true);
    return this.publicConnectionSettings();
  }

  saveConnectionMode(mode: 'local' | 'remote', expectedStateVersion: number): ConnectionSettingsSnapshot {
    const now = utcNow();
    const result = this.db.prepare(`
      UPDATE connection_settings SET mode=?, state_version=state_version+1, updated_at=?
      WHERE singleton=1 AND state_version=?
    `).run(mode, now, expectedStateVersion);
    if (result.changes !== 1) throw new AppError('SETTINGS.CONFLICT', '连接设置已在其他窗口更新，请刷新后重试。', true);
    return this.publicConnectionSettings();
  }

  publicConnectionSettings(): ConnectionSettingsSnapshot {
    const { remoteToken: _secret, ...snapshot } = this.getConnectionSettings();
    return snapshot;
  }

  updateMessage(id: string, status: ChatMessage['status'], error = ''): void {
    this.db.prepare('UPDATE chat_messages SET status=?, error=? WHERE message_id=?').run(status, error, id);
  }

  listMessages(sessionId: string): ChatMessage[] {
    return (this.db.prepare(`
      SELECT message_id, session_id, role, content, status, error, created_at
      FROM chat_messages WHERE session_id=? ORDER BY created_at, message_id
    `).all(sessionId) as Array<Record<string, any>>).map((row) => ({
      id: String(row.message_id),
      sessionId: String(row.session_id),
      role: row.role as 'user' | 'assistant',
      content: this.contentCipher.decrypt(String(row.content)),
      status: row.status as ChatMessage['status'],
      error: String(row.error),
      createdAt: String(row.created_at)
    })).map((message) => ({
      ...message,
      attachments: this.listMessageAttachments(message.id)
    }));
  }
}
