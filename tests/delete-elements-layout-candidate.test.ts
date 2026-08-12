import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {verifyOfficialPackage} from '../src/main/features/official-package.js';

const repository=path.resolve(import.meta.dirname,'..');
const candidate=path.join(repository,'feature-packages','delete-elements','candidates','delete-elements-0.3.20.ofp');
const candidateSha256='21745674636b24580c0d5491859a186638abfde0dc106abc0ae6987e7703a08d';

function unpack(envelope:{files:Array<{path:string;contentBase64:string}>},target:string):void{
  for(const member of envelope.files){
    const filename=path.resolve(target,...member.path.split('/'));
    assert.equal(filename.startsWith(`${path.resolve(target)}${path.sep}`),true);
    fs.mkdirSync(path.dirname(filename),{recursive:true});
    fs.writeFileSync(filename,Buffer.from(member.contentBase64,'base64'));
  }
}

test('historic Delete 0.3.20 remains immutable under its signed contract, independent of successor source and current install policy',()=>{
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'omnia-delete-layout-package-'));
  const unpacked=path.join(temporary,'unpacked');
  try{
    const candidateBytes=fs.readFileSync(candidate);
    assert.equal(crypto.createHash('sha256').update(candidateBytes).digest('hex'),candidateSha256);
    const envelope=verifyOfficialPackage(JSON.parse(candidateBytes.toString('utf8')),'omnia-feature');
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
  }finally{fs.rmSync(temporary,{recursive:true,force:true});}
});
