import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {CoreDatabase} from '../src/main/database.js';
import {FeaturePackageManager} from '../src/main/features/package-manager.js';
import {packageDigest, verifyOfficialPackage} from '../src/main/features/official-package.js';
import {resolveProductPaths} from '../src/main/paths.js';

const repository=path.resolve(import.meta.dirname,'..');
const candidate=path.join(repository,'feature-packages','delete-elements','candidates','delete-elements-0.3.20.ofp');
const source=path.join(repository,'feature-packages','delete-elements','source');
const cipher={encrypt:(value:string)=>value,decrypt:(value:string)=>value};

function unpack(envelope:{files:Array<{path:string;contentBase64:string}>},target:string):void{
  for(const member of envelope.files){
    const filename=path.resolve(target,...member.path.split('/'));
    assert.equal(filename.startsWith(`${path.resolve(target)}${path.sep}`),true);
    fs.mkdirSync(path.dirname(filename),{recursive:true});
    fs.writeFileSync(filename,Buffer.from(member.contentBase64,'base64'));
  }
}

test('Delete 0.3.20 is immutable, self-tests under the current layout contract, and has no Comments projection',()=>{
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'omnia-delete-layout-package-'));
  const unpacked=path.join(temporary,'unpacked');
  const productRoot=path.join(temporary,'product');
  try{
    const envelope=verifyOfficialPackage(JSON.parse(fs.readFileSync(candidate,'utf8')),'omnia-feature');
    assert.equal(envelope.packageId,'omnia.delete-elements');
    assert.equal(envelope.version,'0.3.20');
    assert.equal(envelope.sequence,29);
    unpack(envelope,unpacked);
    const surface=JSON.parse(fs.readFileSync(path.join(unpacked,'frontend','surface.json'),'utf8'));
    assert.equal(surface.selectionBrowser.layout?.schemaVersion,'omnia.selection-browser-layout/v1');
    assert.equal(surface.selectionBrowser.layout?.mode,'fixed_footer_split');
    assert.equal(surface.actions.some((action:any)=>String(action.actionId).toLowerCase().includes('comment')),false);
    const selfTest=spawnSync(process.execPath,[path.join(unpacked,'tests','self-test.cjs')],{cwd:unpacked,encoding:'utf8',windowsHide:true});
    assert.equal(selfTest.status,0,selfTest.stderr||selfTest.stdout);
    assert.match(selfTest.stdout,/omnia\.delete-elements package self-test passed/u);
    assert.deepEqual(fs.readFileSync(path.join(unpacked,'middle','worker.cjs')),
      Buffer.from(fs.readFileSync(path.join(source,'middle','worker.cjs'),'utf8').replaceAll('__FEATURE_VERSION__','0.3.20')));
    const paths=resolveProductPaths(productRoot);
    const database=new CoreDatabase(paths.database,cipher);
    try{
      const manager=new FeaturePackageManager(database.db,paths);
      const installed=manager.install(candidate);
      assert.equal(installed.featureVersion,'0.3.20');
      assert.equal(installed.packageDigest,packageDigest(envelope));
    }finally{database.close();}
  }finally{fs.rmSync(temporary,{recursive:true,force:true});}
});
