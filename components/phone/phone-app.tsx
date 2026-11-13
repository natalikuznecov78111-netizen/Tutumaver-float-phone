"use client";
import { DEFAULT_PHONE_RINGTONE } from "@/lib/default-notification-sounds";
import {startPhoneAudio,setPhoneSpeaker,finishPhoneAudio,playPhoneAudio,hasNativePhoneAudio} from '@/lib/phone-audio';
import {takePhoneOpening} from '@/lib/phone-opening';
import { AudioSourcePicker } from "@/components/audio-source-picker";
import { isRingtoneSource } from "@/lib/ringtone-source";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, Clock3, ContactRound, Delete, Keyboard, MicOff, Volume2, MessageSquare, RotateCw, Send, Phone, PhoneOff, Search, Settings2, Star, Trash2, X } from "lucide-react";
import { loadCharacters, CHARACTERS_UPDATED_EVENT } from "@/lib/character-storage";
import { loadSms, smsContactDisplayName, SMS_EVENT } from "@/lib/sms-storage";
import { resolveUserIdentity } from "@/lib/settings-storage";
import { findChatSessionById, loadChatContacts, loadChatSessions } from "@/lib/chat-storage";
import { resolveChatCharacterAvatar } from "@/lib/chat-profile-storage";
import { resolveVoiceConfig, resolveUserVoiceConfig, synthesizeSpeech, playAudioBlobViaMediaElement } from "@/lib/tts-service";
import {Call039Transcript,type Call039Command} from "@/components/chat/call039-transcript";
import type {Call039Line} from "@/components/chat/call039-shared-ui";
import {VoiceFavoriteDialog} from "@/components/chat/voice-favorite-dialog";
import { loadMediaBlob, storeMediaBlob } from "@/lib/media-cache-storage";
import { decidePhoneAnswer, generatePhoneReply, queuePhoneUserLine } from "@/lib/phone-engine";
import {
  appendPhoneCall,
  getCharacterPhoneNumber,
  getUserPhoneNumber,
  loadPhoneState,
  markMissedCallsSeen,
  savePhoneState,
  PHONE_EVENT,
  phoneId,
  setUserPhoneNumber,
  setCharacterPhoneNumber,
  togglePhoneFavorite,
  removePhoneCall,
  type PhoneCallRecord,
  type PhoneTranscriptLine,
} from "@/lib/phone-storage";
import styles from "./phone-app.module.css";
import { CommunicationSettings } from "@/components/communication-settings";
import { communicationBusy, setCommunicationCallActive } from "@/lib/communication-policy";
import { PhoneFavoriteReplay } from "./phone-favorite-replay";

const DEFAULT_CONTACT_AVATAR = "/images/default-contact-avatar.jpg";

type Tab = "favorites" | "recents" | "contacts" | "keypad";
type CallPhase = "ringing" | "incoming" | "connected" | "ended";

type ActiveCall = {
  id: string;
  characterId: string;
  number: string;
  direction: "incoming" | "outgoing";
  startedAt: number;
  connectedAt?: number;
  phase: CallPhase;
  status?: PhoneCallRecord["status"];
  transcript: PhoneTranscriptLine[];
};

function fmtDuration(sec: number) {
  const m = Math.floor(sec / 60).toString().padStart(2, "0");
  const s = Math.max(0, sec % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}
function fmtRecent(ts: number) {
  const d = new Date(ts); const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

export function PhoneApp({ onClose, onNotice }: { onClose: () => void; onNotice?: (text: string) => void }) {
  const [tab, setTab] = useState<Tab>("recents");
  const [showPhoneSettings, setShowPhoneSettings] = useState(false);
  const [ringtoneDraft, setRingtoneDraft] = useState(() => loadPhoneState().ringtoneUrl || "");
  const [ringtoneEnabled, setRingtoneEnabled] = useState(() => loadPhoneState().ringtoneEnabled !== false);
  const [revision, setRevision] = useState(0);
  const [query, setQuery] = useState("");
  const [recentFilter, setRecentFilter] = useState<"all" | "missed">("all");
  const [expandedFavoriteId, setExpandedFavoriteId] = useState<string | null>(null);
  const [dial, setDial] = useState("");
  const [editingMe, setEditingMe] = useState(false);
  const [myNumberDraft, setMyNumberDraft] = useState(getUserPhoneNumber());
  const [editingCharacterId, setEditingCharacterId] = useState<string | null>(null);
  const [characterNumberDraft, setCharacterNumberDraft] = useState("");
  const [activeCall, setActiveCall] = useState<ActiveCall | null>(null);
  const [speaker,setSpeaker]=useState(false);
  const [inputOpen,setInputOpen]=useState(false);
  const openedRef=useRef(new Set<string>());
  const speechRun=useRef(0);
  const [typed, setTyped] = useState("");
  const [queued, setQueued] = useState(0);
  const [busy, setBusy] = useState(false);
  const [uiHidden, setUiHidden] = useState(false);
  const [playing039,setPlaying039]=useState<string|null>(null);
  const [favorite039,setFavorite039]=useState<PhoneTranscriptLine|null>(null);
  const rerollStart039=useRef<number|null>(null);
  const [elapsed, setElapsed] = useState(0);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const activeCallRef = useRef<ActiveCall | null>(null);
  const startOutgoingRef = useRef<((characterId: string) => Promise<void>) | null>(null);
  const audioAbortRef = useRef<(() => void) | null>(null);
  const characters = useMemo(() => loadCharacters(), [revision]);
  const calls = useMemo(() => loadPhoneState().calls, [revision]);
  const sms = useMemo(() => loadSms(), [revision]);

  useEffect(() => { activeCallRef.current = activeCall;setCommunicationCallActive(activeCall&&activeCall.phase!=="ended"?activeCall.characterId:null);return()=>setCommunicationCallActive(null); }, [activeCall]);
  useEffect(() => { if (tab === "recents") markMissedCallsSeen(); }, [tab, revision]);
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("phone-call-state", { detail: activeCall?.phase === "connected"
      ? { active: true, characterId: activeCall.characterId, connectedAt: activeCall.connectedAt }
      : { active: false } }));
    return () => { window.dispatchEvent(new CustomEvent("phone-call-state", { detail: { active: false } })); };
  }, [activeCall?.phase, activeCall?.characterId, activeCall?.connectedAt]);
  useEffect(() => {
    const refresh = () => setRevision(v => v + 1);
    window.addEventListener(PHONE_EVENT, refresh); window.addEventListener(SMS_EVENT, refresh); window.addEventListener(CHARACTERS_UPDATED_EVENT, refresh);
    return () => { window.removeEventListener(PHONE_EVENT, refresh); window.removeEventListener(SMS_EVENT, refresh); window.removeEventListener(CHARACTERS_UPDATED_EVENT, refresh); };
  }, []);
  useEffect(() => {
    if (!activeCall?.connectedAt || activeCall.phase !== "connected") return;
    const tick = () => setElapsed(Math.floor((Date.now() - activeCall.connectedAt!) / 1000));
    tick(); const id = window.setInterval(tick, 1000); return () => window.clearInterval(id);
  }, [activeCall?.connectedAt, activeCall?.phase]);
  useEffect(() => {
    if (!uiHidden && transcriptRef.current) transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
  }, [activeCall?.transcript.length, uiHidden]);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { sessionId?: string; answered?: boolean } | undefined;
      const session = detail?.sessionId ? findChatSessionById(detail.sessionId) : null;
      if (!session?.contactId) return;
      const character = loadCharacters().find(c => c.id === session.contactId);
      if (!character) return;
      const now = Date.now();
      const incoming: ActiveCall = { id: phoneId(), characterId: character.id, number: getCharacterPhoneNumber(character.id), direction: "incoming", startedAt: now, phase: detail?.answered ? "connected" : "incoming", connectedAt: detail?.answered ? now : undefined, transcript: [] };
      activeCallRef.current = incoming; setActiveCall(incoming);
    };
    window.addEventListener("phone-open-incoming", handler);
    return () => window.removeEventListener("phone-open-incoming", handler);
  }, []);

  useEffect(() => {
    const handler = (e: Event) => { const id = String((e as CustomEvent).detail?.characterId || ""); if (id) void startOutgoingRef.current?.(id); };
    window.addEventListener("phone-start-outgoing", handler); return () => window.removeEventListener("phone-start-outgoing", handler);
  }, []);

  const characterById = useCallback((id: string) => characters.find(c => c.id === id), [characters]);
  const aliasFor = useCallback((id: string) => {
    return smsContactDisplayName(id, characterById(id)?.name || "未知号码", sms);
  }, [sms, characterById]);

  const finishCall = useCallback((status: PhoneCallRecord["status"] = "completed") => {
    const call = activeCallRef.current; if (!call) return;
    speechRun.current++;audioAbortRef.current?.(); audioAbortRef.current = null;void finishPhoneAudio().catch(()=>{});
    const endedAt = Date.now();
    const durationSec = call.connectedAt ? Math.max(0, Math.floor((endedAt - call.connectedAt) / 1000)) : 0;
    appendPhoneCall({ id: call.id, characterId: call.characterId, number: call.number, direction: call.direction, status, startedAt: call.startedAt, connectedAt: call.connectedAt, endedAt, durationSec, transcript: call.transcript, source: "phone" });
    activeCallRef.current={...call,phase:"ended",status};setActiveCall(activeCallRef.current);
    setTimeout(() => { if(activeCallRef.current?.id!==call.id)return;activeCallRef.current=null;setActiveCall(null); setElapsed(0); setTyped(""); setQueued(0); setBusy(false); setUiHidden(false); }, 700);
  }, []);

  const startOutgoing = useCallback(async (characterId: string) => {
    const number = getCharacterPhoneNumber(characterId);
    const call: ActiveCall = { id: phoneId(), characterId, number, direction: "outgoing", startedAt: Date.now(), phase: "ringing", transcript: [] };
    activeCallRef.current = call; setActiveCall(call); setElapsed(0); setBusy(true);
    const decision = await decidePhoneAnswer(characterId);
    if (!activeCallRef.current || activeCallRef.current.id !== call.id || activeCallRef.current.phase!=="ringing") return;
    if (decision === "answer") {
      setActiveCall(prev => prev ? { ...prev, phase: "connected", connectedAt: Date.now() } : prev); setBusy(false); return;
    }
    setBusy(false); finishCall(decision === "busy" ? "busy" : decision === "decline" ? "declined" : "missed");
  }, [finishCall]);

  useEffect(() => { startOutgoingRef.current = startOutgoing; }, [startOutgoing]);

  const acceptIncoming = useCallback(() => setActiveCall(prev => { const next = prev ? { ...prev, phase: "connected" as const, connectedAt: Date.now() } : prev; activeCallRef.current = next; return next; }), []);

  const busyDeparture = useRef<string>("");
  const summonRef = useRef<() => Promise<void>>(async()=>{});
  useEffect(()=>{if(activeCall?.phase!=="connected")return;const timer=setInterval(()=>{const call=activeCallRef.current;if(!call||call.phase!=="connected"||busy)return;const active=communicationBusy("phone",call.characterId);const key=`${call.id}:${active?.item.id}`;if(active&&active.level>=3&&busyDeparture.current!==key){busyDeparture.current=key;void summonRef.current();}},5000);return()=>clearInterval(timer);},[activeCall?.phase,busy]);
  const sendTyped = useCallback(() => {
    const text = typed.trim(); const call = activeCallRef.current;
    if (!text || !call || call.phase !== "connected" || busy) return;
    const line = queuePhoneUserLine(call.characterId, text);
    const next = { ...call, transcript: [...call.transcript, line] };
    activeCallRef.current = next; setActiveCall(next);
    setTyped(""); setQueued(v => v + 1);
  }, [typed, busy]);

  const summon = useCallback(async () => {
    const call = activeCallRef.current; if (!call || call.phase !== "connected" || busy) return;
    if(call.direction==="outgoing"&&!call.transcript.some(l=>l.role==="user")){onNotice?.("你拨出的电话，由你先说第一句");setInputOpen(true);return;}
    const generation=++speechRun.current;
    setBusy(true);
    try {
      const rerollAt=rerollStart039.current;
      const result = await generatePhoneReply(call.characterId, rerollAt===null?call.transcript:call.transcript.slice(0,rerollAt));
      if(!result.lines.length)throw new Error("没有生成回复，原有台词已保留");
      if(rerollAt!==null&&activeCallRef.current?.id===call.id){
        const kept={...activeCallRef.current,transcript:activeCallRef.current.transcript.slice(0,rerollAt)};
        activeCallRef.current=kept;setActiveCall(kept);
      }
      rerollStart039.current=null;
      const batchId=phoneId("call_reply_batch");
      for (const reply of result.lines) {
        if (generation!==speechRun.current||activeCallRef.current?.id !== call.id || activeCallRef.current.phase !== "connected") break;
        const line: PhoneTranscriptLine = { id: reply.id, role: "assistant", original: reply.original, translated: reply.translated, createdAt: Date.now(), batchId };
        // Show original and translation immediately; TTS runs afterward and reads only original.
        const current = activeCallRef.current;
        if (current?.id !== call.id) break;
        const updated = { ...current, transcript: [...current.transcript, line] };
        activeCallRef.current = updated; setActiveCall(updated);
        // Never synthesize during generation. Only the bubble Play control triggers TTS.
      }
      setQueued(0);
      if (generation===speechRun.current&&result.hangup && activeCallRef.current?.id === call.id) setTimeout(() => {if(activeCallRef.current?.id===call.id&&activeCallRef.current.phase==="connected")finishCall("completed");}, 250);
    } catch (e) { onNotice?.(e instanceof Error ? e.message : "电话回复失败"); if(activeCallRef.current?.id===call.id&&(communicationBusy("phone",call.characterId)?.level||1)>=3)finishCall("completed"); }
    finally { if(generation===speechRun.current)setBusy(false); }
  }, [busy, onNotice, finishCall]);
  summonRef.current = summon;

  useEffect(()=>{
    if(activeCall?.phase!=="connected")return;
    const id=activeCall.id;
    void startPhoneAudio().then(state=>{if(activeCallRef.current?.id===id)setSpeaker(state.speaker);}).catch(e=>onNotice?.(String(e)));
    return()=>{audioAbortRef.current?.();void finishPhoneAudio().catch(()=>{});};
  },[activeCall?.id,activeCall?.phase]);
  useEffect(()=>{
    const call=activeCall;if(!call||call.phase!=="connected"||openedRef.current.has(call.id))return;
    openedRef.current.add(call.id);setInputOpen(call.direction==="outgoing");
    if(call.direction!=="incoming")return;
    const token=++speechRun.current;setBusy(true);
    void (async()=>{
      try{
        const session=loadChatSessions().find(s=>!s.isGroup&&s.contactId===call.characterId);
        const reply=await takePhoneOpening(session?.id||call.characterId,call.characterId);
        if(speechRun.current!==token||activeCallRef.current?.id!==call.id||activeCallRef.current.phase!=="connected")return;
        const line:PhoneTranscriptLine={...reply,role:"assistant",createdAt:Date.now()};
        const next={...activeCallRef.current,transcript:[...activeCallRef.current.transcript,line]};activeCallRef.current=next;setActiveCall(next);
        // Incoming-call opening text is shown immediately; voice remains on-demand.
      }catch(e){onNotice?.(e instanceof Error?e.message:"开场语音失败，可点击重回重试");}
      finally{if(speechRun.current===token)setBusy(false);}
    })();
  },[activeCall?.id,activeCall?.phase]);
  const replayLine039=async(line:PhoneTranscriptLine)=>{
    if(playing039===line.id){audioAbortRef.current?.();audioAbortRef.current=null;setPlaying039(null);return;}
    audioAbortRef.current?.();
    const call=activeCallRef.current;if(!call||call.phase!=="connected")return;
    const voice=line.role==="user"?resolveUserVoiceConfig():resolveVoiceConfig(call.characterId,"chat");
    if(!voice){onNotice?.(line.role==="user"?"请先设置用户语音配置":"请先给角色绑定语音配置");return;}
    try{
      setPlaying039(line.id);
      let blob=line.audioRef?(await loadMediaBlob(line.audioRef))?.blob:undefined;
      if(!blob){
        blob=await synthesizeSpeech(line.original,voice)||undefined;
        if(!blob)throw new Error("语音合成未返回音频");
        const audioRef=await storeMediaBlob(blob,blob.type||"audio/mpeg","audio");
        const latest=activeCallRef.current;
        if(latest?.id===call.id){
          const next={...latest,transcript:latest.transcript.map(item=>item.id===line.id?{...item,audioRef}:item)};
          activeCallRef.current=next;setActiveCall(next);
        }
      }
      if(activeCallRef.current?.id!==call.id||activeCallRef.current.phase!=="connected")return;
      const playing=playPhoneAudio(blob);audioAbortRef.current=playing.abort;await playing.promise;
    }catch(e){onNotice?.(e instanceof Error?e.message:"本句语音播放失败");}
    finally{audioAbortRef.current=null;setPlaying039(null);}
  };
  const phone039Edit=(line:Call039Line,original:string,translated:string)=>{
    const call=activeCallRef.current;if(!call)return;
    const updated={...call,transcript:call.transcript.map(item=>item.id===line.id?
      {...item,original,translated:translated||undefined,audioRef:item.original===original?item.audioRef:undefined}:item)};
    activeCallRef.current=updated;setActiveCall(updated);
  };
  const phone039Action=(cmd:Call039Command,line:Call039Line)=>{
    if(busy)return;
    const call=activeCallRef.current;if(!call)return;const idx=call.transcript.findIndex(item=>item.id===line.id);if(idx<0)return;
    if(cmd==="favorite"){setFavorite039(call.transcript[idx]);return;}
    if(cmd==="delete"||cmd==="delete-after"){
      const updated={...call,transcript:cmd==="delete"?call.transcript.filter(x=>x.id!==line.id):call.transcript.slice(0,idx+1)};
      activeCallRef.current=updated;setActiveCall(updated);return;
    }
    let start=idx+1;
    if(cmd==="reroll-batch"){
      const batch=call.transcript[idx].batchId;
      if(batch)start=call.transcript.findIndex(x=>x.batchId===batch);
      else{start=idx;while(start>0&&call.transcript[start-1].role==="assistant")start--;}
    }
    rerollStart039.current=start;void summonRef.current();
  };

  // Keep historical call replay / legacy command entry points functional.
  const replayLine=async(line:PhoneTranscriptLine)=>{
    if(!line.audioRef)return;const media=await loadMediaBlob(line.audioRef);
    if(media)await playPhoneAudio(media.blob).promise;
  };
  const regenerateLast=()=>{
    const call=activeCallRef.current;if(!call||busy)return;
    const idx=call.transcript.map(line=>line.role).lastIndexOf("user");
    rerollStart039.current=idx+1;void summonRef.current();
  };

  if (activeCall) {
    const name=aliasFor(activeCall.characterId);
    const connected=activeCall.phase==="connected";
    return <div className={`${styles.callScreen} ${styles.phone039Call}`}>
      <div className={styles.callBackdrop}/>
      <div className={styles.callTint}/>
      {favorite039&&<VoiceFavoriteDialog key={favorite039.id}
        draft={{kind:"call",sourceKey:`phone:${activeCall.id}:${favorite039.id}`,text:favorite039.original,
          characterId:activeCall.characterId,role:favorite039.role,getAudio:async()=>favorite039.audioRef?(await loadMediaBlob(favorite039.audioRef))?.blob:undefined}}
        onClose={()=>setFavorite039(null)}/>}
      <div className={styles.callTop}>
        <div className={styles.callStatus}>{activeCall.phase==="incoming"?"来电":activeCall.phase==="ringing"?"正在呼叫…":activeCall.phase==="ended"?"通话已结束":fmtDuration(elapsed)}</div>
        <div className={styles.callName}>{name}</div>
        <div className={styles.callSubtitle}>{resolveVoiceConfig(activeCall.characterId,"chat")?"语音已接入":"文字通话 · 未接入语音"}</div>
      </div>
      {connected&&!uiHidden&&<div className={styles.phone039Conversation}>
        <div className={styles.phone039Transcript} ref={transcriptRef}>
          <Call039Transcript lines={activeCall.transcript.map(line=>({id:line.id,role:line.role,kind:"speech" as const,
            text:line.original+(line.translated?" | "+line.translated:"")}))}
            playingId={playing039} onPlay={line=>{const current=activeCallRef.current?.transcript.find(x=>x.id===line.id);if(current)void replayLine039(current);}}
            onEdit={phone039Edit} onCommand={phone039Action}/>
          {busy&&<div className={styles.callWait}>对方正在回应…</div>}
        </div>
        <div className={styles.phone039InputRow}>
          <input autoFocus aria-label="电话语言输入" placeholder="输入你想说的话，回车发送…"
            value={typed} onChange={e=>setTyped(e.target.value)}
            onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();sendTyped();}}}/>
          <button type="button" onClick={()=>void summon()} disabled={busy} aria-label="召唤角色继续">↑</button>
        </div>
        {queued>0&&<div className={styles.phone039Queued}>已发送{queued}条 · ↑召唤回复</div>}
      </div>}
      <div className={styles.phone039Controls}>
        {activeCall.phase==="incoming"?<>
          <button className={`${styles.phone039Round} ${styles.phone039Hang}`} aria-label="拒接" onClick={()=>finishCall("declined")}><PhoneOff size={29}/></button>
          <button className={`${styles.phone039Round} ${styles.phone039Accept}`} aria-label="接听" onClick={acceptIncoming}><Phone size={29}/></button>
        </>:connected?<>
          <div><button className={styles.phone039Round} data-active={speaker?"1":"0"} aria-label={speaker?"切换听筒":"开启免提"}
              disabled={!hasNativePhoneAudio()} onClick={()=>{void setPhoneSpeaker(!speaker).then(state=>setSpeaker(state.speaker)).catch(e=>onNotice?.(String(e)));}}>
              <Volume2 size={26}/></button><span>免提</span></div>
          <div><button className={`${styles.phone039Round} ${styles.phone039Hang}`} aria-label="挂断" onClick={()=>finishCall("completed")}><PhoneOff size={28}/></button><span>结束</span></div>
          <div><button className={styles.phone039Round} data-active={!uiHidden?"1":"0"} aria-label={uiHidden?"显示台词和输入":"隐藏台词和输入"}
             onClick={()=>setUiHidden(v=>!v)}><MessageSquare size={26}/></button><span>台词</span></div>
        </>:<button className={`${styles.phone039Round} ${styles.phone039Hang}`} aria-label="取消呼叫"
            onClick={()=>finishCall(activeCall.phase==="ringing"?"canceled":"completed")}><PhoneOff size={29}/></button>}
      </div>
    </div>;
  }

  const filteredChars = characters.filter(c => !query.trim() || `${aliasFor(c.id)} ${getCharacterPhoneNumber(c.id)}`.toLowerCase().includes(query.trim().toLowerCase()));
  const filteredCalls = calls.filter(c => (recentFilter === "all" || c.status === "missed") && (!query.trim() || `${aliasFor(c.characterId)} ${c.number}`.toLowerCase().includes(query.trim().toLowerCase())));
  const favoriteCalls = calls.filter(c => c.favorite);
  const normalizedDial = dial.replace(/\D/g, "");
  const dialCandidates = normalizedDial.length >= 2 ? characters.filter(c => {
    const number = getCharacterPhoneNumber(c.id);
    return number && number.replace(/\D/g, "").includes(normalizedDial);
  }).slice(0, 5) : [];
  const matchDial = normalizedDial ? characters.find(c => getCharacterPhoneNumber(c.id).replace(/\D/g, "") === normalizedDial) : undefined;

  return <div className={styles.app}>
    <header className={styles.header}><button className={styles.backButton} aria-label="返回桌面" title="返回桌面" onClick={onClose}><ChevronLeft size={22}/></button><span>电话</span><button className={styles.backButton} aria-label="电话设置" title="电话设置" onClick={()=>{setRingtoneDraft(loadPhoneState().ringtoneUrl || "");setRingtoneEnabled(loadPhoneState().ringtoneEnabled !== false);setShowPhoneSettings(true)}}><Settings2 size={19}/></button></header>
    <main className={styles.main}>
      {tab === "recents" && <section><div className={styles.segment}><button className={recentFilter==="all"?styles.activeSeg:undefined} onClick={()=>setRecentFilter("all")}>所有通话</button><button className={recentFilter==="missed"?styles.activeSeg:undefined} onClick={()=>setRecentFilter("missed")}>未接来电</button></div><h1>最近通话</h1><div className={styles.search}><Search size={17}/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="搜索" /></div><div className={styles.list}>{filteredCalls.map(call => <div className={styles.row} key={call.id} onClick={()=>startOutgoing(call.characterId)}><div className={styles.avatar}><img src={DEFAULT_CONTACT_AVATAR} alt=""/></div><div className={styles.rowText}><strong className={call.status === "missed" ? styles.missed : undefined}>{aliasFor(call.characterId)}</strong><span>{call.direction === "incoming" ? "来电" : "去电"}{call.status !== "completed" ? ` · ${call.status === "missed" ? "未接" : call.status === "busy" ? "忙线" : call.status === "declined" ? "已拒绝" : "已取消"}` : call.durationSec ? ` · ${fmtDuration(call.durationSec)}` : ""}</span></div><span className={styles.time}>{fmtRecent(call.startedAt)}</span><button className={styles.infoBtn} onClick={e=>{e.stopPropagation(); togglePhoneFavorite(call.id)}} aria-label={call.favorite ? "取消收藏" : "收藏通话"}><Star fill={call.favorite ? "currentColor" : "none"} size={17}/></button><button className={styles.deleteCallBtn} onClick={e=>{e.stopPropagation(); removePhoneCall(call.id)}} aria-label="删除通话记录"><Trash2 size={17}/></button></div>)}</div></section>}
      {tab === "contacts" && <section><h1>通讯录</h1><div className={styles.search}><Search size={17}/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="搜索" /></div><button className={styles.meCard} onClick={()=>{setMyNumberDraft(getUserPhoneNumber());setEditingMe(true)}}><div className={styles.meAvatar}><img src={DEFAULT_CONTACT_AVATAR} alt=""/></div><div><strong>{resolveUserIdentity(characters[0]?.id || "", "chat")?.name || "我的名片"}</strong><span>{getUserPhoneNumber() || "点击填写我的电话号码"}</span></div></button><div className={styles.list}>{filteredChars.map(c=><div className={styles.row} key={c.id} onClick={()=>{setEditingCharacterId(c.id);setCharacterNumberDraft(getCharacterPhoneNumber(c.id));}}><div className={styles.avatar}><img src={DEFAULT_CONTACT_AVATAR} alt=""/></div><div className={styles.rowText}><strong>{aliasFor(c.id)}</strong><span>{getCharacterPhoneNumber(c.id)||"未设置号码 · 点击编辑"}</span></div><button className={styles.phoneMini} onClick={e=>{e.stopPropagation();startOutgoing(c.id)}} disabled={!getCharacterPhoneNumber(c.id)}><Phone size={18}/></button></div>)}</div></section>}
      {tab === "favorites" && <section><h1>个人收藏</h1><p className={styles.subtle}>点开回放，上下滑动查看双方的对话；滑到角色那句时播放已保存的语音。</p><div className={styles.list}>{favoriteCalls.map(call=><div className={styles.favoriteGroup} key={call.id}><div className={`${styles.favoriteCard} ${expandedFavoriteId===call.id ? styles.favoriteCardExpanded : ""}`}><div><strong>{aliasFor(call.characterId)}</strong><span>{new Date(call.startedAt).toLocaleString("zh-CN")} · {fmtDuration(call.durationSec)}</span></div><button onClick={()=>setExpandedFavoriteId(id=>id===call.id?null:call.id)} aria-expanded={expandedFavoriteId===call.id} aria-controls={`phone-replay-${call.id}`}>{expandedFavoriteId===call.id?"收起":"回放"}</button>{expandedFavoriteId!==call.id && <><button onClick={()=>togglePhoneFavorite(call.id)} aria-label="取消收藏"><Star fill="currentColor" size={18}/></button><button className={styles.favoriteDelete} onClick={()=>removePhoneCall(call.id)} aria-label="删除通话记录"><Trash2 size={18}/></button></>}</div>{expandedFavoriteId===call.id && <PhoneFavoriteReplay call={call} name={aliasFor(call.characterId)} userName={resolveUserIdentity(call.characterId, "chat")?.name?.trim() || "我"} onUnfavorite={()=>{setExpandedFavoriteId(null);togglePhoneFavorite(call.id)}} onDelete={()=>{setExpandedFavoriteId(null);removePhoneCall(call.id)}} />}</div>)}</div></section>}
      {tab === "keypad" && <section className={styles.keypadPage}><div className={styles.dialDisplay}>{dial || " "}</div><button className={styles.addNumber}>添加号码</button>{dialCandidates.length > 0 && !matchDial && <div className={styles.dialSuggestions}>{dialCandidates.map(c=><button key={c.id} onClick={()=>setDial(getCharacterPhoneNumber(c.id))}><span className={styles.suggestionAvatar}><img src={DEFAULT_CONTACT_AVATAR} alt=""/></span><span><strong>{aliasFor(c.id)}</strong><small>{getCharacterPhoneNumber(c.id)}</small></span></button>)}</div>}{matchDial && <div className={styles.dialMatch}>{aliasFor(matchDial.id)} · {getCharacterPhoneNumber(matchDial.id)}</div>}<div className={styles.keypad}>{[["1",""],["2","ABC"],["3","DEF"],["4","GHI"],["5","JKL"],["6","MNO"],["7","PQRS"],["8","TUV"],["9","WXYZ"],["*",""],["0","+"],["#",""]].map(([n,l])=><button key={n} onClick={()=>setDial(v=>v+n)}><strong>{n}</strong><span>{l}</span></button>)}</div><div className={styles.keypadBottom}><span/><button className={styles.callKey} disabled={!matchDial} onClick={()=>matchDial&&startOutgoing(matchDial.id)}><Phone/></button><button className={styles.deleteKey} onClick={()=>setDial(v=>v.slice(0,-1))}><Delete/></button></div></section>}
    </main>
    <nav className={styles.tabs}><button className={tab==="favorites"?styles.selected:undefined} onClick={()=>setTab("favorites")}><Star/><span>个人收藏</span></button><button className={tab==="recents"?styles.selected:undefined} onClick={()=>setTab("recents")}><Clock3/><span>最近通话</span></button><button className={tab==="contacts"?styles.selected:undefined} onClick={()=>setTab("contacts")}><ContactRound/><span>通讯录</span></button><button className={tab==="keypad"?styles.selected:undefined} onClick={()=>setTab("keypad")}><Keyboard/><span>拨号键盘</span></button></nav>
    {showPhoneSettings && <div className={styles.modal} role="dialog" aria-modal="true" aria-label="电话设置"><div className={styles.modalCard}><button className={styles.modalClose} onClick={()=>setShowPhoneSettings(false)} aria-label="关闭"><X/></button><h2>电话设置</h2><CommunicationSettings channel="phone"/><label className={styles.settingsToggleRow}><span>来电声音</span><input className={styles.settingsSwitch} type="checkbox" role="switch" aria-label="来电声音" checked={ringtoneEnabled} onChange={e=>setRingtoneEnabled(e.target.checked)}/></label><AudioSourcePicker defaultValue={DEFAULT_PHONE_RINGTONE} label="来电铃声" value={ringtoneDraft} onChange={setRingtoneDraft} onNotice={onNotice} defaultHint="保存后生效；恢复默认后使用电话的内置来电铃声。"/><button className={styles.saveBtn} onClick={()=>{const url=ringtoneDraft.trim();if(url && !isRingtoneSource(url)){onNotice?.("请填写 http 或 https 音频地址");return;}const next=loadPhoneState();next.ringtoneUrl=url;next.ringtoneEnabled=ringtoneEnabled;savePhoneState(next);setShowPhoneSettings(false)}}>保存</button></div></div>}
    {editingMe && <div className={styles.modal}><div className={styles.modalCard}><button className={styles.modalClose} onClick={()=>setEditingMe(false)}><X/></button><h2>我的名片</h2><label>电话号码<input value={myNumberDraft} onChange={e=>setMyNumberDraft(e.target.value)} placeholder="例如 +86 138 0000 0000"/></label><p className={styles.modalHint}>这里与 SMS 的真实号码共用同一份数据，保存后两边同步。</p><button className={styles.saveBtn} onClick={()=>{setUserPhoneNumber(myNumberDraft);setEditingMe(false)}}>保存</button></div></div>}
    {editingCharacterId && <div className={styles.modal}><div className={styles.modalCard}><button className={styles.modalClose} onClick={()=>setEditingCharacterId(null)}><X/></button><h2>{aliasFor(editingCharacterId)}</h2><label>电话号码<input value={characterNumberDraft} onChange={e=>setCharacterNumberDraft(e.target.value.replace(/\D/g, ""))} placeholder="输入角色电话号码"/></label><p className={styles.modalHint}>Phone 与 SMS 共用这个号码；在任一处修改，另一边都会同步显示。</p><button className={styles.saveBtn} onClick={()=>{setCharacterPhoneNumber(editingCharacterId,characterNumberDraft);setEditingCharacterId(null)}}>保存</button></div></div>}
  </div>;
}
