process.env.SIGNAL98_DB=':memory:';
process.env.SIGNAL98_GHOST_PROVIDER='none';
delete process.env.TYPESAFE_API_KEY;
process.env.LLM_API_KEY='test-only';
process.env.LLM_BASE_URL='https://chat.test';
import test from 'node:test';
import assert from 'node:assert/strict';
let model;
globalThis.fetch=async (url,init)=>{
  assert.equal(url,'https://chat.test/chat/completions','no requests may escape the model stub');
  if(!model) throw new Error('model unavailable');
  return model(JSON.parse(init.body));
};
const {handle}=await import('../lib/api.js');
const {q,createProject}=await import('../lib/db.js');
const call=async(method,path,body)=>{
  const [route,qs]=path.split('?');
  const r=await handle(new Request(`http://localhost/api/${path}`,{method,headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined}),route.split('/'));
  return {status:r.status,data:await r.json()};
};
function seed(pid,title){return Number(q("INSERT INTO issues(project_id,fingerprint,title,kind,first_seen,last_seen,judge_status,judged_by,classification,verdict,category,count) VALUES (?,?,?,'error',?,?,'judged','jev-test',?,'ticket','payments',20)").run(pid,title,title,Date.now(),Date.now(),JSON.stringify({responder:'GHOST-02',severity:2})).lastInsertRowid);}
const done=async(id)=>{for(let i=0;i<200;i++){const r=await call('GET',`issues/${id}/conversation`);if(!r.data.messages.some(m=>['queued','running'].includes(m.status)))return r.data;await new Promise(r=>setTimeout(r,5));}assert.fail('reply did not settle');};

test('chat is issue scoped, persistent, idempotent, and carries history to the model',async()=>{
  const a=seed(1,'checkout failed'),b=seed(1,'another error');
  let unblock,requests=0;
  model=async body=>{requests++;assert.match(body.messages[1].content,/checkout failed/);assert.match(body.messages[1].content,/Why did this fail/);await new Promise(r=>unblock=r);return Response.json({choices:[{message:{content:'The payment request failed. Inspect the provider response.'}}]});};
  let r=await call('POST',`issues/${a}/conversation`,{message:'Why did this fail?',request_id:'request_123'});assert.equal(r.status,200);
  r=await call('POST',`issues/${a}/conversation`,{message:'Why did this fail?',request_id:'request_123'});assert.equal(r.status,200);
  assert.equal((await call('POST',`issues/${a}/conversation`,{message:'Second question',request_id:'request_456'})).status,409);
  while(!unblock) await new Promise(r=>setTimeout(r,5));unblock();
  const d=await done(a);assert.equal(d.messages.length,2);assert.equal(d.messages[1].provider,'openai-compatible');assert.equal(requests,1);assert.equal(d.ghost.name,'PATCHER');
  assert.equal((await call('GET',`issues/${b}/conversation`)).data.messages.length,0);
  model=async body=>{assert.match(body.messages[1].content,/Inspect the provider response/);assert.match(body.messages[1].content,/What next/);return Response.json({choices:[{message:{content:'Check the response status.'}}]});};
  await call('POST',`issues/${a}/conversation`,{message:'What next?',request_id:'request_789'});assert.equal((await done(a)).messages.length,4);
  const pid=createProject('Other').id;assert.equal((await call('GET',`issues/${a}/conversation?project=${pid}`)).status,404);
  assert.equal((await call('POST',`issues/${a}/conversation`,{message:'',request_id:'request_bad'})).status,400);
});

test('model failure is visible and can be retried without duplicating the user message',async()=>{
  const id=seed(1,'retry case');model=null;
  await call('POST',`issues/${id}/conversation`,{message:'Explain this',request_id:'retry_12345'});
  const d=await done(id);assert.equal(d.messages[1].status,'failed');assert.match(d.messages[1].error,/unavailable/);
  model=async()=>Response.json({choices:[{message:{content:'Recovered reply'}}]});
  assert.equal((await call('POST',`issues/${id}/conversation-retry`,{message_id:d.messages[1].id})).status,200);
  const r=await done(id);assert.equal(r.messages.length,2);assert.equal(r.messages[1].content,'Recovered reply');
});

test('inbox paginates hundreds of issues and fresh demo excludes historical issues',async()=>{
  for(let i=0;i<120;i++)seed(1,`scale ${i}`);
  const first=(await call('GET','conversations')).data;
  const next=(await call('GET','conversations?offset=50')).data;
  assert.equal(first.items.length,50);assert.equal(next.items.length,50);assert.equal(first.has_more,true);
  assert.equal(first.items.some(a=>next.items.some(b=>a.id===b.id)),false);
  assert.equal((await call('GET',`conversations?since=${Date.now()}`)).data.total,0);
  assert.equal((await call('GET','conversations?q=scale%20119')).data.total,1);
});

test('monitoring returns real zero values for a fresh demo and range buckets',async()=>{
  const r=(await call('GET',`monitoring?since=${Date.now()}&range=7d`)).data;
  assert.equal(r.totals.errors,0);assert.equal(r.totals.affected,0);assert.deepEqual(r.states,[]);assert.equal(r.bucket,21600000);
  assert.ok(r.series.every(p=>p.errors===0));
});
