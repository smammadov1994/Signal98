"use client";
import {useState} from 'react';
import {useApi,fmtNum,ago} from '../lib/client';
import {useDemoSession} from '../lib/demo-session';
import {GhostGlyph} from './Ghost';
import {useWidth} from './charts';

const priorities={page:'Needs attention',notify:'Investigate',ticket:'Can wait',ignore:'Noise'};
export default function MonitoringDashboard({wm,meta}) {
  const session=useDemoSession();
  const [range,setRange]=useState('24h'),[tab,setTab]=useState('open');
  const scope=session.since?`&since=${session.since}`:'';
  const data=useApi(`monitoring?range=${range}${scope}`,{every:10000,on:['event','issue','verdict']});
  const list=useApi(`conversations?status=${tab}${scope}`,{every:10000,on:['issue','verdict','agent','chat']});
  const urgent=useApi(`conversations?status=open&verdict=page${scope}`,{every:10000,on:['issue','verdict']});
  const d=data.data,states=d?.states || [],items=list.data?.items || [];
  const open=states.filter(s=>s.status==='open').reduce((n,s)=>n+s.n,0),attn=states.filter(s=>s.status==='open'&&['page','notify'].includes(s.verdict)).reduce((n,s)=>n+s.n,0),resolved=states.filter(s=>s.status==='resolved').reduce((n,s)=>n+s.n,0);
  const period=range==='24h'?'Last 24 hours':'Last 7 days';
  return <div className="monitoring-dashboard">
    <header className="md-heading"><div><p>WORKSPACE HEALTH</p><h1>Dashboard</h1></div><div><button className="md-scope" onClick={session.since?session.history:session.start}>{session.since?'Current demo':'Saved history'} <span>⌄</span></button><select aria-label="Dashboard time range" value={range} onChange={e=>setRange(e.target.value)}><option value="24h">Last 24 hours</option><option value="7d">Last 7 days</option></select></div></header>
    {(data.error || list.error || urgent.error)&&<p className="conversation-error" role="alert">Some monitoring data couldn’t refresh. <button onClick={()=>{data.reload();list.reload();urgent.reload();}}>Retry</button></p>}
    <div className="md-layout"><main>
      <div className="md-stats">{[['Open issues',open,'Current queue','lavender'],['Needs attention',attn,'Page or investigate','peach'],['Errors captured',d?.totals.errors,period,'mint'],['People affected',d?.totals.affected,period,'blue']].map(([label,value,note,tone])=><div key={label}><span>{label}<i className={tone}/></span><strong>{d?fmtNum(value):'—'}</strong><small>{note}{session.since&&label.includes('captured')?' · current demo':''}</small></div>)}</div>
      <section className="md-panel md-activity"><header><div><h2>Error activity</h2><p>{session.since?'Errors received in this demo':'Captured error occurrences'}</p></div><span className="md-legend"><i/>Errors</span></header>{d?<DotActivity points={d.series} bucket={d.bucket}/>:<div className="md-loading">{data.error?'Activity unavailable.':'Loading activity…'}</div>}<footer><span><strong>{fmtNum(d?.totals.events)}</strong> total events · {period.toLowerCase()}</span><button onClick={()=>wm.open('feed')}>View live feed ↗</button></footer></section>
      <section className="md-panel md-issues"><header><h2>Manage issues</h2><button onClick={()=>wm.open('conversations')}>Open conversations ↗</button></header><div className="md-tabs">{[['open','Open',open],['resolved','Resolved',resolved],['all','All',states.reduce((n,s)=>n+s.n,0)]].map(([key,label,n])=><button key={key} aria-pressed={tab===key} onClick={()=>setTab(key)}>{label}<span>{d?n:'—'}</span></button>)}</div><div className="md-table-wrap"><table><thead><tr><th>Issue / specialist</th><th>Priority</th><th>Occurrences</th><th>Last seen</th><th><span className="overview-sr-only">Conversation</span></th></tr></thead><tbody>{items.slice(0,7).map(i=><tr key={i.id}><td><div className="md-issue-person"><span><GhostGlyph size={23} color={i.ghost.color}/></span><div><button onClick={()=>wm.open('conversations',{id:i.id})}>{i.title.replace(/^Demo checkout: /,'Checkout · ')}</button><small>{i.ghost.name} · #{i.id}</small></div></div></td><td><span className={`md-priority ${i.verdict}`}>{i.status==='resolved'?'Resolved':priorities[i.verdict] || 'Pending'}</span></td><td>{fmtNum(i.count)}</td><td>{ago(i.last_seen)}</td><td><button className="md-chat-link" onClick={()=>wm.open('conversations',{id:i.id})} aria-label={`Chat about issue ${i.id}`}>↗</button></td></tr>)}</tbody></table></div>{!items.length&&<p className="md-empty">{list.loading?'Loading issues…':`No ${tab==='all'?'recorded':tab} issues in this view.`}</p>}{(list.data?.total || 0)>7&&<button className="md-more" onClick={()=>wm.open('conversations')}>Browse all {list.data.total} conversations →</button>}</section>
    </main><aside className="md-right">
      <section className="md-panel md-priorities"><header><h2>Priority issues</h2><button onClick={()=>wm.open('issues')}>View all</button></header>{urgent.data?.items?.length?urgent.data.items.slice(0,4).map(i=><button className="md-priority-row" key={i.id} onClick={()=>wm.open('conversations',{id:i.id})}><span className="md-priority-ring"/><span><strong>{i.title}</strong><small>Needs attention · #{i.id}</small></span><span>›</span></button>):<div className="md-priority-clear"><span>✓</span><strong>{urgent.data?'No urgent issues':'Checking priorities…'}</strong><p>{urgent.data?'Issues that need an immediate response will appear here.':'The queue will update automatically.'}</p></div>}</section>
      <section className="md-ghost"><GhostGlyph size={44} color="#8977d1"/><p>YOUR ISSUE SPECIALISTS</p><h2>What should we<br/>look into?</h2><span>Each error has a Ghost with its assessment, context, and conversation.</span><div className="md-ghost-actions"><button onClick={()=>wm.open('conversations')}>Discuss an error ↗</button><button onClick={()=>wm.open('runs')}>Review a fix ↗</button></div><button className="md-ghost-open" onClick={()=>wm.open('conversations')}>Open Ghost inbox <span>→</span></button></section>
      <div className="md-demo-link"><span>Try the full flow</span><a href="http://localhost:3000/demo" target="_blank" rel="noreferrer">Open playground ↗</a></div>
      <button className="md-connection" onClick={()=>wm.open('settings',{tab:'jev'})}>JEV {meta.data?.jev?.enabled&&meta.data.jev.lastOkAt&&meta.data.jev.circuit!=='open'?'connected':'connection settings'} ↗</button>
    </aside></div>
  </div>;
}

function DotActivity({points,bucket}) {
  const [ref,width]=useWidth(600);
  const max=Math.max(0,...points.map(p=>p.errors)),unit=Math.max(1,Math.ceil(max/8));
  const H=200,left=28,right=15,bottom=26,step=(width-left-right)/Math.max(1,points.length),radius=Math.min(5,step/3);
  const ticks=[0,Math.floor((points.length-1)/2),points.length-1];
  const label=t=>new Date(t).toLocaleString([],{month:bucket>3600000?'short':undefined,day:bucket>3600000?'numeric':undefined,hour:'numeric'});
  return <div className="md-dot-chart" ref={ref}><svg width={width} height={H} role="img" aria-label={`Error occurrences over time. ${points.reduce((n,p)=>n+p.errors,0)} errors. Each dot represents up to ${unit} errors.`}><line x1={left} x2={width-right} y1={H-bottom} y2={H-bottom} stroke="#e6e7ed"/>{points.map((p,i)=><g key={p.t}><title>{label(p.t)}: {p.errors} errors</title>{Array.from({length:Math.ceil(p.errors/unit)},(_,j)=><circle key={j} cx={left+step*(i+.5)} cy={H-bottom-9-j*17} r={radius} fill={p.errors===max&&max>0?'#9788de':'#a3e0d4'}/>)}{!p.errors&&<circle cx={left+step*(i+.5)} cy={H-bottom-3} r={1.5} fill="#e6e9ed"/>}</g>)}{ticks.filter((v,i,a)=>a.indexOf(v)===i).map(i=><text key={i} x={left+step*(i+.5)} y={H-6} textAnchor={i===0?'start':i===points.length-1?'end':'middle'} fontSize="10" fill="#727589">{label(points[i].t)}</text>)}{!max&&<text x={width/2} y={H/2-8} textAnchor="middle" fontSize="13" fill="#797d8d">No errors recorded in this period</text>}</svg><div className="md-chart-note">1 dot = up to {fmtNum(unit)} {unit===1?'error':'errors'}{max>0?' · purple marks the peak':''}<details><summary>View counts</summary><div>{points.map(p=><span key={p.t}>{label(p.t)}<b>{p.errors}</b></span>)}</div></details></div></div>;
}
