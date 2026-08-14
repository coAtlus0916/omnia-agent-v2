import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  featureActionFailureMessage,
  droppedInputIsStandaloneFile,
  reconcileBootstrapReviewDrafts,
  retainFeatureActionFailure,
  selectionBrowserUsesFixedFooter
} from '../src/renderer/feature-window.js';
import type {DeclarativeFeatureSurface, DeclarativeReviewField} from '../src/shared/feature-contracts.js';

const root=path.resolve(import.meta.dirname,'..');

test('generic Feature renderer is contract-driven two-column workflow without feature-id business branches',()=>{
  const renderer=fs.readFileSync(path.join(root,'src/renderer/feature-window.ts'),'utf8'); const html=fs.readFileSync(path.join(root,'src/renderer/feature-window.html'),'utf8');
  assert.match(renderer,/surface\.workflow/u);assert.match(renderer,/surface\.progress/u);assert.match(renderer,/surface\.issues/u);assert.match(renderer,/importInputBytes/u);assert.match(renderer,/saveManagedAsset/u);assert.doesNotMatch(renderer,/omnia\.(?:recording|create-associate)|featureId\s*===\s*['"]/u);
  assert.match(renderer,/action\.pendingPresentation/u);assert.match(renderer,/action\.presentation === 'return'/u);assert.match(renderer,/pending\.workflowStepId/u);
  assert.doesNotMatch(renderer,/\['confirm-return', 'continue-return', 'reconcile-return'\]|createAssociatePendingPresentation/u);
  assert.match(html,/grid-template-columns:176px minmax\(0,1fr\)/u);assert.match(html,/@media\(max-width:560px\)[\s\S]*\.workflow-rail ol\{display:flex/u);assert.match(html,/#feature-root\{[^}]*overflow:auto/u);assert.match(html,/overflow-x:auto/u);
});

test('generic Feature upload preserves standalone drops and forwards folder selection contracts',()=>{
  assert.equal(droppedInputIsStandaloneFile([{relativePath:'制度.zip'}]),true);
  assert.equal(droppedInputIsStandaloneFile([{relativePath:'制度/制度.docx'}]),false);
  assert.equal(droppedInputIsStandaloneFile([{relativePath:'a.docx'},{relativePath:'b.xlsx'}]),false);
  const renderer=fs.readFileSync(path.join(root,'src/renderer/feature-window.ts'),'utf8');
  const main=fs.readFileSync(path.join(root,'src/main/index.ts'),'utf8');
  assert.match(renderer,/action\.input\.multiple !== undefined[\s\S]*action\.input\.directory !== undefined/u);
  assert.match(renderer,/droppedInputIsStandaloneFile\(collected\)/u);
  assert.match(renderer,/dataTransfer\.files/u);
  assert.match(main,/请选择资料的选取方式[\s\S]*选择文件[\s\S]*选择文件夹/u);
});

test('Delete and Workpaper opt into the same declared fixed-footer catalog layout without Comments',()=>{
  const deletion=fs.readFileSync(path.join(root,'scripts/package-delete-feature.mjs'),'utf8');
  const workpaper=fs.readFileSync(path.join(root,'scripts/package-workpaper-preparation-feature.mjs'),'utf8');
  for(const source of [deletion,workpaper]){
    assert.match(source,/schemaVersion: 'omnia\.selection-browser-layout\/v1',\s*mode: 'fixed_footer_split'/u);
    assert.doesNotMatch(source,/featureId\s*===\s*['"](?:omnia\.delete-elements|omnia\.workpaper-preparation)/u);
  }
  assert.doesNotMatch(deletion,/actionId: '[-a-z]*comment/u);
  assert.doesNotMatch(workpaper,/actionId: '[-a-z]*comment/u);
});

test('standard selection-browser surfaces retain the legacy layout while fixed mode explicitly opts in',()=>{
  assert.equal(selectionBrowserUsesFixedFooter(undefined),false);
  assert.equal(selectionBrowserUsesFixedFooter({schemaVersion:'omnia.declarative-selection-browser/v1',layout:{schemaVersion:'omnia.selection-browser-layout/v1',mode:'standard'},hierarchyLabel:'Hierarchy',resultsLabel:'Results',searchPlaceholder:'Search',emptyMessage:'Empty',allScopesLabel:'All',selectVisibleLabel:'Select',clearSelectionLabel:'Clear',footerActionIds:['select-action'],primaryActionId:'select-action'}),false);
  assert.equal(selectionBrowserUsesFixedFooter({schemaVersion:'omnia.declarative-selection-browser/v1',layout:{schemaVersion:'omnia.selection-browser-layout/v1',mode:'fixed_footer_split'},hierarchyLabel:'Hierarchy',resultsLabel:'Results',searchPlaceholder:'Search',emptyMessage:'Empty',allScopesLabel:'All',selectVisibleLabel:'Select',clearSelectionLabel:'Clear',footerActionIds:['select-action'],primaryActionId:'select-action'}),true);
});

test('generic selection browsers preserve both independent pane scroll positions across every DOM rerender',()=>{
  const renderer=fs.readFileSync(path.join(root,'src/renderer/feature-window.ts'),'utf8');
  assert.match(renderer,/function captureSelectionBrowserScroll\(\)[\s\S]*hierarchyTop: hierarchy\.scrollTop[\s\S]*resultsTop: results\.scrollTop/u);
  assert.match(renderer,/function restoreSelectionBrowserScroll\([\s\S]*snapshot\.uiIdentity !== selectionUiIdentity[\s\S]*hierarchy\?\.scrollTo\(\{top:snapshot\.hierarchyTop[\s\S]*results\?\.scrollTo\(\{top:snapshot\.resultsTop/u);
  assert.match(renderer,/function render\(\): void \{\s*const selectionScroll = captureSelectionBrowserScroll\(\);[\s\S]*root\.innerHTML[\s\S]*restoreSelectionBrowserScroll\(selectionScroll\);/u);
  assert.match(renderer,/next\?\.focus\(\{preventScroll:true\}\)/u);
});

test('generic Feature review renders real review contract and dispatches CAS-safe actions without silent dirty-value loss',()=>{
  const renderer=fs.readFileSync(path.join(root,'src/renderer/feature-window.ts'),'utf8'); const html=fs.readFileSync(path.join(root,'src/renderer/feature-window.html'),'utf8');
  for(const token of ['surface.review','review.elementTypes','review.elements','review.fields','review.issueOrder','data-review-kind','data-review-element','data-review-field','data-review-input']) assert.match(renderer,new RegExp(token.replace('.','\\.'),'u'));
  assert.match(renderer,/currentSelected \|\| elements\.find\(\(element\) => element\.blocking\)/u);
  assert.match(renderer,/surface\?\.review\?\.fields[\s\S]*dirtyReviewValues\.has\(field\.fieldKey\)[\s\S]*rowKey: field\.rowKey[\s\S]*fieldKey: field\.fieldKey[\s\S]*expectedRevision: field\.expectedRevision[\s\S]*dirtyReviewValues\.get\(field\.fieldKey\)/u);
  assert.match(renderer,/remove-batch-row[\s\S]*rowKey: selectedReviewRowKey, expectedRunRevision: surface\?\.stateVersion/u);
  assert.match(renderer,/revalidate-all[\s\S]*expectedRunRevision: surface\?\.stateVersion/u);
  assert.match(renderer,/dirtyReviewValues\.size > 0/u);assert.match(renderer,/请先保存修改/u);
  assert.match(renderer,/const actions = !visibleReview && !surface\.recorder && !hasSelectionBrowser/u);assert.match(renderer,/surface\?\.review && action\?\.input\?\.kind === 'open_file'[\s\S]*请先返回上传步骤/u);
  assert.match(renderer,/window\.confirm\('仅从本次上传批次中移除此元素；不会删除 Omnia 中的任何对象。是否继续？'\)/u);
  assert.match(renderer,/review-shell[\s\S]*review-issues[\s\S]*review-layout/u);assert.match(renderer,/\$\{progress\}[\s\S]*\$\{review\}/u);
  assert.doesNotMatch(renderer,/isDataAvailable/u);assert.doesNotMatch(renderer,/featureId\s*===\s*['"]|omnia\.create-associate/u);
  assert.match(html,/\.review-layout\{display:grid;grid-template-columns:146px minmax\(0,1fr\)/u);
  assert.match(html,/\.review-fields\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/u);
  assert.match(html,/@media\(max-width:840px\)[\s\S]*\.review-layout\{grid-template-columns:1fr\}[\s\S]*\.review-types\{display:grid/u);
});

test('create-associate declared effects match durable Review and confirmation side effects',()=>{
  const packager=fs.readFileSync(path.join(root,'scripts/package-create-associate-feature.mjs'),'utf8');
  for(const actionId of ['revalidate-all','back-to-upload','prepare-return'])assert.match(packager,new RegExp(`actionId: '${actionId}'[^\n]+effect: 'local_state_write'`,'u'));
  const worker=fs.readFileSync(path.join(root,'feature-packages/create-associate/source/middle/worker.cjs'),'utf8');
  assert.match(worker,/input\.actionId==='back-to-upload'[\s\S]*plan\.reviewNavigation='upload'[\s\S]*store\.call\('savePlan',plan\)/u);
  assert.doesNotMatch(worker,/recomputeLocalIssues\(plan\.parsed\);if\(input\.actionId==='remove-batch-row'\)/u);
});

test('Main dispatches signed on-reopen action only for a retained closed instance',()=>{
  const manager=fs.readFileSync(path.join(root,'src/main/services/surface-window-manager.ts'),'utf8');
  const packageManager=fs.readFileSync(path.join(root,'src/main/features/package-manager.ts'),'utf8');
  const renderer=fs.readFileSync(path.join(root,'src/renderer/index.tsx'),'utf8');
  const packager=fs.readFileSync(path.join(root,'scripts/package-create-associate-feature.mjs'),'utf8');
  const worker=fs.readFileSync(path.join(root,'feature-packages/create-associate/source/middle/worker.cjs'),'utf8');
  assert.match(packager,/const version = '0\.2\.\d+'; const sequence = \d+;/u);assert.match(packager,/minimumShellVersion: '0\.4\.15'/u);
  assert.match(packager,/lifecycle:\{schemaVersion:'omnia\.declarative-feature-surface-lifecycle\/v1',onReopenActionId:'fresh-start-on-reopen'\}/u);
  assert.match(packager,/actionId: 'fresh-start-on-reopen'[^\n]+effect: 'local_state_write'[^\n]+visible: false[^\n]+presentation: 'background'[^\n]+selectionMode: 'none'[^\n]+dependencies: \[\]/u);
  assert.match(worker,/input\?\.actionId==='restart-run'\|\|input\?\.actionId==='fresh-start-on-reopen'[\s\S]*trigger=input\.actionId==='fresh-start-on-reopen'\?'surface_reopen':'explicit_feature_fresh_start'/u);
  assert.match(packageManager,/exactKeys\(lifecycle, \['schemaVersion', 'onReopenActionId'\][\s\S]*action\.visible !== false[\s\S]*action\.presentation !== 'background'[\s\S]*action\.effect === 'omnia_mutation'[\s\S]*action\.input !== undefined[\s\S]*action\.output !== undefined/u);
  assert.match(packageManager,/if \(surface\.lifecycle\) next\.lifecycle = surface\.lifecycle;[\s\S]*else delete next\.lifecycle/u);
  assert.match(manager,/const reopening = existing\.placement === 'closed';[\s\S]*if \(!reopening\) return this\.openExisting\(existing, input, false\);[\s\S]*this\.openExisting\(existing, input, true\)/u);
  assert.match(manager,/surface\.lifecycle\?\.onReopenActionId[\s\S]*expectedStateVersion: surface\.stateVersion,[\s\S]*payload: \{\}/u);
  assert.match(manager,/private async openExisting[\s\S]*const surface = reopening \? await this\.runReopenLifecycle\(existing\) : this\.cachedSurface\(existing\)/u);
  assert.doesNotMatch(manager,/async focus\([^]*runReopenLifecycle/u);
  assert.match(renderer,/if \(opened\.surfaceStateVersion !== surface\.stateVersion\) \{[\s\S]*await window\.omnia\.getSnapshot\(\)[\s\S]*refreshedSurface\.stateVersion < opened\.surfaceStateVersion[\s\S]*setSnapshot\(openedSnapshot\)/u);
});

test('Create & Associate signs action pending copy and declares Return-layer actions generically',()=>{
  const packager=fs.readFileSync(path.join(root,'scripts/package-create-associate-feature.mjs'),'utf8');
  for(const actionId of ['confirm-upload','prepare-return','confirm-return','continue-return','reconcile-return']){
    assert.match(packager,new RegExp(`actionId: '${actionId}'[^\\n]+pendingPresentation: \\{ schemaVersion: 'omnia\\.declarative-action-pending-presentation/v1', title: '[^']+', message: '[^']+', workflowStepId: '(?:validate|return)' \\}`,'u'));
  }
  for(const actionId of ['confirm-return','continue-return','reconcile-return']){
    assert.match(packager,new RegExp(`actionId: '${actionId}'[^\\n]+presentation: 'return'`,'u'));
  }
});

test('Renderer selects the authoritative signed Surface before retiring an upgraded instance',()=>{
  const renderer=fs.readFileSync(path.join(root,'src/renderer/index.tsx'),'utf8');
  const activation=renderer.slice(renderer.indexOf('const previousActiveId = activeTab'),renderer.indexOf('const activeFeatureInstance ='));
  const selectAt=activation.indexOf('const next = await window.omnia.selectFeature({ featureId })');
  const resolveAt=activation.indexOf('host.resolveIdentity(surface.featureId, key)');
  const closeAt=activation.indexOf('await window.omnia.closeFeatureSurface(candidate.instanceId)');
  const focusAt=activation.indexOf('await window.omnia.focusFeatureSurface(existing.instanceId)');
  const openAt=activation.indexOf('await window.omnia.openFeatureSurface({');
  assert.ok(selectAt >= 0 && selectAt < resolveAt && resolveAt < closeAt && closeAt < focusAt && focusAt < openAt);
  assert.match(activation,/for \(const candidate of identity\.superseded\)[\s\S]*await window\.omnia\.closeFeatureSurface\(candidate\.instanceId\)[\s\S]*host\.close\(candidate\.instanceId\)[\s\S]*openedInstanceIdsRef\.current\.delete\(candidate\.instanceId\)/u);
  assert.match(activation,/getSurfaceManagerSnapshot\?\.\(\)[\s\S]*managerHasLiveInstance[\s\S]*host\.close\(existing\.instanceId\)[\s\S]*openedInstanceIdsRef\.current\.delete\(existing\.instanceId\)[\s\S]*host\.open\(surface\.featureId, key, surface\)/u);
  assert.doesNotMatch(activation,/Core 返回的 Feature Surface 身份与已打开实例不一致/u);
});

test('same-revision bootstrap preserves only field-contract-compatible review drafts',()=>{
  const field=(fieldKey:string, overrides:Partial<DeclarativeReviewField>={}):DeclarativeReviewField=>({
    rowKey:'row-1',kind:'APP',fieldKey,rawFieldKey:fieldKey,label:fieldKey,expectedRevision:3,inputKind:'text',
    currentValue:'server value',allowedValues:[],required:true,maxLength:200,editable:true,message:'',
    sourceSheet:'IT Risk Assessment',sourceRow:23,derivation:'verbatim_user_workbook_cell',...overrides
  });
  const makeSurface=(stateVersion:number,fields:DeclarativeReviewField[],overrides:Partial<DeclarativeFeatureSurface>={}):DeclarativeFeatureSurface=>({
    schemaVersion:'omnia.declarative-feature-surface/v1',featureId:'omnia.test',featureVersion:'1.0.0',surfaceId:'test.review',stateVersion,
    title:'Test',description:'',density:'compact',status:'ready',statusMessage:'',scopes:[],items:[],selectedItemIds:[],search:'',actions:[],
    review:{selectedKind:'APP',selectedRowKey:'row-1',elementTypes:[],elements:[],fields,issueOrder:[]},...overrides
  });
  const previous=makeSurface(9,[field('compatible'),field('changed-revision')]);
  const sameBootstrap=makeSurface(9,[field('compatible'),field('changed-revision',{expectedRevision:4})]);
  const drafts=new Map([['compatible','draft kept'],['changed-revision','unsafe draft dropped']]);
  assert.deepEqual([...reconcileBootstrapReviewDrafts(previous,sameBootstrap,drafts)],[['compatible','draft kept']]);
  assert.equal(reconcileBootstrapReviewDrafts(previous,makeSurface(10,sameBootstrap.review!.fields),drafts).size,0);
  assert.equal(reconcileBootstrapReviewDrafts(previous,makeSurface(9,previous.review!.fields,{surfaceId:'other.review'}),drafts).size,0);
  assert.equal(reconcileBootstrapReviewDrafts(previous,makeSurface(9,[]),drafts).size,0);
});

test('Feature Surface keeps the real failed action error across its authoritative disconnected projection',()=>{
  const renderer=fs.readFileSync(path.join(root,'src/renderer/feature-window.ts'),'utf8');
  assert.match(renderer,/catch \(error\) \{[\s\S]*featureActionFailureMessage\(error\)[\s\S]*featureActionFailure = \{surfaceIdentity: surfaceIdentity\(requestedSurface\), actionId, message\}/u);
  assert.match(renderer,/onBootstrap\(\(next\) => \{[\s\S]*retainFeatureActionFailure\(featureActionFailure, next\)[\s\S]*errorMessage = featureActionFailure\?\.message \|\| ''/u);
  const connectorError=Object.assign(new Error('Authorization 已失效；请重新连接当前 Omnia Pack。'),{code:'CONNECTOR.AUTH_REQUIRED'});
  const message=featureActionFailureMessage(connectorError);
  assert.equal(message,'[CONNECTOR.AUTH_REQUIRED] Authorization 已失效；请重新连接当前 Omnia Pack。');
  const failure={
    surfaceIdentity:'omnia.delete-elements\u00000.3.15\u0000delete-elements.main',
    actionId:'create-delete-plan',
    message
  };
  const disconnected={
    featureId:'omnia.delete-elements',featureVersion:'0.3.15',surfaceId:'delete-elements.main',
    actions:[{actionId:'create-delete-plan',label:'创建删除计划',effect:'read_only' as const,enabled:false,reason:'请先连接当前 Omnia Pack。',selectionMode:'multiple' as const}]
  };
  assert.strictEqual(retainFeatureActionFailure(failure,disconnected),failure,'a same-action authority refresh must not erase its real failure');
  assert.equal(retainFeatureActionFailure(failure,{...disconnected,surfaceId:'another.surface'}),null);
  assert.equal(retainFeatureActionFailure(failure,{...disconnected,actions:[]}),null,'leaving the failed workflow action clears the stale alert');
});

test('Shell Feature navigation renders signed mixed-depth groups without Feature-ID branches',()=>{
  const source=fs.readFileSync(path.join(root,'src/renderer/index.tsx'),'utf8'); const styles=fs.readFileSync(path.join(root,'src/renderer/styles.css'),'utf8'); const component=source.slice(source.indexOf('function FeatureNavigation'),source.indexOf('function AttachmentCard'));
  assert.match(component,/buildFeatureNavigationTree\(snapshot\.features\.groups, snapshot\.features\.navigation\)/u);
  assert.match(component,/function NavigationGroup/u);assert.match(component,/navigation-subgroup/u);assert.match(component,/node\.group\.label/u);
  assert.match(component,/const available = leaf\.availability === 'available'/u);assert.match(component,/disabled=\{!available\}/u);
  assert.match(component,/showFeatureVersion=\{snapshot\.preference\.showFeatureVersions\}/u);
  assert.match(component,/navigation-feature-version">v\.\{leaf\.featureVersion\}/u);
  assert.match(styles,/\.navigation-leaf-copy \{[^}]*gap: 8px/u);
  assert.match(component,/feature-navigation \$\{collapsed \? 'collapsed' : ''\}/u);assert.match(styles,/\.feature-navigation\.collapsed \{ width: 0; border: 0; \}/u);
  assert.doesNotMatch(component,/featureId\s*===\s*['"]omnia\./u);
});

test('Shell General settings persist Feature version visibility through the real preference API',()=>{
  const source=fs.readFileSync(path.join(root,'src/renderer/index.tsx'),'utf8');
  const settings=source.slice(source.indexOf('function SettingsDialog'),source.indexOf('function RemotePairingDialog'));
  const contracts=fs.readFileSync(path.join(root,'src/shared/contracts.ts'),'utf8');
  const preload=fs.readFileSync(path.join(root,'src/preload/index.ts'),'utf8');
  const main=fs.readFileSync(path.join(root,'src/main/index.ts'),'utf8');
  assert.match(settings,/>通用<\/button>/u);
  assert.match(settings,/>显示 Feature 版本号<\/span>/u);
  assert.match(settings,/checked=\{snapshot\.preference\.showFeatureVersions\}/u);
  assert.match(settings,/window\.omnia\.saveFeatureVersionVisibility\(\{ visible: event\.target\.checked, expectedStateVersion: snapshot\.preference\.stateVersion \}\)/u);
  assert.match(contracts,/saveFeatureVersionVisibility\(input: \{ visible: boolean; expectedStateVersion: number \}\)/u);
  assert.match(preload,/saveFeatureVersionVisibility: \(input\) => invoke\('shell:save-feature-version-visibility', input\)/u);
  assert.match(main,/shell:save-feature-version-visibility/u);
});
