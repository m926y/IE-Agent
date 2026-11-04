import {useEffect,useRef,useState} from 'react';
import {aiHistoryGet,aiHistorySave} from './api';
import {forStorage,mergeConversations,readConversations,writeConversations} from './ai-history';
import type {Message,Conversation} from './ai-history';
import './ai-conversations.css';
export {readConversations} from './ai-history';

export function ConversationSidebar({user,messages,onSelect,busy,mobile=false,onDismiss,onReady}:{user:string;messages:Message[];onSelect:(messages:Message[])=>void;busy:boolean;mobile?:boolean;onDismiss?:()=>void;onReady?:()=>void}){
 const [query,setQuery]=useState('');
 const [saved,setSaved]=useState(()=>{const value=readConversations(user);if(!value.active)value.active=crypto.randomUUID();return value});
 const [storageError,setStorageError]=useState(false);
 const [cloudReady,setCloudReady]=useState(false);
 const [cloudError,setCloudError]=useState(false);
 const version=useRef(0);
 const queue=useRef(Promise.resolve());
 useEffect(()=>{let cancelled=false;
  aiHistoryGet().then(r=>{if(cancelled)return;version.current=r.version_no;
   const merged=mergeConversations(readConversations(user),r.snapshot);
   setSaved(merged);
   const thread=merged.items.find(t=>t.id===merged.active);
   if(thread&&JSON.stringify(forStorage(messages))!==JSON.stringify(thread.messages))onSelect(thread.messages.map(m=>({...m,restored:true})));
   setCloudReady(true);setCloudError(false);onReady?.();
  }).catch(()=>{if(cancelled)return;setCloudReady(true);setCloudError(true);onReady?.()});
  return()=>{cancelled=true};
 },[user]);
 useEffect(()=>{try{writeConversations(user,saved);setStorageError(false)}catch{setStorageError(true)}},[saved,user]);
 useEffect(()=>{setSaved(previous=>{
  const existing=previous.items.find(t=>t.id===previous.active);
  const full=forStorage(messages);
  if(!full.length&&!existing)return previous;
  if(existing&&JSON.stringify(existing.messages)===JSON.stringify(full))return previous;
  const current:Conversation={id:previous.active,title:messages.find(m=>m.role==='user')?.content.slice(0,28)||'新会话',updated:Date.now(),messages:full};
  const next={active:previous.active,items:[current,...previous.items.filter(t=>t.id!==previous.active)]};
  return next;
 })},[messages,user]);
 useEffect(()=>{if(!cloudReady)return;
  const snapshot=saved;
  const timer=setTimeout(()=>{queue.current=queue.current.then(async()=>{
   try{const r=await aiHistorySave(snapshot,version.current);version.current=r.version_no;setCloudError(false)}
   catch{try{const latest=await aiHistoryGet();const merged={...mergeConversations(snapshot,latest.snapshot),active:snapshot.active};const r=await aiHistorySave(merged,latest.version_no);version.current=r.version_no;setSaved(previous=>({...mergeConversations(previous,merged),active:previous.active}));setCloudError(false)}catch{setCloudError(true)}}
  })},300);
  return()=>clearTimeout(timer);
 },[saved,cloudReady]);
 function select(id:string){if(busy||id===saved.active)return;const thread=saved.items.find(t=>t.id===id);if(!thread)return;setSaved({...saved,active:id});onSelect(thread.messages.map(m=>({...m,restored:true})));onDismiss?.()}
 function create(){if(busy)return;setSaved({...saved,active:crypto.randomUUID()});onSelect([]);onDismiss?.()}
 useEffect(()=>{if(!mobile)return;const h=()=>create();window.addEventListener('claw:driver-new-chat',h);return()=>window.removeEventListener('claw:driver-new-chat',h)},[mobile,busy,saved]);
 return <aside className="ai-conversations" aria-label="助手会话">{mobile&&<input className="mobile-chat-search" aria-label="搜索历史会话" placeholder="搜索会话" value={query} onChange={e=>setQuery(e.target.value)}/>}<button className="btn primary" disabled={busy} onClick={create}>＋ 新建会话</button><h4>历史会话</h4>{storageError&&<p role="alert">浏览器存储空间不足，当前对话未能保存；请清理浏览器空间。</p>}{cloudError&&<p role="status">云端历史暂不可用，本浏览器仍会保留对话。</p>}{saved.items.filter(t=>t.messages.length&&t.title.includes(query)).map(t=><button className={'ai-thread '+(t.id===saved.active?'active':'')} disabled={busy} aria-pressed={t.id===saved.active} key={t.id} onClick={()=>select(t.id)}><span>{t.title.startsWith('AI04 三种管理路径')?'车辆处置方案':t.title}</span><small>{new Date(t.updated).toLocaleDateString('zh-CN')}</small></button>)}{!saved.items.some(t=>t.messages.length)&&<p>暂无历史会话</p>}</aside>
}
