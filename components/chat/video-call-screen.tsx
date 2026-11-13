"use client";
import {DraggableMediaWindow} from "@/components/ui/draggable-media-window";
import {characterSpeaksFirst} from "@/lib/call-first-speaker";
import { VoiceFavoriteDialog } from "./voice-favorite-dialog";
import { useCallEndRecord } from "./use-call-end-record";
import { parseCallOutput, SINGLE_CALL_ACTIONS } from "@/lib/call-participation";
import { useChatCallIdentity, useChatUserAvatar, useGlobalCallAppearance } from "./use-chat-user-avatar";

import { useState, useRef, useEffect, useCallback } from "react";
import { ChatSession, ChatMessage, loadChatMessages, pushChatMessage, deleteChatMessagesByIds, editChatMessage, getLatestCharacterStateValues, resolveChatUserAvatar } from "@/lib/chat-storage";
import { getStatusRegionConfig, isCustomStatusRegionActive } from "@/lib/chat-status-region";
import { RotateCcw, Upload, Video, VideoOff, PhoneOff, MessageSquare, MessageSquareOff } from "lucide-react";
import {Call039Transcript, type Call039Command} from "./call039-transcript";
import type {Call039Line} from "./call039-shared-ui";
import { parseStateValues, mergeStateValues } from "@/lib/state-value-parser";
import { parseAIResponse } from "@/lib/rich-message-parser";
import { generateChatCompletion, flattenCompletionResult } from "@/lib/chat-engine";
import { resolveUserIdentity } from "@/lib/settings-storage";
import { cancelFollowUp } from "@/lib/follow-up-service";
import { createSTTSession, type STTSession } from "@/lib/stt-service";
import { resolveVoiceConfig, resolveUserVoiceConfig, synthesizeSpeech, playAudioBlob, playAudioBlobViaMediaElement, setCallAudioSessionActive } from "@/lib/tts-service";
import { isCallRecordingSupported, resolveCloudSttConfig } from "@/lib/stt-cloud";
import { useHoldToTalk } from "./use-hold-to-talk";
import { CallTranscriptBubble } from "./call-transcript-bubble";
import { displayCallAction, originalCallSpeech, splitCallTranscript, VIDEO_CALL_FORMAT } from "@/lib/call-transcript";
import type { Character } from "@/lib/character-types";
import { useCallKeyboardOffsetStyle } from "./use-call-keyboard-offset";
import { CallSttWarningDialog, hideCallSttWarningPermanently, isCallSttWarningHidden } from "./call-stt-warning-dialog";
import { isAndroidBrowser, isIOSDevice } from "./voice-input-platform";
import { UploadedVideoVolumeControl } from "./call-volume-control";
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
    kind: "speech" | "action";
};

type VideoCallScreenProps = {
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

export function VideoCallScreen({ session, character, onEnd, onConnect, initiator = "user", answered = false, minimized = false, onMinimize, onRestore }: VideoCallScreenProps) {
    const callIdentity = useChatCallIdentity(character, session);
    const effectiveUserAvatar = useChatUserAvatar(session);
    const globalCallAppearance = useGlobalCallAppearance();
    // 同 voice-call-screen：iOS 保留 Web Speech 免提 + Web Audio 播放；
    // 其余设备改按住说话 + 云端转写，播放走媒体元素。没配识别时回落旧行为。
    const iosDeviceRef = useRef(isIOSDevice());
    const iosDevice = iosDeviceRef.current;
    const holdToTalkRef = useRef(
        !iosDeviceRef.current && isCallRecordingSupported() && resolveCloudSttConfig(session.contactId) !== null,
    );
    const holdToTalk = holdToTalkRef.current;
    const androidTextInputOnlyRef = useRef(isAndroidBrowser() && !holdToTalkRef.current);
    const androidTextInputOnly = androidTextInputOnlyRef.current;
    const playCallAudio = iosDevice ? playAudioBlob : playAudioBlobViaMediaElement;
    const keyboardOffsetStyle = useCallKeyboardOffsetStyle();
    const [callState, setCallState] = useState<CallState>(answered ? "IDLE" : "CONNECTING");
    const hasConnectedRef = useRef(false);
    const [callDuration, setCallDuration] = useState(0);
    const [subtitles, setSubtitles] = useState<SubtitleEntry[]>([]);
    const [queuedTurns, setQueuedTurns] = useState(0);
    const [playingSubtitleId, setPlayingSubtitleId] = useState<string | null>(null);
    const subtitleAudioCacheRef = useRef(new Map<string, Blob>());
    const [interimText, setInterimText] = useState("");
    const [isMuted, setIsMuted] = useState(false);
    const [isSpeakerMuted, setIsSpeakerMuted] = useState(false);
    const [inputMode, setInputMode] = useState<"voice" | "text">("text");
    const [typedText, setTypedText] = useState("");
    const [composeKind, setComposeKind] = useState<"speech" | "action">("speech");
    const [bgImageResolved, setBgImageResolved] = useState<string | null>(null);
    const [callAppearanceResolved, setCallAppearanceResolved] = useState<string | null>(null);
    const [cameraEnabled, setCameraEnabled] = useState(false);
    const [cameraFacingMode, setCameraFacingMode] = useState<"user" | "environment">("user");
    const [cameraError, setCameraError] = useState<string | null>(null);
    const [replyError, setReplyError] = useState<string | null>(null);
    const [showSttWarning, setShowSttWarning] = useState(false);

    const sttRef = useRef<STTSession | null>(null);
    const audioTokenRef = useRef(0);
    const audioAbortRef = useRef<(() => void) | null>(null);
    const timerRef = useRef<NodeJS.Timeout | null>(null);
    const subtitlesScrollRef = useRef<HTMLDivElement | null>(null);
    const callStartRef = useRef<number>(0);
    const pausedAtRef = useRef<number | null>(null);
    const minimizedRef = useRef(false);
    const stateRef = useRef<string>(answered ? "IDLE" : "CONNECTING");
    const interimTextRef = useRef<string>("");
    const sttWarningShownRef = useRef(false);
    const messagesRef = useRef<ChatMessage[]>([]);
    const [favoriteLine,setFavoriteLine]=useState<SubtitleEntry|null>(null);
    const lastAssistantTurnIdsRef = useRef<string[]>([]);
    const pendingRerollIds039 = useRef<string[]>([]);
    const [transcriptVisible039,setTranscriptVisible039] = useState(true);
    const [temporaryVideo039,setTemporaryVideo039] = useState<string|null>(null);
    const [uploadedVideoVolume, setUploadedVideoVolume] = useState(0);
    const uploadedVideoElement = useRef<HTMLVideoElement|null>(null);
    const adjustUploadedVideoVolume = (value: number) => {
        const v = Math.max(0,Math.min(1,value));
        setUploadedVideoVolume(v);
        const el=uploadedVideoElement.current;
        if(el){el.volume=v;el.muted=v===0;if(v>0)void el.play().catch(()=>{});}
    };
    const temporaryVideoRef039 = useRef<string|null>(null);
    const temporaryVideoFile039 = useRef<HTMLInputElement|null>(null);
    const [uploadNotice039,setUploadNotice039] = useState(false);
    const uploadApproved039 = useRef(false);
    const resetTemporaryVideo039 = () => {if(temporaryVideoRef039.current)URL.revokeObjectURL(temporaryVideoRef039.current);temporaryVideoRef039.current=null;setTemporaryVideo039(null);};
    const acceptTemporaryVideo039 = async (file?:File) => {
        if(!file)return;
        if(file.size>20*1024*1024){setCameraError("通话视频不能超过20MB");return;}
        const url=URL.createObjectURL(file);
        const sample=document.createElement("video");sample.preload="metadata";sample.src=url;
        const duration=await new Promise<number>(resolve=>{sample.onloadedmetadata=()=>resolve(sample.duration);sample.onerror=()=>resolve(NaN);setTimeout(()=>resolve(NaN),5000);});
        if(!Number.isFinite(duration)||duration<=0||duration>15){URL.revokeObjectURL(url);setCameraError("请选择15秒以内的可播放视频");return;}
        resetTemporaryVideo039();temporaryVideoRef039.current=url;setTemporaryVideo039(url);
    };
    useEffect(()=>()=>{if(temporaryVideoRef039.current)URL.revokeObjectURL(temporaryVideoRef039.current);},[]);

    const cameraStreamRef = useRef<MediaStream | null>(null);
    const cameraEnabledRef = useRef<boolean>(false);
    const videoElRef = useRef<HTMLVideoElement | null>(null);
    const isSpeakerMutedRef = useRef<boolean>(false);
    const _initUi = resolveUserIdentity(session.contactId, "chat");
    const userNameRef = useRef<string>(_initUi?.name || "你");
    const userAvatarRef = useRef<string | null>(resolveChatUserAvatar(session, _initUi?.avatarUrl) || null);

    useCallEndRecord(session.id, "video", callDuration);
    useEffect(() => { stateRef.current = callState; }, [callState]);
    useEffect(() => {
        window.dispatchEvent(new CustomEvent("chat-call-state", { detail: { active: callState !== "ENDED", sessionId: session.id, type: "video", phase: callState === "CONNECTING" ? "ringing" : "connected" } }));

    }, [callState, session.id]);
    useEffect(() => { minimizedRef.current = minimized; }, [minimized]);

    // 缩小为悬浮窗：冻结通话——停止监听、打断在播放的语音（摄像头继续保留，方便恢复时不用重新申请权限）
    useEffect(() => {
        if (!minimized) return;
        audioTokenRef.current++; setPlayingSubtitleId(null); if (stateRef.current === "AI_SPEAKING") {stateRef.current="IDLE";setCallState("IDLE");}
        if (sttRef.current) { sttRef.current.abort(); sttRef.current = null; }
        setInterimText("");
        if (audioAbortRef.current) { audioAbortRef.current(); audioAbortRef.current = null; }
        if (window.speechSynthesis) window.speechSynthesis.cancel();
    }, [minimized]);

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
    useEffect(() => { interimTextRef.current = interimText; }, [interimText]);
    useEffect(() => { cameraEnabledRef.current = cameraEnabled; }, [cameraEnabled]);

    const showSttCompatibilityWarning = useCallback(() => {
        if (androidTextInputOnly) {
            setInputMode("text");
            return;
        }
        if (sttWarningShownRef.current || isCallSttWarningHidden()) return;
        sttWarningShownRef.current = true;
        setShowSttWarning(true);
    }, [androidTextInputOnly]);

    const call039Edit = (line:Call039Line,original:string,translated:string) => {
        const current=subtitles.find(item=>item.id===line.id);if(!current)return;
        const content=current.kind==="action" ? original : original+(translated?" | "+translated:"");
        editChatMessage(line.id,current.kind==="action"?"【动作】"+content:content);
        messagesRef.current=messagesRef.current.map(m=>m.id===line.id?{...m,content:current.kind==="action"?"【动作】"+content:content}:m);
        setSubtitles(prev=>prev.map(item=>item.id===line.id?{...item,text:content}:item));
        if(originalCallSpeech(current.text)!==original)subtitleAudioCacheRef.current.delete(line.id);
    };
    const call039Command = (op:Call039Command,line:Call039Line) => {
        if(callState!=="IDLE")return;
        const idx=subtitles.findIndex(item=>item.id===line.id);if(idx<0)return;
        if(op==="favorite"){const original=subtitles[idx];if(original.kind==="speech")setFavoriteLine(original);return;}
        if(op==="delete"||op==="delete-after"){
            const ids=(op==="delete"?[line.id]:subtitles.slice(idx+1).map(item=>item.id));
            if(ids.length){deleteChatMessagesByIds(session.id,ids);messagesRef.current=messagesRef.current.filter(m=>!ids.includes(m.id));
              ids.forEach(id=>subtitleAudioCacheRef.current.delete(id));
              setSubtitles(prev=>prev.filter(item=>!ids.includes(item.id)));}
            return;
        }
        const start=op==="reroll-after"?idx+1:(()=>{let i=idx;while(i>0&&subtitles[i-1].role==="assistant"&&subtitles[i-1].kind&&subtitles[i-1].id!==subtitles[i].id)i--;return i;})();
        const toReplace=subtitles.slice(start).map(item=>item.id);
        if(!toReplace.length){void runConversationTurn(false,true);return;}
        pendingRerollIds039.current=toReplace;void runConversationTurn(true,false);
    };
    const handleNeverShowSttWarning = useCallback(() => {
        hideCallSttWarningPermanently();
        setShowSttWarning(false);
    }, []);

    useEffect(() => {
        const el = subtitlesScrollRef.current;
        if (!el) return;
        const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
        if (distanceFromBottom < 60) {
            window.requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
        }
    }, [subtitles.length, interimText]);
    useEffect(() => {
        isSpeakerMutedRef.current = isSpeakerMuted;
        if (isSpeakerMuted) {
            audioTokenRef.current++; setPlayingSubtitleId(null); if (stateRef.current === "AI_SPEAKING") { stateRef.current="IDLE"; setCallState("IDLE"); }
        }
        if (isSpeakerMuted && audioAbortRef.current) {
            audioAbortRef.current();
            audioAbortRef.current = null;
        }
    }, [isSpeakerMuted]);

    useEffect(() => {
        if (!cameraError) return;
        const timer = window.setTimeout(() => setCameraError(null), 3500);
        return () => window.clearTimeout(timer);
    }, [cameraError]);

    const stopCameraStream = useCallback(() => {
        const stream = cameraStreamRef.current;
        if (stream) {
            stream.getTracks().forEach((track) => track.stop());
            cameraStreamRef.current = null;
        }
        if (videoElRef.current) {
            videoElRef.current.srcObject = null;
        }
    }, []);

    const startCameraStream = useCallback(async (facingMode: "user" | "environment") => {
        if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
            setCameraError("当前环境不支持摄像头");
            return false;
        }
        // 安卓必须先释放旧流：摄像头被旧 track 占用时，请求另一颗摄像头会失败，
        // 或在 ideal 模式下被静默降级回前置（看起来"切不动"）。
        stopCameraStream();
        try {
            let stream: MediaStream;
            try {
                // exact 优先：切换语义明确，拿不到目标摄像头时真正报错而非静默回退
                stream = await navigator.mediaDevices.getUserMedia({
                    video: { facingMode: { exact: facingMode }, width: { ideal: 640 }, height: { ideal: 480 } },
                    audio: false,
                });
            } catch {
                stream = await navigator.mediaDevices.getUserMedia({
                    video: { facingMode: { ideal: facingMode }, width: { ideal: 640 }, height: { ideal: 480 } },
                    audio: false,
                });
            }
            cameraStreamRef.current = stream;
            if (videoElRef.current) {
                videoElRef.current.srcObject = stream;
                videoElRef.current.play().catch(() => {});
            }
            return true;
        } catch (err) {
            console.warn("[VideoCall] getUserMedia failed:", err);
            setCameraError("无法访问摄像头");
            return false;
        }
    }, [stopCameraStream]);

    const handleCameraToggle = useCallback(async () => {
        if (cameraEnabled) {
            stopCameraStream();
            setCameraEnabled(false);
            return;
        }
        const ok = await startCameraStream(cameraFacingMode);
        if (ok) setCameraEnabled(true);
    }, [cameraEnabled, cameraFacingMode, startCameraStream, stopCameraStream]);

    const handleSwitchFacing = useCallback(async () => {
        if (!cameraEnabled) {
            setCameraError("请先打开摄像头");
            return;
        }
        const next: "user" | "environment" = cameraFacingMode === "user" ? "environment" : "user";
        const ok = await startCameraStream(next);
        if (ok) setCameraFacingMode(next);
        else {
            setCameraError("无法切换摄像头");
            await startCameraStream(cameraFacingMode);
        }
    }, [cameraEnabled, cameraFacingMode, startCameraStream]);

    const captureCameraFrame = useCallback((): string | null => {
        const video = videoElRef.current;
        if (!cameraEnabledRef.current || !video || !video.videoWidth || !video.videoHeight) return null;
        try {
            const canvas = document.createElement("canvas");
            const targetWidth = 640;
            const targetHeight = Math.round((video.videoHeight / video.videoWidth) * targetWidth);
            canvas.width = targetWidth;
            canvas.height = targetHeight;
            const ctx = canvas.getContext("2d");
            if (!ctx) return null;
            ctx.drawImage(video, 0, 0, targetWidth, targetHeight);
            return canvas.toDataURL("image/jpeg", 0.7);
        } catch (err) {
            console.warn("[VideoCall] frame capture failed:", err);
            return null;
        }
    }, []);

    // ── Resolve videoBackground from IndexedDB ──────

    useEffect(() => {
        if (!session.videoBackground) {
            setBgImageResolved(null);
            return;
        }
        if (session.videoBackground.startsWith("data:") || session.videoBackground.startsWith("http")) {
            setBgImageResolved(session.videoBackground);
            return;
        }
        import("@/lib/chat-asset-storage").then(({ getChatImageFromIndexedDB }) => {
            getChatImageFromIndexedDB(session.videoBackground!).then(dataUrl => {
                if (dataUrl) setBgImageResolved(dataUrl);
            });
        });
    }, [session.videoBackground]);
    useEffect(() => {
        const reference = session.callAppearance || globalCallAppearance;
        if (!reference) { setCallAppearanceResolved(null); return; }
        if (/^(data:|https?:)/i.test(reference)) { setCallAppearanceResolved(reference); return; }
        let cancelled = false;
        import("@/lib/chat-asset-storage").then(({ getChatImageFromIndexedDB }) =>
            getChatImageFromIndexedDB(reference).then(url => { if (!cancelled) setCallAppearanceResolved(url || null); })
        );
        return () => { cancelled = true; };
    }, [session.callAppearance, globalCallAppearance]);

    // ── Call timer ───────────────────────────────────

    useEffect(() => {
        if (callState === "CONNECTING" || callState === "ENDED") return;
        if (!callStartRef.current) callStartRef.current = Date.now();

        // 缩小为悬浮窗：冻结计时显示，不再推进
        if (minimized) {
            if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
            if (pausedAtRef.current === null) pausedAtRef.current = Date.now();
            return;
        }
        // 从悬浮窗恢复：把冻结期间流逝的时间补回起点，避免时长跳变
        if (pausedAtRef.current !== null) {
            callStartRef.current += Date.now() - pausedAtRef.current;
            pausedAtRef.current = null;
        }

        timerRef.current = setInterval(() => {
            setCallDuration(Math.floor((Date.now() - callStartRef.current) / 1000));
        }, 1000);

        return () => { if (timerRef.current) clearInterval(timerRef.current); };
    }, [callState, minimized]);

    // ── Connecting animation ─────────────────────────

    useEffect(() => {
        cancelFollowUp(session.id);

        const ui = resolveUserIdentity(session.contactId, "chat");
        userNameRef.current = ui?.name || "你";
        userAvatarRef.current = resolveChatUserAvatar(session, ui?.avatarUrl) || null;

        messagesRef.current = loadChatMessages(session.id);

        const lastMsg = messagesRef.current[messagesRef.current.length - 1];
        const initRole = initiator === "character" ? "assistant" : "user";
        if (!lastMsg || !(lastMsg.content.includes("发起了视频通话"))) {
            const callMsg = initiator === "character"
                ? `[我向${userNameRef.current}发起了视频通话]`
                : `[我向${callIdentity.name}发起了视频通话]`;
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
            connectTimer = setTimeout(() => setCallState("IDLE"), 3000);
        }

        return () => {
            if (connectTimer) clearTimeout(connectTimer);
            if (timerRef.current) clearInterval(timerRef.current);
            stopCameraStream();
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Track first connect
    useEffect(() => {
        if (callState !== "CONNECTING" && !hasConnectedRef.current) {
            hasConnectedRef.current = true;
        }
    }, [callState]);

    const formatTime = (seconds: number) => {
        const m = Math.floor(seconds / 60);
        const s = seconds % 60;
        return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
    };

    const stateLabel = (): string => {
        switch (callState) {
            case "CONNECTING": return initiator === "character" ? "来电..." : "正在呼叫...";
            case "IDLE": return isMuted ? "已静音" : "视频通话中";
            case "USER_SPEAKING": return "正在聆听...";
            case "PROCESSING": return "对方正在思考...";
            case "AI_SPEAKING": return playingSubtitleId ? "正在播放…" : "准备语音…";
            case "ENDED": return "通话已结束";
        }
    };

    // ── AI response processing ──

    const processAIResponse = useCallback((aiResponseText: string): SubtitleEntry[] => {
        const previousState = getLatestCharacterStateValues(session.contactId);

        const { parts, stateValues, freshStateValues, statusPanel, innerMonologue } = parseAIResponse(aiResponseText, previousState);

        // 自定义状态栏渲染戳：不盖的话 custom 模式下 [状态栏] 原文按 markdown 渲染，看着像掉格式
        const statusRegionMode = statusPanel && isCustomStatusRegionActive(getStatusRegionConfig(session.id))
            ? ("custom" as const)
            : undefined;

        // Filter out non-chat action types
        const chatParts = parts.filter(p =>
            !p.mediaType || !["voice_call", "video_call", "poke", "accept_red_packet", "decline_red_packet", "accept_transfer", "decline_transfer", "accept_payment_request", "decline_payment_request"].includes(p.mediaType)
        );

        const displayParts = chatParts.flatMap(part => part.mediaType ? [{ ...part, callKind: "speech" as const }] :
            splitCallTranscript(part.content, true).map(line => ({ ...part, content: line.kind === "action" ? `【动作】${line.text}` : line.text, callKind: line.kind })));
        const saved: ChatMessage[] = [];
        if (displayParts.length === 0 && (statusPanel || innerMonologue)) {
            saved.push(pushChatMessage({
                sessionId: session.id, role: "assistant", content: "",
                statusPanel,
                statusRegionMode,
                innerMonologue, stateValues: stateValues.length > 0 ? stateValues : undefined,
                freshStateValues,
            }));
        } else {
            saved.push(...displayParts.map((part, idx) =>
                pushChatMessage({
                    sessionId: session.id, role: "assistant", content: part.content,
                    mediaType: part.mediaType,
                    mediaData: { ...part.mediaData, callLineKind: part.callKind },
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
        return saved.filter(message => !message.mediaType && message.content.trim()).map(message => ({
            id: message.id, role: "assistant", kind: message.mediaData?.callLineKind || "speech",
            text: message.mediaData?.callLineKind === "action" ? displayCallAction(message.content.replace(/^【动作】/, "")) : message.content,
        }));
    }, [session.id, session.contactId]);

    // ── Full conversation turn ──────────────────────

    const queueUserText = useCallback((text: string, kind: "speech" | "action" = "speech") => {
        if (!text.trim() || stateRef.current === "ENDED" || minimizedRef.current) return;
        firstSpeakerDone.current=true;
        const userMsg = pushChatMessage({ sessionId: session.id, role: "user", content: kind === "action" ? `【动作】${text.trim()}` : text.trim(), mediaData: { callLineKind: kind } });
        messagesRef.current = [...messagesRef.current, userMsg];
        setSubtitles(prev => [...prev, { id: userMsg.id, role: "user", text: text.trim(), kind }]);
        setQueuedTurns(count => count + 1);
        setInterimText("");
        setCallState("IDLE");
    }, [session.id]);

    const firstSpeakerDone=useRef(false);
    const firstSpeakerChoice=useRef<boolean|null>(null);
    const runConversationTurn = useCallback(async (reroll = false, manual = false) => {
        setCallState("PROCESSING");
        setInterimText("");
        setReplyError(null);
        const replacedIds = reroll ? (pendingRerollIds039.current.length ? [...pendingRerollIds039.current] : [...lastAssistantTurnIdsRef.current]) : [];
        pendingRerollIds039.current = [];
        const discarded = new Set(replacedIds);
        const history = reroll ? messagesRef.current.filter(message => !discarded.has(message.id)) : messagesRef.current;

        try {
            const frame = manual ? captureCameraFrame() : null;
            const aiResponseText = flattenCompletionResult(await generateChatCompletion(session, history, {
                appTags: ["chat", "video"],
                callFormatInstruction: `${VIDEO_CALL_FORMAT}\n${SINGLE_CALL_ACTIONS}\n通话已接通；若本次通话还没有对话，请按既有关系自然先开口，不假装用户刚说过话。`,
                attachedImages: frame ? [frame] : undefined,
            }));
            if (stateRef.current === "ENDED") return;

            const output = parseCallOutput(aiResponseText);
            const leaving = output.some(part => part.kind === "leave");
            const cleanText = output.filter(part => part.kind === "speech").map(part => part.text).join("\n");
            const newLines = processAIResponse(cleanText);
            if (reroll && replacedIds.length) {
                if (!lastAssistantTurnIdsRef.current.length) {
                    lastAssistantTurnIdsRef.current = replacedIds;
                    throw new Error("回复为空，请重试");
                }
                deleteChatMessagesByIds(session.id, replacedIds);
                messagesRef.current = messagesRef.current.filter(message => !discarded.has(message.id));
                replacedIds.forEach(id => subtitleAudioCacheRef.current.delete(id));
            }
            setSubtitles(prev => [...prev.filter(subtitle => !discarded.has(subtitle.id)), ...newLines]);
            setQueuedTurns(0);
            if (leaving) { stateRef.current="ENDED"; setCallState("ENDED"); audioTokenRef.current++; audioAbortRef.current?.(); setPlayingSubtitleId(null); pushChatMessage({sessionId:session.id,role:"assistant",content:`[${callIdentity.name}挂断了视频通话]`,mediaData:{callDuration:formatTime(callDuration)}}); setTimeout(onEnd,500); }
            else if (stateRef.current !== "ENDED") setCallState("IDLE");
        } catch (error: any) {
            if (stateRef.current !== "ENDED") {
                setReplyError(error?.message || "发送失败");
                setCallState("IDLE");
            }
        }
    }, [session, processAIResponse, captureCameraFrame, callIdentity.name, callDuration, onEnd]);

    useEffect(()=>{
        if(callState!=="IDLE" || firstSpeakerDone.current || minimized)return;
        if(firstSpeakerChoice.current===null)firstSpeakerChoice.current=characterSpeaksFirst(session.contactId);
        const timer=setTimeout(()=>{if(stateRef.current!=="IDLE")return;firstSpeakerDone.current=true;if(firstSpeakerChoice.current)void runConversationTurn();},0);
        return ()=>clearTimeout(timer);
    },[callState,minimized,session.contactId,runConversationTurn]);

    const playSubtitle = useCallback(async (subtitle: SubtitleEntry) => {
        if (playingSubtitleId === subtitle.id) { audioTokenRef.current++; audioAbortRef.current?.(); setPlayingSubtitleId(null); if (stateRef.current !== "ENDED") { stateRef.current="IDLE";setCallState("IDLE"); } return; }
        if (minimizedRef.current || stateRef.current !== "IDLE" || isSpeakerMutedRef.current || subtitle.kind === "action") return;
        const voiceConfig = subtitle.role === "user" ? resolveUserVoiceConfig() : resolveVoiceConfig(session.contactId);
        if (!voiceConfig) { setReplyError(subtitle.role === "user" ? "请先在全局聊天信息中选择用户语音配置" : "请先给角色绑定语音配置"); return; }
        const token = ++audioTokenRef.current;
        sttRef.current?.abort(); sttRef.current = null;
        stateRef.current="AI_SPEAKING";setCallState("AI_SPEAKING");setReplyError(null);
        try {
            let blob = subtitleAudioCacheRef.current.get(subtitle.id);
            if (!blob) blob = await synthesizeSpeech(originalCallSpeech(subtitle.text), voiceConfig) || undefined;
            if (token !== audioTokenRef.current || stateRef.current === "ENDED" || minimizedRef.current || isSpeakerMutedRef.current) return;
            if (!blob) throw new Error("语音合成未返回音频");
            subtitleAudioCacheRef.current.set(subtitle.id, blob);
            let began=false;
            const { promise, abort } = playCallAudio(blob, () => { if(token===audioTokenRef.current && stateRef.current!=="ENDED") { began=true;setPlayingSubtitleId(subtitle.id); } });
            audioAbortRef.current=abort;await promise;
            if(!began && token===audioTokenRef.current)throw new Error("播放未开始，请重听或检查浏览器音频权限");
        } catch(error) { if(token===audioTokenRef.current && stateRef.current!=="ENDED")setReplyError(error instanceof Error ? error.message : "播放失败"); }
        finally { if(token===audioTokenRef.current) { audioAbortRef.current=null;setPlayingSubtitleId(null);if(stateRef.current!=="ENDED"){stateRef.current="IDLE";setCallState("IDLE");} } }
    }, [session.contactId, playCallAudio, playingSubtitleId]);

    // ── Auto-listen ────────────────────────────────

    const startListening = useCallback(() => {
        if (holdToTalk) return; // 按住说话模式不用 Web Speech 自动监听
        if (androidTextInputOnly) {
            setInputMode("text");
            return;
        }
        if (sttRef.current) { sttRef.current.abort(); sttRef.current = null; }
        setInterimText(""); interimTextRef.current = "";

        const stt = createSTTSession({
            onInterim: (text) => {
                setInterimText(text); interimTextRef.current = text;
                if (stateRef.current === "IDLE") setCallState("USER_SPEAKING");
            },
            onFinal: (text) => {
                sttRef.current = null;
                interimTextRef.current = "";
                if (text.trim()) queueUserText(text.trim());
                else { setInterimText(""); setCallState("IDLE"); }
            },
            onError: () => {
                sttRef.current = null; setInterimText("");
                showSttCompatibilityWarning();
                if (stateRef.current === "USER_SPEAKING" || stateRef.current === "IDLE") setCallState("IDLE");
            },
            onNoSpeech: () => {
                sttRef.current = null;
                showSttCompatibilityWarning();
                if (stateRef.current === "IDLE" || stateRef.current === "USER_SPEAKING") {
                    setTimeout(() => { if (stateRef.current === "IDLE") startListening(); }, 300);
                }
            },
            onEnd: () => {
                sttRef.current = null;
                if (stateRef.current === "USER_SPEAKING" || stateRef.current === "IDLE") {
                    const fallback = interimTextRef.current;
                    if (fallback.trim()) queueUserText(fallback.trim());
                    else { setInterimText(""); setCallState("IDLE"); }
                }
            },
        }, "zh-CN");

        sttRef.current = stt;
        if (stt.isSupported) stt.start();
        else {
            sttRef.current = null;
            showSttCompatibilityWarning();
        }
    }, [androidTextInputOnly, holdToTalk, queueUserText, session.contactId, showSttCompatibilityWarning]);

    useEffect(() => {
        if (holdToTalk) return; // 按住说话模式无自动监听
        if (inputMode === "text" && sttRef.current) {
            sttRef.current.abort();
            sttRef.current = null;
            setInterimText("");
        }
        if (!androidTextInputOnly && inputMode === "voice" && callState === "IDLE" && !isMuted && !minimized) {
            const timer = setTimeout(() => { if (stateRef.current === "IDLE" && !minimizedRef.current) startListening(); }, 500);
            return () => clearTimeout(timer);
        }
        if (isMuted && sttRef.current) { sttRef.current.abort(); sttRef.current = null; }
    }, [androidTextInputOnly, holdToTalk, callState, isMuted, inputMode, minimized, startListening]);

    const handleInputModeToggle = useCallback(() => {
        if (androidTextInputOnly) {
            if (sttRef.current) { sttRef.current.abort(); sttRef.current = null; }
            setInterimText("");
            if (stateRef.current === "USER_SPEAKING") setCallState("IDLE");
            setInputMode("text");
            return;
        }
        if (inputMode === "voice") {
            if (sttRef.current) { sttRef.current.abort(); sttRef.current = null; }
            setInterimText("");
            if (stateRef.current === "USER_SPEAKING") setCallState("IDLE");
            setInputMode("text");
        } else {
            setInputMode("voice");
        }
    }, [androidTextInputOnly, inputMode]);

    const handleTextSubmit = useCallback(() => {
        const text = typedText.trim();
        if (!text || callState !== "IDLE") return;
        if (sttRef.current) { sttRef.current.abort(); sttRef.current = null; }
        setTypedText("");
        queueUserText(text, composeKind);
    }, [typedText, callState, queueUserText, composeKind]);

    // 只有点召唤回复时才生成；没有待发文本也可以催对方主动说话。
    const handleRegenerate = useCallback(() => {
        if (callState !== "IDLE") return;
        if (sttRef.current) { sttRef.current.abort(); sttRef.current = null; }
        runConversationTurn(false, true);
    }, [callState, runConversationTurn]);
    const handleReroll = useCallback(() => {
        if (callState !== "IDLE" || queuedTurns || !lastAssistantTurnIdsRef.current.length) return;
        if (sttRef.current) { sttRef.current.abort(); sttRef.current = null; }
        void runConversationTurn(true);
    }, [callState, queuedTurns, runConversationTurn]);

    // 按住说话（非 iOS）：按下录音，松开转写后走对话轮
    const holdInput = useHoldToTalk({
        characterId: session.contactId,
        canStart: () => stateRef.current === "IDLE" && !minimizedRef.current && !isMuted,
        onRecordingStart: () => {
            setInterimText("");
            if (stateRef.current === "IDLE") setCallState("USER_SPEAKING");
        },
        onTranscribeStart: () => {},
        onTranscript: (text) => { queueUserText(text); },
        onError: () => {
            if (stateRef.current === "USER_SPEAKING" || stateRef.current === "PROCESSING") {
                setCallState("IDLE");
            }
        },
    });

    useEffect(() => {
        if (minimized || callState === "ENDED" || inputMode !== "voice" || isMuted) {
            holdInput.cancel();
            if (stateRef.current === "USER_SPEAKING") setCallState("IDLE");
        }
    }, [minimized, callState, inputMode, isMuted, holdInput.cancel]);

    // ── Hangup ──────────────────────────────────────

    const handleHangup = useCallback(() => {
        stateRef.current="ENDED"; audioTokenRef.current++;
        setCallState("ENDED");
        if (sttRef.current) { sttRef.current.abort(); sttRef.current = null; }
        if (audioAbortRef.current) { audioAbortRef.current(); audioAbortRef.current = null; }
        stopCameraStream();
        resetTemporaryVideo039();
        if (window.speechSynthesis) window.speechSynthesis.cancel();

        const endMsg = pushChatMessage({
            sessionId: session.id, role: "user",
            content: `[我挂断了视频通话]`,
            mediaData: { callDuration: formatTime(callDuration) },
        });
        messagesRef.current = [...messagesRef.current, endMsg];
        setTimeout(() => onEnd(), 1500);
    }, [session.id, callDuration, onEnd, stopCameraStream]);

    // 通话音频会话 + 卸载兜底：不经挂断键退出时释放识别与在途播放，
    // 防止识别自动重启循环在后台无限自我重启、麦克风永不归还（详见 voice-call-screen）。
    useEffect(() => {
        setCallAudioSessionActive(true);
        return () => {
            stateRef.current = "ENDED";
            audioTokenRef.current++;
            if (sttRef.current) { sttRef.current.abort(); sttRef.current = null; }
            if (audioAbortRef.current) { audioAbortRef.current(); audioAbortRef.current = null; }
            window.dispatchEvent(new CustomEvent("chat-call-state", { detail: { active: false, sessionId: session.id } }));
            setCallAudioSessionActive(false);
        };
    }, []);

    // ── Render ──────────────────────────────────────

    if (minimized) {
        return (
            <DraggableMediaWindow label={`返回与${callIdentity.name}的视频通话`} onOpen={onRestore} style={{backgroundImage:`url(${bgImageResolved || ""})`}}><span className="call-mini-window-overlay"/><span className="call-mini-window-name">{callIdentity.name}</span></DraggableMediaWindow>
        );
    }

    return (
        <div className="absolute inset-0 z-[100] flex flex-col bg-black text-white overflow-hidden call-keyboard-shift videocall-redesign" style={keyboardOffsetStyle}>
            {favoriteLine && <VoiceFavoriteDialog key={favoriteLine.id} draft={{kind:"call",sourceKey:`${session.id}:video:${favoriteLine.id}`,text:originalCallSpeech(favoriteLine.text),characterId:session.contactId,role:favoriteLine.role,getAudio:async()=>subtitleAudioCacheRef.current.get(favoriteLine.id)}} onClose={()=>setFavoriteLine(null)}/> }
            <UploadedVideoVolumeControl volume={uploadedVideoVolume} onChange={adjustUploadedVideoVolume} />

            {onMinimize && callState !== "ENDED" && (
                <button
                    type="button"
                    className="call-back-btn"
                    onClick={onMinimize}
                    aria-label="缩小通话"
                    title="缩小通话"
                >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M15 18l-6-6 6-6" />
                    </svg>
                </button>
            )}
            {/* Full-screen blurred background (character avatar) */}
            <div
                className="videocall-bg-blur"
                style={{
                    backgroundImage: bgImageResolved
                        ? `url(${bgImageResolved})`
                        : callIdentity.avatar
                            ? `url(${callIdentity.avatar})`
                            : "linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)",
                }}
            />

            {temporaryVideo039&&<video ref={el=>{uploadedVideoElement.current=el;if(el){el.volume=uploadedVideoVolume;el.muted=uploadedVideoVolume===0;}}} className="call039-temp-video" src={temporaryVideo039} autoPlay muted={uploadedVideoVolume===0} loop playsInline />}
            <input type="file" accept="video/*" ref={temporaryVideoFile039} hidden onChange={e=>{void acceptTemporaryVideo039(e.target.files?.[0]);e.target.value="";}}/>
            {callState!=="ENDED"&&<button type="button" className="call039-temp-upload" aria-label="临时上传通话视频" title="本次视频通话临时替换画面"
              onClick={()=>uploadApproved039.current?temporaryVideoFile039.current?.click():setUploadNotice039(true)}><Upload size={18}/></button>}
            {uploadNotice039&&<div className="call039-disclaimer"><section role="dialog" aria-modal="true" aria-label="视频素材使用须知">
              <h3>视频素材使用须知</h3><p>本功能展示的视频均由用户自行从本地选择，仅用于虚构视频通话场景的模拟与体验。{"\n\n"}视频画面及互动情节不代表现实人物的真实行为、言论或关系，请勿将虚构内容与现实人物关联，亦请勿上升真人。</p>
              <footer><button onClick={()=>setUploadNotice039(false)}>取消</button><button onClick={()=>{uploadApproved039.current=true;setUploadNotice039(false);temporaryVideoFile039.current?.click();}}>我已知晓，继续上传</button></footer>
            </section></div>}
            {/* A single small self picture; the custom call background fills the rest of the screen. */}
            <div className="videocall-self-cam" aria-label="我的通话画面">
                {cameraEnabled ? (
                    <video
                        autoPlay
                        playsInline
                        muted
                        ref={(el) => { if (el && el !== videoElRef.current) { videoElRef.current = el; if (cameraStreamRef.current) { el.srcObject = cameraStreamRef.current; el.play().catch(() => {}); } } }}
                        className="w-full h-full object-cover"
                    />
                ) : (callAppearanceResolved || effectiveUserAvatar) ? (
                    <img src={callAppearanceResolved || effectiveUserAvatar || ""} alt={userNameRef.current} className="w-full h-full object-cover" />
                ) : (
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--c-text)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                        <circle cx="12" cy="7" r="4" />
                    </svg>
                )}
            </div>

            {/* Top info bar */}
            <div className="relative z-10 gcall-topbar gcall-topbar-video">
                <div className="gcall-topbar-title videocall-name">
                    {callIdentity.name}
                </div>
                <div
                    className="gcall-topbar-sub videocall-name"
                    {...(callState === "CONNECTING" || callState === "PROCESSING" ? { "data-anim": "" } : {})}
                >
                    {callState !== "CONNECTING" && callState !== "ENDED" ? `${formatTime(callDuration)} · ` : ""}
                    {stateLabel()}
                </div>
            </div>

            {transcriptVisible039&&<div className="call039-video-overlay" ref={subtitlesScrollRef}>
                <Call039Transcript lines={subtitles.map(item=>({...item,kind:item.kind||"speech",speakerName:item.role==="user"?"我":callIdentity.name}))}
                    showSpeaker playingId={playingSubtitleId} onPlay={line=>{const item=subtitles.find(v=>v.id===line.id);if(item)void playSubtitle(item);}}
                    onEdit={call039Edit} onCommand={call039Command}/>
                {interimText&&<div className="call-video-action">{interimText}</div>}
            </div>}
            {transcriptVisible039&&callState!=="CONNECTING"&&callState!=="ENDED"&&<div className="call039-voice-compose">
                <button type="button" className="call039-kind" onClick={()=>setComposeKind(k=>k==="speech"?"action":"speech")} aria-label="切换语言和动作">{composeKind==="speech"?"语":"动"}</button>
                <input value={typedText} onChange={e=>setTypedText(e.target.value)}
                  onKeyDown={e=>{if(e.key==="Enter"&&!e.nativeEvent.isComposing&&!e.shiftKey){e.preventDefault();handleTextSubmit();}}}
                  placeholder={composeKind==="speech"?"输入你想说的话，回车发送…":"输入动作，回车发送…"} disabled={callState!=="IDLE"}/>
                <button type="button" onClick={handleRegenerate} disabled={callState!=="IDLE"} aria-label="召唤角色继续">↑</button>
            </div>}
            {cameraError && (
                <div className="videocall-toast" role="status" aria-live="polite">{cameraError}</div>
            )}
            {replyError && (
                <button type="button" className="videocall-toast videocall-reply-error" title={replyError} onClick={() => setReplyError(null)} aria-label={`通话回复失败：${replyError}。点击关闭`}>
                    回复失败，点击关闭并重试
                </button>
            )}

            {/* 按住说话提示/错误行 */}
            {holdToTalk && inputMode === "voice" && callState !== "CONNECTING" && callState !== "ENDED" && (
                <div className="text-center ts-12 opacity-80 px-5 relative z-[1]">
                    {holdInput.recState === "recording" ? "松开发送"
                        : holdInput.recState === "transcribing" ? "识别中…"
                        : holdInput.error || "按住麦克风说话"}
                </div>
            )}

            <div className={`call039-video-controls${callState==="CONNECTING" && initiator==="user" ? " call039-video-controls--outgoing" : ""}${callState==="ENDED" ? " call039-video-controls--ended" : ""}`} role="group" aria-label="视频通话控制">
                {callState==="CONNECTING" && initiator==="character" ? <>
                    <button type="button" className="hang" onClick={()=>onEnd()} aria-label="拒接"><PhoneOff size={25}/></button>
                    <button type="button" onClick={()=>setCallState("IDLE")} aria-label="接听"><Video size={24}/></button>
                </> : callState!=="CONNECTING"&&callState!=="ENDED" ? <>
                    <button type="button" onClick={handleCameraToggle} aria-label={cameraEnabled?"关闭摄像头":"打开摄像头"}>{cameraEnabled?<Video size={24}/>:<VideoOff size={24}/>}</button>
                    <button type="button" className="hang" onClick={handleHangup} aria-label="挂断"><PhoneOff size={28}/></button>
                    <button type="button" onClick={()=>setTranscriptVisible039(x=>!x)} aria-label={transcriptVisible039?"隐藏对话和输入":"显示对话和输入"}>{transcriptVisible039?<MessageSquare size={24}/>:<MessageSquareOff size={24}/>}</button>
                </> : <button className="hang" onClick={()=>onEnd()} aria-label="取消呼叫"><PhoneOff size={28}/></button>}
            </div>
            {!androidTextInputOnly && showSttWarning && (
                <CallSttWarningDialog
                    onClose={() => setShowSttWarning(false)}
                    onNeverShow={handleNeverShowSttWarning}
                />
            )}

        </div>
    );
}
