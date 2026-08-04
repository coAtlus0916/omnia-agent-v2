import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {reconcileBootstrapReviewDrafts} from '../src/renderer/feature-window.js';
import type {DeclarativeFeatureSurface, DeclarativeReviewField} from '../src/shared/feature-contracts.js';

const root=path.resolve(import.meta.dirname,'..');

test('generic Feature renderer is contract-driven two-column workflow without feature-id business branches',()=>{
  const renderer=fs.readFileSync(path.join(root,'src/renderer/feature-window.ts'),'utf8'); const html=fs.readFileSync(path.join(root,'src/renderer/feature-window.html'),'utf8');
  assert.match(renderer,/surface\.workflow/u);assert.match(renderer,/surface\.progress/u);assert.match(renderer,/surface\.issues/u);assert.match(renderer,/importInputBytes/u);assert.match(renderer,/saveManagedAsset/u);assert.doesNotMatch(renderer,/omnia\.(?:recording|create-associate)|featureId\s*===\s*['"]/u);
  assert.match(html,/grid-template-columns:176px minmax\(0,1fr\)/u);assert.match(html,/@media\(max-width:560px\)[\s\S]*\.workflow-rail ol\{display:flex/u);assert.match(html,/#feature-root\{[^}]*overflow:auto/u);assert.match(html,/overflow-x:auto/u);
});

test('generic Feature review renders real review contract and dispatches CAS-safe actions without silent dirty-value loss',()=>{
  const renderer=fs.readFileSync(path.join(root,'src/renderer/feature-window.ts'),'utf8'); const html=fs.readFileSync(path.join(root,'src/renderer/feature-window.html'),'utf8');
  for(const token of ['surface.review','review.elementTypes','review.elements','review.fields','review.issueOrder','data-review-kind','data-review-element','data-review-field','data-review-input']) assert.match(renderer,new RegExp(token.replace('.','\\.'),'u'));
  assert.match(renderer,/currentSelected \|\| elements\.find\(\(element\) => element\.blocking\)/u);
  assert.match(renderer,/surface\?\.review\?\.fields[\s\S]*dirtyReviewValues\.has\(field\.fieldKey\)[\s\S]*rowKey: field\.rowKey[\s\S]*fieldKey: field\.fieldKey[\s\S]*expectedRevision: field\.expectedRevision[\s\S]*dirtyReviewValues\.get\(field\.fieldKey\)/u);
  assert.match(renderer,/remove-batch-row[\s\S]*rowKey: selectedReviewRowKey, expectedRunRevision: surface\?\.stateVersion/u);
  assert.match(renderer,/revalidate-all[\s\S]*expectedRunRevision: surface\?\.stateVersion/u);
  assert.match(renderer,/dirtyReviewValues\.size > 0/u);assert.match(renderer,/请先保存修改/u);
  assert.match(renderer,/const actions = !surface\.review/u);assert.match(renderer,/surface\?\.review && action\?\.input\?\.kind === 'open_file'[\s\S]*请先返回上传步骤/u);
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
  assert.match(worker,/reviewNavigation='upload'[\s\S]*savePlan/u);assert.match(worker,/REVIEW\.REIMPORT_REQUIRES_UPLOAD_STEP/u);
  assert.doesNotMatch(worker,/recomputeLocalIssues\(plan\.parsed\);if\(input\.actionId==='remove-batch-row'\)/u);
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

test('Shell Feature navigation renders every installed leaf flat and ignores legacy group hierarchy',()=>{
  const source=fs.readFileSync(path.join(root,'src/renderer/index.tsx'),'utf8'); const component=source.slice(source.indexOf('function FeatureNavigation'),source.indexOf('function NavigationLeaf'));
  assert.match(component,/snapshot\.features\.navigation/u);assert.match(component,/\.sort\(/u);assert.doesNotMatch(component,/features\.groups|navigation-subgroup|group\.label/u);
});
