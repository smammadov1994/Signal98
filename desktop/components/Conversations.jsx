"use client";
import { useEffect, useRef, useState } from 'react';
import { api, useApi, ago, fmtNum } from '../lib/client';
import { useDemoSession } from '../lib/demo-session';
import { GhostGlyph } from './Ghost';

const verdicts={page:'Needs attention',notify:'Investigate',ticket:'Can wait',ignore:'Noise'};
const title=i => i?.title?.replace(/^Demo checkout: /,'Checkout · ') || 'Issue conversation';
const ghostName=g => g?.name ? g.name.charAt(0)+g.name.slice(1).toLowerCase() : 'Ghost';

export default function Conversations({wm,params={},nonce}) {
  const session=useDemoSession();
  const [search,setSearch]=useState(''),[filter,setFilter]=useState('open'),[offset,setOffset]=useState(0),[selected,setSelected]=useState(null),[mobileOpen,setMobileOpen]=useState(false);
  const list=useApi(`conversations?status=${filter==='all'?'all':'open'}${filter==='page'?'&verdict=page':''}&q=${encodeURIComponent(search)}&offset=${offset}${session.since?`&since=${session.since}`:''}`,{every:10000,on:['issue','verdict','chat','agent']});
  useEffect(()=>{setOffset(0);},[search,filter,session.since]);
  useEffect(()=>{setSelected(params.id || null);setMobileOpen(!!params.id);},[params.id,nonce]);
  const previousScope=useRef(session.since);
  useEffect(()=>{if(previousScope.current!==session.since){previousScope.current=session.since;setSelected(null);setMobileOpen(false);}},[session.since]);
  useEffect(()=>{if (!selected && list.data?.items?.length) setSelected(list.data.items[0].id);},[list.data]);
  const id=selected || list.data?.items?.[0]?.id;
  return <div className={`ghost-inbox${mobileOpen?' show-chat':''}`}>
    <aside className="conversation-list" aria-label="Issue conversations">
      <header><div><h1>Conversations</h1><span>{list.data?.total ?? '—'} {list.data?.total===1?'grouped issue':'grouped issues'}</span></div><GhostGlyph size={27} color="#8d80d5" /></header>
      <label className="conversation-search"><span aria-hidden="true">⌕</span><input aria-label="Search issue conversations" placeholder="Search errors, categories…" value={search} onChange={e=>setSearch(e.target.value)} /></label>
      <div className="conversation-filters">{[['open','Open'],['page','Urgent'],['all','All']].map(([key,label])=><button key={key} aria-pressed={filter===key} onClick={()=>setFilter(key)}>{label}</button>)}</div>
      <div className="conversation-scope"><span>{session.since?'Current demo':'Saved history'}</span><button onClick={session.since?session.history:session.start}>{session.since?'View history':'Start fresh'}</button></div>
      {list.error && <p className="conversation-error">Couldn’t refresh. <button onClick={list.reload}>Retry</button></p>}
      <div className="conversation-items">{!list.data ? <p className="conversation-empty">Loading conversations…</p> : !list.data.items.length ? <div className="conversation-empty"><strong>{search?'No matching issues.':'No issues here yet.'}</strong><p>{session.since?'Trigger an error in the playground or view saved history.':'New captured errors will appear here.'}</p><a href="http://localhost:3000/demo" target="_blank" rel="noreferrer">Open playground ↗</a></div> : list.data.items.map(i=><button className={`conversation-item${id===i.id?' selected':''}`} key={i.id} onClick={()=>{setSelected(i.id);setMobileOpen(true);}} aria-pressed={id===i.id}><span className="conversation-avatar"><GhostGlyph size={23} color={i.ghost?.color || '#8b80d8'} /></span><span className="conversation-copy"><span className="conversation-item-top"><strong>{title(i)}</strong><small>{ago(i.last_seen)}</small></span><span className="conversation-preview">{['queued','running'].includes(i.chat_status)?'Ghost is replying…':i.preview?.replace(/[*`#]/g,'') || `${ghostName(i.ghost)} · ${i.category || 'Classifying…'}`}</span><span className={`conversation-priority ${i.verdict}`}>{i.status==='resolved'?'Resolved':verdicts[i.verdict] || 'Pending'}<small>#{i.id} · {fmtNum(i.count)} occurrences</small></span></span></button>)}</div>
      {list.data && (offset>0 || list.data.has_more) && <div className="conversation-pagination"><button disabled={!offset} onClick={()=>setOffset(v=>Math.max(0,v-50))}>Previous</button><span>{offset+1}–{offset+list.data.items.length} of {list.data.total}</span><button disabled={!list.data.has_more} onClick={()=>setOffset(v=>v+50)}>Next</button></div>}
      <footer>One issue, one Ghost. Repeats stay together.</footer>
    </aside>
    {id ? <IssueChat key={id} id={id} wm={wm} onBack={()=>setMobileOpen(false)} /> : <section className="chat-welcome"><GhostGlyph size={66} color="#9183d8" /><h2>Every error has a conversation.</h2><p>JEV assesses the impact. Your Ghost helps you understand the cause and prepare a fix.</p><a className="chat-primary" href="http://localhost:3000/demo" target="_blank" rel="noreferrer">Trigger your first error ↗</a><button onClick={session.history}>Browse saved issues</button></section>}
  </div>;
}

function IssueChat({id,wm,onBack}) {
  const result=useApi(`issues/${id}/conversation`,{every:4000,on:['chat','verdict','issue']});
  const detail=useApi(`issues/${id}`,{every:6000,on:['agent','issue']});
  const [draft,setDraft]=useState(()=>{try{return sessionStorage.getItem(`s98_chat_draft_${id}`)||'';}catch{return '';}}),[sending,setSending]=useState(false),[error,setError]=useState(''),[preparing,setPreparing]=useState(false),[older,setOlder]=useState([]),[historyMore,setHistoryMore]=useState(true),[loadingOlder,setLoadingOlder]=useState(false);
  useEffect(()=>{try{sessionStorage.setItem(`s98_chat_draft_${id}`,draft);}catch{}},[id,draft]);
  const request=useRef(null),scroller=useRef(null),nearBottom=useRef(true);
  const data=result.data,issue=data?.issue,ghost=data?.ghost;
  const fresh=data?.messages || [],all=[...older.filter(m=>!fresh.some(n=>n.id===m.id)),...fresh];
  const last=fresh.at(-1),busy=['queued','running'].includes(last?.status);
  const run=detail.data?.runs?.[0];
  useEffect(()=>{if(nearBottom.current && scroller.current) scroller.current.scrollTop=scroller.current.scrollHeight;},[fresh.length,last?.status,run?.status]);
  async function send(text=draft) {
    if(!text.trim() || sending || busy) return;
    setSending(true);setError('');
    if(!request.current || request.current.text!==text) request.current={text,id:crypto.randomUUID()};
    try {await api(`issues/${id}/conversation`,{method:'POST',body:{message:text,request_id:request.current.id}});setDraft('');request.current=null;nearBottom.current=true;result.reload();}
    catch(e){setError(e.message);} finally{setSending(false);}
  }
  async function prepare() {
    setPreparing(true);setError('');
    try {await api(`issues/${id}/agent`,{method:'POST'});detail.reload();}catch(e){setError(e.message);}finally{setPreparing(false);}
  }
  async function retry(messageId) {try{await api(`issues/${id}/conversation-retry`,{method:'POST',body:{message_id:messageId}});result.reload();}catch(e){setError(e.message);}}
  async function loadOlder() {
    setLoadingOlder(true);
    try {const r=await api(`issues/${id}/conversation?before=${all[0]?.id}`);setOlder(v=>[...r.messages,...v]);setHistoryMore(r.has_more);}catch(e){setError(e.message);}finally{setLoadingOlder(false);}
  }
  if(!data) return <section className="chat-welcome"><h2>{result.error?'Couldn’t load this conversation.':'Opening conversation…'}</h2>{result.error&&<button onClick={result.reload}>Try again</button>}</section>;
  const judged=issue.judge_status==='judged', real=judged && issue.judged_by && !issue.judged_by.startsWith('heuristic');
  const canFix=!preparing && !['queued','running'].includes(run?.status) && !busy;
  return <section className="issue-chat" aria-label={`Conversation for issue ${id}`}>
    <header className="chat-header"><button className="chat-back" onClick={onBack} aria-label="Back to conversations">←</button><span className="chat-header-avatar"><GhostGlyph size={26} color={ghost?.color || '#9183d8'} /></span><div><h2>{title(issue)}</h2><p>{ghostName(ghost)} <span>· Issue #{id} · {issue.status}</span></p></div><button className="chat-subtle" onClick={()=>wm.open('issue',{id})}>Issue details ↗</button></header>
    <div className="chat-scroll" ref={scroller} onScroll={e=>{const s=e.currentTarget;nearBottom.current=s.scrollHeight-s.scrollTop-s.clientHeight<120;}}>
      <div className="chat-transcript">
        <div className="chat-context"><div className="chat-context-heading"><span>{real?'JEV ASSESSMENT':judged?'KEYWORD FALLBACK · NOT JEV':'CLASSIFICATION PENDING'}</span><button onClick={()=>wm.open('judgment',{id})}>Full result ↗</button></div><h3>{judged?verdicts[issue.verdict] || 'Assessed':'Waiting for classification'}</h3><div className="chat-context-facts"><span>Severity <strong>{judged?`${Number(issue.severity || 0).toFixed(1)} / 4`:'—'}</strong></span><span>Total occurrences <strong>{fmtNum(issue.count)}</strong></span><span>People affected <strong>{fmtNum(detail.data?.users)}</strong></span></div><p>{judged?`${issue.judged_by} · ${issue.category || 'Uncategorized'} · ${issue.cause?.replaceAll('_',' ') || 'Cause unknown'}`:'Your Ghost will use the assessment once it arrives.'}</p></div>
        <div className="chat-introduction"><GhostGlyph size={21} color={ghost?.color || '#9183d8'} /><div><strong>{ghostName(ghost)}</strong><p>I’m assigned to this issue. Ask me about the captured error, investigate the cause, or prepare a code fix.</p><small>{ghostName(ghost)} uses this error’s assessment, stack trace, and your conversation.</small></div></div>
        {!fresh.length && !older.length && <div className="chat-starters">{['What happened here?','What should we investigate first?','How would you fix this?'].map(t=><button key={t} disabled={sending||busy} onClick={()=>send(t)}>{t} ↗</button>)}</div>}
        {(data.has_more && historyMore) && <button className="chat-load-older" disabled={loadingOlder} onClick={loadOlder}>{loadingOlder?'Loading…':'Load earlier messages'}</button>}
        {all.map(m=><article key={m.id} className={`chat-message ${m.role}`}><div className="chat-message-author">{m.role==='assistant'?<><GhostGlyph size={17} color={ghost?.color || '#9183d8'} />{ghostName(ghost)}</>:'You'}<time>{new Date(m.created_at).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}</time></div>{m.status==='failed'?<div className="chat-failed"><p>{m.error || 'Reply failed.'}</p>{m.id===last?.id&&<button onClick={()=>retry(m.id)}>Retry reply</button>}</div>:['running','queued'].includes(m.status)?<p className="chat-thinking" role="status">{m.status==='queued'?'Waiting for an available model…':`${ghostName(ghost)} is investigating…`}</p>:<MessageText content={m.content} />}</article>)}
        {run && <div className={`chat-run ${run.status}`}><strong>{({queued:'Fix queued',running:'Ghost is preparing a fix',succeeded:'Proposed fix ready to review',applied:'Fix applied',failed:'Fix attempt failed',skipped:'Fix not started'})[run.status] || run.status}</strong><p>{run.summary || 'Working in a separate copy of your app. Progress updates automatically.'}</p><button onClick={()=>wm.open('run',{id:run.id})}>{run.status==='succeeded'?'Review changes & apply':'View fix details'} →</button></div>}
      </div>
    </div>
    <div className="chat-compose-area">{(error||result.error)&&<p className="conversation-error" role="alert">{error||'Couldn’t refresh this conversation.'}</p>}{data.provider==='template'&&<p className="conversation-error">Chat model not connected. <button onClick={()=>wm.open('settings',{tab:'ghost'})}>Configure Ghost</button></p>}<div className="chat-compose-actions"><span>Discuss first. Review every code change.</span><button onClick={prepare} disabled={!canFix}>{preparing?'Starting…':'Prepare fix'} <span aria-hidden="true">↗</span></button></div><form onSubmit={e=>{e.preventDefault();send();}}><textarea aria-label={`Message ${ghostName(ghost)}`} placeholder={`Message ${ghostName(ghost)} about this error…`} value={draft} maxLength={8000} onChange={e=>setDraft(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();send();}}} rows={2}/><button className="chat-send" aria-label="Send message" disabled={sending||busy||!draft.trim()||data.provider==='template'} type="submit">↑</button></form><p className="chat-compose-note">{busy?'Reply in progress. You can keep writing.':`${data.provider==='claude-code'?'Claude Code':data.provider==='template'?'No model':'Connected model'} · Enter to send, Shift + Enter for a new line`}</p></div>
  </section>;
}

function MessageText({content}) {
  // Render only plain text, fenced code and simple emphasis; model HTML is never executed.
  return <div className="chat-message-content">{content.split(/(```[\s\S]*?```)/g).map((part,i)=>part.startsWith('```')?<pre key={i}><code>{part.replace(/^```[^\n]*\n?/,'').replace(/```$/,'')}</code></pre>:<div key={i}>{part.split(/(\*\*[^*]+\*\*)/g).map((s,j)=>s.startsWith('**')?<strong key={j}>{s.slice(2,-2)}</strong>:s)}</div>)}</div>;
}
