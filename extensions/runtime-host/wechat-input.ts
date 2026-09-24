import { appendFileSync, chmodSync, mkdirSync, openSync, closeSync, renameSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { inboxFileName, WechatStore, type InboundRecord } from "../channel-wechat/store.ts";
import { readAttachment } from "../runtime/registry.ts";
import { masterAddress } from "../runtime/address.ts";
import { newOutboxItem, outboxDir, outboxItemId, writeOutboxItem } from "../runtime/message-outbox.ts";
import { sessionAlive, defaultTimersDir } from "../timers.ts";
import { classifyRemoteCommand } from "../runtime/wechat-remote-command.ts";
import { readWechatInputConfig, readWechatCreds, readWechatRemoteCommandConfig, wechatCredsPath } from "./wechat-bind.ts";

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
 const pending=store.readInbox(0).filter(x=>x.state==="pending").sort((a,b)=>a.receivedAt.localeCompare(b.receivedAt)||a.msgId.localeCompare(b.msgId));
 if(!pending.length) return {injected:false,reason:"empty"};
 // M2（L4 必须修）：注入点对命令形态 **结构性 fail-closed**。能力开启
 // （channels.wechat.remoteCommands.enabled===true）时，命令形态记录绝不走注入路——
 // 不改终态、不写 outbox，留给旁挂消费端（wechat-command-consumer）处理。这样裁定③不靠
 // “消费端抢跑 200ms”：冷启动 5s 窗口 / 会话门失败（not-owner、subagent）/ dedupe 重投窗口下，
 // 即使消费端不在线，命令也不会被当普通文本注入。按序跳过（不选它、继续找下一条）
 // 而非直接返回，避免一条滞留命令饿死其后的普通文本。
 let gate=false; try{ gate=readWechatRemoteCommandConfig(opts.configPath).enabled===true; }catch{ gate=false; }
 let skipped=0; let record:InboundRecord|undefined;
 for(const rec of pending){ if(gate&&classifyRemoteCommand(rec.text).kind!=="not-command"){ skipped++; continue; } record=rec; break; }
 const dir=WechatStore.resolveDir(opts.runtimeDir);
 const ownerOpenId = readWechatCreds(wechatCredsPath(opts.runtimeDir))?.ownerOpenId;
 const allowlisted=(r:InboundRecord):boolean=>Boolean(r.fromId)&&(r.fromId===ownerOpenId||config.allowFrom.includes(r.fromId));
 if(!record){
  if(skipped){
   // 轴一先判（与今天口径一致）：非白名单的命令形态记录仍交回 not-allowlisted rejected
   const first=pending[0]!;
   if(!allowlisted(first)){ try { atomicRecord(dir,{...first,state:"rejected",rejectedReason:"not-allowlisted"}); } catch {} audit(opts.runtimeDir,{at:(opts.now??new Date()).toISOString(),msgId:mask(first.msgId),from:mask(first.fromId),ownerSid:"",generation:0,decision:"denied",reason:"not-allowlisted"}); return {injected:false,reason:"not-allowlisted"}; }
   audit(opts.runtimeDir,{at:(opts.now??new Date()).toISOString(),msgId:mask(first.msgId),from:mask(first.fromId),ownerSid:"",generation:0,decision:"skipped",reason:"command-shaped",count:skipped});
   return {injected:false,reason:"command-shaped"};
  }
  return {injected:false,reason:"empty"};
 }
 const at=(opts.now??new Date()).toISOString();
 const base={at,msgId:mask(record.msgId),from:mask(record.fromId),ownerSid:"",generation:0};
 if(!allowlisted(record)) { try { atomicRecord(dir,{...record,state:"rejected",rejectedReason:"not-allowlisted"}); } catch {} audit(opts.runtimeDir,{...base,decision:"denied",reason:"not-allowlisted"}); return {injected:false,reason:"not-allowlisted"}; }
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
  atomicRecord(dir,updated);
  audit(opts.runtimeDir,{...base,decision:"accepted",reason:"injected",ownerSid:owner.sessionId.slice(0,12),generation:owner.generation,outboxId:item.id});
  return {injected:true};
 } catch { try { atomicRecord(dir,{...record,state:"rejected",rejectedReason:"write-failed"}); } catch {} audit(opts.runtimeDir,{...base,decision:"uncertain",reason:"write-failed",ownerSid:before.sessionId.slice(0,12),generation:before.generation}); return {injected:false,reason:"uncertain"}; }
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
