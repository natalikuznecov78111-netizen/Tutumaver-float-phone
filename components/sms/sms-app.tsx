"use client";
import { DEFAULT_SMS_SOUND } from "@/lib/default-notification-sounds";
import { AudioSourcePicker } from "@/components/audio-source-picker";

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ArrowLeft, Ban, Check, ChevronRight, Copy, ImagePlus, MoreHorizontal, Pencil, Phone, Plus, Search, Settings2, ShieldOff, Video, AudioLines, X, Trash2, RotateCcw } from "lucide-react";
import { loadCharacters } from "@/lib/character-storage";
import { smsContactAlias, smsContactDisplayName, setSmsContactAlias, addSmsMessage, createVirtualIdentity, ensureSmsThread, getSmsThreadUnreadCount, markSmsThreadRead, loadSms, saveSms, phoneFromPersona, smsId, SMS_EVENT, SMS_REGIONS, DEFAULT_SMS_EMOJI, type SmsMessage, type SmsState, type SmsThread } from "@/lib/sms-storage";
import { getCharacterPhoneNumber, setCharacterPhoneNumber } from "@/lib/phone-storage";
import { generateSmsReply } from "@/lib/sms-engine";
import { chatStatus } from "@/lib/sms-continuity";
import styles from "./sms-app.module.css";
import { CommunicationSettings } from "@/components/communication-settings";
import { communicationBusy, queueBusySms } from "@/lib/communication-policy";
import { chooseBusyResumeAt } from "@/lib/chat-busy-hold";

const isEmoji = (value: string) => /[\p{Extended_Pictographic}\p{Regional_Indicator}]/u.test(value) && Array.from(value).length <= 16;
const date = (n: number) => new Date(n).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
const clock = (n: number) => new Date(n).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
const stamp = (n: number) => {
  const d = new Date(n), now = new Date();
  if (d.toDateString() === now.toDateString()) return `Today ${clock(n)}`;
  return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,"0")}/${String(d.getDate()).padStart(2,"0")} ${clock(n)}`;
};
const separated = (current: SmsMessage, previous?: SmsMessage) => !previous || new Date(current.createdAt).toDateString() !== new Date(previous.createdAt).toDateString() || current.createdAt - previous.createdAt >= 20*60_000;

type Reply = Awaited<ReturnType<typeof generateSmsReply>>;
export function SmsApp({ onClose, onNotice, initialThreadId }: { onClose: () => void; onNotice?: (text: string) => void; initialThreadId?: string | null }) {
  const [state, setState] = useState<SmsState>(() => loadSms());
  const [route, setRoute] = useState<"list" | "compose" | "chat" | "detail" | "settings">(initialThreadId ? "chat" : "list");
  const [selected, setSelected] = useState<string | null>(initialThreadId || null);
  const [characterId, setCharacterId] = useState("");
  const [identityId, setIdentityId] = useState("real");
  const [region, setRegion] = useState("KR");
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [menu, setMenu] = useState(false);
  const [settingsReturn, setSettingsReturn] = useState<"list" | "compose" | "chat" | "detail">("list");
  const [editing, setEditing] = useState(false);
  const [selectedRows, setSelectedRows] = useState<string[]>([]);
  const [tray, setTray] = useState(false);
  const [pickedEmoji, setPickedEmoji] = useState("");
  const [emojiDraft, setEmojiDraft] = useState("");
  const [manageEmoji, setManageEmoji] = useState(false);
  const [emojiError, setEmojiError] = useState("");
  const [translationExpanded, setTranslationExpanded] = useState<Record<string, boolean>>({});
  const [contextId, setContextId] = useState<string | null>(null);
  const [contextAnchor, setContextAnchor] = useState({ top: 0, left: 0 });
  const [editor, setEditor] = useState<{original:string;translated:string} | null>(null);
  const [contactOpen, setContactOpen] = useState(false);
  const [contactAnchor, setContactAnchor] = useState({top:0,left:0});
  const [contactEdit, setContactEdit] = useState<"alias" | "phone" | null>(null);
  const [contactDraft, setContactDraft] = useState("");
  const [selectingMessages, setSelectingMessages] = useState(false);
  const [selectedMessages, setSelectedMessages] = useState<string[]>([]);
  const backgroundInput = useRef<HTMLInputElement>(null);
  const longPress = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointerOrigin = useRef<{x:number;y:number} | null>(null);
  const skipClick = useRef(false);
  const dragEmoji = useRef("");
  const listRef = useRef<HTMLDivElement>(null);
  const conversationRef = useRef<HTMLDivElement>(null);
  const characters = useMemo(() => loadCharacters(), [route]);
  const selectedThread = state.threads.find(t => t.id === selected) ?? null;
  const messages = state.messages.filter(m => m.threadId === selected);
  const timeMarkers = new Set<string>();
  let lastMarker: SmsMessage | undefined;
  for (const message of messages) { if (separated(message,lastMarker)) { timeMarkers.add(message.id); lastMarker = message; } }
  const contextual = state.messages.find(m => m.id === contextId && m.threadId === selected);
  const name = (thread: SmsThread) => smsContactDisplayName(thread.characterId, characters.find(c => c.id === thread.characterId)?.name || thread.characterNumber || "联系人", state);
  const displayName = (thread: SmsThread) => thread.identityId === "real" ? name(thread) : `${name(thread)} · ${thread.number || "陌生号码"}`;
  const threads = useMemo(() => state.threads.filter(t => state.messages.some(m => m.threadId === t.id)).sort((a,b) => b.updatedAt-a.updatedAt).filter(t => {
    const character = characters.find(c => c.id === t.characterId);
    return `${t.alias ?? ""} ${character?.name ?? ""} ${t.number} ${state.messages.filter(m=>m.threadId===t.id).at(-1)?.original ?? ""}`.toLowerCase().includes(search.toLowerCase());
  }), [state, search, characters]);
  useEffect(() => { const handler = () => setState(loadSms()); window.addEventListener(SMS_EVENT, handler); return () => window.removeEventListener(SMS_EVENT, handler); }, []);
  useEffect(() => {
    if (!initialThreadId || !state.threads.some(thread => thread.id === initialThreadId)) return;
    setSelected(initialThreadId);
    setRoute("chat");
  }, [initialThreadId]);
  useEffect(() => {
    const activeThreadId = route === "chat" ? selected : null;
    window.dispatchEvent(new CustomEvent("sms-active-thread", { detail: { threadId: activeThreadId } }));
    if (activeThreadId) markSmsThreadRead(activeThreadId);
    return () => { window.dispatchEvent(new CustomEvent("sms-active-thread", { detail: { threadId: null } })); };
  }, [route, selected, state.messages.length]);
  useEffect(() => { if (route === "chat" && !contextId) listRef.current?.scrollTo({ top: listRef.current.scrollHeight }); }, [messages.length, selected, route, contextId]);
  useEffect(() => { setTranslationExpanded({}); }, [state.autoExpandTranslation]);
  useEffect(() => () => { if (longPress.current) clearTimeout(longPress.current); }, []);
  function persist(next: SmsState) { saveSms(next); setState({ ...next }); }
  function openSettings(from: "list" | "compose" | "chat" | "detail") { setSettingsReturn(from); setRoute("settings"); }
  function back() { setError(""); setMenu(false); setTray(false); setContactOpen(false); setSelectingMessages(false); setSelectedMessages([]); if (route === "detail") setRoute("chat"); else if (route === "chat" || route === "compose" || route === "settings") setRoute("list"); else onClose(); }
  function start() {
    if (!characterId) return setError("先选择收件人");
    const character = characters.find(c => c.id === characterId);
    if (!character) return;
    const next = loadSms();
    const thread = ensureSmsThread(next, characterId, identityId, getCharacterPhoneNumber(characterId) || "");
    persist(next); setSelected(thread.id); setRoute("chat"); setError(""); setDraft("");
  }
  function applyReply(fresh: SmsState, live: SmsThread, reply: Reply, batchId: string) {
    if (reply.summary) live.summary = reply.summary;
    if (live.identityId !== "real" && reply.awareness) { live.awareness = reply.awareness; live.suspicion = reply.suspicion; }
    if (reply.block) live.blockedByCharacter = true;
    if (!live.blockedByMe) reply.messages.forEach(m => addSmsMessage(fresh, live, "incoming", m.original, m.translated, batchId));
    reply.reactions?.forEach(reaction => { const target = fresh.messages.find(m => m.id === reaction.messageId && m.threadId === live.id && m.direction === "outgoing"); if (target) target.reactions = [...(target.reactions ?? []), { id: smsId(), emoji: reaction.emoji, by: "character" }]; });
  }
  async function summon(threadId: string) {
    const next = loadSms(); const thread = next.threads.find(t => t.id === threadId);
    if (!thread || busy) return;
    setError(""); setBusy(true);
    try {
      if (thread.blockedByCharacter || thread.blockedByMe) return;
      const reply = await generateSmsReply(thread, next, "summon");
      if (reply.deferred || reply.channel==="wait") return;
      if (!reply.messages.length && !reply.block && reply.channel !== "call") return;
      const fresh = loadSms(); const live = fresh.threads.find(t => t.id === threadId);
      if (!live || live.blockedByMe) return;
      applyReply(fresh, live, reply, smsId()); persist(fresh);
      if (reply.channel === "call") window.dispatchEvent(new CustomEvent("phone-request-incoming", { detail: { characterId: live.characterId, source: "sms" } }));
    } catch (e) { setError(e instanceof Error ? e.message : "回复生成失败"); } finally { setBusy(false); }
  }
  function send() {
    if (!selectedThread || !draft.trim()) return;
    const next = loadSms(); const thread = next.threads.find(t => t.id === selectedThread.id);
    if (!thread) return;
    const sent=addSmsMessage(next, thread, "outgoing", draft.trim()); persist(next);
    const active=communicationBusy("sms",thread.characterId);
    if(active&&active.level>1)queueBusySms(thread.id,chooseBusyResumeAt(active),sent.id); setDraft(""); setError("");
  }
  function editMessage() {
    if (!contextual || !editor?.original.trim()) return;
    const next = loadSms(), target = next.messages.find(m => m.id === contextual.id);
    if (!target) return;
    target.original = editor.original.trim();
    target.translated = target.direction === "incoming" ? editor.translated.trim() || undefined : undefined;
    persist(next); setContextId(null); setEditor(null);
  }
  function deleteMessage() {
    if (!contextual) return;
    const next = loadSms(); next.messages = next.messages.filter(m => m.id !== contextual.id);
    const thread = next.threads.find(t => t.id === contextual.threadId);
    if (thread) thread.updatedAt = next.messages.filter(m => m.threadId === thread.id).at(-1)?.createdAt ?? Date.now();
    persist(next); setContextId(null);
  }
  function deleteSelectedMessages() {
    if (!selectedMessages.length || !selected) return;
    if (!window.confirm(`删除选中的 ${selectedMessages.length} 条短信？`)) return;
    const ids = new Set(selectedMessages), next = loadSms();
    next.messages = next.messages.filter(m => m.threadId !== selected || !ids.has(m.id));
    const thread = next.threads.find(t => t.id === selected);
    if (thread) thread.updatedAt = next.messages.filter(m => m.threadId === selected).at(-1)?.createdAt ?? Date.now();
    persist(next); setSelectedMessages([]); setSelectingMessages(false);
  }
  async function copyMessage() {
    if (!contextual) return;
    try { await navigator.clipboard.writeText(contextual.original); setContextId(null); }
    catch { setError("复制失败，请检查浏览器剪贴板权限"); setContextId(null); }
  }
  async function regenerate(scope: "single" | "batch") {
    if (!contextual || busy) return;
    const snapshot = loadSms(), thread = snapshot.threads.find(t => t.id === contextual.threadId);
    if (!thread) return;
    const all = snapshot.messages.filter(m => m.threadId === thread.id);
    const selectedIndex = all.findIndex(m => m.id === contextual.id);
    if (selectedIndex < 0) return;
    const target = contextual.direction === "incoming" ? contextual : all[selectedIndex+1]?.direction === "incoming" ? all[selectedIndex+1] : null;
    if (!target) { setContextId(null);setError("这条短信后还没有角色回复，可以用输入框旁的召唤回复");return; }
    const index = all.findIndex(m => m.id === target.id);
    if (index < 0) return;
    const batchId = target.batchId;
    let start = index, end = index;
    if (scope === "batch") {
      if (batchId) { while (start > 0 && all[start-1].batchId === batchId && all[start-1].direction === "incoming") start--; while (end+1 < all.length && all[end+1].batchId === batchId && all[end+1].direction === "incoming") end++; }
      else { while (start > 0 && all[start-1].direction === "incoming" && !separated(all[start],all[start-1])) start--; while (end+1 < all.length && all[end+1].direction === "incoming" && !separated(all[end+1],all[end])) end++; }
    }
    const targets = all.slice(start,end+1), targetIds = new Set(targets.map(m => m.id));
    // The AI sees exactly the messages that preceded the selected response.
    const preceding = new Set(all.slice(0,start).map(m => m.id));
    const promptState: SmsState = { ...snapshot, messages: snapshot.messages.filter(m => m.threadId !== thread.id || preceding.has(m.id)) };
    const promptThread = { ...thread, awareness: targets[0].awarenessAt ?? (thread.identityId === "real" ? "confirmed" : "unknown"), summary: "" };
    setContextId(null); setError(""); setBusy(true);
    try {
      const reply = await generateSmsReply(promptThread, promptState, "regenerate", scope === "single");
      if (!reply.messages.length) throw new Error("角色这次没有生成短信，可以重试");
      const fresh = loadSms(), live = fresh.threads.find(t => t.id === thread.id);
      if (!live || !targets.every(m => fresh.messages.some(current => current.id === m.id))) return;
      const first = fresh.messages.findIndex(m => m.id === targets[0].id);
      if (first < 0 || targets.some((m,i) => fresh.messages[first+i]?.id !== m.id)) return;
      const isLatest = fresh.messages.filter(m => m.threadId === thread.id).at(-1)?.id === targets.at(-1)?.id;
      if (scope === "single") {
        fresh.messages[first].original = reply.messages[0].original;
        fresh.messages[first].translated = reply.messages[0].translated;
        fresh.messages[first].reactions = [];
      } else {
        const prior = fresh.messages[first];
        const replacementBatch = batchId || smsId();
        const replacements: SmsMessage[] = reply.messages.map((m,i) => ({ id: smsId(), threadId: thread.id, direction: "incoming", original:m.original, translated:m.translated, createdAt: prior.createdAt+i, delivered: prior.delivered, batchId: replacementBatch, awarenessAt: prior.awarenessAt }));
        fresh.messages.splice(first, targets.length, ...replacements);
      }
      if (isLatest) { if (reply.summary) live.summary = reply.summary; if (live.identityId !== "real" && reply.awareness) { live.awareness = reply.awareness; live.suspicion = reply.suspicion; } }
      persist(fresh);
    } catch (e) { setError(e instanceof Error ? e.message : "重生成失败"); } finally { setBusy(false); }
  }
  function react(messageId: string, emoji: string) {
    const next = loadSms(), target = next.messages.find(m => m.id === messageId && m.threadId === selected && m.direction === "incoming");
    if (!target) return;
    target.reactions = [...(target.reactions ?? []).filter(r => r.by !== "user"), { id: smsId(), emoji, by: "user" }];
    persist(next); setPickedEmoji(""); setTray(false);
  }
  function addEmoji() {
    const emoji = emojiDraft.trim(), next = loadSms();
    if (!isEmoji(emoji)) return setEmojiError("请输入一个表情（可含肤色或组合）");
    if (next.emojiChoices.includes(emoji)) return setEmojiError("这个表情已经在备选里了");
    if (next.emojiChoices.length >= 80) return setEmojiError("备选最多保存 80 个表情");
    next.emojiChoices.push(emoji); persist(next); setEmojiDraft(""); setEmojiError("");
  }
  function removeEmoji(emoji: string) {
    const next = loadSms(); next.emojiChoices = next.emojiChoices.filter(item => item !== emoji);
    persist(next); if (pickedEmoji === emoji) setPickedEmoji("");
  }
  function showContext(id: string, element: HTMLElement) {
    const container = conversationRef.current;
    if (!container) return;
    const rect = element.getBoundingClientRect(), parent = container.getBoundingClientRect();
    const incoming = loadSms().messages.find(m => m.id === id)?.direction === "incoming";
    const width = Math.min(260, parent.width - 24), height = incoming ? 330 : 228;
    const above = rect.top - parent.top - height - 9;
    const below = rect.bottom - parent.top + 9;
    const top = above >= 12 ? above : Math.min(Math.max(12, below), Math.max(12, parent.height - height - 12));
    const rawLeft = incoming ? rect.left - parent.left : rect.right - parent.left - width;
    setContextAnchor({ top, left: Math.max(12, Math.min(rawLeft, parent.width - width - 12)) });
    setContactOpen(false); setContextId(id); setEditor(null); setPickedEmoji("");
  }
  function showContactContext(element: HTMLElement) {
    const container = conversationRef.current;
    if (!container) return;
    const rect = element.getBoundingClientRect(), parent = container.getBoundingClientRect();
    const width = Math.min(280,parent.width-24);
    setContactAnchor({top:Math.min(Math.max(12,rect.bottom-parent.top+10),Math.max(12,parent.height-340)),left:Math.max(12,Math.min(rect.left-parent.left+rect.width/2-width/2,parent.width-width-12))});
    setContextId(null);setContactEdit(null);setContactOpen(true);
  }
  function startContactPress(event: ReactPointerEvent) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    pointerOrigin.current={x:event.clientX,y:event.clientY};
    if (longPress.current) clearTimeout(longPress.current);
    const element=event.currentTarget as HTMLElement;
    longPress.current=setTimeout(()=>{skipClick.current=true;showContactContext(element);longPress.current=null;},500);
  }
  function saveContactEdit() {
    if (!selectedThread || !contactEdit) return;
    if (contactEdit === "alias") updateAlias(contactDraft);
    else updateCharacterPhone(selectedThread.characterId,contactDraft);
    setContactEdit(null);setContactOpen(false);
  }
  function clearThreadMessages() {
    if (!selected || !window.confirm("清空此联系人当前会话的所有短信？")) return;
    const next=loadSms();next.messages=next.messages.filter(m=>m.threadId!==selected);
    const thread=next.threads.find(t=>t.id===selected);if(thread)thread.updatedAt=Date.now();
    persist(next);setContactOpen(false);
  }
  function startPress(event: ReactPointerEvent, id: string) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    pointerOrigin.current = {x:event.clientX,y:event.clientY};
    if (longPress.current) clearTimeout(longPress.current);
    const element = event.currentTarget as HTMLElement;
    longPress.current = setTimeout(() => { skipClick.current = true; showContext(id, element); longPress.current = null; }, 500);
  }
  function movePress(event: ReactPointerEvent) {
    if (pointerOrigin.current && Math.hypot(event.clientX-pointerOrigin.current.x,event.clientY-pointerOrigin.current.y)>12) endPress();
  }
  function endPress() { if (longPress.current) clearTimeout(longPress.current); longPress.current = null; pointerOrigin.current = null; }
  function toggleBlock() {
    if (!selectedThread) return;
    const next = loadSms(); const thread = next.threads.find(t => t.id === selectedThread.id);
    if (thread) {
      thread.blockedByMe = !thread.blockedByMe;
      if (thread.blockedByMe && thread.identityId === "real" && next.realNumber.trim() && chatStatus(thread.characterId).blocked) {
        // Let the next background contact opportunity reconsider the Phone channel.
        next.lastAutoAt[thread.characterId] = 0;
        next.contactAttempts[thread.characterId] = 0;
      }
      persist(next);
    }
  }
  function deleteThreads() {
    if (!selectedRows.length || !window.confirm(`删除选中的 ${selectedRows.length} 条会话及全部短信？`)) return;
    const ids = new Set(selectedRows), next = loadSms();
    next.threads = next.threads.filter(t => !ids.has(t.id)); next.messages = next.messages.filter(m => !ids.has(m.threadId));
    persist(next); setSelectedRows([]); setEditing(false);
  }
  function deleteThread(id: string) {
    if (!window.confirm("删除这个号码的短信会话？")) return;
    const next = loadSms(); next.threads = next.threads.filter(t => t.id !== id); next.messages = next.messages.filter(m => m.threadId !== id);
    persist(next); setSelected(null); setRoute("list");
  }
  function updateReal(value: string) {
    const next = loadSms(); next.realNumber = value;
    next.threads.filter(t => t.identityId === "real").forEach(t => { t.number = value; }); persist(next);
  }
  function updateCharacterPhone(id: string, value: string) {
    setCharacterPhoneNumber(id, value);
    setState(loadSms());
  }
  function updateAlias(value: string) {
    const next=loadSms(), thread=next.threads.find(t=>t.id===selected);
    if (thread) {setSmsContactAlias(next,thread.characterId,value);persist(next);}
  }
  function addVirtual() {
    const next = loadSms(); const identity = createVirtualIdentity(next, region);persist(next);setIdentityId(identity.id);onNotice?.(`已创建虚拟号码 ${identity.number}`);
  }
  function uploadBackground(file?: File) {
    if (!file || !selected) return;
    if (!file.type.startsWith("image/") || file.size > 2_000_000) return setError("请选择小于 2 MB 的图片");
    const threadId=selected, reader=new FileReader();
    reader.onload=()=>{const next=loadSms(), thread=next.threads.find(t=>t.id===threadId);if(thread){thread.backgroundUrl=String(reader.result);persist(next);setError("");}};
    reader.readAsDataURL(file);
  }
  const avatar = (_id: string) => <span className={styles.avatar}><img src="/images/default-contact-avatar.jpg" alt="" /></span>;
  const background = selectedThread?.backgroundUrl ?? state.background;
  return <div className={styles.app}>
    {route === "list" && <>
      <div className={styles.listHeader}><div className={styles.toolbar}><button className={styles.glass} onClick={onClose}>返回</button><div style={{display:"flex",gap:12}}><button className={styles.glass} onClick={()=>{setEditing(v=>!v);setSelectedRows([]);}}>{editing?"完成":"编辑"}</button><button className={styles.glass} onClick={()=>openSettings("list")}>设置</button></div></div><h1>信息</h1></div>
      <div className={styles.threadList}>{threads.length ? threads.map(thread=>{ const last=state.messages.filter(m=>m.threadId===thread.id).at(-1); const chosen=selectedRows.includes(thread.id); const unread = getSmsThreadUnreadCount(state, thread.id); return <button key={thread.id} className={styles.threadRow} onClick={()=>{if(editing){setSelectedRows(rows=>chosen?rows.filter(x=>x!==thread.id):[...rows,thread.id]);return;}setSelected(thread.id);setRoute("chat");markSmsThreadRead(thread.id);setError("");}}>{editing ? <span className={`${styles.checkCircle} ${chosen?styles.checked:""}`}>{chosen && <Check size={15}/>}</span> : avatar(thread.characterId)}<span className={styles.threadText}><span className={styles.threadTop}><strong>{displayName(thread)}</strong>{unread > 0 && <span className={styles.unreadCount}>{unread > 99 ? "99+" : unread}</span>}<time>{date(thread.updatedAt)}</time></span><span className={styles.preview}>{last?.original || "开始一段短信"}</span></span>{!editing && <ChevronRight size={17} className={styles.chevron}/>}</button>}) : <div className={styles.empty}>还没有短信<br/>点击右下角写一条</div>}</div>
      {editing ? <div className={styles.deleteDock}><span>已选择 {selectedRows.length} 项</span><button disabled={!selectedRows.length} onClick={deleteThreads}>删除</button></div> : <div className={styles.listDock}><label className={styles.search}><Search size={20}/><input placeholder="搜索" value={search} onChange={e=>setSearch(e.target.value)} /></label><button className={styles.composeButton} aria-label="新建短信" onClick={()=>{setRoute("compose");setError("");}}><Pencil size={22}/></button></div>}
    </>}
    {route === "compose" && <><header className={styles.subHeader}><button className={styles.glass} onClick={back}><ArrowLeft size={20}/></button><strong>新建信息</strong><button className={styles.glass} onClick={()=>openSettings("compose")}><Settings2 size={20}/></button></header><div className={styles.form}><label>收件人<select value={characterId} onChange={e=>setCharacterId(e.target.value)}><option value="">选择角色</option>{characters.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label><label>发件号码<select value={identityId} onChange={e=>setIdentityId(e.target.value)}><option value="real">真实号码 {state.realNumber || "（设置中填写）"}</option>{state.identities.map(i=><option key={i.id} value={i.id}>{i.number}</option>)}</select></label><button className={styles.primary} onClick={start}>进入会话</button><button className={styles.secondary} onClick={()=>openSettings("compose")}>管理我的号码 / 生成小号</button></div></>}
    {route === "chat" && selectedThread && <div ref={conversationRef} className={styles.conversation} style={background ? {backgroundImage:`url(${background})`} : undefined}>
      <header className={styles.chatHeader}>
        <button className={styles.glass} aria-label="返回" onClick={back}><ArrowLeft size={22}/></button>
        <button className={styles.person} aria-label="长按联系人名称打开设置" onPointerDown={startContactPress} onPointerMove={movePress} onPointerUp={endPress} onPointerCancel={endPress} onContextMenu={e=>{e.preventDefault();endPress();showContactContext(e.currentTarget);}} onClick={()=>{skipClick.current=false;}} onKeyDown={e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();showContactContext(e.currentTarget);}}}>{avatar(selectedThread.characterId)}<span className={styles.personName}>{name(selectedThread)} <ChevronRight size={12}/></span></button>
        <button className={styles.glass} aria-label="打电话" title="打电话" onClick={()=>window.dispatchEvent(new CustomEvent("phone-request-outgoing", { detail: { characterId: selectedThread.characterId } }))}><Phone size={21}/></button>
      </header>
      <div className={styles.bubbles} ref={listRef}>
        {messages.length===0 && <div className={styles.chatEmpty}>发送第一条短信，或召唤角色主动说话</div>}
        {messages.map((m,i)=>{
          const following=messages[i+1];
          const tail=!following || following.direction!==m.direction || separated(following,m);
          const hasTranslation=m.direction==="incoming" && !!m.translated && m.translated!==m.original;
          const expanded=translationExpanded[m.id] ?? state.autoExpandTranslation;
          return <div key={m.id}>
            {timeMarkers.has(m.id) && <div className={styles.timestamp}>{stamp(m.createdAt)}</div>}
            <div className={`${styles.message} ${m.direction==="outgoing"?styles.mine:styles.theirs} ${tail?styles.tail:""} ${selectingMessages?styles.selectableMessage:""}`} data-sms-message-id={m.id}
              onPointerDown={e=>{if(!selectingMessages)startPress(e,m.id);}} onPointerMove={movePress} onPointerUp={endPress} onPointerCancel={endPress}
              onContextMenu={e=>{e.preventDefault();endPress();if(!selectingMessages){skipClick.current=true;showContext(m.id,e.currentTarget);}}}
              onDragOver={e=>{if(dragEmoji.current && m.direction==="incoming") e.preventDefault();}}
              onDrop={e=>{e.preventDefault();if(dragEmoji.current)react(m.id,dragEmoji.current);dragEmoji.current="";}}>
              {selectingMessages && <button type="button" className={`${styles.messageCheck} ${selectedMessages.includes(m.id)?styles.messageChecked:""}`} aria-label={`选择短信：${m.original.slice(0,20)}`} aria-pressed={selectedMessages.includes(m.id)} onClick={()=>setSelectedMessages(ids=>ids.includes(m.id)?ids.filter(id=>id!==m.id):[...ids,m.id])}>{selectedMessages.includes(m.id) && <Check size={14}/>}</button>}
              <div className={styles.bubbleWrap}>
                <div className={styles.bubble} role={hasTranslation?"button":undefined} tabIndex={hasTranslation?0:undefined} aria-expanded={hasTranslation?expanded:undefined}
                  onKeyDown={e=>{if(hasTranslation && (e.key==="Enter" || e.key===" ")){e.preventDefault();setTranslationExpanded(value=>({...value,[m.id]:!expanded}));}}}
                  onClick={()=>{if(skipClick.current || contextId){skipClick.current=false;return;}if(selectingMessages){setSelectedMessages(ids=>ids.includes(m.id)?ids.filter(id=>id!==m.id):[...ids,m.id]);return;}if(pickedEmoji && m.direction==="incoming"){react(m.id,pickedEmoji);return;}if(hasTranslation)setTranslationExpanded(value=>({...value,[m.id]:!expanded}));}}>{m.original}</div>
                {m.reactions?.length ? <div className={styles.reactions}>{m.reactions.map(r=><span key={r.id} className={styles.reactionSticker}><span className={styles.reaction}>{r.emoji}</span></span>)}</div> : null}
              </div>
              {hasTranslation && expanded && <div className={styles.translation}>{m.translated}</div>}
            </div>
          </div>;
        })}
        {busy && <div className={styles.typing} aria-label="对方正在输入"><span/><span/><span/></div>}
      </div>
      {tray && <div className={styles.emojiTray}>
        <div className={styles.emojiHeading}><span>{manageEmoji?"管理常用表情":"点选或拖到对方短信上"}</span><button type="button" onClick={()=>{setManageEmoji(value=>!value);setPickedEmoji("");}}>{manageEmoji?"完成":"管理"}</button></div>
        <div className={styles.emojiGrid}>{state.emojiChoices.map(emoji=><span className={styles.emojiItem} key={emoji}>
          <button type="button" aria-label={emoji} className={pickedEmoji===emoji?styles.emojiSelected:""} draggable={!manageEmoji}
            onDragStart={e=>{dragEmoji.current=emoji;e.dataTransfer.setData("text/plain",emoji);}} onDragEnd={()=>{dragEmoji.current="";}}
            onPointerDown={()=>{dragEmoji.current=emoji;}}
            onPointerUp={e=>{if(!manageEmoji){const el=document.elementFromPoint(e.clientX,e.clientY)?.closest("[data-sms-message-id]");if(el)react(el.getAttribute("data-sms-message-id")||"",emoji);}dragEmoji.current="";}}
            onClick={()=>{if(!manageEmoji)setPickedEmoji(emoji);}}>{emoji}</button>
          {manageEmoji && <button type="button" className={styles.emojiRemove} aria-label={`移除 ${emoji}`} onClick={()=>removeEmoji(emoji)}>×</button>}
        </span>)}</div>
        <form className={styles.emojiAdd} onSubmit={e=>{e.preventDefault();addEmoji();}}><input aria-label="添加常用表情" placeholder="粘贴或输入自己的 emoji" value={emojiDraft} maxLength={32} onChange={e=>{setEmojiDraft(e.target.value);setEmojiError("");}}/><button type="submit">添加</button></form>
        {emojiError && <span className={styles.emojiError}>{emojiError}</span>}
        {manageEmoji && <button type="button" className={styles.emojiReset} onClick={()=>{const next=loadSms();next.emojiChoices=[...DEFAULT_SMS_EMOJI];persist(next);}}>恢复默认表情</button>}
      </div>}
      {error && <p className={styles.error}>{error} {!busy && <button type="button" onClick={()=>void summon(selectedThread.id)}>重试</button>}</p>}
      {selectingMessages ? <div className={styles.messageSelectionBar}><button type="button" onClick={()=>{setSelectingMessages(false);setSelectedMessages([]);}}>取消</button><span>已选 {selectedMessages.length} 条</span><button type="button" className={styles.redOption} disabled={!selectedMessages.length} onClick={deleteSelectedMessages}><Trash2 size={16}/> 删除</button></div> : <form className={styles.composer} onSubmit={e=>{e.preventDefault();send();}}>
        <button type="button" className={styles.round} aria-label="表情贴纸" aria-expanded={tray} onClick={()=>{setTray(value=>!value);setPickedEmoji("");}}><Plus size={25}/></button>
        <input aria-label="短信内容" enterKeyHint="send" placeholder="iMessage" value={draft} onChange={e=>setDraft(e.target.value)} />
        <button type="button" className={styles.round} aria-label="召唤回复" title="召唤回复" disabled={busy} onClick={()=>void summon(selectedThread.id)}><AudioLines size={21}/></button>
      </form>}
      <input ref={backgroundInput} type="file" hidden accept="image/*" onChange={e=>{uploadBackground(e.target.files?.[0]);e.target.value="";}}/>
      {contextual && <div className={styles.contextShade} onPointerDown={e=>{if(e.target===e.currentTarget){setContextId(null);setEditor(null);skipClick.current=false;}}}>
        <div className={`${styles.contextPanel} ${editor?styles.contextEditor:""}`} style={editor?undefined:contextAnchor}>{editor ? <>
          <h3>编辑短信</h3><label>原文<textarea autoFocus value={editor.original} onChange={e=>setEditor({...editor,original:e.target.value})}/></label>
          {contextual.direction==="incoming" && <label>中文翻译<textarea value={editor.translated} onChange={e=>setEditor({...editor,translated:e.target.value})}/></label>}
          <div className={styles.contextActions}><button onClick={()=>setEditor(null)}>取消</button><button onClick={editMessage} disabled={!editor.original.trim()}>保存</button></div>
        </> : <>
          <button onClick={()=>void copyMessage()}><span>复制</span><Copy size={17}/></button>
          <button onClick={()=>setEditor({original:contextual.original,translated:contextual.translated??""})}><span>编辑{contextual.direction==="incoming"?"（正文+译文）":""}</span><Pencil size={17}/></button>
          <button onClick={()=>void regenerate("single")} disabled={busy}><span>重回本条</span><RotateCcw size={17}/></button><button onClick={()=>void regenerate("batch")} disabled={busy}><span>重回本轮全部</span><RotateCcw size={17}/></button>
          <button onClick={()=>{setSelectedMessages([contextual.id]);setSelectingMessages(true);setTray(false);setContextId(null);}}><span>多选</span><Check size={17}/></button>
          <button className={styles.redOption} onClick={deleteMessage}><span>删除</span><Trash2 size={17}/></button>
        </>}</div>
      </div>}
      {contactOpen && <div className={styles.contextShade} onPointerDown={e=>{if(e.target===e.currentTarget){setContactOpen(false);setContactEdit(null);skipClick.current=false;}}}>
        <div className={`${styles.contextPanel} ${styles.contactPanel}`} style={contactAnchor}>
          {contactEdit ? <><h3>{contactEdit==="alias"?"修改备注":"角色手机号"}</h3><label>{contactEdit==="alias"?"备注名称":"角色手机号"}<input autoFocus value={contactDraft} onChange={e=>setContactDraft(contactEdit === "phone" ? e.target.value.replace(/\D/g, "") : e.target.value)} onKeyDown={e=>{if(e.key==="Enter")saveContactEdit();}}/></label><div className={styles.contextActions}><button onClick={()=>setContactEdit(null)}>取消</button><button onClick={saveContactEdit}>保存</button></div></> : <>
            <button onClick={()=>{setContactDraft(smsContactAlias(selectedThread.characterId,state));setContactEdit("alias");}}><span>修改备注</span><Pencil size={17}/></button>
            <button onClick={()=>{setContactDraft(selectedThread.characterNumber);setContactEdit("phone");}}><span>设定角色手机号</span><Phone size={17}/></button>
            <button onClick={()=>{toggleBlock();setContactOpen(false);}}><span>{selectedThread.blockedByMe?"解除拉黑":"拉黑此人"}</span>{selectedThread.blockedByMe?<ShieldOff size={17}/>:<Ban size={17}/>}</button>
            <button onClick={()=>{setContactOpen(false);backgroundInput.current?.click();}}><span>设置聊天背景</span><ImagePlus size={17}/></button>
            {selectedThread.backgroundUrl && <button onClick={()=>{const next=loadSms(),thread=next.threads.find(t=>t.id===selected);if(thread){thread.backgroundUrl="";persist(next);}setContactOpen(false);}}><span>恢复默认背景</span><ImagePlus size={17}/></button>}
            <button className={styles.redOption} onClick={clearThreadMessages}><span>清空所有消息</span><Trash2 size={17}/></button>
          </>}
        </div>
      </div>}
    </div>}
    {route === "detail" && selectedThread && <><header className={styles.subHeader}><button className={styles.glass} onClick={back}><ArrowLeft size={20}/></button><strong>联系人设置</strong><span/></header><div className={styles.details}>{avatar(selectedThread.characterId)}<h2>{name(selectedThread)}</h2><label>修改备注<input placeholder="输入备注，保存后显示在头像下" value={smsContactAlias(selectedThread.characterId,state)} onChange={e=>updateAlias(e.target.value)}/></label><label>角色手机号<input placeholder="输入手机号" value={selectedThread.characterNumber} onChange={e=>updateCharacterPhone(selectedThread.characterId,e.target.value.replace(/\D/g, ""))}/></label><div className={styles.card}><span>发件身份</span><b>{selectedThread.identityId==="real" ? `真实号码 ${state.realNumber||"未设置"}` : selectedThread.number}</b></div><div className={styles.card}><span>拉黑此人</span><button onClick={toggleBlock}>{selectedThread.blockedByMe ? <><ShieldOff size={17}/>解除拉黑</> : <><Ban size={17}/>拉黑此人</>}</button></div>{selectedThread.identityId!=="real" && <div className={styles.card}><span>对方对身份的判断</span><b>{selectedThread.awareness==="unknown"?"未知":selectedThread.awareness==="suspected"?"怀疑中":"已确认"}</b></div>}<label className={styles.upload}>设置聊天背景 <ImagePlus size={16}/><input type="file" hidden accept="image/*" onChange={e=>uploadBackground(e.target.files?.[0])}/></label>{background && <button className={styles.secondary} onClick={()=>{const next=loadSms(),thread=next.threads.find(t=>t.id===selected);if(thread){thread.backgroundUrl="";persist(next);}}}>清除本联系人背景</button>}<button className={styles.danger} onClick={()=>deleteThread(selectedThread.id)}>删除会话</button></div></>}
    {route === "settings" && <><header className={styles.subHeader}><button className={styles.glass} onClick={()=>setRoute(settingsReturn)}><ArrowLeft size={20}/></button><strong>短信设置</strong><button className={styles.glass} onClick={()=>setRoute("list")}><X size={20}/></button></header><div className={styles.settings}><h3>显示</h3><label className={styles.toggleRow}><span>自动展开角色短信翻译</span><input type="checkbox" checked={state.autoExpandTranslation} onChange={e=>{const next=loadSms();next.autoExpandTranslation=e.target.checked;persist(next);}}/></label><p>仅影响短信 App；点击对方气泡仍可单独展开或收起。查手机的翻译设置不受影响。</p><h3>短信提示音</h3><label className={styles.toggleRow}><span>新短信声音</span><input type="checkbox" role="switch" checked={state.soundEnabled !== false} onChange={e=>{const next=loadSms();next.soundEnabled=e.target.checked;persist(next);}}/></label><AudioSourcePicker defaultValue={DEFAULT_SMS_SOUND} label="短信提示音" value={state.ringtoneUrl || ""} onChange={value=>{const next=loadSms();next.ringtoneUrl=value;persist(next);}} onNotice={onNotice} defaultHint="收到新短信时播放；恢复默认后使用内置短信提示音。"/><h3>我的号码</h3><label>真实号码<input placeholder="例如 +82 10 1234 5678" value={state.realNumber} onChange={e=>updateReal(e.target.value)} /></label><p>号码只用于虚构手机内的短信。发件身份按号码独立保存。</p><h3>虚拟号码</h3><div className={styles.inline}><select value={region} onChange={e=>setRegion(e.target.value)}>{SMS_REGIONS.map(r=><option value={r.code} key={r.code}>{r.name}</option>)}</select><button onClick={addVirtual}>随机生成</button></div>{state.identities.map(i=><div className={styles.number} key={i.id}>{i.number}<Check size={16}/></div>)}<h3>角色号码</h3>{characters.map(c=><label key={c.id}>{c.name}<input placeholder={phoneFromPersona(c.persona) || "输入手机号"} value={state.characterNumbers[c.id] ?? ""} onChange={e=>updateCharacterPhone(c.id,e.target.value.replace(/\D/g, ""))} /></label>)}<CommunicationSettings channel="sms"/></div></>}
    {error && route!=="chat" && <p className={styles.error}>{error}</p>}
  </div>;
}
