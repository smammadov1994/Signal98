// One persistent conversation per grouped issue; model work only starts on a user message.
import { q, db, tx, parse } from './db.js';
import { publicIssue } from './classify.js';
import { getGhost } from './ghosts.js';
import { replyToIssue, ghostProvider } from './ghost.js';
import { publish } from './bus.js';
import { HttpError, clamp } from './util.js';

const specialist = issue => {
  const g = getGhost((typeof issue.classification === 'string' ? parse(issue.classification, {}) : issue.classification)?.responder);
  return {id:g.id,name:g.name,color:g.color,specialty:g.specialty};
};

export function listConversations(pid, params) {
  const where = ['i.project_id = ?', 'i.merged_into IS NULL'], args = [pid];
  const since = Number(params.get('since'));
  if (Number.isFinite(since) && since > 0) { where.push('i.id IN (SELECT issue_id FROM events WHERE project_id = ? AND received_at >= ?)'); args.push(pid,since); }
  const status = params.get('status') || 'open';
  if (status !== 'all') { where.push('i.status = ?'); args.push(status); }
  if (params.get('verdict')) { where.push('i.verdict = ?'); args.push(params.get('verdict')); }
  if (params.get('q')) { where.push('(i.title LIKE ? OR i.category LIKE ? OR CAST(i.id AS TEXT) = ?)'); args.push(`%${params.get('q').slice(0,200)}%`,`%${params.get('q').slice(0,200)}%`,params.get('q')); }
  const offset = Math.floor(clamp(Number(params.get('offset')) || 0,0,1000000));
  const filter = where.join(' AND ');
  const total = db().prepare(`SELECT COUNT(*) n FROM issues i WHERE ${filter}`).get(...args).n;
  const items = db().prepare(`SELECT i.*, (SELECT substr(content,1,180) FROM issue_messages m WHERE m.issue_id = i.id AND m.project_id = i.project_id ORDER BY id DESC LIMIT 1) preview, (SELECT status FROM issue_messages m WHERE m.issue_id = i.id AND m.project_id = i.project_id ORDER BY id DESC LIMIT 1) chat_status FROM issues i WHERE ${filter} ORDER BY i.priority DESC, i.id DESC LIMIT 50 OFFSET ?`).all(...args,offset).map(row => ({...publicIssue(row),ghost:specialist(row)}));
  if (Number.isFinite(since) && since > 0 && items.length) {
    const counts=q('SELECT issue_id, COUNT(*) n FROM events WHERE project_id = ? AND received_at >= ? GROUP BY issue_id').all(pid,since);
    const map=new Map(counts.map(r=>[r.issue_id,r.n]));
    for (const item of items) { item.total_count=item.count;item.count=map.get(item.id) || 0; }
  }
  return {items,total,offset,has_more:offset+items.length<total};
}

function state() {
  if (!globalThis.__s98_chat) {
    // A reply interrupted by a server restart is visibly retryable, never silently repeated.
    q("UPDATE issue_messages SET status = 'failed', error = 'The server restarted before the reply finished. Please retry.' WHERE status = 'running'").run();
    globalThis.__s98_chat = {active:0};
  }
  return globalThis.__s98_chat;
}
function changed(pid,id) { publish('chat',{project_id:pid,issue_id:id}); }
export function pumpChats() {
  const s=state();
  while(s.active<2) {
    const reply=q("SELECT * FROM issue_messages WHERE role = 'assistant' AND status = 'queued' ORDER BY id LIMIT 1").get();
    if(!reply) break;
    q("UPDATE issue_messages SET status = 'running' WHERE id = ?").run(reply.id);
    s.active++;
    processReply(reply).finally(()=>{s.active--;pumpChats();});
  }
}
async function processReply(reply) {
  try {
    const issue=q('SELECT * FROM issues WHERE id = ? AND project_id = ?').get(reply.issue_id,reply.project_id);
    if(!issue) throw new Error('This issue no longer exists.');
    const messages=q("SELECT role, content FROM issue_messages WHERE project_id = ? AND issue_id = ? AND id < ? AND status = 'complete' ORDER BY id DESC LIMIT 40").all(reply.project_id,reply.issue_id,reply.id).reverse();
    const out=await replyToIssue(issue,messages);
    q("UPDATE issue_messages SET status = 'complete', content = ?, provider = ? WHERE id = ?").run(out.content,out.provider,reply.id);
  } catch(err) {
    q("UPDATE issue_messages SET status = 'failed', error = ? WHERE id = ?").run(String(err.message || 'Reply failed').slice(0,500),reply.id);
  } finally { changed(reply.project_id,reply.issue_id); }
}
export async function conversation(pid,issue,params) {
  pumpChats();
  const before=Number(params.get('before')) || Number.MAX_SAFE_INTEGER;
  const rows=q('SELECT * FROM issue_messages WHERE project_id = ? AND issue_id = ? AND id < ? ORDER BY id DESC LIMIT 101').all(pid,issue.id,before);
  const has_more=rows.length>100;
  return {issue:publicIssue(issue),ghost:specialist(issue),provider:await ghostProvider(),messages:rows.slice(0,100).reverse(),has_more};
}
export function sendMessage(pid,issue,body) {
  const content=typeof body.message === 'string' ? body.message.trim() : '';
  const request=typeof body.request_id === 'string' ? body.request_id : '';
  if(!content || content.length>8000) throw new HttpError(400,'Write a message between 1 and 8,000 characters.');
  if(!/^[a-zA-Z0-9_-]{8,100}$/.test(request)) throw new HttpError(400,'A valid request_id is required.');
  state();
  const previous=q("SELECT * FROM issue_messages WHERE project_id = ? AND issue_id = ? AND request_id = ? AND role = 'assistant'").get(pid,issue.id,request);
  if(previous) {
    const original=q("SELECT content FROM issue_messages WHERE project_id = ? AND issue_id = ? AND request_id = ? AND role = 'user'").get(pid,issue.id,request);
    if(original?.content!==content) throw new HttpError(409,'This request id belongs to a different message.');
    return {message:previous};
  }
  if(q("SELECT id FROM issue_messages WHERE project_id = ? AND issue_id = ? AND status IN ('queued','running')").get(pid,issue.id)) throw new HttpError(409,'Ghost is already replying to this issue.');
  if(q("SELECT COUNT(*) n FROM issue_messages WHERE project_id = ? AND status IN ('queued','running')").get(pid).n>=50) throw new HttpError(429,'The conversation queue is full. Try again shortly.');
  const id=tx(()=>{
    q("INSERT INTO issue_messages(project_id,issue_id,role,content,created_at,request_id) VALUES (?,?,'user',?,?,?)").run(pid,issue.id,content,Date.now(),request);
    return Number(q("INSERT INTO issue_messages(project_id,issue_id,role,status,created_at,request_id) VALUES (?,?,'assistant','queued',?,?)").run(pid,issue.id,Date.now(),request).lastInsertRowid);
  });
  changed(pid,issue.id);pumpChats();
  return {message:q('SELECT * FROM issue_messages WHERE id = ?').get(id)};
}
export function retryMessage(pid,issue,id) {
  state();
  const last=q('SELECT * FROM issue_messages WHERE project_id = ? AND issue_id = ? ORDER BY id DESC LIMIT 1').get(pid,issue.id);
  if(!last || last.id!==Number(id) || last.role!=='assistant' || last.status!=='failed') throw new HttpError(409,'Only the latest failed reply can be retried.');
  if(q("SELECT COUNT(*) n FROM issue_messages WHERE project_id = ? AND status IN ('queued','running')").get(pid).n>=50) throw new HttpError(429,'The conversation queue is full. Try again shortly.');
  q("UPDATE issue_messages SET status = 'queued', error = NULL WHERE id = ?").run(last.id);
  pumpChats();changed(pid,issue.id);
  return {ok:true};
}
