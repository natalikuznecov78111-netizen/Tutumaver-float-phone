"use client";
import { SpeechFailureNotice, useSpeechFailure } from "./speech-failure-notice";
import {DraggableMediaWindow} from "@/components/ui/draggable-media-window";
import {characterSpeaksFirst} from "@/lib/call-first-speaker";
import { VoiceFavoriteDialog } from "./voice-favorite-dialog";
import { useCallEndRecord } from "./use-call-end-record";
import { parseCallOutput, SINGLE_CALL_ACTIONS } from "@/lib/call-participation";
import { useChatCallIdentity, useChatUserAvatar } from "./use-chat-user-avatar";

import { useState, useRef, useEffect, useCallback } from "react";
import { ChatSession, ChatMessage, loadChatMessages, pushChatMessage, deleteChatMessagesByIds, getLatestCharacterStateValues } from "@/lib/chat-storage";
import { getStatusRegionConfig, isCustomStatusRegionActive } from "@/lib/chat-status-region";
import { X, Send } from "lucide-react";
import { VoiceCallLayout } from "./voice-call-layout";
import { parseAIResponse } from "@/lib/rich-message-parser";
import { generateChatCompletion, flattenCompletionResult } from "@/lib/chat-engine";
import { resolveUserIdentity } from "@/lib/settings-storage";
import { cancelFollowUp } from "@/lib/follow-up-service";
import { resolveVoiceConfig, resolveUserVoiceConfig, synthesizeSpeech, playAudioBlob, playAudioBlobViaMediaElement, setCallAudioSessionActive, selectCallAudioOutput } from "@/lib/tts-service";
import { callRetryRange, originalCallSpeech, splitCallTranscript, VOICE_CALL_FORMAT } from "@/lib/call-transcript";
import type { Character } from "@/lib/character-types";
import { useCallKeyboardOffsetStyle } from "./use-call-keyboard-offset";
import { isIOSDevice } from "./voice-input-platform";
import { CallVolumeControl } from "./call-volume-control";
import { startIncomingCallVibration } from "@/lib/call-vibration";
import { useCallScreenSounds } from "@/lib/chat-sound";

// ── Types ───────────────────────────────────────────

type CallState =
    | "CONNECTING"
    | "IDLE"
    | "USER_SPEAKING"
    | "PROCESSING"
    | "AI_SPEAKING"
    | "ENDED";

type SubtitleEntry = {
    id: string;
    role: "user" | "assistant";
    text: string;
};

type VoiceCallScreenProps = {
    session: ChatSession;
    character: Character;
    onEnd: () => void;
    onConnect?: () => void;
    initiator?: "user" | "character";
    answered?: boolean;
    /** 通话是否处于缩小的悬浮窗状态：暂停麦克风监听/计时/语音播放，仅显示背景+名字 */
    minimized?: boolean;
    /** 点击左上角返回键：请求缩小为悬浮窗（通话逻辑冻结，不挂断） */
    onMinimize?: () => void;
    /** 点击悬浮窗：请求恢复为全屏通话界面 */
    onRestore?: () => void;
};

// ── Component ───────────────────────────────────────

export function VoiceCallScreen({ session, character, onEnd, onConnect, initiator = "user", answered = false, minimized = false, onMinimize, onRestore }: VoiceCallScreenProps) {
    const callIdentity = useChatCallIdentity(character, session);
    const effectiveUserAvatar = useChatUserAvatar(session);
    const iosDevice = isIOSDevice();
    const playCallAudio = useCallback((blob: Blob, onStart?: () => void) => iosDevice ? playAudioBlob(blob, onStart, true) : playAudioBlobViaMediaElement(blob, onStart, true), [iosDevice]);
    const keyboardOffsetStyle = useCallKeyboardOffsetStyle();
    const [callState, setRawCallState] = useState<CallState>(answered ? "IDLE" : "CONNECTING");
    const hasConnectedRef = useRef(false);
    const [callDuration, setCallDuration] = useState(0);
    const [subtitles, setSubtitles] = useState<SubtitleEntry[]>([]);
    const [inputOpen, setInputOpen] = useState(false);
    const inputOpenRef = useRef(false);
    const [roundStart, setRoundStart] = useState<string | null>(null);
    const [outputName, setOutputName] = useState("播放设备");
    const generationRef = useRef<AbortController | null>(null);
    const audioTokenRef = useRef(0);
    const [queuedTurns, setQueuedTurns] = useState(0);
    const [playingSubtitleId, setPlayingSubtitleId] = useState<string | null>(null);
    const [interimText, setInterimText] = useState("");
    const [typedText, setTypedText] = useState("");
    const [bgImageResolved, setBgImageResolved] = useState<string | null>(null);
    const [replyError, setReplyError] = useState<string | null>(null);
    const { speechFailure, clearSpeechFailure, reportSpeechFailure } = useSpeechFailure();

    const sttRef = useRef<{ abort: () => void } | null>(null);
    const audioAbortRef = useRef<(() => void) | null>(null);
    const subtitleAudioCacheRef = useRef(new Map<string, Blob>());
    const timerRef = useRef<NodeJS.Timeout | null>(null);
    const callStartRef = useRef<number>(0);
    const minimizedRef = useRef(false);
    const stateRef = useRef<string>(answered ? "IDLE" : "CONNECTING");
    const setCallState = useCallback((next: CallState) => { stateRef.current = next; setRawCallState(next); }, []);
    const setInputVisible = useCallback((open: boolean) => { inputOpenRef.current = open; setInputOpen(open); }, []);
    const interimTextRef = useRef<string>("");  // ref 版本，闭包安全
    const messagesRef = useRef<ChatMessage[]>([]);
    const [favoriteLine,setFavoriteLine]=useState<SubtitleEntry|null>(null);
    const lastAssistantTurnIdsRef = useRef<string[]>([]);
    const _initUi = resolveUserIdentity(session.contactId, "chat");
    const userNameRef = useRef<string>(_initUi?.name || "你");

    // Keep refs in sync
    useCallEndRecord(session.id, "voice", callDuration);
    useEffect(() => { stateRef.current = callState; }, [callState]);
    useEffect(() => {
        window.dispatchEvent(new CustomEvent("chat-call-state", { detail: { active: callState !== "ENDED", sessionId: session.id, type: "voice", phase: callState === "CONNECTING" ? "ringing" : "connected" } }));

    }, [callState, session.id]);
    useEffect(() => { minimizedRef.current = false; }, [minimized]);

    // 来电等待接听：循环振动（开关在聊天主页，iOS 网页不支持自动无效果）
    // + 来电/致电铃声与挂断音（角色专属提示音优先，其余在"全局聊天信息 → 提示音"）
    useCallScreenSounds({ initiator, callState, session });
    useEffect(() => {
        if (initiator !== "character" || callState !== "CONNECTING") return;
        const stop = startIncomingCallVibration();
        return stop;
    }, [initiator, callState]);

    // Pause WeChat keep-alive while the call holds the mic/audio; restore on exit.
    useEffect(() => {
        
        return () => {  };
    }, []);

    // 通话音频会话 + 卸载兜底：不经挂断键退出（返回聊天页/切会话/组件被销毁）时，
    // 把识别、在途播放与音频会话全部释放。此前识别的自动重启循环在卸载后条件
    // 恒成立（stateRef 停在 IDLE），会在后台无限自我重启，麦克风永不归还，
    // 整页音频被钉在通话模式（语音条/试听音量巨大且音量键失灵）。
    useEffect(() => {
        setCallAudioSessionActive(true);
        return () => {
            stateRef.current = "ENDED";
            generationRef.current?.abort();
            audioTokenRef.current++;
            if (sttRef.current) { sttRef.current.abort(); sttRef.current = null; }
            if (audioAbortRef.current) { audioAbortRef.current(); audioAbortRef.current = null; }
            window.dispatchEvent(new CustomEvent("chat-call-state", { detail: { active: false, sessionId: session.id } }));
            setCallAudioSessionActive(false);
        };
    }, []);
    useEffect(() => { interimTextRef.current = interimText; }, [interimText]);

    // ── Resolve voiceBackground from IndexedDB ──────

    useEffect(() => {
        if (!session.voiceBackground) {
            setBgImageResolved(null);
            return;
        }
        if (session.voiceBackground.startsWith("data:") || session.voiceBackground.startsWith("http")) {
            setBgImageResolved(session.voiceBackground);
            return;
        }
        // IndexedDB ID
        import("@/lib/chat-asset-storage").then(({ getChatImageFromIndexedDB }) => {
            getChatImageFromIndexedDB(session.voiceBackground!).then(dataUrl => {
                if (dataUrl) setBgImageResolved(dataUrl);
            });
        });
    }, [session.voiceBackground]);

    // ── Call timer ───────────────────────────────────

    useEffect(() => {
        if (callState === "CONNECTING" || callState === "ENDED") return;

        if (!callStartRef.current) {
            callStartRef.current = Date.now();
        }

        timerRef.current = setInterval(() => {
            setCallDuration(Math.floor((Date.now() - callStartRef.current) / 1000));
        }, 1000);

        return () => {
            if (timerRef.current) clearInterval(timerRef.current);
        };
    }, [callState]);

    // ── Connecting animation (3s fake dial) ─────────

    useEffect(() => {
        cancelFollowUp(session.id);

        // Resolve user name
        const ui = resolveUserIdentity(session.contactId, "chat");
        userNameRef.current = ui?.name || "你";

        // Load existing messages for context
        messagesRef.current = loadChatMessages(session.id);

        // Insert system message (skip if already exists from strict mode remount)
        const lastMsg = messagesRef.current[messagesRef.current.length - 1];
        const initRole = initiator === "character" ? "assistant" : "user";
        if (!lastMsg || !(lastMsg.content.includes("发起了语音通话"))) {
            const callMsg = initiator === "character"
                ? `[我向${userNameRef.current}发起了语音通话]`
                : `[我向${callIdentity.name}发起了语音通话]`;
            const sysMsg = pushChatMessage({
                sessionId: session.id,
                role: initRole,
                content: callMsg,
            });
            messagesRef.current = [...messagesRef.current, sysMsg];
        }

        // User-initiated: auto-connect after 3s fake dial
        // Character-initiated: wait for user to accept
        let connectTimer: NodeJS.Timeout | undefined;
        if (initiator !== "character" && !answered) {
            connectTimer = setTimeout(() => {
                setCallState("IDLE");
            }, 3000);
        }

        return () => {
            if (connectTimer) clearTimeout(connectTimer);
            if (timerRef.current) clearInterval(timerRef.current);
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Track first connect
    useEffect(() => {
        if (callState !== "CONNECTING" && !hasConnectedRef.current) {
            hasConnectedRef.current = true;
        }
    }, [callState]);

    // ── Format time MM:SS ───────────────────────────

    const formatTime = (seconds: number) => {
        const m = Math.floor(seconds / 60);
        const s = seconds % 60;
        return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
    };

    // ── State label ─────────────────────────────────

    const stateLabel = (): string => {
        switch (callState) {
            case "CONNECTING": return initiator === "character" ? "来电..." : "正在呼叫...";
            case "IDLE": return "通话中";
            case "USER_SPEAKING": return "正在聆听...";
            case "PROCESSING": return "对方正在思考...";
            case "AI_SPEAKING": return "对方正在说话...";
            case "ENDED": return "通话已结束";
        }
    };

    // ── AI response processing (same logic as chat-room) ──

    const processAIResponse = useCallback((aiResponseText: string): SubtitleEntry[] => {
        // Use shared parseAIResponse for full rich media support (stickers, quotes, etc.)
        const previousState = getLatestCharacterStateValues(session.contactId);

        const { parts, stateValues, freshStateValues, statusPanel, innerMonologue } = parseAIResponse(aiResponseText, previousState);

        // 自定义状态栏渲染戳：不盖的话 custom 模式下 [状态栏] 原文按 markdown 渲染，看着像掉格式
        const statusRegionMode = statusPanel && isCustomStatusRegionActive(getStatusRegionConfig(session.id))
            ? ("custom" as const)
            : undefined;

        // Filter out non-chat action types (voice_call, video_call, poke, etc.)
        const chatParts = parts.filter(p =>
            !p.mediaType || !["voice_call", "video_call", "poke", "accept_red_packet", "decline_red_packet", "accept_transfer", "decline_transfer", "accept_payment_request", "decline_payment_request"].includes(p.mediaType)
        );

        const spokenParts = chatParts.flatMap(part => part.mediaType === "audio" ? splitCallTranscript(part.mediaData?.label || part.content, false).map(line => ({ ...part, mediaType: undefined, mediaData: undefined, content: line.text })) : part.mediaType ? [] : splitCallTranscript(part.content, false).map(line => ({ ...part, content: line.text }))).filter(part => part.content.trim());
        if (!spokenParts.length) throw new Error("回复没有可显示的台词，请重试");
        const saved: ChatMessage[] = [];
        if (spokenParts.length === 0 && (statusPanel || innerMonologue)) {
            saved.push(pushChatMessage({
                sessionId: session.id,
                role: "assistant",
                content: "",
                statusPanel,
                statusRegionMode,
                innerMonologue,
                stateValues: stateValues.length > 0 ? stateValues : undefined,
                freshStateValues,
            }));
        } else {
            saved.push(...spokenParts.map((part, idx) =>
                pushChatMessage({
                    sessionId: session.id,
                    role: "assistant",
                    content: part.content,
                    mediaType: part.mediaType,
                    mediaData: part.mediaData,
                    statusPanel: idx === 0 && statusPanel ? statusPanel : undefined,
                    statusRegionMode: idx === 0 && statusPanel ? statusRegionMode : undefined,
                    innerMonologue: idx === 0 && innerMonologue ? innerMonologue : undefined,
                    stateValues: idx === 0 && stateValues.length > 0 ? stateValues : undefined,
                    freshStateValues: idx === 0 ? freshStateValues : undefined,
                })
            ));
        }
        messagesRef.current = [...messagesRef.current, ...saved];
        lastAssistantTurnIdsRef.current = saved.map(message => message.id);
        return saved.filter(message => !message.mediaType && message.content.trim())
            .map(message => ({ id: message.id, role: "assistant", text: message.content }));
    }, [session.id, session.contactId]);

    // ── Full conversation turn ──────────────────────

    const queueUserText = useCallback((userText: string) => {
        const text = userText.trim();
        if (!text || !inputOpenRef.current || !["IDLE", "USER_SPEAKING"].includes(stateRef.current)) return;
        setInputVisible(false);
        firstSpeakerDone.current=true;
        const userMsg = pushChatMessage({ sessionId: session.id, role: "user", content: text });
        messagesRef.current = [...messagesRef.current, userMsg];
        setSubtitles(prev => [...prev, { id: userMsg.id, role: "user", text }]);
        setQueuedTurns(count => count + 1);
        setInterimText("");
        setCallState("IDLE");
    }, [session.id]);

    const firstSpeakerDone=useRef(false);
    const firstSpeakerChoice=useRef<boolean|null>(null);
    const runConversationTurn = useCallback(async (retryId?: string) => {
        if (stateRef.current !== "IDLE") return;
        const range = retryId ? callRetryRange(messagesRef.current, retryId) : null;
        if (retryId && (!range || !subtitles.some(s => s.id === retryId && s.role === "assistant"))) return;
        const history = range ? range.history : [...messagesRef.current];
        const removedIds = range?.removed.map(m => m.id) || [];
        const discarded = new Set(removedIds);
        setInputVisible(false);
        sttRef.current?.abort(); sttRef.current = null;
        setCallState("PROCESSING"); setInterimText(""); setReplyError(null);
        const request = new AbortController(); generationRef.current = request;
        try {
            const text = flattenCompletionResult(await generateChatCompletion(session, history, { appTags: ["chat", "voice"], callFormatInstruction: `${VOICE_CALL_FORMAT}\n${SINGLE_CALL_ACTIONS}\n通话已接通；若本次通话还没有对话，请按既有关系自然先开口，不假装用户刚说过话。`, signal: request.signal }));
            if (request.signal.aborted || (stateRef.current as string) === "ENDED" || generationRef.current !== request) return;
            const output = parseCallOutput(text);
            const leaving = output.some(part => part.kind === "leave");
            const cleanText = output.filter(part => part.kind === "speech").map(part => part.text).join("\n");
            const newLines = cleanText.trim() ? processAIResponse(cleanText) : leaving ? [] : processAIResponse(cleanText);
            if (removedIds.length) {
                deleteChatMessagesByIds(session.id, removedIds);
                messagesRef.current = messagesRef.current.filter(m => !discarded.has(m.id));
                removedIds.forEach(id => subtitleAudioCacheRef.current.delete(id));
            }
            setSubtitles(prev => [...prev.filter(s => !discarded.has(s.id)), ...newLines]);
            setRoundStart(newLines[0]?.id || null); setQueuedTurns(0);
            if (leaving) { setCallState("ENDED"); audioTokenRef.current++; audioAbortRef.current?.(); setPlayingSubtitleId(null); const endMessage = pushChatMessage({sessionId:session.id,role:"assistant",content:`[${callIdentity.name}挂断了语音通话]`,mediaData:{callDuration:formatTime(callDuration)}}); messagesRef.current.push(endMessage); setTimeout(onEnd,500); }
        } catch (error) {
            if (!request.signal.aborted && (stateRef.current as string) !== "ENDED") setReplyError(error instanceof Error ? error.message : "回复失败，请重试");
        } finally {
            if (generationRef.current === request) { generationRef.current = null; if ((stateRef.current as string) !== "ENDED") setCallState("IDLE"); }
        }
    }, [session, processAIResponse, subtitles, setCallState, setInputVisible, callIdentity.name, callDuration, onEnd]);

    useEffect(()=>{
        if(callState!=="IDLE" || firstSpeakerDone.current  )return;
        if(firstSpeakerChoice.current===null)firstSpeakerChoice.current=characterSpeaksFirst(session.contactId);
        const timer=setTimeout(()=>{if(stateRef.current!=="IDLE")return;firstSpeakerDone.current=true;if(firstSpeakerChoice.current)void runConversationTurn();},0);
        return ()=>clearTimeout(timer);
    },[callState,minimized,session.contactId,runConversationTurn]);

    const playSubtitle = useCallback(async (subtitle: SubtitleEntry) => {
        if (playingSubtitleId === subtitle.id) { audioTokenRef.current++; audioAbortRef.current?.(); setPlayingSubtitleId(null); if ((stateRef.current as string) !== "ENDED") setCallState("IDLE"); return; }
        if (stateRef.current !== "IDLE") return;
        const voiceConfig = subtitle.role === "user" ? resolveUserVoiceConfig() : resolveVoiceConfig(session.contactId);
        if (!voiceConfig) { setReplyError(subtitle.role === "user" ? "请先在全局聊天信息中选择用户语音配置" : "请先给角色绑定语音配置"); return; }
        const token = ++audioTokenRef.current;
        sttRef.current?.abort(); sttRef.current = null;
        setCallState("AI_SPEAKING"); setReplyError(null);
        clearSpeechFailure();
        let stage: "synthesis" | "playback" = "synthesis";
        try {
            let blob = subtitleAudioCacheRef.current.get(subtitle.id);
            if (!blob) blob = await synthesizeSpeech(originalCallSpeech(subtitle.text), voiceConfig) || undefined;
            if (token !== audioTokenRef.current || (stateRef.current as string) === "ENDED") return;
            if (!blob) throw new Error("语音合成未返回音频");
            subtitleAudioCacheRef.current.set(subtitle.id, blob);
            stage = "playback";
            let started = false;
            const { promise, abort } = playCallAudio(blob, () => { if (token === audioTokenRef.current && (stateRef.current as string) !== "ENDED") { started = true; setPlayingSubtitleId(subtitle.id); } });
            audioAbortRef.current = abort; await promise;
            if (!started && token === audioTokenRef.current) throw new Error("播放未开始，请重听或检查浏览器音频权限");
        } catch (error) { if (token === audioTokenRef.current && (stateRef.current as string) !== "ENDED") reportSpeechFailure(stage, error, () => { void playSubtitle(subtitle); }); }
        finally { if (token === audioTokenRef.current) { audioAbortRef.current = null; setPlayingSubtitleId(null); if ((stateRef.current as string) !== "ENDED") setCallState("IDLE"); } }
    }, [session.contactId, playCallAudio, playingSubtitleId, setCallState]);

    const deleteSubtitle = useCallback((id: string) => {
        if (["PROCESSING", "CONNECTING", "ENDED"].includes(stateRef.current)) return;
        if (!subtitles.some(s => s.id === id && s.role === "assistant")) return;
        audioTokenRef.current++; audioAbortRef.current?.(); audioAbortRef.current = null;
        setPlayingSubtitleId(null); subtitleAudioCacheRef.current.delete(id);
        deleteChatMessagesByIds(session.id, [id]);
        messagesRef.current = messagesRef.current.filter(m => m.id !== id);
        lastAssistantTurnIdsRef.current = lastAssistantTurnIdsRef.current.filter(v => v !== id);
        setSubtitles(prev => prev.filter(s => s.id !== id)); setCallState("IDLE");
    }, [session.id, subtitles, setCallState]);

    const handleTextSubmit = useCallback(() => {
        const text = typedText.trim();
        if (!text || callState !== "IDLE") return;
        if (sttRef.current) {
            sttRef.current.abort();
            sttRef.current = null;
        }
        setTypedText("");
        queueUserText(text);
    }, [typedText, callState, queueUserText]);

    // Arrow summons a new reply; reroll replaces the last assistant turn.
    const handleRegenerate = useCallback(() => {
        if (callState !== "IDLE") return;
        if (sttRef.current) {
            sttRef.current.abort();
            sttRef.current = null;
        }
        void runConversationTurn();
    }, [callState, runConversationTurn]);
    // ── Hangup ──────────────────────────────────────

    const handleHangup = useCallback(() => {
        generationRef.current?.abort(); audioTokenRef.current++; setInputVisible(false);
        setCallState("ENDED");

        // Stop any ongoing STT
        if (sttRef.current) {
            sttRef.current.abort();
            sttRef.current = null;
        }

        // Stop any ongoing audio playback
        if (audioAbortRef.current) {
            audioAbortRef.current();
            audioAbortRef.current = null;
        }

        // Stop browser TTS
        if (window.speechSynthesis) {
            window.speechSynthesis.cancel();
        }

        const endMsg = pushChatMessage({
            sessionId: session.id,
            role: "user",
            content: `[我挂断了语音通话]`,
            mediaData: { callDuration: formatTime(callDuration) },
        });
        messagesRef.current = [...messagesRef.current, endMsg];

        // Delay then close
        setTimeout(() => onEnd(), 1500);
    }, [session.id, callDuration, onEnd]);

    // ── Render ──────────────────────────────────────

    if (minimized) {
        return (
            <DraggableMediaWindow label={`返回与${callIdentity.name}的语音通话`} onOpen={onRestore} style={{backgroundImage:`url(${bgImageResolved || callIdentity.avatar || ""})`}}><span className="call-mini-window-overlay"/><span className="call-mini-window-name">{callIdentity.name}</span></DraggableMediaWindow>
        );
    }

    const closeInput = () => {
        setInputVisible(false); sttRef.current?.abort(); sttRef.current = null;
        setInterimText(""); if (stateRef.current === "USER_SPEAKING") setCallState("IDLE");
    };
    const decline = () => {
        setCallState("ENDED"); generationRef.current?.abort();
        pushChatMessage({ sessionId: session.id, role: "user", content: initiator === "character" ? "[我拒绝了语音通话]" : "[我取消了语音通话]" }); onEnd();
    };
    return <div className="absolute inset-0 z-[100] overflow-hidden voicecall-dark voicecall-cards" style={bgImageResolved ? { ...keyboardOffsetStyle, background: `url(${bgImageResolved}) center/cover no-repeat` } : keyboardOffsetStyle}>
        <>
        {favoriteLine && <VoiceFavoriteDialog key={favoriteLine.id} draft={{kind:"call",sourceKey:`${session.id}:voice:${favoriteLine.id}`,text:originalCallSpeech(favoriteLine.text),characterId:session.contactId,role:favoriteLine.role,getAudio:async()=>subtitleAudioCacheRef.current.get(favoriteLine.id)}} onClose={()=>setFavoriteLine(null)}/> }
        {callState !== "ENDED" && <SpeechFailureNotice failure={speechFailure} onClose={clearSpeechFailure} busy={callState !== "IDLE"}/>}
        <VoiceCallLayout name={callIdentity.name} avatar={callIdentity.avatar} userName={userNameRef.current} userAvatar={effectiveUserAvatar} lines={subtitles} roundStart={roundStart} playingId={playingSubtitleId} state={callState} duration={formatTime(callDuration)} queued={queuedTurns} error={replyError} onClearError={() => setReplyError(null)} onMinimize={onMinimize} onSummon={handleRegenerate} onInput={() => setInputVisible(true)} onHangup={handleHangup} incoming={initiator === "character"} onAccept={() => setCallState("IDLE")} onDecline={decline} onPlay={playSubtitle} onFavorite={id=>setFavoriteLine(subtitles.find(line=>line.id===id)||null)} onRetry={id => void runConversationTurn(id)} onDelete={deleteSubtitle} outputName={outputName} onOutput={() => { void selectCallAudioOutput().then(() => setOutputName("已选设备")).catch(error => setReplyError(error instanceof Error ? error.message : "请在系统中选择播放设备")); }} settings={<><CallVolumeControl/><p>逐句点击喇叭重听 长按台词可重试以下或删除</p><p>输入后点击召唤才生成回复</p></>} input={inputOpen && <div className="chat-call-dialog-backdrop chat-call-input-backdrop" onClick={closeInput}><div className="chat-call-dialog chat-call-input-dialog" style={keyboardOffsetStyle} role="dialog" aria-modal="true" aria-label="通话输入" onClick={e=>e.stopPropagation()}><header><strong>输入消息</strong><button onClick={closeInput} aria-label="关闭输入"><X/></button></header><form onSubmit={e=>{e.preventDefault();handleTextSubmit();}}><textarea autoFocus rows={3} value={typedText} onChange={e=>setTypedText(e.target.value)} onKeyDown={e=>{if(e.key==="Enter" && !e.shiftKey && !e.nativeEvent.isComposing){e.preventDefault();handleTextSubmit();}}} placeholder="说点什么…"/><button type="submit" disabled={!typedText.trim() || callState !== "IDLE"}><Send size={16}/>发送</button></form></div></div>}/></>
    </div>;
}
