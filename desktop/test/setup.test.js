process.env.SIGNAL98_DB=':memory:';
process.env.SIGNAL98_GHOST_PROVIDER='none';
delete process.env.TYPESAFE_API_KEY;
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'signal98-setup-test-'));
process.env.SIGNAL98_SETUP_DIR=dir;
process.on('exit',()=>fs.rmSync(dir,{recursive:true,force:true}));
let rejectKey=false,calls=0;
globalThis.fetch=async(url,init)=>{
  assert.match(String(url),/^https:\/\/api\.typesafe\.ai\/v1\/systemone$/,'unexpected network request');
  calls++;
  if(rejectKey) return new Response('must-never-echo-the-submitted-secret',{status:401});
  const body=JSON.parse(init.body);assert.equal(body.state.purpose,'Signal98 connection test');assert.equal(typeof body.questions.connected.instructions,'string');assert.equal(typeof body.questions.connected.criteria.true,'string');assert.equal(typeof body.questions.connected.criteria.false,'string');
  return Response.json({answers:{connected:{type:'noul',noul:1}},model:'jev-test',usage:{input_tokens:10}});
};
const {handle}=await import('../lib/api.js');
const {q}=await import('../lib/db.js');
const {setupSnippets}=await import('../lib/setup-snippets.js');
const call=async(method,route,body,headers={})=>{
  const response=await handle(new Request(`http://localhost/api/${route}`,{method,headers:{'content-type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)}),route.split('?')[0].split('/'));
  return {status:response.status,data:await response.json()};
};

test('new installation starts onboarding; progress, skip and completion are persisted',async()=>{
  let r=await call('GET','meta');assert.equal(r.data.setup.required,true);assert.equal(r.data.setup.step,0);
  await call('POST','setup',{action:'begin',service:'customer-app',framework:'react',step:3,host:'http://localhost:3001'});
  r=await call('GET','setup');assert.equal(r.data.service,'customer-app');assert.equal(r.data.step,3);assert.ok(r.data.proof_id);assert.equal(r.data.proof,null);
  await call('POST','setup',{action:'later'});assert.equal((await call('GET','meta')).data.setup.required,false);
  await call('POST','setup',{step:4});assert.equal((await call('GET','meta')).data.setup.required,true);
  await call('POST','setup',{action:'complete'});r=await call('GET','setup');assert.equal(r.data.required,false);assert.equal(r.data.proof,null,'finishing without a test must not claim verification');
});

test('a key is validated before replacement, private on disk, and never returned to browser',async()=>{
  const key='test-only-secret-not-a-real-key';
  const r=await call('POST','setup/jev',{key});assert.equal(r.status,200);assert.equal(r.data.jev.enabled,true);assert.equal(r.data.jev.model,'jev-test');assert.equal(JSON.stringify(r).includes(key),false);
  const file=path.join(dir,'credentials.json');assert.equal(fs.statSync(file).mode&0o777,0o600);assert.equal(JSON.parse(fs.readFileSync(file)).TYPESAFE_API_KEY,key);
  for(const endpoint of ['setup','meta','overview'])assert.equal(JSON.stringify((await call('GET',endpoint)).data).includes(key),false);
  rejectKey=true;
  const bad=await call('POST','setup/jev',{key:'rejected-candidate'});assert.equal(bad.status,422);assert.equal(JSON.stringify(bad).includes('must-never-echo'),false);assert.equal(process.env.TYPESAFE_API_KEY,key);assert.equal(JSON.parse(fs.readFileSync(file)).TYPESAFE_API_KEY,key);
  rejectKey=false;delete process.env.TYPESAFE_API_KEY;globalThis.__s98_setup_credentials_loaded=false;
  await call('GET','setup');assert.equal(process.env.TYPESAFE_API_KEY,key,'saved key restores after server credential reload');
  assert.equal((await call('POST','setup/jev',{key:'x\ny'})).status,400);
});

test('setup endpoints reject cross-origin mutations and respect admin protection',async()=>{
  const before=calls;
  assert.equal((await call('POST','setup/jev',{key:'somekey'},{origin:'https://untrusted.test'})).status,403);assert.equal(calls,before);
  process.env.SIGNAL98_ADMIN_TOKEN='test-admin';
  try {assert.equal((await call('POST','setup',{action:'complete'})).status,401);assert.equal((await call('GET','setup',undefined,{authorization:'Bearer test-admin'})).status,200);}finally{delete process.env.SIGNAL98_ADMIN_TOKEN;}
});

test('only a new tagged error from the chosen app verifies capture, not old or other events',async()=>{
  await call('POST','setup',{action:'begin',service:'target-app',step:4});
  const d=(await call('GET','setup')).data;
  const issue=Number(q("INSERT INTO issues(project_id,fingerprint,title,first_seen,last_seen,judge_status) VALUES(1,'setup-proof','Setup test',1,1,'judged')").run().lastInsertRowid);
  const add=(uuid,service,received,props,issueId=issue)=>q("INSERT INTO events(uuid,project_id,ts,received_at,event,service,issue_id,props) VALUES(?,1,?,?,'$exception',?,?,?)").run(uuid,Date.now(),received,service,issueId,JSON.stringify(props));
  add('old','target-app',1,{signal98_setup:d.proof_id});
  add('other-app','demo-app',Date.now(),{signal98_setup:d.proof_id});
  add('untagged','target-app',Date.now(),{});
  assert.equal((await call('GET','setup')).data.proof,null);
  add('correct','target-app',Date.now(),{signal98_setup:d.proof_id});
  assert.equal((await call('GET','setup')).data.proof.issue_id,issue);
  await call('POST','setup',{service:'different-app'});assert.equal((await call('GET','setup')).data.proof,null);
});

test('snippets quote app values and include both halves of Next.js capture',()=>{
  const args={host:'https://monitor.test',key:'s98_public',service:'app"name',proof:'unique-token'};
  const react=setupSnippets({...args,framework:'react'});assert.match(react.files[0].code,/createErrorBoundary\(client\)/);assert.ok(react.files[0].code.includes(JSON.stringify(args.service)));assert.match(react.test,/unique-token/);
  const next=setupSnippets({...args,framework:'next'});assert.equal(next.files.length,3);assert.match(next.files[2].code,/onRequestError/);assert.match(next.files[2].code,/await flush/);
  assert.match(setupSnippets({...args,framework:'script'}).files[0].code,/app&quot;name/);
});
