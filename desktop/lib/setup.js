import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {q,kvGet,kvSet,getProject,saveProjectSettings} from './db.js';
import {jevStatus,verifyJevKey,recordJevConnection} from './jev.js';
import {ghostProvider} from './ghost.js';
import {HttpError} from './util.js';
import {publish} from './bus.js';

function secretFile() {
  // Tests using in-memory data must never read a developer's real credentials.
  if(process.env.SIGNAL98_DB===':memory:' && !process.env.SIGNAL98_SETUP_DIR) return null;
  return path.join(process.env.SIGNAL98_SETUP_DIR || process.env.SIGNAL98_DATA_DIR || path.join(process.cwd(),'data'),'credentials.json');
}
export function loadSetupCredentials() {
  if(globalThis.__s98_setup_credentials_loaded) return;
  globalThis.__s98_setup_credentials_loaded=true;
  const file=secretFile();
  if(!file || !fs.existsSync(file)) return;
  try { const value=JSON.parse(fs.readFileSync(file,'utf8'));if(typeof value.TYPESAFE_API_KEY==='string' && value.TYPESAFE_API_KEY) process.env.TYPESAFE_API_KEY=value.TYPESAFE_API_KEY; }
  catch { console.warn('[signal98] Could not read the saved classifier credential. Check the server credential file.'); }
}
export function setupSummary(pid) {
  const saved=kvGet(`setup:${pid}`);
  return {required:saved?.status==='new'||saved?.status==='started',status:saved?.status || 'existing',step:saved?.step || 0};
}
export async function setupStatus(pid) {
  const project=getProject(pid),saved=kvGet(`setup:${pid}`,{});
  const proof=saved.proof_id && q("SELECT e.id,e.issue_id,e.received_at,i.judge_status,i.judged_by,i.verdict FROM events e LEFT JOIN issues i ON i.id=e.issue_id WHERE e.project_id=? AND e.service=? AND e.received_at>=? AND json_extract(e.props,'$.signal98_setup')=? AND e.issue_id IS NOT NULL ORDER BY e.id DESC LIMIT 1").get(pid,saved.service,saved.verify_started_at || 0,saved.proof_id);
  return {...setupSummary(pid),service:saved.service || 'my-react-app',framework:saved.framework || 'react',host:saved.host || '',proof_id:saved.proof_id || null,project:{id:project.id,name:project.name,api_key:project.api_key},repo_path:project.settings.ghost.repoPath || '',jev:jevStatus(),ghost_provider:await ghostProvider(),proof:proof || null,sdk_package:'/downloads/signal98-0.2.0.tgz'};
}
export function saveSetup(pid,body) {
  const old=kvGet(`setup:${pid}`,{}),next={...old};
  if(body.service!==undefined) {
    if(typeof body.service!=='string'||!body.service.trim()||body.service.length>80) throw new HttpError(400,'Enter an app name up to 80 characters.');
    next.service=body.service.trim();
  }
  if(body.framework!==undefined) {
    if(!['react','next','script'].includes(body.framework)) throw new HttpError(400,'Choose React, Next.js, or script tag.');
    next.framework=body.framework;
  }
  if(body.host!==undefined) {
    try {const u=new URL(body.host);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw new Error();next.host=u.href.replace(/\/$/,'');}
    catch {throw new HttpError(400,'Enter an http or https monitor address without credentials, query, or fragment.');}
  }
  if(body.step!==undefined) {
    if(!Number.isInteger(body.step)||body.step<0||body.step>4) throw new HttpError(400,'Invalid setup step.');
    next.step=body.step;
  }
  if(body.repo_path!==undefined) {
    if(typeof body.repo_path!=='string'||body.repo_path.length>1000) throw new HttpError(400,'Enter a valid repository folder.');
    if(body.repo_path.trim()) {
      try {if(!path.isAbsolute(body.repo_path.trim())||!fs.statSync(body.repo_path.trim()).isDirectory()) throw new Error();}
      catch {throw new HttpError(400,'That folder was not found on the Signal98 server. Use an absolute folder path.');}
    }
    const p=getProject(pid);saveProjectSettings(pid,{...p.settings,ghost:{...p.settings.ghost,repoPath:body.repo_path.trim()}});
  }
  if(body.action==='begin' || (next.service!==old.service && next.proof_id) || (body.step===4 && !next.proof_id)) {next.proof_id=crypto.randomUUID();next.verify_started_at=Date.now();}
  next.status=body.action==='complete'?'complete':body.action==='later'?'dismissed':'started';
  if(body.action==='complete') next.completed_at=Date.now();
  kvSet(`setup:${pid}`,next);publish('settings',{project_id:pid});
  return {ok:true,...setupSummary(pid)};
}
export async function saveJevKey(pid,body) {
  if(globalThis.__s98_setup_key_busy) throw new HttpError(409,'A connection check is already running.');
  const candidate=body.key===undefined?process.env.TYPESAFE_API_KEY:body.key;
  if(typeof candidate!=='string'||!candidate.trim()||candidate.length>1024||/[\r\n\x00]/.test(candidate)) throw new HttpError(400,'Enter a valid TypeSafe API key.');
  globalThis.__s98_setup_key_busy=true;
  try {
    let verified;
    try {verified=await verifyJevKey(candidate.trim(),pid);} catch(err) {throw new HttpError(422,err.message);}
    if(body.key!==undefined) {
      const file=secretFile();
      if(!file) throw new HttpError(503,'Credential storage is unavailable.');
      const tmp=`${file}.${crypto.randomUUID()}.tmp`;
      try {
        fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
        fs.writeFileSync(tmp,JSON.stringify({TYPESAFE_API_KEY:candidate.trim()}),{mode:0o600,flag:'wx'});
        fs.renameSync(tmp,file);fs.chmodSync(file,0o600);
      } catch {try{fs.unlinkSync(tmp);}catch{}throw new HttpError(500,'Could not save the key on the server. Check storage permissions.');}
      process.env.TYPESAFE_API_KEY=candidate.trim();
    }
    recordJevConnection(verified);publish('settings',{project_id:pid});
    return {ok:true,jev:jevStatus()};
  } finally {globalThis.__s98_setup_key_busy=false;}
}
