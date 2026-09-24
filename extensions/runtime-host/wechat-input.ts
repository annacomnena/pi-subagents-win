import { appendFileSync, chmodSync, mkdirSync, openSync, closeSync, renameSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { inboxFileName, WechatStore, type InboundRecord } from "../channel-wechat/store.ts";
import { readAttachment } from "../runtime/registry.ts";
import { masterAddress } from "../runtime/address.ts";
import { newOutboxItem, outboxDir, outboxItemId, writeOutboxItem } from "../runtime/message-outbox.ts";
import { sessionAlive, defaultTimersDir } from "../timers.ts";
import { readWechatInputConfig } from "./wechat-bind.ts";

export interface WechatInputOptions {
 runtimeDir: string; configPath: string; now?: Date; timersDir?: string; stateDir?: string;
 readConfig?: typeof readWechatInputConfig;
 readOwner?: typeof readAttachment;
 alive?: typeof sessionAlive;
}
const shortHash = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 12);
const mask = (s: string): string => s.length > 10 ? `${s.slice(0,6)}…${s.slice(-4)}` : shortHash(s);
function audit(path: string, data: Record<string, unknown>): void {
 try { mkdirSync(join(path,"state"),{recursive:true}); const file=join(path,"state","wechat-input-audit.jsonl"); const fd=openSync(file,"a",0o600); try { appendFileSync(fd,JSON.stringify(data)+"\n"); } finally { closeSync(fd); } try { chmodSync(file,0o600); } catch {} } catch {}
}
function atomicRecord(dir: string, rec: InboundRecord & { injectedAt?: string; outboxId?: string }): void {
 const file=join(dir,"inbox",inboxFileName(rec.msgId)); const tmp=`${file}.${process.pid}.tmp`;
 writeFileSync(tmp,JSON.stringify(rec,null,2)+"\n",{mode:0o600}); renameSync(tmp,file);
}
export function tryInjectPending(opts: WechatInputOptions): { injected: boolean; reason?: string } {
 const config=(opts.readConfig??readWechatInputConfig)(opts.configPath);
 if(config.enabled!==true) return {injected:false,reason:"disabled"};
 const store=new WechatStore(WechatStore.resolveDir(opts.runtimeDir));
 const record=store.readInbox(0).filter(x=>x.state==="pending").sort((a,b)=>a.receivedAt.localeCompare(b.receivedAt)||a.msgId.localeCompare(b.msgId))[0];
 if(!record) return {injected:false,reason:"empty"};
 const at=(opts.now??new Date()).toISOString();
 const base={at,msgId:mask(record.msgId),from:mask(record.fromId),ownerSid:"",generation:0};
 if(!record.fromId || !config.allowFrom.includes(record.fromId)) { try { atomicRecord(WechatStore.resolveDir(opts.runtimeDir),{...record,state:"rejected"}); } catch {} audit(opts.runtimeDir,{...base,decision:"denied",reason:"not-allowlisted"}); return {injected:false,reason:"not-allowlisted"}; }
 // W1 parser only materializes direct-message text records; no group discriminator is retained.
 let owner=(opts.readOwner??readAttachment)(masterAddress());
 if(!owner || !(opts.alive??sessionAlive)(opts.timersDir??defaultTimersDir(),owner.sessionId,opts.now??new Date())) { audit(opts.runtimeDir,{...base,decision:"skipped",reason:"master-offline"}); return {injected:false,reason:"master-offline"}; }
 const before=owner;
 const outDir=outboxDir(opts.stateDir??join(opts.runtimeDir,"state"));
 const dedupeKey=`wechat:${record.msgId}`; const id=outboxItemId(dedupeKey);
 try {
  owner=(opts.readOwner??readAttachment)(masterAddress());
  if(!owner || owner.sessionId!==before.sessionId || owner.generation!==before.generation) { audit(opts.runtimeDir,{...base,decision:"skipped",reason:"owner-changed",ownerSid:before.sessionId.slice(0,12),generation:before.generation}); return {injected:false,reason:"owner-changed"}; }
  mkdirSync(outDir,{recursive:true});
  const item=newOutboxItem({dedupeKey,commandKey:id,to:`pi://${owner.sessionId}` as `pi://${string}`,sessionId:owner.sessionId,text:`[微信 ${mask(record.fromId)}] ${record.text}`,now:opts.now??new Date()});
  writeOutboxItem(outDir,item);
  const updated={...record,state:"injected" as const,injectedAt:at,outboxId:item.id};
  atomicRecord(WechatStore.resolveDir(opts.runtimeDir),updated);
  audit(opts.runtimeDir,{...base,decision:"accepted",reason:"injected",ownerSid:owner.sessionId.slice(0,12),generation:owner.generation,outboxId:item.id});
  return {injected:true};
 } catch { try { atomicRecord(WechatStore.resolveDir(opts.runtimeDir),{...record,state:"rejected"}); } catch {} audit(opts.runtimeDir,{...base,decision:"uncertain",reason:"write-failed",ownerSid:before.sessionId.slice(0,12),generation:before.generation}); return {injected:false,reason:"uncertain"}; }
}
export function startWechatInput(opts: WechatInputOptions): ()=>void {
 const inbox=join(opts.runtimeDir,"wechat","receive","inbox"); let busy=false; let timer: ReturnType<typeof setTimeout>|null=null;
 const run=()=>{ if(busy)return; busy=true; try{tryInjectPending(opts);}catch{} finally{busy=false;} };
 const debounce=()=>{if(timer)clearTimeout(timer); timer=setTimeout(run,200); timer.unref?.();};
 let watcher: FSWatcher|null=null;
 try { watcher=watch(inbox,debounce); } catch {}
 const tick=setInterval(run,5000); tick.unref?.(); run();
 return ()=>{clearInterval(tick); if(timer)clearTimeout(timer); try{watcher?.close();}catch{}};
}
