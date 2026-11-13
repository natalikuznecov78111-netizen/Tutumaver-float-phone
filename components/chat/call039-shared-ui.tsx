"use client";

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ArrowUp, MessageSquare, MessageSquareOff, Pause, PhoneOff, Play, Video, VideoOff } from "lucide-react";
import { displayCallSpeech, displayCallAction } from "@/lib/call-transcript";
import { splitBilingualText } from "@/lib/bilingual-text";

/**
 * Shared production-ready *view* components for the Chat video-call redesign.
 * No AI, storage, TTS, or browser permissions in this module: those are provided
 * by the host call screen. The preview and production can use the same markup.
 */
export type Call039Line = {
  id: string;
  role: "user" | "assistant";
  kind: "speech" | "action";
  text: string;
  speakerId?: string;
  speakerName?: string;
  duration?: string;
  batchId?: string;
};
export type Call039ComposeKind = "speech" | "action";

export function Call039LineView({
  line, showSpeaker = false, playing = false, onPlay, onMenu,
}: {
  line: Call039Line;
  showSpeaker?: boolean;
  playing?: boolean;
  onPlay: (line: Call039Line) => void;
  onMenu: (line: Call039Line, anchor: DOMRect) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPress = useRef(false);
  const pointerOrigin = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => setExpanded(true), [line.id]);
  const clearPress = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => () => clearPress(), []);
  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button")) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    longPress.current = false;
    pointerOrigin.current = { x: event.clientX, y: event.clientY };
    const anchor = event.currentTarget;
    clearPress();
    timer.current = setTimeout(() => {
      longPress.current = true;
      onMenu(line, anchor.getBoundingClientRect());
    }, 460);
  };
  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointerOrigin.current) return;
    if (Math.abs(event.clientX - pointerOrigin.current.x) + Math.abs(event.clientY - pointerOrigin.current.y) > 12) clearPress();
  };
  const handlePointerUp = () => { clearPress(); pointerOrigin.current = null; };

  const isAction = line.kind === "action";
  const display = isAction ? displayCallAction(line.text) : displayCallSpeech(line.text);
  const bilingual = isAction ? null : splitBilingualText(display);
  const content = bilingual?.original || display;
  const hasTranslation = !!bilingual?.translated;

  return (
    <div className={isAction ? "vc-line vc-line--action" : "vc-line"} data-role={line.role} data-line-id={line.id} data-kind={line.kind}>
      {showSpeaker && !isAction && <div className="vc-speaker-label">{line.speakerName || (line.role === "user" ? "我" : "成员")}</div>}
      <div
        className={isAction ? "vc-action-text" : "vc-glass-bubble"}
        role="button"
        tabIndex={0}
        aria-label={isAction ? "长按编辑动作" : hasTranslation ? "点击展开或收起翻译，长按显示操作菜单" : "长按显示操作菜单"}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onPointerLeave={handlePointerUp}
        onContextMenu={(event) => { event.preventDefault(); clearPress(); onMenu(line, event.currentTarget.getBoundingClientRect()); }}
        onClick={() => {
          if (longPress.current) { longPress.current = false; return; }
          if (hasTranslation) setExpanded(value => !value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && hasTranslation) { event.preventDefault(); setExpanded(value => !value); }
        }}
      >
        {isAction ? (
          <span>{display}</span>
        ) : (
          <>
            <div className="vc-bubble-main">
              <button type="button" className="vc-play" aria-label={playing ? "暂停当前语音" : "合成并播放本句语音"}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => { event.stopPropagation(); onPlay(line); }}
              >{playing ? <Pause size={14} fill="currentColor"/> : <Play size={14} fill="currentColor"/>}</button>
              <span className="vc-original">{content}</span>
              <span className="vc-bubble-right">
                {line.duration && <span className="vc-duration">{line.duration}</span>}
                
              </span>
            </div>
            {hasTranslation && expanded && <div className="vc-translation">{bilingual!.translated}</div>}
          </>
        )}
      </div>
    </div>
  );
}

export function Call039Composer({
  draft, setDraft, kind, setKind, onSend, onSummon, busy = false, pending = 0,
}: {
  draft: string;
  setDraft: (value: string) => void;
  kind: Call039ComposeKind;
  setKind: (value: Call039ComposeKind) => void;
  onSend: () => void;
  onSummon: () => void;
  busy?: boolean;
  pending?: number;
}) {
  return (
    <div className="vc-composer-wrap">
      <div className="vc-compose-shell">
        <button type="button" className="vc-kind-switch" aria-label="切换语言或动作输入"
          onClick={() => setKind(kind === "speech" ? "action" : "speech")}
        >{kind === "speech" ? "语" : "动"}</button>
        <input className="vc-compose-input" value={draft} onChange={event => setDraft(event.target.value)}
          placeholder={kind === "speech" ? "输入你想说的话，回车发送…" : "输入你要做的动作，回车发送…"}
          onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); onSend(); } }}
          aria-label="视频通话消息输入"
        />
        <button type="button" className="vc-summon" aria-label="召唤角色继续（不会发送未输入完的草稿）"
          disabled={busy} title={pending ? "召唤回复（已发送 " + pending + " 条）" : "让角色自然继续"}
          onClick={onSummon}
        ><ArrowUp size={22} strokeWidth={2.7}/></button>
      </div>
      {pending > 0 && <div className="vc-pending" aria-live="polite">已发送 {pending} 条 · 点击小飞机召唤</div>}
    </div>
  );
}

export function Call039Controls({
  cameraOn, onCamera, onHangup, visible, onVisibility,
}: {
  cameraOn: boolean;
  onCamera: () => void;
  onHangup: () => void;
  visible: boolean;
  onVisibility: () => void;
}) {
  return (
    <div className="vc-controls" aria-label="视频通话底部控制栏">
      <button type="button" onClick={onCamera} className="vc-control-btn"
        aria-label={cameraOn ? "关闭摄像头" : "开启摄像头"} title={cameraOn ? "关闭摄像头" : "开启摄像头"}
      >{cameraOn ? <Video size={24}/> : <VideoOff size={24}/>}</button>
      <button type="button" onClick={onHangup} className="vc-control-btn vc-hangup" aria-label="挂断视频通话"><PhoneOff size={27}/></button>
      <button type="button" onClick={onVisibility} className="vc-control-btn" aria-label={visible ? "隐藏对话与动作" : "显示对话与动作"}
      >{visible ? <MessageSquare size={24}/> : <MessageSquareOff size={24}/>}</button>
    </div>
  );
}

export const VIDEO_LONG_PRESS_OPTIONS = [
  { id: "edit", label: "编辑回复" },
  { id: "favorite", label: "收藏语音", speechOnly: true },
  { id: "reroll-batch", label: "重回本段" },
  { id: "reroll-after", label: "重回以下" },
  { id: "delete", label: "删除", destructive: true },
  { id: "delete-after", label: "删除以下", destructive: true },
] as const;
