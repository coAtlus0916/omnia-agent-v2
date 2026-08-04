import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  AiAttachmentCapability,
  AiProviderKind,
  LayoutPreference,
  ShellSnapshot
} from '../shared/contracts.js';
import type {
  DeclarativeFeatureSurface,
  FeatureMessageCard,
  FeatureNavigationLeaf
} from '../shared/feature-contracts.js';
import { SurfaceHost, type SurfaceInstance } from './surface-host.js';
import type { InteractionLogEntry, InteractionLogPage, InteractionLogTrace, InteractionPlane, InteractionSeverity } from '../shared/interaction-log-contracts.js';

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const formatTime = (value: string) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
const formatSize = (value: number) => value < 1024 * 1024
  ? `${Math.max(1, Math.round(value / 1024))} KB`
  : `${(value / 1024 / 1024).toFixed(1)} MB`;
type RunAction = () => Promise<any>;
type Run = (name: string, action: RunAction, onSuccess?: (value: any) => void) => void;

function ScaleControl({ snapshot, fail }: { snapshot: ShellSnapshot; fail(message: string): void }) {
  const save = (percent: number) => window.omnia.saveScale({
    percent,
    expectedStateVersion: snapshot.preference.stateVersion
  }).catch((error) => fail(error instanceof Error ? error.message : '缩放保存失败'));
  return <div className="scale-control" aria-label="全局界面缩放">
    <button type="button" aria-label="缩小" disabled={snapshot.preference.uiScalePercent <= 80}
      onClick={() => void save(snapshot.preference.uiScalePercent - 5)}>−</button>
    <button type="button" className="scale-value" aria-label="重置缩放" onClick={() => void save(100)}>
      {snapshot.preference.uiScalePercent}%
    </button>
    <button type="button" aria-label="放大" disabled={snapshot.preference.uiScalePercent >= 130}
      onClick={() => void save(snapshot.preference.uiScalePercent + 5)}>+</button>
  </div>;
}

function GlobalSessionBar({ snapshot, run, fail, openSafety, openConnection, busy }: {
  snapshot: ShellSnapshot;
  run: Run;
  fail(message: string): void;
  openSafety(): void;
  openConnection(): void;
  busy?: string;
}) {
  const connection = snapshot.connection;
  const keepalive = snapshot.keepalive;
  const status = connection.connecting ? 'connecting'
    : connection.connected ? 'connected' : 'disconnected';
  const connectionReason = connection.message || connection.adapterReason || 'Connector state is unavailable.';
  return <header className="global-session-bar" data-testid="global-session-bar">
    <button type="button" className="transport-state" title={connectionReason} aria-label="Remote Connector 连接详情" onClick={openConnection}>
      <span className={`transport-dot ${status}`} />
      <span>Remote</span>
    </button>
    <button type="button" className={`connect-capsule ${status}`}
      title={status === 'connecting' ? '取消当前连接尝试' : connectionReason}
      onClick={() => {
        if (status === 'connecting') run('cancel-connect', () => window.omnia.cancelConnect());
        else if (status === 'connected' || connection.bindingState === 'repair_required') openConnection();
        else run('connect', () => window.omnia.connect());
      }}>
      {status === 'connecting' ? 'Cancel' : status === 'connected'
        ? <><span className="connect-default">Connected</span><span className="connect-hover">Connect</span></>
        : 'Connect'}
    </button>
    <button type="button" className="icon-button" aria-label="刷新会话" title={connection.connecting ? '连接中，暂不能刷新' : '刷新会话'}
      disabled={connection.connecting || busy === 'refresh' || !connection.connected || !connection.adapterAvailable}
      onClick={() => run('refresh', () => window.omnia.refresh())}>↻</button>
    <button type="button" className={`keepalive-button ${keepalive.enabled ? 'enabled' : ''}`} aria-label="A 保活"
      aria-pressed={keepalive.enabled} disabled={!connection.connected && !keepalive.enabled}
      title={connection.connected ? (keepalive.enabled ? '关闭保活' : '开启保活') : '连接 Pack 后才能开启保活'}
      onClick={() => run('keepalive', () => window.omnia.setKeepalive(!keepalive.enabled))}>A</button>
    <div className="pack-identity" title={connection.engagementName || 'Pack identity 尚未读取'}>
      <span className="pack-label">Pack</span>
      <strong>{connection.engagementName || '未读取'}</strong>
    </div>
    <button type="button" className={`safety-indicator ${snapshot.safety.enabled && snapshot.safety.validForCurrentConnection ? 'locked' : ''}`}
      aria-label="安全锁设置" title={snapshot.safety.enabled ? (snapshot.safety.invalidReason || '安全锁已启用') : '安全锁未启用'}
      onClick={openSafety}>▣</button>
    {keepalive.lastError ? <span className="session-error" role="status" title={keepalive.lastError}>保活失败</span> : null}
    <span className="session-spacer" />
    <ScaleControl snapshot={snapshot} fail={fail} />
  </header>;
}

function FeatureNavigation({ snapshot, collapsed, run, openFeature }: {
  snapshot: ShellSnapshot;
  collapsed: boolean;
  run: Run;
  openFeature?: (featureId: string) => void;
}) {
  return <aside id="feature-navigation" className={`feature-navigation ${collapsed ? 'collapsed' : ''}`} aria-label="FeatureNavigation">
    <div className="navigation-scroll">
      {!snapshot.features.navigation.length
        ? <div className="navigation-empty"><strong>没有可用 Feature</strong><p>Registry 尚未返回已安装且兼容的功能。</p></div>
        : [...snapshot.features.navigation].sort((left, right) => left.order - right.order || left.label.localeCompare(right.label, 'zh-CN')).map((leaf) =>
          <NavigationLeaf key={`${leaf.featureId}:${leaf.id}`} leaf={leaf} selected={snapshot.features.selectedFeatureId === leaf.featureId} run={run} {...(openFeature ? { openFeature } : {})} />)}
    </div>
  </aside>;
}

function NavigationLeaf({ leaf, selected, run, openFeature }: { leaf: FeatureNavigationLeaf; selected: boolean; run: Run; openFeature?: (featureId: string) => void }) {
  const available = leaf.availability === 'available';
  return <button type="button" className={`navigation-leaf ${selected ? 'active' : ''}`} disabled={!available}
    title={leaf.reason || (available ? leaf.label : '该 Feature 当前不可用')}
    onClick={() => openFeature ? openFeature(leaf.featureId) : run(`select-feature:${leaf.featureId}`, () => window.omnia.selectFeature({ featureId: leaf.featureId }))}>
    <span>{leaf.label}</span><span className={`nav-dot ${leaf.availability}`} aria-hidden="true" />
  </button>;
}

function AttachmentCard({ item, staged, run }: {
  item: ShellSnapshot['chat']['stagedAttachments'][number]; staged: boolean; run: Run;
}) {
  const delivery: Record<typeof item.modelDelivery, string> = {
    not_attempted: '未送入模型', sent: '已送入模型', blocked: '能力阻止', unconfirmed: '未确认'
  };
  return <div className={`attachment-card ${item.status === 'failed' ? 'failed' : ''}`}>
    <div><strong>{item.name}</strong><small>{formatSize(item.size)} · {item.mediaType}</small></div>
    <span className={`delivery ${item.modelDelivery}`}>本地安全存储 · {delivery[item.modelDelivery]}</span>
    {item.error ? <p>{item.error}</p> : null}
    <div>
      {item.previewable && item.status !== 'failed' ? <button type="button" onClick={() => run('preview', () => window.omnia.previewAttachment(item.id))}>预览</button> : null}
      {staged ? <button type="button" onClick={() => run('remove-attachment', () => window.omnia.removeAttachment(item.id))}>移除</button> : null}
    </div>
  </div>;
}

function CommentsPanel({ snapshot, run }: { snapshot: ShellSnapshot; run: Run }) {
  const [draft, setDraft] = useState('');
  const [height, setHeight] = useState(snapshot.chat.composerHeightPx);
  const messages = useRef<HTMLDivElement>(null);
  useEffect(() => setHeight(snapshot.chat.composerHeightPx), [snapshot.chat.composerHeightPx]);
  useEffect(() => { messages.current?.scrollTo({ top: messages.current.scrollHeight }); }, [snapshot.chat.messages, snapshot.features.messageCards]);
  const send = () => {
    const attachmentIds = snapshot.chat.stagedAttachments.filter((item) => item.status !== 'removed').map((item) => item.id);
    if (!draft.trim() && !attachmentIds.length) return;
    const content = draft;
    setDraft('');
    run('comments:send', () => window.omnia.sendMessage({ content, attachmentIds }));
  };
  const resize = (event: React.PointerEvent<HTMLDivElement>) => {
    const startY = event.clientY;
    const startHeight = height;
    const move = (next: PointerEvent) => setHeight(clamp(startHeight + startY - next.clientY, 88, 360));
    const up = (next: PointerEvent) => {
      const value = clamp(startHeight + startY - next.clientY, 88, 360);
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      run('composer-height', () => window.omnia.saveComposerHeight({ heightPx: value }));
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  return <section className="comments-panel" aria-label="Comments">
    <div className="comments-stream" ref={messages}>
      {!snapshot.chat.messages.length && !snapshot.features.messageCards.length
        ? <div className="chat-empty"><strong>Comments</strong><p>聊天、确认、进度和结果会保存在这里。</p></div> : null}
      {snapshot.chat.messages.map((message) => <article className={`message ${message.role}`} key={message.id}>
        <div className="message-meta"><span>{message.role === 'user' ? '你' : 'Assistant'}</span><time>{formatTime(message.createdAt)}</time></div>
        {message.content ? <div className="message-body">{message.content}</div> : null}
        {message.attachments.map((item) => <AttachmentCard key={item.id} item={item} staged={false} run={run} />)}
        {message.error ? <div className="message-status">{message.error}</div> : null}
      </article>)}
      {snapshot.features.messageCards.map((card) => <MessageCard key={card.messageId} card={card} run={run} />)}
    </div>
    {snapshot.chat.stagedAttachments.length ? <div className="staged-attachments">{snapshot.chat.stagedAttachments.map((item) =>
      <AttachmentCard key={item.id} item={item} staged run={run} />)}</div> : null}
    <form className="comments-composer" onSubmit={(event) => { event.preventDefault(); send(); }}>
      <div className="composer-resizer" role="separator" aria-orientation="horizontal" title="调整输入区高度" onPointerDown={resize} />
      <textarea data-testid="comments-textarea" style={{ height }} value={draft} onChange={(event) => setDraft(event.target.value)}
        placeholder="输入消息；Enter 发送，Shift+Enter 换行" onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(); }
        }} />
      <div className="composer-actions">
        <button data-testid="comments-attachment" type="button" onClick={() => run('choose-attachments', () => window.omnia.chooseAttachments())}>添加图片/文件</button>
        <button data-testid="comments-send" type="submit" className="primary" disabled={!draft.trim() && !snapshot.chat.stagedAttachments.length}>发送</button>
      </div>
    </form>
  </section>;
}

function MessageCard({ card, run }: { card: FeatureMessageCard; run: Run }) {
  return <article className={`feature-message-card ${card.state}`}>
    <div className="message-meta"><span>Feature</span><strong>{card.title}</strong></div>
    <p>{card.summary}</p>
    <dl>{card.details.map((detail) => <React.Fragment key={detail.label}><dt>{detail.label}</dt><dd>{detail.value}</dd></React.Fragment>)}</dl>
    {card.actions.length ? <div className="button-row no-border">{card.actions.map((action) => <button type="button" key={action.actionId}
      className={action.effect === 'omnia_mutation' ? 'danger' : ''} disabled={!action.enabled} title={action.reason}
      onClick={() => run(`comments:${action.actionId}`, () => window.omnia.featureAction({
        featureId: card.featureId, featureVersion: card.featureVersion, surfaceId: card.surfaceId,
        actionId: action.actionId, expectedStateVersion: card.stateVersion,
        payload: { runId: card.runId, confirmationId: card.confirmationId }
      }))}>{action.label}</button>)}</div> : null}
  </article>;
}

/** Docked Feature content is a main-process WebContentsView, never Shell DOM. */
function FeatureSurfaceFrame({ instance, surface, scalePercent }: { instance: SurfaceInstance<DeclarativeFeatureSurface>; surface: DeclarativeFeatureSurface; scalePercent: number }) {
  const slot = useRef<HTMLDivElement>(null);
  const [reason, setReason] = useState('');
  useEffect(() => {
    const publish = () => {
      const rect = slot.current?.getBoundingClientRect();
      if (!rect || rect.width < 1 || rect.height < 1) return;
      void window.omnia.openFeatureSurface?.({
        instanceId: instance.instanceId,
        featureId: surface.featureId,
        featureVersion: surface.featureVersion,
        surfaceId: surface.surfaceId,
        placement: 'docked',
        bounds: { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) }
      }).then((result) => { if (result && !result.attached) setReason(result.reason); });
    };
    publish();
    const observer = new ResizeObserver(publish);
    if (slot.current) observer.observe(slot.current);
    return () => observer.disconnect();
  }, [instance.instanceId, surface.featureId, surface.featureVersion, surface.surfaceId, scalePercent]);
  return <div ref={slot} className="feature-surface-frame" data-surface-instance-id={instance.instanceId}>
    {reason ? <p className="feature-empty">{reason}</p> : null}
  </div>;
}
function SurfaceActions({ onDetach, onMinimize, onClose }: {
  onDetach(): void; onMinimize(): void; onClose(): void;
}) {
  return <div className="surface-actions" aria-label="Feature 窗口操作">
    <button type="button" aria-label="弹出 Feature" title="弹出" onClick={onDetach}>↗</button>
    <button type="button" aria-label="最小化 Feature" title="最小化" onClick={onMinimize}>−</button>
    <button type="button" aria-label="关闭 Feature" title="关闭（保留 Run）" onClick={onClose}>×</button>
  </div>;
}

function FeatureHost({ instance, scalePercent, onDetach, onMinimize, onClose }: {
  instance: SurfaceInstance<DeclarativeFeatureSurface>; scalePercent: number; onDetach(): void; onMinimize(): void; onClose(): void;
}) {
  if (!instance.value) return <div className="feature-empty">正在读取 Feature Surface…</div>;
  return <div className="feature-host-content"><div className="feature-host-toolbar"><span>{instance.value.title}</span>
    <SurfaceActions onDetach={onDetach} onMinimize={onMinimize} onClose={onClose} /></div>
    <FeatureSurfaceFrame instance={instance} surface={instance.value} scalePercent={scalePercent} /></div>;
}

function TabStrip({ snapshot, host, activeTab, setActiveTab, run, onChange }: {
  snapshot: ShellSnapshot; host: SurfaceHost<DeclarativeFeatureSurface>; activeTab: string;
  setActiveTab(value: string): void; run: Run; onChange(): void;
}) {
  const featureLabels = useMemo(() => new Map(snapshot.features.navigation.map((leaf) => [leaf.featureId, leaf.label])), [snapshot.features.navigation]);
  const instances = host.snapshot().instances.filter((instance) => instance.placement === 'docked');
  const activateFeature = (instance: SurfaceInstance<DeclarativeFeatureSurface>) => {
    const existing = host.get(instance.instanceId);
    if (existing?.placement === 'minimized') {
      host.restore(instance.instanceId);
      void window.omnia.restoreFeatureSurface?.(instance.instanceId);
    } else if (existing?.placement === 'detached') {
      host.focus(instance.instanceId);
      const surface = existing.value;
      if (surface) void window.omnia.openFeatureSurface?.({ instanceId: existing.instanceId, featureId: surface.featureId, featureVersion: surface.featureVersion, surfaceId: surface.surfaceId, placement: 'detached' });
    }
    run(`select-tab:${instance.featureId}`, () => window.omnia.selectFeature({ featureId: instance.featureId }), (next: ShellSnapshot) => {
      const surface = next.features.surface;
      if (surface) host.update(surface.featureId, `${surface.featureVersion}:${surface.surfaceId}`, surface);
      setActiveTab(instance.instanceId);
      onChange();
    });
  };
  return <nav className="tab-strip" aria-label="会话标签">
    <button type="button" className="collapse-button" aria-controls="feature-navigation"
      aria-expanded={!snapshot.layout.collapsedPanels['feature-menu']} title={snapshot.layout.collapsedPanels['feature-menu'] ? '展开功能栏' : '收起功能栏'}
      onClick={() => run('toggle-feature-navigation', () => window.omnia.saveLayout({
        featureNavigationBasisPoints: snapshot.layout.featureNavigationBasisPoints,
        featureNavigationCollapsed: !Boolean(snapshot.layout.collapsedPanels['feature-menu']),
        expectedStateVersion: snapshot.layout.stateVersion
      }))}>☰</button>
    <button type="button" className={`tab comments-tab ${activeTab === 'comments' ? 'active' : ''}`} onClick={() => setActiveTab('comments')}>Comments</button>
    {instances.map((instance) => <button type="button" key={instance.instanceId}
      className={`tab feature-tab ${activeTab === instance.instanceId ? 'active' : ''} ${instance.placement === 'minimized' ? 'minimized' : ''}`}
      onClick={() => activateFeature(instance)} title={featureLabels.get(instance.featureId) || instance.featureId}>
      <span>{featureLabels.get(instance.featureId) || instance.featureId}</span>
      {instance.placement === 'minimized' ? <small>最小化</small> : null}
    </button>)}
  </nav>;
}

const WORKSPACE_RULE_GROUPS = [
  { id: 'it_audit', label: 'IT 审计' },
  { id: 'financial_audit', label: '财务审计' },
  { id: 'business_process', label: '业务流程' },
  { id: 'other', label: '其他' }
] as const;
const WORKSPACE_IT_PATTERN = /(?:^|[\s_\-/])(it|gitc|ipe|dcno|db|os)(?:$|[\s_\-/])|信息技术|信息系统|应用系统|数据库|操作系统|网络|接口|权限|访问管理|变更管理|cyber|application|database|operating\s+system|interface|it\s*memos?/i;
const WORKSPACE_FINANCIAL_PATTERN = /财务报告|财务结账|会计|总账|合并报表|试算平衡|financial\s+statements?|financial\s+reporting|accounting|general\s+ledger|consolidation|trial\s+balance|journal\s+entr/i;
const WORKSPACE_BUSINESS_PATTERN = /业务流程|循环|收入|销售|采购|存货|库存|薪酬|工资|资金|固定资产|税务|revenue|sales|procurement|purchas|inventory|payroll|treasury|fixed\s+assets?|tax|business\s+process|cycle/i;

/**
 * v4-compatible display grouping only. The result is never written back as an
 * Omnia Section relationship; safety persistence still receives exact Facet IDs.
 */
function workspaceRuleGroup(name: string): typeof WORKSPACE_RULE_GROUPS[number]['id'] {
  const value = String(name || '').trim();
  if (/^test$/i.test(value) || /^20\d{3}(?:\D|$)/.test(value) || WORKSPACE_IT_PATTERN.test(value)) return 'it_audit';
  if (WORKSPACE_FINANCIAL_PATTERN.test(value)) return 'financial_audit';
  if (WORKSPACE_BUSINESS_PATTERN.test(value)) return 'business_process';
  return 'other';
}

function SafetyPanel({ snapshot, run }: { snapshot: ShellSnapshot; run: Run }) {
  const [selected, setSelected] = useState<Set<string>>(new Set(snapshot.safety.workspaceIds));
  const [globalEnabled, setGlobalEnabled] = useState(snapshot.safety.globalEnabled);
  const [globalSections, setGlobalSections] = useState<Set<string>>(new Set(snapshot.safety.globalSectionIds));
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [reloadNotice, setReloadNotice] = useState('');
  useEffect(() => {
    setSelected(new Set(snapshot.safety.workspaceIds));
    setGlobalEnabled(snapshot.safety.globalEnabled);
    setGlobalSections(new Set(snapshot.safety.globalSectionIds));
  }, [snapshot.safety.stateVersion]);
  const directory = snapshot.workspaceDirectory.observation;
  const replaceDraftFromSnapshot = (latest: ShellSnapshot) => {
    setSelected(new Set(latest.safety.workspaceIds));
    setGlobalEnabled(latest.safety.globalEnabled);
    setGlobalSections(new Set(latest.safety.globalSectionIds));
  };
  const save = (enabled: boolean) => run('safety', async () => {
    setReloadNotice('');
    try {
      return await window.omnia.saveSafety({
        enabled,
        globalEnabled,
        globalSectionIds: [...globalSections],
        workspaceIds: [...selected],
        expectedStateVersion: snapshot.safety.stateVersion
      });
    } catch (error) {
      const code = String((error as Error & { code?: string })?.code || '');
      if (code !== 'SAFETY.CONFLICT') throw error;
      const latest = await window.omnia.getSnapshot();
      replaceDraftFromSnapshot(latest);
      setReloadNotice('安全锁已由另一窗口更新。本次修改没有保存，已重新读取最新安全锁；请核对后再提交。');
      return latest;
    }
  });
  const reloadSafety = () => run('safety-reload', async () => {
    const latest = await window.omnia.getSnapshot();
    replaceDraftFromSnapshot(latest);
    setReloadNotice('已重新读取 Core 中的最新安全锁。本窗口未保存的选择已丢弃。');
    return latest;
  });
  const toggle = (workspaceId: string) => {
    const next = new Set(selected);
    next.has(workspaceId) ? next.delete(workspaceId) : next.add(workspaceId);
    setSelected(next);
  };
  const toggleGlobalSection = (sectionId: string) => {
    const next = new Set(globalSections);
    next.has(sectionId) ? next.delete(sectionId) : next.add(sectionId);
    setGlobalSections(next);
  };
  const normalizedQuery = query.trim().normalize('NFKC').toLocaleLowerCase('zh-CN');
  const knownSectionIds = new Set(directory?.sections.map((section) => section.id) || []);
  const authoritativeGroups = directory ? directory.sections.map((section) => ({
      id: section.id,
      label: section.name,
      authoritative: true,
      workspaces: directory.workspaces.filter((item) => item.parentSectionId === section.id)
    })).filter((group) => group.workspaces.length > 0) : [];
  const ungroupedWorkspaces = directory?.workspaces.filter((item) => !item.parentSectionId || !knownSectionIds.has(item.parentSectionId)) || [];
  const ruleGroups = WORKSPACE_RULE_GROUPS.map((rule) => ({
    id: `rule:${rule.id}`,
    label: `规则分组 · ${rule.label}`,
    authoritative: false,
    workspaces: ungroupedWorkspaces.filter((workspace) => workspaceRuleGroup(workspace.name) === rule.id)
  })).filter((group) => group.workspaces.length > 0);
  const groups = [...authoritativeGroups, ...ruleGroups];
  const selectedWorkspaces = directory?.workspaces.filter((workspace) => selected.has(workspace.id)) || [];
  const workspaceSectionNames = new Map(directory?.sections.map((section) => [section.id, section.name]) || []);
  const workspaceRuleNames = new Map(WORKSPACE_RULE_GROUPS.map((group) => [group.id, group.label]));
  const globalMembershipCount = directory?.workspaces.filter((workspace) => globalSections.has(workspace.parentSectionId)).length || 0;
  const authoritativeMembershipAvailable = Boolean(directory?.workspaces.some((workspace) => workspace.parentSectionId && knownSectionIds.has(workspace.parentSectionId)));
  return <section className="safety-workbench" aria-label="安全锁设置">
    <div className={`global-safety-card ${globalEnabled ? 'enabled' : ''}`}>
      <div className="global-safety-heading"><div><h3>全局安全锁</h3><p>仅约束删除目标的关联 Workspace；显式选择的 Workspace 始终优先。所在部分必须来自 Omnia 权威关系。</p></div>
        <label className="safety-switch" title={!authoritativeMembershipAvailable ? 'Omnia 未返回可核验的 Section 成员关系，不能启用全局安全锁' : ''}><input type="checkbox" checked={globalEnabled} disabled={!authoritativeMembershipAvailable && !globalEnabled} onChange={(event) => {
          setGlobalEnabled(event.target.checked);
          if (!event.target.checked) setGlobalSections(new Set());
        }} /><span>{globalEnabled ? '已启用' : '未启用'}</span></label></div>
      <div className="global-section-options" aria-label="全局安全锁所在部分">
        {directory?.sections.map((section) => {
          const count = directory.workspaces.filter((workspace) => workspace.parentSectionId === section.id).length;
          return <label key={section.id} title={count ? '' : 'Omnia 未返回该部分的 Workspace 成员关系，不能用于授权'}>
            <input type="checkbox" checked={globalSections.has(section.id)} disabled={!globalEnabled || count === 0} onChange={() => toggleGlobalSection(section.id)} />
            <span>{section.name}</span><small>{count}</small>
          </label>;
        })}
        {directory && !directory.sections.length ? <p className="reason">Omnia 当前没有返回可核验的所在部分。</p> : null}
      </div>
      {!authoritativeMembershipAvailable ? <p className="reason">Omnia 当前未返回 Workspace 与 Section 的权威成员关系，全局安全锁不可启用。下方规则分组只用于批量选择精确 Workspace Facet ID。</p> : null}
      {globalEnabled ? <p className="global-safety-summary">已锁定 {globalSections.size} 个所在部分，冻结 {globalMembershipCount} 个关联 Workspace。</p> : null}
    </div>
    <div className="safety-toolbar">
      <label><span>搜索 Workspace</span><input type="search" value={query} placeholder="名称或 Workspace Facet ID" onChange={(event) => setQuery(event.target.value)} /></label>
      <div className="button-row no-border">
        <button type="button" onClick={reloadSafety} title="丢弃本窗口未保存的选择，并读取 Core 中最新的安全锁状态">重新读取安全锁</button>
        <button type="button" onClick={() => run('workspaces', () => window.omnia.refreshWorkspaceDirectory())} disabled={!snapshot.connection.connected}>刷新 Workspace</button>
      </div>
    </div>
    {!directory ? <p className="reason">{snapshot.workspaceDirectory.reason}</p> : <div className="safety-picker">
      <section className="safety-location-pane" aria-label="所在部分"><div className="safety-pane-title"><strong>所在部分</strong><span>{directory.workspaces.length} 个 Workspace</span></div>
        <div className="safety-groups">{groups.map((group) => {
          const visible = group.workspaces.filter((workspace) => !normalizedQuery
            || workspace.name.normalize('NFKC').toLocaleLowerCase('zh-CN').includes(normalizedQuery)
            || workspace.id.includes(normalizedQuery));
          const selectedCount = group.workspaces.filter((workspace) => selected.has(workspace.id)).length;
          const isCollapsed = collapsed.has(group.id);
          if (normalizedQuery && visible.length === 0) return null;
          return <div className="safety-group" key={group.id}>
            <div className="safety-group-header">
              <button type="button" className="safety-collapse" aria-expanded={!isCollapsed} onClick={() => setCollapsed((current) => {
                const next = new Set(current); next.has(group.id) ? next.delete(group.id) : next.add(group.id); return next;
              })}><span>{isCollapsed ? '›' : '⌄'}</span><strong>{group.label}</strong>{!group.authoritative ? <small>仅批量选择</small> : null}</button>
              <label title={group.authoritative ? '选择或取消此部分中的全部 Workspace' : '按规则批量选择或取消精确 Workspace Facet ID；不会把规则写成所在部分'}><input type="checkbox" checked={selectedCount === group.workspaces.length} onChange={(event) => {
                const next = new Set(selected); for (const workspace of group.workspaces) event.target.checked ? next.add(workspace.id) : next.delete(workspace.id); setSelected(next);
              }} /><span>{selectedCount}/{group.workspaces.length}</span></label>
            </div>
            {!isCollapsed ? <div className="safety-workspace-list">{visible.map((workspace) => <label key={workspace.id} title={workspace.id}>
              <input type="checkbox" checked={selected.has(workspace.id)} onChange={() => toggle(workspace.id)} /><span>{workspace.name}</span>
            </label>)}</div> : null}
          </div>;
        })}</div>
      </section>
      <aside className="safety-selected-pane" aria-label="已选 Workspace"><div className="safety-pane-title"><strong>已选的工作区</strong><button type="button" disabled={!selected.size} onClick={() => setSelected(new Set())}>清空</button></div>
        <div className="safety-selected-list">{selectedWorkspaces.map((workspace) => <div key={workspace.id} title={workspace.id}><span><strong>{workspace.name}</strong><small>{workspaceSectionNames.get(workspace.parentSectionId) || `规则分组 · ${workspaceRuleNames.get(workspaceRuleGroup(workspace.name)) || '其他'}（仅批量选择）`}</small></span><button type="button" aria-label={`移除 ${workspace.name}`} onClick={() => toggle(workspace.id)}>×</button></div>)}
          {!selectedWorkspaces.length ? <p>尚未选择 Workspace。</p> : null}</div>
      </aside>
    </div>}
    {reloadNotice ? <p className="reason">{reloadNotice}</p> : null}
    <div className="safety-footer"><div><strong>{selected.size}</strong> 个显式 Workspace{snapshot.safety.enabled ? ' · 当前安全锁已启用' : ''}</div><div className="button-row no-border">
      <button type="button" className="primary" disabled={!selected.size || !directory || (globalEnabled && (!globalSections.size || !globalMembershipCount))} onClick={() => save(true)}>{snapshot.safety.enabled ? '保存安全锁' : '保存并启用'}</button>
      {snapshot.safety.enabled ? <button type="button" onClick={() => save(false)}>关闭安全锁</button> : null}</div></div>
    {snapshot.safety.invalidReason ? <p className="reason error">{snapshot.safety.invalidReason}</p> : null}
  </section>;
}

function InteractionLogPanel() {
  const [severity, setSeverity] = useState<'' | InteractionSeverity>('');
  const [plane, setPlane] = useState<'' | InteractionPlane>('');
  const [period, setPeriod] = useState('24');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState<InteractionLogPage>({ entries: [], hasMore: false });
  const [selected, setSelected] = useState<InteractionLogTrace | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const refresh = useCallback(() => {
    setLoading(true); setError('');
    const hours = Number(period);
    void window.omnia.queryInteractionLogs({
      severity, plane, interactionId: search.trim(), limit: 200,
      ...(hours > 0 ? { since: new Date(Date.now() - hours * 3_600_000).toISOString() } : {})
    }).then((next) => {
      setPage(next);
      if (selected && !next.entries.some((entry) => entry.traceId === selected.traceId)) setSelected(null);
    }).catch((reason) => setError(reason instanceof Error ? reason.message : '日志查询失败。')).finally(() => setLoading(false));
  }, [severity, plane, period, search, selected?.traceId]);
  useEffect(refresh, [severity, plane, period]);
  const openTrace = (entry: InteractionLogEntry) => {
    setError('');
    void window.omnia.getInteractionTrace(entry.traceId).then(setSelected)
      .catch((reason) => setError(reason instanceof Error ? reason.message : '日志详情查询失败。'));
  };
  const active = selected?.entries.find((entry) => entry.phase === 'failure') || selected?.entries.at(-1) || null;
  return <section className="interaction-log-panel" aria-label="交互日志">
    <div className="log-toolbar">
      <label>级别<select value={severity} onChange={(event) => setSeverity(event.target.value as '' | InteractionSeverity)}><option value="">全部</option><option value="error">错误</option><option value="info">信息</option></select></label>
      <label>层<select value={plane} onChange={(event) => setPlane(event.target.value as '' | InteractionPlane)}><option value="">全部</option><option value="surface">Surface</option><option value="middle">Middle</option><option value="core">Core</option><option value="connector">Connector</option></select></label>
      <label>时间<select value={period} onChange={(event) => setPeriod(event.target.value)}><option value="1">1 小时</option><option value="24">24 小时</option><option value="168">7 天</option><option value="336">14 天</option></select></label>
      <label className="log-search">交互 ID<input value={search} maxLength={128} placeholder="interaction / trace / parent ID" onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') refresh(); }} /></label>
      <button type="button" onClick={refresh} disabled={loading}>{loading ? '查询中…' : '查询'}</button>
    </div>
    {error ? <p className="reason error log-query-error">{error}</p> : null}
    <div className="log-content">
      <div className="log-list" role="list" aria-label="日志列表">
        {page.entries.map((entry) => <button type="button" role="listitem" key={entry.eventId} className={selected?.traceId === entry.traceId ? 'active' : ''} onClick={() => openTrace(entry)}>
          <time>{formatTime(entry.timestamp)}</time><span className={`log-result ${entry.phase}`}>{entry.phase === 'failure' ? '失败' : entry.phase === 'success' ? '成功' : '进行中'}</span>
          <strong>{entry.plane} / {entry.component}</strong><span>{entry.action}</span>
          <code>{entry.errorCode || entry.failurePoint || '—'}</code>
        </button>)}
        {!page.entries.length && !loading ? <p className="reason">当前筛选条件下没有日志。</p> : null}
        {page.hasMore ? <p className="reason">结果超过 200 条，请缩小时间或 ID 范围。</p> : null}
      </div>
      <div className="log-detail" aria-label="日志详情">
        {!active ? <p className="reason">选择一条日志查看同一 trace 的完整阶段。</p> : <>
          <dl><dt>Trace ID</dt><dd><code>{active.traceId}</code></dd><dt>Interaction ID</dt><dd><code>{active.interactionId}</code></dd>
            <dt>结果 / 耗时</dt><dd>{active.phase} / {active.durationMs} ms</dd><dt>层 / 组件</dt><dd>{active.plane} / {active.component}</dd>
            <dt>操作</dt><dd>{active.surface} / {active.action}</dd><dt>错误码</dt><dd><code>{active.errorCode || '—'}</code></dd>
            <dt>失败点</dt><dd><code>{active.failurePoint || '—'}</code></dd><dt>消息</dt><dd>{active.message || '—'}</dd>
            <dt>业务关联</dt><dd><code>{[active.runId, active.commandId, active.requestId, active.operationId].filter(Boolean).join(' / ') || '—'}</code></dd></dl>
          <h4>Trace 阶段</h4><ol>{selected!.entries.map((entry) => <li key={entry.eventId}><time>{formatTime(entry.timestamp)}</time> {entry.plane}/{entry.component} · {entry.action} · {entry.phase}{entry.failurePoint ? ` · ${entry.failurePoint}` : ''}</li>)}</ol>
          <h4>脱敏详情</h4><pre>{JSON.stringify(active.details, null, 2)}</pre>
        </>}
      </div>
    </div>
  </section>;
}

function SafetyDialog({ snapshot, close, run }: { snapshot: ShellSnapshot; close(): void; run: Run }) {
  useEffect(() => {
    if (snapshot.connection.connected) run('workspaces', () => window.omnia.refreshWorkspaceDirectory());
  }, [snapshot.connection.connected, snapshot.connection.engagementId, run]);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <section className="safety-dialog" role="dialog" aria-modal="true" aria-label="安全锁工作台" data-testid="safety-dialog">
      <header><div><h2>安全锁</h2><p>以当前 Pack 的精确 Workspace Facet ID 锁定目标，并用权威所在部分限制删除关联。</p></div><button type="button" onClick={close}>关闭</button></header>
      <div className="safety-dialog-body"><SafetyPanel snapshot={snapshot} run={run} /></div>
    </section>
  </div>;
}

function SettingsDialog({ snapshot, close, run, fail }: { snapshot: ShellSnapshot; close(): void; run: Run; fail(message: string): void }) {
  const ai = snapshot.settings.ai;
  const [section, setSection] = useState<'ai' | 'logs'>('ai');
  const [provider, setProvider] = useState<AiProviderKind>(ai.provider);
  const [baseUrl, setBaseUrl] = useState(ai.baseUrl);
  const [model, setModel] = useState(ai.model);
  const [capability, setCapability] = useState<AiAttachmentCapability>(ai.attachmentCapability);
  const [apiKey, setApiKey] = useState('');
  const [settingsBasis, setSettingsBasis] = useState(snapshot.settingsLayout.settingsNavigationBasisPoints);
  useEffect(() => setSettingsBasis(snapshot.settingsLayout.settingsNavigationBasisPoints), [snapshot.settingsLayout.stateVersion]);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <section className="settings-dialog" role="dialog" aria-modal="true" aria-label="设置" data-testid="settings-dialog">
      <header><h2>设置</h2><div className="header-actions"><ScaleControl snapshot={snapshot} fail={fail} /><button type="button" onClick={close}>关闭</button></div></header>
      <div className="settings-columns" style={{ gridTemplateColumns: `${settingsBasis / 100}% 7px minmax(0, 1fr)` }}><nav className="settings-nav" aria-label="设置导航" data-testid="settings-nav-scroll">
        <button type="button" className={section === 'ai' ? 'active' : ''} onClick={() => setSection('ai')}>AI 设置</button>
        <button type="button" className={section === 'logs' ? 'active' : ''} onClick={() => setSection('logs')}>日志</button>
      </nav><div className="settings-splitter" role="separator" aria-orientation="vertical" aria-label="调整设置导航宽度"
        aria-valuemin={1600} aria-valuemax={3600} aria-valuenow={settingsBasis} tabIndex={0}
        onDoubleClick={() => run('settings-layout-reset', () => window.omnia.saveSettingsLayout({ settingsNavigationBasisPoints: 2200, expectedStateVersion: snapshot.settingsLayout.stateVersion }))}
        onKeyDown={(event) => {
          let next = settingsBasis;
          if (event.key === 'ArrowLeft') next -= event.shiftKey ? 500 : 100;
          else if (event.key === 'ArrowRight') next += event.shiftKey ? 500 : 100;
          else if (event.key === 'Home') next = 1600;
          else if (event.key === 'End') next = 3600;
          else if (event.key === 'Enter') next = 2200;
          else return;
          event.preventDefault(); next = clamp(next, 1600, 3600); setSettingsBasis(next);
          run('settings-layout-keyboard', () => window.omnia.saveSettingsLayout({ settingsNavigationBasisPoints: next, expectedStateVersion: snapshot.settingsLayout.stateVersion }));
        }}
        onPointerDown={(event) => {
          const grid = event.currentTarget.parentElement!; const start = event.clientX; const base = settingsBasis;
          const move = (next: PointerEvent) => setSettingsBasis(clamp(Math.round(base + (next.clientX - start) / grid.clientWidth * 10000), 1600, 3600));
          const up = (next: PointerEvent) => {
            const value = clamp(Math.round(base + (next.clientX - start) / grid.clientWidth * 10000), 1600, 3600);
            window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); setSettingsBasis(value);
            run('settings-layout', () => window.omnia.saveSettingsLayout({ settingsNavigationBasisPoints: value, expectedStateVersion: snapshot.settingsLayout.stateVersion }));
          };
          window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
        }} />
      <div className={`settings-main ${section === 'logs' ? 'logs-active' : ''}`} data-testid="settings-main-scroll">
        {section === 'ai' ? <section className="settings-section"><h3>AI 设置</h3>
          <label>Provider<select value={provider} onChange={(event) => { const next = event.target.value as AiProviderKind; setProvider(next); if (next === 'deepseek') { setBaseUrl('https://api.deepseek.com'); setModel('deepseek-v4-flash'); setCapability('text_only'); } }}>
            <option value="deepseek">DeepSeek</option><option value="custom">OpenAI-compatible Custom</option></select></label>
          <label>Base URL<input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} /></label>
          <label>Model<input value={model} onChange={(event) => setModel(event.target.value)} /></label>
          <label>附件能力<select disabled={provider === 'deepseek'} value={capability} onChange={(event) => setCapability(event.target.value as AiAttachmentCapability)}>
            <option value="text_only">仅文本</option><option value="images">图片</option><option value="images_and_text">图片与文本文件</option></select></label>
          <label>API Key<input type="password" autoComplete="off" value={apiKey} placeholder={ai.hasApiKey ? '已安全保存；留空表示不变更' : '尚未配置'} onChange={(event) => setApiKey(event.target.value)} /></label>
          <p className={`test-state ${ai.testStatus}`}>{ai.testMessage || '尚未测试连接。'}</p>
          <div className="button-row no-border"><button type="button" className="primary" onClick={() => run('save-ai', () => window.omnia.saveAiSettings({ provider, baseUrl, model, attachmentCapability: capability, ...(apiKey ? { apiKey } : {}), expectedStateVersion: ai.stateVersion }))}>保存 AI 设置</button>
            <button type="button" disabled={!ai.hasApiKey && !apiKey} onClick={() => run('test-ai', () => window.omnia.testAiProvider())}>测试连接</button></div>
        </section> : null}
        {section === 'logs' ? <InteractionLogPanel /> : null}
      </div></div>
    </section>
  </div>;
}

function RemoteConnectionDialog({ snapshot, close, run }: { snapshot: ShellSnapshot; close(): void; run: Run }) {
  const binding = snapshot.settings.connection;
  const pairing = snapshot.remotePairing;
  const pairingCapability = snapshot.bridgePairing;
  const pairingBusy = ['waiting', 'candidate'].includes(pairing.state);
  const repair = () => {
    if (!window.confirm('重新配对会在新设备验证成功后撤销旧绑定。是否继续？')) return;
    run('remote-repair', () => window.omnia.beginRemotePairing({ repair: true, confirmed: true, expectedStateVersion: binding.stateVersion }));
  };
  const unbind = () => {
    if (!window.confirm('解除绑定只会清除 Connector 身份，不会删除聊天、Feature、Evidence 或文档。是否继续？')) return;
    run('remote-unbind', () => window.omnia.revokeRemoteBinding({ confirmed: true, expectedStateVersion: binding.stateVersion }), close);
  };
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <section className="connection-dialog" role="dialog" aria-modal="true" aria-label="Remote Connector 连接" data-testid="remote-connection-dialog">
      <header><div><h2>Remote Connector</h2><p>{snapshot.connection.message || '等待连接状态。'}</p></div><button type="button" onClick={close}>关闭</button></header>
      <div className="connection-dialog-body">
        {pairing.state === 'waiting' ? <section className="pairing-guide">
          <h3>首次连接</h3><p>在公司电脑的 Remote Connector 中输入以下 4 位数字链接码。链接码 2 分钟内有效且仅可使用一次。</p>
          <code data-testid="remote-pairing-code">{pairing.pairingCode}</code><small>有效期至 {formatTime(pairing.expiresAt)}</small>
        </section> : null}
        {pairing.state === 'candidate' ? <p className="reason">{pairing.message}</p> : null}
        {pairing.state === 'expired' || pairing.state === 'failed' ? <p className="reason error">{pairing.message}</p> : null}
        {!pairingBusy && !pairingCapability.canCreateSession
          ? <p className="reason error" data-testid="remote-pairing-capability-reason">{pairingCapability.reason}</p>
          : null}
        {binding.remotePaired ? <dl className="connection-facts"><dt>状态</dt><dd>{binding.bindingState}</dd><dt>设备</dt><dd>{binding.connectorName || binding.connectorId}</dd><dt>Connector</dt><dd>{binding.connectorVersion || '未知'}</dd><dt>协议</dt><dd>{binding.protocolVersion || '未知'}</dd></dl> : null}
        <div className="button-row no-border">
          <button type="button" onClick={() => run('remote-diagnose', () => window.omnia.diagnoseRemoteConnection())}>诊断连接</button>
          {!pairingBusy && (binding.remotePaired || binding.bindingState === 'repair_required') ? <button type="button" disabled={!pairingCapability.canCreateSession} title={pairingCapability.reason} onClick={repair}>重新配对</button> : null}
          {!pairingBusy && binding.remotePaired ? <button type="button" className="danger" onClick={unbind}>解除当前设备绑定</button> : null}
          {pairingBusy ? <button type="button" onClick={() => run('remote-pair-cancel', () => window.omnia.cancelRemotePairing())}>取消当前链接码</button> : null}
          {!binding.remotePaired && !pairingBusy ? <button type="button" className="primary" disabled={!pairingCapability.canCreateSession} title={pairingCapability.reason} onClick={() => run('remote-pair', () => window.omnia.beginRemotePairing({ repair: false, expectedStateVersion: binding.stateVersion }))}>生成一次性链接码</button> : null}
        </div>
      </div>
    </section>
  </div>;
}

function ShellApp() {
  const [snapshot, setSnapshot] = useState<ShellSnapshot | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [preview, setPreview] = useState<LayoutPreference | null>(null);
  const [settings, setSettings] = useState(false);
  const [safety, setSafety] = useState(false);
  const [connectionDetails, setConnectionDetails] = useState(false);
  const [activeTab, setActiveTab] = useState('comments');
  const [hostVersion, setHostVersion] = useState(0);
  const hostRef = useRef(new SurfaceHost<DeclarativeFeatureSurface>());
  const host = hostRef.current;
  const run = useCallback<Run>((name, action, onSuccess) => {
    setBusy(name); setError('');
    void action().then((value) => {
      if (value?.schemaVersion) {
        setSnapshot(value);
        if (value.features?.messageCards?.some((card: FeatureMessageCard) => card.state === 'pending_confirmation')) setActiveTab('comments');
      }
      onSuccess?.(value);
    }).catch((reason) => setError(reason instanceof Error ? reason.message : '操作失败')).finally(() => setBusy(''));
  }, []);
  useEffect(() => {
    void window.omnia.getSnapshot().then(setSnapshot).catch((reason) => setError(reason instanceof Error ? reason.message : '读取 Core 状态失败'));
    const offChanged = window.omnia.onChanged((next) => {
      setSnapshot(next);
      const surface = next.features.surface;
      if (surface) {
        const key = `${surface.featureVersion}:${surface.surfaceId}`;
        if (!host.get(`${surface.featureId}::${key}`)) host.open(surface.featureId, key, surface);
        else host.update(surface.featureId, key, surface);
        setHostVersion((value) => value + 1);
      }
      if (next.features.messageCards.some((card) => card.state === 'pending_confirmation')) setActiveTab('comments');
    });
    const offDocked = window.omnia.onFeatureDocked?.((instanceId) => {
      if (!host.dock(instanceId)) return;
      setActiveTab(instanceId);
      setHostVersion((value) => value + 1);
    });
    return () => { offChanged(); offDocked?.(); };
  }, [host]);
  useEffect(() => {
    if (snapshot?.remotePairing.state === 'waiting') setConnectionDetails(true);
  }, [snapshot?.remotePairing.state]);
  useEffect(() => {
    if (snapshot?.remotePairing.state !== 'waiting') return;
    const timer = window.setInterval(() => run('remote-pair-poll', () => window.omnia.pollRemotePairing()), 1_500);
    return () => window.clearInterval(timer);
  }, [snapshot?.remotePairing.state, run]);
  useEffect(() => {
    const active = activeTab === 'comments' ? null : host.get(activeTab);
    void window.omnia.setDockedSurfaceVisibility?.({
      activeInstanceId: !settings && !safety && !connectionDetails && active?.placement === 'docked' ? active.instanceId : null,
      overlayActive: settings || safety || connectionDetails
    });
  }, [activeTab, settings, safety, connectionDetails, host, hostVersion]);
  useEffect(() => {
    if (!snapshot) return;
    const keydown = (event: KeyboardEvent) => {
      if (!event.ctrlKey) return;
      let percent: number | null = null;
      if (event.key === '0') percent = 100;
      else if (event.key === '+' || event.key === '=') percent = snapshot.preference.uiScalePercent + 5;
      else if (event.key === '-' || event.key === '_') percent = snapshot.preference.uiScalePercent - 5;
      if (percent === null) return;
      event.preventDefault();
      const next = clamp(percent, 80, 130);
      run('keyboard-scale', () => window.omnia.saveScale({ percent: next, expectedStateVersion: snapshot.preference.stateVersion }));
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [snapshot?.preference.stateVersion, snapshot?.preference.uiScalePercent, run]);
  if (!snapshot) return <div className="boot-screen">正在读取 Core 状态…</div>;
  const layout = preview || snapshot.layout;
  const commit = (middle: number) => {
    setPreview(null);
    run('layout', () => window.omnia.saveLayout({ featureNavigationBasisPoints: middle,
      featureNavigationCollapsed: Boolean(snapshot.layout.collapsedPanels['feature-menu']), expectedStateVersion: snapshot.layout.stateVersion }));
  };
  const openFeature = (featureId: string) => {
    const existing = host.getByFeature(featureId)[0];
    const shouldActivateNewSurface = !existing || existing.placement === 'closed';
    if (existing && existing.placement !== 'closed') {
      if (existing.placement === 'minimized') {
        host.restore(existing.instanceId); void window.omnia.restoreFeatureSurface?.(existing.instanceId);
      } else if (existing.placement === 'detached') {
        host.focus(existing.instanceId);
      }
    }
    run(`select-feature:${featureId}`, () => window.omnia.selectFeature({ featureId }), (next: ShellSnapshot) => {
      const surface = next.features.surface;
      if (!surface) return;
      const key = `${surface.featureVersion}:${surface.surfaceId}`;
      const current = host.get(surface.featureId + '::' + key);
      const instance = current && current.placement !== 'closed' ? current : host.open(surface.featureId, key, surface);
      host.update(surface.featureId, key, surface);
      if (instance.placement === 'detached') {
        void window.omnia.openFeatureSurface?.({ instanceId: instance.instanceId, featureId: surface.featureId, featureVersion: surface.featureVersion, surfaceId: surface.surfaceId, placement: 'detached' });
      }
      if (shouldActivateNewSurface || instance.placement === 'docked') setActiveTab(instance.instanceId);
      setHostVersion((v) => v + 1);
    });
  };
  const activeFeatureInstance = activeTab !== 'comments' ? host.get(activeTab) : undefined;
  const detach = (instance: SurfaceInstance<DeclarativeFeatureSurface>) => {
    host.detach(instance.instanceId); setActiveTab('comments'); setHostVersion((v) => v + 1);
    const surface = instance.value;
    if (surface) void window.omnia.openFeatureSurface?.({ instanceId: instance.instanceId, featureId: surface.featureId, featureVersion: surface.featureVersion, surfaceId: surface.surfaceId, placement: 'detached' });
  };
  const minimize = (instance: SurfaceInstance<DeclarativeFeatureSurface>) => {
    host.minimize(instance.instanceId); setActiveTab('comments'); setHostVersion((v) => v + 1);
    const surface = instance.value;
    if (surface) void window.omnia.openFeatureSurface?.({ instanceId: instance.instanceId, featureId: surface.featureId, featureVersion: surface.featureVersion, surfaceId: surface.surfaceId, placement: 'minimized' });
  };
  const closeFeature = (instance: SurfaceInstance<DeclarativeFeatureSurface>) => {
    host.close(instance.instanceId); setActiveTab('comments'); setHostVersion((v) => v + 1);
    void window.omnia.closeFeatureSurface?.(instance.instanceId);
  };
  const openSettings = () => {
    void window.omnia.setDockedSurfaceVisibility?.({ activeInstanceId: null, overlayActive: true });
    setSettings(true);
  };
  const closeSettings = () => setSettings(false);
  return <div className="app-frame" aria-busy={Boolean(busy)}>
    <aside className="rail"><div className="brand-mark" aria-label="Omnia Agent">OA</div><div className="rail-spacer" />
      <button type="button" className="rail-settings" aria-label="设置" title="设置" onClick={openSettings}>⚙</button></aside>
    <section className="workspace-shell"><GlobalSessionBar snapshot={snapshot} run={run} fail={setError} busy={busy} openSafety={() => setSafety(true)} openConnection={() => setConnectionDetails(true)} />
      <div className="content-grid" style={{ gridTemplateColumns: snapshot.layout.collapsedPanels['feature-menu'] ? '0 minmax(0, 1fr)' : `${layout.featureNavigationBasisPoints / 100}% 7px minmax(0, 1fr)` }}>
        <FeatureNavigation snapshot={snapshot} collapsed={snapshot.layout.collapsedPanels['feature-menu']} run={run} openFeature={openFeature} />
        {!snapshot.layout.collapsedPanels['feature-menu'] ? <div className="navigation-splitter" role="separator" aria-label="调整 FeatureNavigation 宽度" onPointerDown={(event) => {
          const hostElement = event.currentTarget.parentElement!; const start = event.clientX; const base = layout.featureNavigationBasisPoints;
          const move = (next: PointerEvent) => { const delta = next.clientX - start; const nextBasis = clamp(Math.round(base + delta / hostElement.clientWidth * 10000), 1800, 4800); setPreview({ ...layout, featureNavigationBasisPoints: nextBasis }); };
          const up = (next: PointerEvent) => { const delta = next.clientX - start; const nextBasis = clamp(Math.round(base + delta / hostElement.clientWidth * 10000), 1800, 4800); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); commit(nextBasis); };
          window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
        }} /> : null}
        <main className="tabbed-host"><TabStrip snapshot={snapshot} host={host} activeTab={activeTab} setActiveTab={setActiveTab} run={run} onChange={() => setHostVersion((v) => v + 1)} />
          <div className="host-content" key={hostVersion}>{activeTab === 'comments' || !activeFeatureInstance || activeFeatureInstance.placement !== 'docked'
            ? <CommentsPanel snapshot={snapshot} run={run} />
            : <FeatureHost instance={activeFeatureInstance} scalePercent={snapshot.preference.uiScalePercent} onDetach={() => detach(activeFeatureInstance)} onMinimize={() => minimize(activeFeatureInstance)} onClose={() => closeFeature(activeFeatureInstance)} />}</div>
        </main>
      </div>
    </section>
    {settings ? <SettingsDialog snapshot={snapshot} close={closeSettings} run={run} fail={setError} /> : null}
    {safety ? <SafetyDialog snapshot={snapshot} close={() => setSafety(false)} run={run} /> : null}
    {connectionDetails ? <RemoteConnectionDialog snapshot={snapshot} close={() => setConnectionDetails(false)} run={run} /> : null}
    {error ? <div className="toast" role="alert"><span>{error}</span><button type="button" onClick={() => setError('')} aria-label="关闭错误">×</button></div> : null}
  </div>;
}

createRoot(document.getElementById('root')!).render(<ShellApp />);
