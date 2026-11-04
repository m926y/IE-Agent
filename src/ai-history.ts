export type Message={role:'user'|'assistant';content:string;restored?:boolean;err?:string};
export type Conversation={id:string;title:string;updated:number;messages:Message[]};
export type Saved={active:string;items:Conversation[]};
const key=(user:string)=>'claw_ai_threads_'+user;

export const forStorage=(messages:Message[])=>messages.map(({restored:_,...message})=>message);

export function mergeConversations(local:Saved,remote:Saved):Saved{
 const all=new Map<string,Conversation>();
 for(const item of [...remote.items,...local.items]){const old=all.get(item.id);if(!old||item.updated>=old.updated)all.set(item.id,item)}
 const items=[...all.values()].sort((a,b)=>b.updated-a.updated);
 const localAt=local.items.find(t=>t.id===local.active)?.updated||0;
 const remoteAt=remote.items.find(t=>t.id===remote.active)?.updated||0;
 const active=localAt>=remoteAt?local.active:remote.active;
 return {active:items.some(t=>t.id===active)?active:items[0]?.id||'',items};
}

export function readConversations(user:string):Saved{
 try{
  const raw=localStorage.getItem(key(user))||sessionStorage.getItem(key(user));
  const saved=JSON.parse(raw||'null');
  if(saved&&Array.isArray(saved.items)){
   const result:Saved={active:typeof saved.active==='string'?saved.active:'',items:saved.items.filter((t:Conversation)=>t&&typeof t.id==='string'&&Array.isArray(t.messages))};
   if(!localStorage.getItem(key(user)))localStorage.setItem(key(user),JSON.stringify(result));
   return result;
  }
 }catch{}
 return {active:'',items:[]};
}

export function writeConversations(user:string,value:Saved){
 localStorage.setItem(key(user),JSON.stringify(value));
}
