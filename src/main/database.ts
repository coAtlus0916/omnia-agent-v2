import { createHash, randomUUID } from 'node:crypto';
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
const defaultRemoteBridgeUrl = () => process.env.OMNIA_V5_REMOTE_BRIDGE_URL || 'https://agent.labcaspian.com/v5-bridge/';

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
      `],
      [9, `
        CREATE TABLE remote_binding_settings (
          singleton INTEGER PRIMARY KEY CHECK(singleton=1),
          bridge_url TEXT NOT NULL,
          pair_id TEXT NOT NULL,
          connector_id TEXT NOT NULL,
          connector_name TEXT NOT NULL,
          connector_version TEXT NOT NULL,
          protocol_version TEXT NOT NULL,
          generation INTEGER NOT NULL CHECK(generation >= 0),
          token_ciphertext TEXT NOT NULL,
          lifecycle TEXT NOT NULL CHECK(lifecycle IN ('unpaired','bound','repair_required','revoked')),
          state_version INTEGER NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE connector_migration_audit (
          audit_id TEXT PRIMARY KEY,
          migration_version INTEGER NOT NULL,
          legacy_mode TEXT NOT NULL,
          decision TEXT NOT NULL,
          legacy_connection_snapshot_ciphertext TEXT NOT NULL,
          occurred_at TEXT NOT NULL
        );
        INSERT INTO remote_binding_settings(
          singleton, bridge_url, pair_id, connector_id, connector_name, connector_version,
          protocol_version, generation, token_ciphertext, lifecycle, state_version, updated_at
        )
        SELECT 1, remote_bridge_url,
          CASE WHEN mode='remote' AND remote_token_ciphertext!='' THEN remote_pair_id ELSE '' END,
          '', '', '',
          CASE WHEN mode='remote' AND remote_token_ciphertext!='' THEN 'omnia.v5.remote-connector/v1' ELSE '' END,
          CASE WHEN mode='remote' AND remote_token_ciphertext!='' THEN 1 ELSE 0 END,
          CASE WHEN mode='remote' AND remote_token_ciphertext!='' THEN remote_token_ciphertext ELSE '' END,
          CASE WHEN mode='remote' AND remote_token_ciphertext!='' THEN 'bound' ELSE 'unpaired' END,
          state_version + 1, strftime('%Y-%m-%dT%H:%M:%fZ','now')
        FROM connection_settings WHERE singleton=1;
      `],
      [10, `
        DROP TABLE connection_settings;
      `],
      [11, `
        CREATE TABLE remote_pairing_pending (
          singleton INTEGER PRIMARY KEY CHECK(singleton=1),
          session_id TEXT NOT NULL,
          poll_secret_ciphertext TEXT NOT NULL,
          bridge_url TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          expected_pair_id TEXT NOT NULL,
          expected_generation INTEGER NOT NULL,
          expected_binding_state TEXT NOT NULL,
          expected_state_version INTEGER NOT NULL,
          matched_pair_id TEXT NOT NULL,
          matched_token_ciphertext TEXT NOT NULL,
          matched_generation INTEGER NOT NULL,
          matched_connector_id TEXT NOT NULL,
          matched_connector_name TEXT NOT NULL,
          matched_connector_version TEXT NOT NULL,
          commit_required INTEGER NOT NULL CHECK(commit_required IN (0,1)),
          cleanup_required INTEGER NOT NULL CHECK(cleanup_required IN (0,1)),
          status TEXT NOT NULL CHECK(status IN ('creating','active','corrupt','manual_reconcile_required','manual_cleanup_required')),
          session_id_hash TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE remote_revocation_pending (
          singleton INTEGER PRIMARY KEY CHECK(singleton=1),
          bridge_url TEXT NOT NULL,
          pair_id TEXT NOT NULL,
          token_ciphertext TEXT NOT NULL,
          requested_at TEXT NOT NULL,
          last_attempt_at TEXT NOT NULL,
          last_error TEXT NOT NULL,
          attempts INTEGER NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('active','manual_revoke_required'))
        );
        CREATE TABLE remote_binding_events (
          event_id TEXT PRIMARY KEY,
          event_type TEXT NOT NULL,
          pair_id TEXT NOT NULL,
          generation INTEGER NOT NULL,
          previous_pair_id TEXT NOT NULL,
          details_json TEXT NOT NULL,
          occurred_at TEXT NOT NULL
        );
      `],
      [12, `
        CREATE TABLE feature_runs (
          run_id TEXT PRIMARY KEY,
          trace_id TEXT NOT NULL UNIQUE,
          feature_id TEXT NOT NULL,
          feature_version TEXT NOT NULL,
          engagement_id TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN (
            'draft','acquiring','processing','needs_input','converting','validating_output',
            'ready_for_review','waiting_confirmation','returning','verifying','succeeded',
            'failed','uncertain','reconciling','cancelled','not_evaluable'
          )),
          state_revision INTEGER NOT NULL CHECK(state_revision >= 1),
          source_artifact_id TEXT NOT NULL,
          template_version_id TEXT NOT NULL,
          output_artifact_id TEXT NOT NULL,
          plan_digest TEXT NOT NULL,
          last_error TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX feature_runs_feature_state ON feature_runs(feature_id, state, updated_at);
        CREATE TABLE feature_run_events (
          event_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK(revision >= 1),
          from_state TEXT NOT NULL,
          to_state TEXT NOT NULL,
          event_type TEXT NOT NULL,
          details_json TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          UNIQUE(run_id, revision)
        );
        CREATE INDEX feature_run_events_run_revision ON feature_run_events(run_id, revision);

        CREATE TABLE feature_artifacts (
          artifact_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          feature_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('source','template_candidate','template_instance','result','evidence')),
          media_type TEXT NOT NULL,
          original_name TEXT NOT NULL,
          source_kind TEXT NOT NULL CHECK(source_kind IN ('user_import','managed_template','worker_output','connector_evidence')),
          source_ref TEXT NOT NULL,
          managed_path TEXT NOT NULL,
          sha256 TEXT NOT NULL CHECK(length(sha256)=64),
          size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
          source_version TEXT NOT NULL,
          imported_at TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX feature_artifacts_run_kind ON feature_artifacts(run_id, kind, created_at);

        CREATE TABLE template_versions (
          template_version_id TEXT PRIMARY KEY,
          template_id TEXT NOT NULL,
          version TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('candidate','published','revoked')),
          source_artifact_id TEXT NOT NULL,
          file_digest TEXT NOT NULL CHECK(length(file_digest)=64),
          semantic_digest TEXT NOT NULL CHECK(length(semantic_digest)=64),
          schema_version TEXT NOT NULL,
          owner TEXT NOT NULL,
          license TEXT NOT NULL,
          authorization_ref TEXT NOT NULL,
          requested_by TEXT NOT NULL,
          published_by TEXT NOT NULL,
          published_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(template_id, version)
        );

        CREATE TABLE template_instances (
          template_instance_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          template_version_id TEXT NOT NULL,
          source_artifact_id TEXT NOT NULL,
          output_artifact_id TEXT NOT NULL,
          patch_digest TEXT NOT NULL,
          semantic_digest TEXT NOT NULL CHECK(length(semantic_digest)=64),
          output_file_digest TEXT NOT NULL CHECK(length(output_file_digest)=64),
          governance_digest TEXT NOT NULL CHECK(length(governance_digest)=64),
          state TEXT NOT NULL CHECK(state IN ('candidate','valid','invalid','revoked')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE feature_field_revisions (
          field_revision_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          template_instance_id TEXT NOT NULL,
          field_key TEXT NOT NULL,
          raw_field_key TEXT NOT NULL,
          canonical_field_id TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK(revision >= 1),
          value_kind TEXT NOT NULL CHECK(value_kind IN ('source','derived','inherited','rule_default','user_revision')),
          value_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('accepted','needs_input','blocked','superseded')),
          created_at TEXT NOT NULL,
          UNIQUE(run_id, field_key, revision)
        );
        CREATE INDEX feature_field_revisions_current ON feature_field_revisions(run_id, field_key, revision DESC);

        CREATE TABLE feature_field_provenance (
          provenance_id TEXT PRIMARY KEY,
          field_revision_id TEXT NOT NULL,
          source_artifact_id TEXT NOT NULL,
          source_sheet TEXT NOT NULL,
          source_row INTEGER NOT NULL CHECK(source_row >= 1),
          row_key TEXT NOT NULL,
          field_key TEXT NOT NULL,
          source_trace_id TEXT NOT NULL,
          derivation_rule TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX feature_field_provenance_revision ON feature_field_provenance(field_revision_id);

        CREATE TABLE feature_issues (
          issue_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          field_key TEXT NOT NULL,
          issue_type TEXT NOT NULL CHECK(issue_type IN ('missing','conflict','ambiguous','invalid_enum','digest_mismatch','contract_mismatch','visual_unverified')),
          state TEXT NOT NULL CHECK(state IN ('needs_input','resolved','waived','blocking')),
          message TEXT NOT NULL,
          resolution_revision_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          resolved_at TEXT NOT NULL
        );
        CREATE INDEX feature_issues_run_state ON feature_issues(run_id, state, created_at);

        CREATE TABLE feature_confirmations (
          confirmation_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          plan_digest TEXT NOT NULL,
          connector_id TEXT NOT NULL,
          session_generation INTEGER NOT NULL,
          engagement_id TEXT NOT NULL,
          safety_revision INTEGER NOT NULL,
          credential_digest TEXT NOT NULL,
          preflight_digest TEXT NOT NULL,
          confirmation_token_digest TEXT NOT NULL,
          decision TEXT NOT NULL CHECK(decision IN ('pending','approved','rejected','expired','invalidated')),
          actor_id TEXT NOT NULL,
          decision_at TEXT NOT NULL,
          consumed_command_id TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE TABLE managed_content_intents (
          intent_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          plan_digest TEXT NOT NULL,
          target_kind TEXT NOT NULL CHECK(target_kind IN ('object','relation','field','risk_control','documentation','evaluation')),
          target_key TEXT NOT NULL,
          intended_revision_json TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('frozen','commanded','verified','failed','uncertain','cancelled')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(run_id, target_kind, target_key)
        );

        CREATE TABLE feature_commands (
          command_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          intent_id TEXT NOT NULL,
          operation_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL UNIQUE,
          plan_digest TEXT NOT NULL,
          request_digest TEXT NOT NULL,
          evidence_operation_ids_json TEXT NOT NULL,
          evidence_target_identity_key TEXT NOT NULL,
          evidence_request_digest TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN (
            'prepared','submitted','committed','verifying','readback_verified','closed_not_applied','failed','uncertain'
          )),
          commit_point_at TEXT NOT NULL,
          submitted_at TEXT NOT NULL,
          completed_at TEXT NOT NULL,
          last_error TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX feature_commands_run_state ON feature_commands(run_id, state, created_at);
        CREATE TABLE feature_command_specs (
          command_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          spec_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE feature_operation_receipts (
          receipt_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          command_id TEXT NOT NULL,
          feature_id TEXT NOT NULL,
          feature_version TEXT NOT NULL,
          operation_package_digest TEXT NOT NULL,
          operation_id TEXT NOT NULL,
          authority_digest TEXT NOT NULL,
          connector_id TEXT NOT NULL,
          session_generation INTEGER NOT NULL,
          engagement_id TEXT NOT NULL,
          frozen_target_key TEXT NOT NULL,
          target_identity_key TEXT NOT NULL,
          workspace_ids_json TEXT NOT NULL,
          plan_digest TEXT NOT NULL,
          request_digest TEXT NOT NULL,
          response_digest TEXT NOT NULL,
          response_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE TABLE feature_command_evidence (
          evidence_id TEXT PRIMARY KEY,
          command_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          evidence_type TEXT NOT NULL CHECK(evidence_type IN ('preflight','request','commit','readback','reconcile','projection')),
          evidence_digest TEXT NOT NULL,
          receipt_id TEXT NOT NULL,
          verified INTEGER NOT NULL CHECK(verified IN (0,1)),
          payload_json TEXT NOT NULL,
          occurred_at TEXT NOT NULL
        );
        CREATE INDEX feature_command_evidence_command ON feature_command_evidence(command_id, occurred_at);
        CREATE UNIQUE INDEX feature_command_evidence_receipt ON feature_command_evidence(receipt_id) WHERE receipt_id<>'';

        CREATE TABLE feature_reconcile_commands (
          reconcile_command_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          original_command_id TEXT NOT NULL,
          operation_id TEXT NOT NULL,
          request_digest TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('prepared','running','completed','failed')),
          outcome TEXT NOT NULL CHECK(outcome IN ('pending','applied','not_applied','inconclusive','drifted')),
          evidence_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          completed_at TEXT NOT NULL
        );

        CREATE TABLE managed_objects (
          authority_instance_id TEXT NOT NULL,
          tenant_or_org_id TEXT NOT NULL,
          pack_id TEXT NOT NULL,
          engagement_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          object_type TEXT NOT NULL,
          object_id TEXT NOT NULL,
          current_revision INTEGER NOT NULL CHECK(current_revision >= 1),
          lifecycle TEXT NOT NULL CHECK(lifecycle IN ('active','deleted','unknown')),
          freshness TEXT NOT NULL CHECK(freshness IN ('verified_current','stale','unknown')),
          updated_at TEXT NOT NULL,
          PRIMARY KEY(authority_instance_id, tenant_or_org_id, pack_id, engagement_id, workspace_id, object_type, object_id)
        );
        CREATE TABLE managed_object_revisions (
          revision_id TEXT PRIMARY KEY,
          authority_instance_id TEXT NOT NULL,
          tenant_or_org_id TEXT NOT NULL,
          pack_id TEXT NOT NULL,
          engagement_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          object_type TEXT NOT NULL,
          object_id TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK(revision >= 1),
          run_id TEXT NOT NULL,
          intent_id TEXT NOT NULL,
          command_id TEXT NOT NULL,
          evidence_id TEXT NOT NULL,
          provenance_json TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          verified_at TEXT NOT NULL,
          UNIQUE(authority_instance_id, tenant_or_org_id, pack_id, engagement_id, workspace_id, object_type, object_id, revision)
        );

        CREATE TABLE managed_relations (
          authority_instance_id TEXT NOT NULL,
          tenant_or_org_id TEXT NOT NULL,
          pack_id TEXT NOT NULL,
          engagement_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          relation_type TEXT NOT NULL,
          relation_key TEXT NOT NULL,
          source_object_id TEXT NOT NULL,
          target_object_id TEXT NOT NULL,
          current_revision INTEGER NOT NULL CHECK(current_revision >= 1),
          lifecycle TEXT NOT NULL CHECK(lifecycle IN ('active','deleted','unknown')),
          freshness TEXT NOT NULL CHECK(freshness IN ('verified_current','stale','unknown')),
          updated_at TEXT NOT NULL,
          PRIMARY KEY(authority_instance_id, tenant_or_org_id, pack_id, engagement_id, workspace_id, relation_type, relation_key)
        );
        CREATE TABLE managed_relation_revisions (
          revision_id TEXT PRIMARY KEY,
          authority_instance_id TEXT NOT NULL,
          tenant_or_org_id TEXT NOT NULL,
          pack_id TEXT NOT NULL,
          engagement_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          relation_type TEXT NOT NULL,
          relation_key TEXT NOT NULL,
          source_object_id TEXT NOT NULL,
          target_object_id TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK(revision >= 1),
          run_id TEXT NOT NULL,
          intent_id TEXT NOT NULL,
          command_id TEXT NOT NULL,
          evidence_id TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          verified_at TEXT NOT NULL,
          UNIQUE(authority_instance_id, tenant_or_org_id, pack_id, engagement_id, workspace_id, relation_type, relation_key, revision)
        );

        CREATE TABLE managed_content_repairs (
          repair_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          command_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('projection_retry','read_only_reconcile','manual_review')),
          state TEXT NOT NULL CHECK(state IN ('pending','running','completed','blocked')),
          automatic_replay_allowed INTEGER NOT NULL DEFAULT 0 CHECK(automatic_replay_allowed=0),
          last_error TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE feature_surface_states (
          feature_id TEXT PRIMARY KEY,
          feature_version TEXT NOT NULL,
          surface_id TEXT NOT NULL,
          state_revision INTEGER NOT NULL CHECK(state_revision >= 1),
          payload_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE feature_capability_evidence (
          capability_evidence_id TEXT PRIMARY KEY,
          feature_id TEXT NOT NULL,
          feature_version TEXT NOT NULL,
          operation_package_digest TEXT NOT NULL,
          scenario_id TEXT NOT NULL,
          capability_id TEXT NOT NULL,
          authority_instance_id TEXT NOT NULL,
          tenant_or_org_id TEXT NOT NULL,
          pack_contract_id TEXT NOT NULL,
          engagement_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          automated_status TEXT NOT NULL CHECK(automated_status IN ('pending','passed','failed')),
          portable_status TEXT NOT NULL CHECK(portable_status IN ('pending','passed','failed')),
          canary_status TEXT NOT NULL CHECK(canary_status IN ('pending','passed','failed','revoked')),
          readback_status TEXT NOT NULL CHECK(readback_status IN ('pending','passed','failed')),
          evidence_digest TEXT NOT NULL CHECK(length(evidence_digest)=64),
          verified INTEGER NOT NULL CHECK(verified IN (0,1)),
          verified_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          revoked_at TEXT NOT NULL,
          UNIQUE(feature_id, feature_version, operation_package_digest, scenario_id, capability_id,
                 authority_instance_id, tenant_or_org_id, pack_contract_id, engagement_id, workspace_id)
        );
        CREATE INDEX feature_capability_gate ON feature_capability_evidence(
          feature_id, feature_version, scenario_id, capability_id, canary_status, readback_status
        );
        CREATE TABLE feature_managed_assets (
          feature_id TEXT NOT NULL,
          feature_version TEXT NOT NULL,
          package_digest TEXT NOT NULL,
          member_path TEXT NOT NULL,
          member_digest TEXT NOT NULL CHECK(length(member_digest)=64),
          asset_kind TEXT NOT NULL CHECK(asset_kind IN ('governance','runtime_template_base')),
          managed_path TEXT NOT NULL,
          imported_at TEXT NOT NULL,
          PRIMARY KEY(feature_id, feature_version, member_path)
        );
      `],
      [13, `
        CREATE TABLE feature_mutation_reservations (
          authority_instance_id TEXT NOT NULL,
          tenant_or_org_id TEXT NOT NULL,
          pack_id TEXT NOT NULL,
          engagement_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          logical_identity_key TEXT NOT NULL,
          owner_run_id TEXT NOT NULL,
          owner_intent_id TEXT NOT NULL,
          owner_command_id TEXT NOT NULL,
          lifecycle TEXT NOT NULL CHECK(lifecycle IN ('active','completed','released')),
          acquired_at TEXT NOT NULL,
          lease_expires_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(authority_instance_id,tenant_or_org_id,pack_id,engagement_id,workspace_id,logical_identity_key)
        );
        CREATE INDEX feature_mutation_reservation_owner ON feature_mutation_reservations(owner_run_id,owner_intent_id,lifecycle);
      `],
      [14, `
        CREATE TABLE template_instance_field_revisions (
          template_instance_id TEXT NOT NULL,
          field_revision_id TEXT NOT NULL,
          field_key TEXT NOT NULL,
          revision INTEGER NOT NULL,
          bound_at TEXT NOT NULL,
          PRIMARY KEY(template_instance_id,field_key),
          UNIQUE(template_instance_id,field_revision_id)
        );
      `],
      [15, `
        CREATE TABLE feature_issues_v15 (
          issue_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          field_key TEXT NOT NULL,
          issue_type TEXT NOT NULL CHECK(issue_type IN ('missing','conflict','ambiguous','invalid_enum','digest_mismatch','contract_mismatch','visual_unverified')),
          state TEXT NOT NULL CHECK(state IN ('needs_input','resolved','waived','blocking')),
          message TEXT NOT NULL,
          resolution_revision_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          resolved_at TEXT NOT NULL
        );
        INSERT INTO feature_issues_v15 SELECT * FROM feature_issues;
        DROP TABLE feature_issues;
        ALTER TABLE feature_issues_v15 RENAME TO feature_issues;
        CREATE INDEX feature_issues_run_state ON feature_issues(run_id,state,created_at);
      `],
      [16, `
        ALTER TABLE feature_confirmations ADD COLUMN authority_instance_id TEXT NOT NULL DEFAULT '';
        ALTER TABLE feature_confirmations ADD COLUMN tenant_or_org_id TEXT NOT NULL DEFAULT '';
        ALTER TABLE feature_confirmations ADD COLUMN pack_id TEXT NOT NULL DEFAULT '';
        ALTER TABLE feature_operation_receipts ADD COLUMN authority_instance_id TEXT NOT NULL DEFAULT '';
        ALTER TABLE feature_operation_receipts ADD COLUMN tenant_or_org_id TEXT NOT NULL DEFAULT '';
        ALTER TABLE feature_operation_receipts ADD COLUMN pack_id TEXT NOT NULL DEFAULT '';
      `],
      [17, `
        CREATE TABLE feature_managed_assets_v17 (
          feature_id TEXT NOT NULL,
          feature_version TEXT NOT NULL,
          package_digest TEXT NOT NULL,
          member_path TEXT NOT NULL,
          member_digest TEXT NOT NULL CHECK(length(member_digest)=64),
          asset_kind TEXT NOT NULL CHECK(asset_kind IN ('governance','runtime_template_base','source_template')),
          managed_path TEXT NOT NULL,
          imported_at TEXT NOT NULL,
          PRIMARY KEY(feature_id,feature_version,member_path)
        );
        INSERT INTO feature_managed_assets_v17 SELECT * FROM feature_managed_assets;
        DROP TABLE feature_managed_assets;
        ALTER TABLE feature_managed_assets_v17 RENAME TO feature_managed_assets;
      `],
      [18, `
        UPDATE ai_provider_settings
        SET base_url='https://api.deepseek.com', model='deepseek-v4-flash',
            test_status='untested', test_message='', tested_at='', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE singleton=1 AND provider='deepseek' AND model='deepseek-chat'
          AND base_url IN ('https://api.deepseek.com/v1/','https://api.deepseek.com/v1','https://api.deepseek.com/');
      `],
      [19, `
        CREATE TABLE interaction_logs (
          event_id TEXT PRIMARY KEY,
          interaction_id TEXT NOT NULL UNIQUE,
          trace_id TEXT NOT NULL,
          parent_id TEXT NOT NULL,
          timestamp TEXT NOT NULL,
          completed_at TEXT NOT NULL,
          duration_ms INTEGER NOT NULL CHECK(duration_ms >= 0),
          plane TEXT NOT NULL CHECK(plane IN ('surface','middle','core','connector')),
          component TEXT NOT NULL,
          surface TEXT NOT NULL,
          action TEXT NOT NULL,
          phase TEXT NOT NULL CHECK(phase IN ('start','success','failure')),
          severity TEXT NOT NULL CHECK(severity IN ('info','error')),
          error_code TEXT NOT NULL,
          failure_point TEXT NOT NULL,
          message TEXT NOT NULL,
          details_json TEXT NOT NULL,
          run_id TEXT NOT NULL,
          command_id TEXT NOT NULL,
          request_id TEXT NOT NULL,
          operation_id TEXT NOT NULL
        );
        CREATE INDEX interaction_logs_timestamp ON interaction_logs(timestamp DESC, event_id DESC);
        CREATE INDEX interaction_logs_trace ON interaction_logs(trace_id, timestamp, event_id);
        CREATE INDEX interaction_logs_failure ON interaction_logs(severity, plane, timestamp DESC);
        CREATE INDEX interaction_logs_action ON interaction_logs(component, action, timestamp DESC);
      `],
      [20, `
        ALTER TABLE workspace_observations ADD COLUMN connector_id TEXT NOT NULL DEFAULT '';
        ALTER TABLE workspace_observations ADD COLUMN session_generation INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE workspace_observations ADD COLUMN authority_instance_id TEXT NOT NULL DEFAULT '';
        ALTER TABLE workspace_observations ADD COLUMN tenant_or_org_id TEXT NOT NULL DEFAULT '';
        ALTER TABLE workspace_observations ADD COLUMN pack_id TEXT NOT NULL DEFAULT '';
        ALTER TABLE workspace_safety ADD COLUMN connector_id TEXT NOT NULL DEFAULT '';
        ALTER TABLE workspace_safety ADD COLUMN session_generation INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE workspace_safety ADD COLUMN authority_instance_id TEXT NOT NULL DEFAULT '';
        ALTER TABLE workspace_safety ADD COLUMN tenant_or_org_id TEXT NOT NULL DEFAULT '';
        ALTER TABLE workspace_safety ADD COLUMN pack_id TEXT NOT NULL DEFAULT '';
        UPDATE workspace_safety
        SET enabled=0, engagement_id='', workspace_ids_json='[]', authority_observation_id='',
            connector_id='', session_generation=0, authority_instance_id='', tenant_or_org_id='', pack_id='',
            state_version=state_version+1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE singleton=1;
      `],
      [21, `
        ALTER TABLE workspace_safety ADD COLUMN global_enabled INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE workspace_safety ADD COLUMN global_section_ids_json TEXT NOT NULL DEFAULT '[]';
        ALTER TABLE workspace_safety ADD COLUMN global_workspace_ids_json TEXT NOT NULL DEFAULT '[]';
      `]
    ];
    for (const [version, sql] of migrations) {
      if (applied.has(version)) continue;
      this.db.exec('BEGIN IMMEDIATE;');
      try {
        this.db.exec(sql);
        if (version === 9) {
          const legacy = this.db.prepare('SELECT mode FROM connection_settings WHERE singleton=1').get() as { mode: string } | undefined;
          const snapshot = this.db.prepare('SELECT payload_json FROM connection_state WHERE singleton=1').get() as { payload_json?: string } | undefined;
          this.db.prepare(`
            INSERT INTO connector_migration_audit(
              audit_id, migration_version, legacy_mode, decision,
              legacy_connection_snapshot_ciphertext, occurred_at
            ) VALUES(?, 9, ?, ?, ?, ?)
          `).run(
            randomUUID(), legacy?.mode || 'fresh_install',
            legacy?.mode === 'remote'
              ? 'migrated_remote_binding_pending_live_validation'
              : legacy?.mode === 'local'
                ? 'local_retired_remote_unpaired'
                : 'fresh_remote_unpaired',
            snapshot?.payload_json || '', utcNow()
          );
        }
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
      ) VALUES(1, 'deepseek', 'https://api.deepseek.com', 'deepseek-v4-flash', 'text_only', '', 1, 'untested', '', '', ?)
    `).run(now);
    this.db.prepare(`
      INSERT OR IGNORE INTO remote_binding_settings(
        singleton, bridge_url, pair_id, connector_id, connector_name, connector_version,
        protocol_version, generation, token_ciphertext, lifecycle, state_version, updated_at
      ) VALUES(1, ?, '', '', '', '', '', 0, '', 'unpaired', 1, ?)
    `).run(defaultRemoteBridgeUrl(), now);
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
      INSERT INTO workspace_observations(
        observation_id, engagement_id, captured_at, payload_json,
        connector_id, session_generation, authority_instance_id, tenant_or_org_id, pack_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      observation.observationId,
      observation.engagementId,
      observation.capturedAt,
      this.contentCipher.encrypt(JSON.stringify(observation)),
      observation.connectorId,
      observation.sessionGeneration,
      observation.authorityInstanceId,
      observation.tenantOrOrgId,
      observation.packId
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
      globalEnabled: row.global_enabled === 1,
      globalSectionIds: JSON.parse(String(row.global_section_ids_json)) as string[],
      globalWorkspaceIds: JSON.parse(String(row.global_workspace_ids_json)) as string[],
      connectorId: String(row.connector_id),
      sessionGeneration: Number(row.session_generation),
      authorityInstanceId: String(row.authority_instance_id),
      tenantOrOrgId: String(row.tenant_or_org_id),
      packId: String(row.pack_id),
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
    globalEnabled: boolean;
    globalSectionIds: string[];
    globalWorkspaceIds: string[];
    connectorId: string;
    sessionGeneration: number;
    authorityInstanceId: string;
    tenantOrOrgId: string;
    packId: string;
    engagementId: string;
    workspaceIds: string[];
    authorityObservationId: string;
    expectedStateVersion: number;
  }): WorkspaceSafetySnapshot {
    const now = utcNow();
    const result = this.db.prepare(`
      UPDATE workspace_safety SET
        enabled=?, global_enabled=?, global_section_ids_json=?, global_workspace_ids_json=?, connector_id=?, session_generation=?, authority_instance_id=?, tenant_or_org_id=?, pack_id=?,
        engagement_id=?, workspace_ids_json=?, authority_observation_id=?,
        state_version=state_version+1, updated_at=?
      WHERE singleton=1 AND state_version=?
    `).run(
      input.enabled ? 1 : 0,
      input.globalEnabled ? 1 : 0,
      JSON.stringify(input.globalSectionIds),
      JSON.stringify(input.globalWorkspaceIds),
      input.connectorId,
      input.sessionGeneration,
      input.authorityInstanceId,
      input.tenantOrOrgId,
      input.packId,
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

  getRemoteBinding(): ConnectionSettingsSnapshot & { bridgeUrl: string; pairId: string; remoteToken: string } {
    const row = this.db.prepare(`SELECT * FROM remote_binding_settings WHERE singleton=1`).get() as Record<string, any>;
    let remoteToken = '';
    let lifecycle = String(row.lifecycle) as ConnectionSettingsSnapshot['bindingState'];
    if (row.token_ciphertext) {
      try {
        remoteToken = this.contentCipher.decrypt(String(row.token_ciphertext));
      } catch {
        lifecycle = 'repair_required';
        if (row.lifecycle !== 'repair_required') {
          const updatedAt = utcNow();
          this.db.prepare(`
          UPDATE remote_binding_settings SET lifecycle='repair_required', state_version=state_version+1, updated_at=?
          WHERE singleton=1
          `).run(updatedAt);
          row.state_version = Number(row.state_version) + 1;
          row.updated_at = updatedAt;
        }
      }
    }
    return {
      bridgeUrl: String(row.bridge_url),
      pairId: String(row.pair_id),
      bindingState: lifecycle,
      remotePaired: Boolean(remoteToken),
      connectorId: String(row.connector_id),
      connectorName: String(row.connector_name),
      connectorVersion: String(row.connector_version),
      protocolVersion: String(row.protocol_version),
      generation: Number(row.generation),
      remoteToken,
      stateVersion: Number(row.state_version),
      updatedAt: String(row.updated_at)
    };
  }

  saveRemoteBinding(input: {
    bridgeUrl: string;
    pairId: string;
    token: string;
    connectorId: string;
    connectorName: string;
    connectorVersion: string;
    protocolVersion: string;
    generation: number;
    expectedStateVersion: number;
  }): ConnectionSettingsSnapshot {
    const now = utcNow();
    this.db.exec('BEGIN IMMEDIATE;');
    try {
    const previous = this.db.prepare('SELECT pair_id, generation FROM remote_binding_settings WHERE singleton=1').get() as any;
    const result = this.db.prepare(`
      UPDATE remote_binding_settings SET bridge_url=?, pair_id=?, token_ciphertext=?,
        connector_id=?, connector_name=?, connector_version=?, protocol_version=?, generation=?, lifecycle='bound',
        state_version=state_version+1, updated_at=? WHERE singleton=1 AND state_version=?
    `).run(
      input.bridgeUrl, input.pairId, this.contentCipher.encrypt(input.token),
      input.connectorId, input.connectorName, input.connectorVersion, input.protocolVersion, input.generation,
      now, input.expectedStateVersion
    );
    if (result.changes !== 1) throw new AppError('SETTINGS.CONFLICT', '连接设置已在其他窗口更新，请刷新后重试。', true);
    this.appendRemoteBindingEvent(
      previous?.pair_id && previous.pair_id !== input.pairId ? 'binding_replaced' : 'binding_activated',
      input.pairId, input.generation, String(previous?.pair_id || ''), { protocolVersion: input.protocolVersion }
    );
    this.db.exec('COMMIT;');
    return this.publicConnectionSettings();
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }

  clearRemoteBinding(expectedStateVersion: number, lifecycle: 'unpaired' | 'repair_required' | 'revoked'): ConnectionSettingsSnapshot {
    const now = utcNow();
    const result = this.db.prepare(`
      UPDATE remote_binding_settings SET pair_id='', connector_id='', connector_name='', connector_version='',
        protocol_version='', generation=0, token_ciphertext='', lifecycle=?,
        state_version=state_version+1, updated_at=? WHERE singleton=1 AND state_version=?
    `).run(lifecycle, now, expectedStateVersion);
    if (result.changes !== 1) throw new AppError('SETTINGS.CONFLICT', '连接设置已在其他窗口更新，请刷新后重试。', true);
    return this.publicConnectionSettings();
  }

  markRemoteBindingRepairRequired(expectedStateVersion: number): ConnectionSettingsSnapshot {
    const now = utcNow();
    this.db.exec('BEGIN IMMEDIATE;');
    try {
    const current = this.db.prepare('SELECT pair_id, generation FROM remote_binding_settings WHERE singleton=1').get() as any;
    const result = this.db.prepare(`
      UPDATE remote_binding_settings SET lifecycle='repair_required',
        state_version=state_version+1, updated_at=? WHERE singleton=1 AND state_version=?
    `).run(now, expectedStateVersion);
    if (result.changes !== 1) throw new AppError('SETTINGS.CONFLICT', '连接设置已在其他窗口更新，请刷新后重试。', true);
    this.appendRemoteBindingEvent('repair_required', String(current?.pair_id || ''), Number(current?.generation || 0), '', {});
    this.db.exec('COMMIT;');
    return this.publicConnectionSettings();
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }

  savePendingRemotePairing(input: {
    sessionId: string;
    pollSecret: string;
    bridgeUrl: string;
    expiresAt: string;
    expectedPairId: string;
    expectedGeneration: number;
    expectedBindingState: ConnectionSettingsSnapshot['bindingState'];
    expectedStateVersion: number;
  }): void {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
    this.db.prepare(`
      INSERT OR REPLACE INTO remote_pairing_pending(
        singleton, session_id, poll_secret_ciphertext, bridge_url, expires_at,
        expected_pair_id, expected_generation, expected_binding_state, expected_state_version,
        matched_pair_id, matched_token_ciphertext, matched_generation,
        matched_connector_id, matched_connector_name, matched_connector_version,
        commit_required, cleanup_required, status, session_id_hash, created_at
      ) VALUES(1, ?, ?, ?, ?, ?, ?, ?, ?, '', '', 0, '', '', '', 0, 0, 'active', ?, ?)
    `).run(
      input.sessionId, this.contentCipher.encrypt(input.pollSecret), input.bridgeUrl, input.expiresAt,
      input.expectedPairId, input.expectedGeneration, input.expectedBindingState, input.expectedStateVersion,
      this.eventDigest(input.sessionId), utcNow()
    );
    this.appendRemoteBindingEvent(
      input.expectedPairId ? 'replacement_pairing_started' : 'pairing_started',
      input.expectedPairId, input.expectedGeneration, '', { sessionIdHash: this.eventDigest(input.sessionId), expiresAt: input.expiresAt }
    );
    this.db.exec('COMMIT;');
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }

  reserveRemotePairingIntent(input: {
    bridgeUrl: string;
    expectedPairId: string;
    expectedGeneration: number;
    expectedBindingState: ConnectionSettingsSnapshot['bindingState'];
    expectedStateVersion: number;
  }): { intentId: string; requestNonce: string; expiresAt: string } {
    const intentId = `intent-${randomUUID()}`;
    const requestNonce = `shell-${randomUUID()}`;
    const expiresAt = new Date(Date.now() + 11 * 60_000).toISOString();
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const pairing = this.db.prepare('SELECT COUNT(*) AS count FROM remote_pairing_pending').get() as any;
      const revocation = this.db.prepare('SELECT COUNT(*) AS count FROM remote_revocation_pending').get() as any;
      if (Number(pairing.count) > 0 || Number(revocation.count) > 0) {
        throw new AppError('REMOTE.LIFECYCLE_PENDING', '已有 Remote 生命周期变更正在进行。', true);
      }
      this.db.prepare(`
        INSERT INTO remote_pairing_pending(
          singleton, session_id, poll_secret_ciphertext, bridge_url, expires_at,
          expected_pair_id, expected_generation, expected_binding_state, expected_state_version,
          matched_pair_id, matched_token_ciphertext, matched_generation,
          matched_connector_id, matched_connector_name, matched_connector_version,
          commit_required, cleanup_required, status, session_id_hash, created_at
        ) VALUES(1, ?, ?, ?, ?, ?, ?, ?, ?, '', '', 0, '', '', '', 0, 0, 'creating', ?, ?)
      `).run(
        intentId, this.contentCipher.encrypt(requestNonce), input.bridgeUrl, expiresAt,
        input.expectedPairId, input.expectedGeneration, input.expectedBindingState, input.expectedStateVersion,
        this.eventDigest(intentId), utcNow()
      );
      this.appendRemoteBindingEvent('pairing_intent_reserved', input.expectedPairId, input.expectedGeneration, '', {
        intentIdHash: this.eventDigest(intentId), requestNonceHash: this.eventDigest(requestNonce), expiresAt
      });
      this.db.exec('COMMIT;');
      return { intentId, requestNonce, expiresAt };
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }

  finalizeRemotePairingIntent(input: {
    intentId: string;
    sessionId: string;
    pollSecret: string;
    expiresAt: string;
  }): void {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const pending = this.db.prepare(`SELECT expected_pair_id, expected_generation FROM remote_pairing_pending WHERE singleton=1 AND session_id=? AND status='creating'`).get(input.intentId) as any;
      const result = this.db.prepare(`
        UPDATE remote_pairing_pending SET session_id=?, poll_secret_ciphertext=?, expires_at=?,
          status='active', session_id_hash=? WHERE singleton=1 AND session_id=? AND status='creating'
      `).run(
        input.sessionId, this.contentCipher.encrypt(input.pollSecret), input.expiresAt,
        this.eventDigest(input.sessionId), input.intentId
      );
      if (result.changes !== 1) throw new AppError('REMOTE.PAIRING_INTENT_LOST', '配对 reservation 已变化，拒绝接管 Bridge 会话。');
      this.appendRemoteBindingEvent(
        pending?.expected_pair_id ? 'replacement_pairing_started' : 'pairing_started',
        String(pending?.expected_pair_id || ''), Number(pending?.expected_generation || 0), '',
        { sessionIdHash: this.eventDigest(input.sessionId), expiresAt: input.expiresAt }
      );
      this.db.exec('COMMIT;');
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }

  clearRemotePairingIntent(intentId: string): void {
    this.db.prepare(`DELETE FROM remote_pairing_pending WHERE singleton=1 AND session_id=? AND status='creating'`).run(intentId);
  }

  getPendingRemotePairing(): null | {
    sessionId: string;
    pollSecret: string;
    bridgeUrl: string;
    expiresAt: string;
    expectedPairId: string;
    expectedGeneration: number;
    expectedBindingState: ConnectionSettingsSnapshot['bindingState'];
    expectedStateVersion: number;
    cleanupRequired: boolean;
    matchedPairId: string;
    matchedToken: string;
    matchedGeneration: number;
    matchedConnectorId: string;
    matchedConnectorName: string;
    matchedConnectorVersion: string;
    commitRequired: boolean;
    status: 'creating' | 'active' | 'corrupt' | 'manual_reconcile_required' | 'manual_cleanup_required';
    sessionIdHash: string;
  } {
    const row = this.db.prepare('SELECT * FROM remote_pairing_pending WHERE singleton=1').get() as Record<string, any> | undefined;
    if (!row) return null;
    const tombstone = (status: 'corrupt' | 'manual_reconcile_required' | 'manual_cleanup_required') => ({
      sessionId: '', pollSecret: '', bridgeUrl: String(row.bridge_url), expiresAt: String(row.expires_at),
      expectedPairId: String(row.expected_pair_id), expectedGeneration: Number(row.expected_generation),
      expectedBindingState: row.expected_binding_state, expectedStateVersion: Number(row.expected_state_version),
      cleanupRequired: Boolean(row.cleanup_required), matchedPairId: String(row.matched_pair_id), matchedToken: '',
      matchedGeneration: Number(row.matched_generation), matchedConnectorId: String(row.matched_connector_id),
      matchedConnectorName: String(row.matched_connector_name), matchedConnectorVersion: String(row.matched_connector_version),
      commitRequired: Boolean(row.commit_required), status, sessionIdHash: String(row.session_id_hash)
    });
    if (row.status === 'creating') {
      return { ...tombstone('corrupt'), status: 'creating', sessionId: String(row.session_id), pollSecret: '' };
    }
    if (row.status === 'corrupt' || row.status === 'manual_reconcile_required' || row.status === 'manual_cleanup_required') return tombstone(row.status);
    try {
      return {
        sessionId: String(row.session_id), pollSecret: this.contentCipher.decrypt(String(row.poll_secret_ciphertext)),
        bridgeUrl: String(row.bridge_url), expiresAt: String(row.expires_at), expectedPairId: String(row.expected_pair_id),
        expectedGeneration: Number(row.expected_generation), expectedBindingState: row.expected_binding_state,
        expectedStateVersion: Number(row.expected_state_version), cleanupRequired: Boolean(row.cleanup_required),
        matchedPairId: String(row.matched_pair_id),
        matchedToken: row.matched_token_ciphertext ? this.contentCipher.decrypt(String(row.matched_token_ciphertext)) : '',
        matchedGeneration: Number(row.matched_generation),
        matchedConnectorId: String(row.matched_connector_id), matchedConnectorName: String(row.matched_connector_name),
        matchedConnectorVersion: String(row.matched_connector_version), commitRequired: Boolean(row.commit_required),
        status: 'active', sessionIdHash: String(row.session_id_hash)
      };
    } catch {
      let status: 'manual_reconcile_required' | 'manual_cleanup_required' = row.matched_pair_id
        ? 'manual_cleanup_required'
        : 'manual_reconcile_required';
      if (row.matched_pair_id && row.matched_token_ciphertext) {
        try { this.contentCipher.decrypt(String(row.matched_token_ciphertext)); }
        catch { status = 'manual_cleanup_required'; }
      }
      this.db.exec('BEGIN IMMEDIATE;');
      try {
        this.db.prepare(`UPDATE remote_pairing_pending SET status=? WHERE singleton=1`).run(status);
        const current = this.db.prepare('SELECT pair_id, generation, lifecycle FROM remote_binding_settings WHERE singleton=1').get() as any;
        if (current?.lifecycle === 'bound') {
          this.db.prepare(`UPDATE remote_binding_settings SET lifecycle='repair_required', state_version=state_version+1, updated_at=? WHERE singleton=1`).run(utcNow());
        }
        this.appendRemoteBindingEvent('pairing_pending_corrupt', String(current?.pair_id || ''), Number(current?.generation || 0), '', {
          pendingStatus: status, sessionIdHash: String(row.session_id_hash)
        });
        this.db.exec('COMMIT;');
      } catch (error) {
        this.db.exec('ROLLBACK;');
        throw error;
      }
      return tombstone(status);
    }
  }

  hasPendingRemoteLifecycleWork(): boolean {
    const pairing = this.db.prepare('SELECT COUNT(*) AS count FROM remote_pairing_pending').get() as any;
    const revocation = this.db.prepare('SELECT COUNT(*) AS count FROM remote_revocation_pending').get() as any;
    return Number(pairing.count) > 0 || Number(revocation.count) > 0;
  }

  clearPendingRemotePairing(): void {
    this.db.prepare('DELETE FROM remote_pairing_pending WHERE singleton=1').run();
  }

  stagePendingPairingCleanup(sessionId: string, pairId: string, token: string, generation: number): void {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const result = this.db.prepare(`
        UPDATE remote_pairing_pending SET matched_pair_id=?, matched_token_ciphertext=?, matched_generation=?, commit_required=0, cleanup_required=1
        WHERE singleton=1 AND session_id=?
      `).run(pairId, this.contentCipher.encrypt(token), generation, sessionId);
      if (result.changes !== 1) throw new AppError('REMOTE.PAIRING_PENDING_MISSING', '配对恢复记录不存在。');
      this.appendRemoteBindingEvent('pairing_cleanup_pending', pairId, generation, '', {});
      this.db.exec('COMMIT;');
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }

  stagePendingPairingCommit(input: {
    sessionId: string; pairId: string; token: string; generation: number;
    connectorId: string; connectorName: string; connectorVersion: string;
  }): void {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const result = this.db.prepare(`
        UPDATE remote_pairing_pending SET matched_pair_id=?, matched_token_ciphertext=?, matched_generation=?,
          matched_connector_id=?, matched_connector_name=?, matched_connector_version=?, commit_required=1, cleanup_required=0
        WHERE singleton=1 AND session_id=?
      `).run(
        input.pairId, this.contentCipher.encrypt(input.token), input.generation,
        input.connectorId, input.connectorName, input.connectorVersion, input.sessionId
      );
      if (result.changes !== 1) throw new AppError('REMOTE.PAIRING_PENDING_MISSING', '配对恢复记录不存在。');
      this.appendRemoteBindingEvent('pairing_commit_staged', input.pairId, input.generation, '', {});
      this.db.exec('COMMIT;');
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }

  promotePendingPairingCommit(sessionId: string, protocolVersion: string): ConnectionSettingsSnapshot {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const pending = this.db.prepare(`
        SELECT * FROM remote_pairing_pending
        WHERE singleton=1 AND session_id=? AND commit_required=1 AND cleanup_required=0
      `).get(sessionId) as Record<string, any> | undefined;
      if (!pending || !pending.matched_pair_id || !pending.matched_token_ciphertext) {
        throw new AppError('REMOTE.PAIRING_COMMIT_NOT_STAGED', '配对候选尚未安全暂存。');
      }
      const current = this.db.prepare('SELECT * FROM remote_binding_settings WHERE singleton=1').get() as Record<string, any>;
      if (
        String(current.pair_id) !== String(pending.expected_pair_id)
        || Number(current.generation) !== Number(pending.expected_generation)
        || String(current.lifecycle) !== String(pending.expected_binding_state)
      ) {
        throw new AppError('SETTINGS.CONFLICT', 'Bridge 已提交候选，但本地 binding 身份已变化；必须进入人工修复。');
      }
      // Decrypt before mutating anything. A corrupt staged credential must
      // leave the durable pending row in place and fail closed.
      const token = this.contentCipher.decrypt(String(pending.matched_token_ciphertext));
      const now = utcNow();
      const update = this.db.prepare(`
        UPDATE remote_binding_settings SET bridge_url=?, pair_id=?, token_ciphertext=?,
          connector_id=?, connector_name=?, connector_version=?, protocol_version=?, generation=?, lifecycle='bound',
          state_version=state_version+1, updated_at=? WHERE singleton=1 AND state_version=?
      `).run(
        String(pending.bridge_url), String(pending.matched_pair_id), this.contentCipher.encrypt(token),
        String(pending.matched_connector_id), String(pending.matched_connector_name),
        String(pending.matched_connector_version), protocolVersion, Number(pending.matched_generation),
        now, Number(current.state_version)
      );
      if (update.changes !== 1) throw new AppError('SETTINGS.CONFLICT', '连接设置已更新，请重试。', true);
      this.appendRemoteBindingEvent(
        pending.expected_pair_id ? 'binding_replaced' : 'binding_activated',
        String(pending.matched_pair_id), Number(pending.matched_generation), String(pending.expected_pair_id),
        { protocolVersion, recoveredFromStagedCommit: true }
      );
      this.db.prepare('DELETE FROM remote_pairing_pending WHERE singleton=1 AND session_id=?').run(sessionId);
      this.db.exec('COMMIT;');
      return this.publicConnectionSettings();
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }

  beginRemoteRevocation(expectedStateVersion: number): void {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const row = this.db.prepare('SELECT * FROM remote_binding_settings WHERE singleton=1 AND state_version=?').get(expectedStateVersion) as Record<string, any> | undefined;
      if (!row || !row.pair_id || !row.token_ciphertext) throw new AppError('SETTINGS.CONFLICT', '连接设置已更新，请重试。', true);
      const now = utcNow();
      this.db.prepare(`
        INSERT OR REPLACE INTO remote_revocation_pending(
          singleton, bridge_url, pair_id, token_ciphertext, requested_at, last_attempt_at, last_error, attempts, status
        ) VALUES(1, ?, ?, ?, ?, '', '', 0, 'active')
      `).run(row.bridge_url, row.pair_id, row.token_ciphertext, now);
      this.db.prepare(`
        UPDATE remote_binding_settings SET lifecycle='repair_required', state_version=state_version+1, updated_at=?
        WHERE singleton=1 AND state_version=?
      `).run(now, expectedStateVersion);
      this.appendRemoteBindingEvent('revocation_pending', String(row.pair_id), Number(row.generation || 0), '', {});
      this.db.exec('COMMIT;');
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }

  getPendingRemoteRevocation(): null | {
    bridgeUrl: string; pairId: string; token: string; attempts: number;
    status: 'active' | 'manual_revoke_required';
  } {
    const row = this.db.prepare('SELECT * FROM remote_revocation_pending WHERE singleton=1').get() as Record<string, any> | undefined;
    if (!row) return null;
    if (row.status === 'manual_revoke_required') {
      return {
        bridgeUrl: String(row.bridge_url), pairId: String(row.pair_id), token: '',
        attempts: Number(row.attempts), status: 'manual_revoke_required'
      };
    }
    try {
      return {
        bridgeUrl: String(row.bridge_url), pairId: String(row.pair_id),
        token: this.contentCipher.decrypt(String(row.token_ciphertext)), attempts: Number(row.attempts), status: 'active'
      };
    } catch {
      this.db.exec('BEGIN IMMEDIATE;');
      try {
        const binding = this.db.prepare(`SELECT pair_id, generation, token_ciphertext FROM remote_binding_settings WHERE singleton=1`).get() as any;
        let recoveredToken = '';
        if (String(binding?.pair_id || '') === String(row.pair_id) && binding?.token_ciphertext) {
          try { recoveredToken = this.contentCipher.decrypt(String(binding.token_ciphertext)); } catch { /* manual tombstone below */ }
        }
        if (recoveredToken) {
          this.db.prepare(`UPDATE remote_revocation_pending SET token_ciphertext=?, status='active' WHERE singleton=1`).run(
            this.contentCipher.encrypt(recoveredToken)
          );
          this.appendRemoteBindingEvent('revocation_pending_credential_recovered', String(row.pair_id), Number(binding?.generation || 0), '', {});
          this.db.exec('COMMIT;');
          return {
            bridgeUrl: String(row.bridge_url), pairId: String(row.pair_id), token: recoveredToken,
            attempts: Number(row.attempts), status: 'active'
          };
        }
        this.db.prepare(`UPDATE remote_revocation_pending SET status='manual_revoke_required', token_ciphertext='' WHERE singleton=1`).run();
        this.db.prepare(`UPDATE remote_binding_settings SET lifecycle='repair_required', state_version=state_version+1, updated_at=? WHERE singleton=1`).run(utcNow());
        this.appendRemoteBindingEvent('revocation_pending_corrupt', String(row.pair_id), Number(binding?.generation || 0), '', { manualRevokeRequired: true });
        this.db.exec('COMMIT;');
      } catch (error) {
        this.db.exec('ROLLBACK;');
        throw error;
      }
      return {
        bridgeUrl: String(row.bridge_url), pairId: String(row.pair_id), token: '',
        attempts: Number(row.attempts), status: 'manual_revoke_required'
      };
    }
  }

  noteRemoteRevocationFailure(message: string): void {
    this.db.prepare(`
      UPDATE remote_revocation_pending SET attempts=attempts+1, last_attempt_at=?, last_error=? WHERE singleton=1
    `).run(utcNow(), message.slice(0, 1000));
  }

  completeRemoteRevocation(): void {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const now = utcNow();
      const current = this.db.prepare('SELECT pair_id, generation FROM remote_binding_settings WHERE singleton=1').get() as any;
      this.db.prepare(`
        UPDATE remote_binding_settings SET pair_id='', connector_id='', connector_name='', connector_version='',
          protocol_version='', generation=0, token_ciphertext='', lifecycle='revoked',
          state_version=state_version+1, updated_at=? WHERE singleton=1
      `).run(now);
      this.db.prepare('DELETE FROM remote_revocation_pending WHERE singleton=1').run();
      this.appendRemoteBindingEvent('revoked', String(current?.pair_id || ''), Number(current?.generation || 0), '', {});
      this.db.exec('COMMIT;');
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }

  private eventDigest(value: string): string {
    // Event correlation is non-secret and one-way; never store session IDs,
    // poll secrets, link codes, tokens, or ciphertext in the append-only log.
    return createHash('sha256').update(value).digest('hex');
  }

  private appendRemoteBindingEvent(
    eventType: string,
    pairId: string,
    generation: number,
    previousPairId: string,
    details: Record<string, unknown>
  ): void {
    this.db.prepare(`
      INSERT INTO remote_binding_events(
        event_id, event_type, pair_id, generation, previous_pair_id, details_json, occurred_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), eventType, pairId, generation, previousPairId, JSON.stringify(details), utcNow());
  }

  publicConnectionSettings(): ConnectionSettingsSnapshot {
    const { remoteToken: _secret, bridgeUrl: _bridgeUrl, pairId: _pairId, ...snapshot } = this.getRemoteBinding();
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
