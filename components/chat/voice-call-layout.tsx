"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ChevronLeft, Hand, Headphones, Maximize2, MessageSquare, MoreHorizontal, Phone, PhoneOff, Settings, Smile, Sparkles, Users, Video, Volume2, X } from "lucide-react";
import { CallTranscriptBubble } from "./call-transcript-bubble";
export type VoiceCallLine = { id: string; role: "user" | "assistant"; text: string };
export function TranscriptCard({ name, avatar, lines, roundStart, playingId, busy, onPlay, onSelect, avatarHeader, positions, personKey }: {
    name: string; avatar: string; lines: VoiceCallLine[]; roundStart?: string | null; playingId: string | null; busy: boolean;
    avatarHeader?: ReactNode; positions?: Map<string, number>; personKey?: string;
    onPlay?: (line: VoiceCallLine) => void; onSelect?: (id: string) => void;
}) {
    const scroll = useRef<HTMLDivElement>(null);
    const restored = useRef(false);
    useEffect(() => () => { if (positions && personKey && scroll.current) positions.set(personKey, scroll.current.scrollTop); }, [positions, personKey]);
    const following = useRef(true);
    const hold = useRef<ReturnType<typeof setTimeout> | null>(null);
    const origin = useRef({ x: 0, y: 0 });
    const [hasNew, setHasNew] = useState(false);
    const [resume, setResume] = useState(0);
    const cancelHold = () => { if (hold.current) clearTimeout(hold.current); hold.current = null; };
    const pauseFollow = () => { following.current = false; setHasNew(true); };
    useEffect(() => () => cancelHold(), []);
    useEffect(() => {
        const element = scroll.current;
        if (!element || !lines.length) return;
        if (!restored.current) { restored.current = true; const position = personKey ? positions?.get(personKey) : undefined; if (position !== undefined) { element.scrollTop = position; following.current = false; return; } }
        if (!following.current) { setHasNew(true); return; }
        setHasNew(false);
        const first = roundStart && element.querySelector<HTMLElement>(`[data-line-id="${CSS.escape(roundStart)}"]`);
        element.scrollTop = first ? first.offsetTop : element.scrollHeight;
        if (!roundStart) return;
        let frame = 0, previous = 0, position = element.scrollTop;
        const advance = (now: number) => {
            if (!following.current) return;
            if (previous) position += Math.min(now - previous, 100) * .025;
            previous = now;
            element.scrollTop = position;
            if (position < element.scrollHeight - element.clientHeight) frame = requestAnimationFrame(advance);
        };
        frame = requestAnimationFrame(advance);
        return () => cancelAnimationFrame(frame);
    }, [lines.length, roundStart, resume]);
    return <section className="chat-call-person-card">
        {avatarHeader || <div className="chat-call-card-avatar">{avatar ? <img src={avatar} alt={name}/> : <span>{name[0] || "?"}</span>}</div>}
        <div className="chat-call-card-transcript" ref={scroll} onScroll={() => { if (positions && personKey && scroll.current) positions.set(personKey, scroll.current.scrollTop); }} onWheel={pauseFollow} onTouchStart={pauseFollow} onKeyDown={e => { if (["ArrowUp","ArrowDown","PageUp","PageDown","Home","End"].includes(e.key)) pauseFollow(); }} tabIndex={0} aria-label={`${name}的通话内容`}>
            {lines.map(line => <div key={line.id} data-line-id={line.id} className="chat-call-line"
                onContextMenu={e => { if (!onSelect) return; e.preventDefault(); cancelHold(); onSelect(line.id); }}
                onPointerDown={e => { if (!onSelect || (e.target as HTMLElement).closest("button")) return; cancelHold(); origin.current = { x:e.clientX,y:e.clientY }; hold.current = setTimeout(() => { onSelect(line.id); hold.current = null; }, 550); }}
                onPointerMove={e => { if (Math.hypot(e.clientX-origin.current.x,e.clientY-origin.current.y)>8) cancelHold(); }} onPointerUp={cancelHold} onPointerCancel={cancelHold}>
                {onPlay ? <CallTranscriptBubble role={line.role} text={line.text} onPlay={() => onPlay(line)} playing={playingId === line.id} disabled={busy && playingId !== line.id}/> : <p className="chat-call-user-line">{line.text}</p>}
                {onSelect && <button type="button" className="chat-call-line-menu" aria-label="这句的操作" onClick={() => onSelect(line.id)}><MoreHorizontal size={14}/></button>}
            </div>)}
            {!lines.length && <p className="chat-call-empty">等待通话内容</p>}
        </div>
        <footer className="chat-call-card-footer"><strong>{name}</strong>{playingId && lines.some(l => l.id === playingId) && <span className="chat-call-wave" aria-label="正在播放"><i/><i/><i/></span>}</footer>
        {hasNew && <button className="chat-call-follow" onClick={() => { following.current=true; setResume(v=>v+1); }}><ArrowDown size={12}/>跟随最新</button>}
    </section>;
}
export function VoiceCallLayout(props: {
    name: string; avatar: string; userName: string; userAvatar: string; lines: VoiceCallLine[]; roundStart: string | null; playingId: string | null;
    state: string; duration: string; queued: number; error: string | null; onClearError: () => void;
    onMinimize?: () => void; onSummon: () => void; onInput: () => void; onHangup: () => void; onAccept: () => void; onDecline: () => void; incoming: boolean;
    onPlay: (line: VoiceCallLine) => void; onFavorite?: (id:string) => void; onRetry?: (id: string) => void; onDelete: (id: string) => void; onOutput: () => void; outputName: string;
    input: ReactNode; settings: ReactNode; group?: { count: number; title: string; selectedId: string; avatars: ReactNode; onMembers: () => void; positions: Map<string, number> };
}) {
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [selected, setSelected] = useState<string | null>(null);
    const assistant = props.lines.filter(l=>l.role === "assistant"), user = props.lines.filter(l=>l.role === "user");
    const busy = props.state !== "IDLE";
    const connected = props.state !== "CONNECTING" && props.state !== "ENDED";
    const phase = props.state === "PROCESSING" ? "对方正在思考…" : props.state === "AI_SPEAKING" ? (props.playingId ? "正在播放…" : "准备语音…") : props.state === "USER_SPEAKING" ? "正在输入…" : props.state === "CONNECTING" ? (props.incoming ? "邀请你加入通话" : "正在呼叫…") : props.state === "ENDED" ? "通话已结束" : props.duration;
    return <div className="chat-single-voice-layout">
        <header className="chat-call-new-top"><button onClick={props.onMinimize} disabled={!props.onMinimize || props.state === "ENDED"} aria-label="缩小通话"><ChevronLeft size={22}/></button><strong>{props.group?.title || props.name}</strong>{props.group ? <button className="chat-call-count" aria-label="通话成员和邀请" onClick={props.group.onMembers}><Users size={15}/>{props.group.count}</button> : <span className="chat-call-count"><Users size={15}/>2</span>}<button aria-label="通话设置" onClick={()=>setSettingsOpen(true)}><Settings size={22}/></button><button aria-label="通话小窗" onClick={props.onMinimize} disabled={!props.onMinimize || props.state === "ENDED"}><Maximize2 size={22}/></button></header>
        <div className="chat-call-decorations" aria-hidden="true"><span><Maximize2 size={15}/>屏幕分享</span><span><Smile size={15}/>快速点赞</span><span><Hand size={15}/>举手</span></div>
        <div className="chat-call-phase" role="status">{phase}{props.queued > 0 && <span> · 已发送 {props.queued} 条</span>}</div>
        <main className="chat-call-persons"><TranscriptCard key={props.group?.selectedId || "assistant"} avatarHeader={props.group?.avatars} positions={props.group?.positions} personKey={props.group?.selectedId} name={props.name} avatar={props.avatar} lines={assistant} roundStart={props.roundStart} playingId={props.playingId} busy={busy} onPlay={props.onPlay} onSelect={setSelected}/><TranscriptCard name={props.userName} avatar={props.userAvatar} lines={user} playingId={props.playingId} busy={busy} onPlay={props.onPlay} onSelect={setSelected}/></main>
        {props.error && <button className="chat-call-error" onClick={props.onClearError}>{props.error}</button>}
        <nav className="chat-call-new-controls" data-phase={connected ? "connected" : props.state === "CONNECTING" ? "connecting" : "ended"} aria-label="通话操作">
            {connected ? <><button onClick={props.onSummon} disabled={busy} aria-label="召唤回复"><Sparkles/></button><button onClick={props.onInput} disabled={busy} aria-label="输入消息"><MessageSquare/></button><button className="chat-call-hangup" onClick={props.onHangup} aria-label="挂断"><PhoneOff/></button><button onClick={props.onOutput} aria-label="播放设备"><Headphones/></button><span className="chat-call-inactive" title="暂不支持切换视频"><Video/></span></> : props.state === "CONNECTING" ? <><button className="chat-call-hangup" onClick={props.onDecline} aria-label={props.incoming ? "拒绝通话" : "取消通话"}><PhoneOff/></button>{props.incoming && <button className="chat-call-accept" onClick={props.onAccept} aria-label="接听通话"><Phone/></button>}</> : <span>通话已结束</span>}
        </nav>
        {settingsOpen && <div className="chat-call-dialog-backdrop" onClick={()=>setSettingsOpen(false)}><div className="chat-call-dialog" role="dialog" aria-modal="true" aria-label="通话设置" onClick={e=>e.stopPropagation()}><header><strong>通话设置</strong><button onClick={()=>setSettingsOpen(false)} aria-label="关闭设置"><X/></button></header>{props.settings}</div></div>}
        {selected && <div className="chat-call-dialog-backdrop" onClick={()=>setSelected(null)}><div className="chat-call-dialog chat-call-actions" role="dialog" aria-modal="true" aria-label="台词操作" onClick={e=>e.stopPropagation()}>{props.onRetry && props.lines.find(l=>l.id===selected)?.role === "assistant" && <><p>这句及之后的回复将重新生成</p><button disabled={busy} onClick={()=>{props.onRetry?.(selected);setSelected(null);}}>重试以下</button></>}<button disabled={busy} onClick={()=>{props.onFavorite?.(selected);setSelected(null);}} hidden={!props.onFavorite}>收藏语音</button><button disabled={props.state === "PROCESSING" || props.state === "CONNECTING" || props.state === "ENDED"} onClick={()=>{props.onDelete(selected);setSelected(null);}}>删除这句</button><button onClick={()=>setSelected(null)}>取消</button></div></div>}
        {props.input}
    </div>;
}
