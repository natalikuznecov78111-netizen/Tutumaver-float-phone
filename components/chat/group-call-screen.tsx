"use client";
import { loadCallFirstSpeaker } from "@/lib/call-first-speaker";
import {DraggableMediaWindow} from "@/components/ui/draggable-media-window";
import { VoiceFavoriteDialog } from "./voice-favorite-dialog";
import { useEffect, useState, useRef, useCallback } from "react";
import { ChevronLeft, Users, X, Send, Sparkles, MessageSquare, MessageSquareOff, Mic, PhoneOff, Phone, Volume2, Video, VideoOff, Upload } from "lucide-react";
import {Call039Transcript, type Call039Command} from "./call039-transcript";
import type {Call039Line} from "./call039-shared-ui";
import { useGlobalCallAppearance, useChatUserAvatar } from "./use-chat-user-avatar";
import { VoiceCallLayout, type VoiceCallLine } from "./voice-call-layout";
import { ChatSession, ChatMessage, loadChatMessages, pushChatMessage, deleteChatMessagesByIds, editChatMessage, getLatestCharacterStateValues } from "@/lib/chat-storage";
import { generateGroupChatCompletion } from "@/lib/group-chat-engine";
import { parseAIResponse } from "@/lib/rich-message-parser";
import { getStatusRegionConfig, isCustomStatusRegionActive } from "@/lib/chat-status-region";
import { resolveUserIdentity } from "@/lib/settings-storage";
import { cancelFollowUp } from "@/lib/follow-up-service";
import { resolveVoiceConfig, resolveUserVoiceConfig, synthesizeSpeech, playAudioBlob, playAudioBlobViaMediaElement, setCallAudioSessionActive, selectCallAudioOutput } from "@/lib/tts-service";
import { parseCallOutput } from "@/lib/call-participation";
import { displayCallAction, originalCallSpeech, splitCallTranscript, VOICE_CALL_FORMAT, VIDEO_CALL_FORMAT } from "@/lib/call-transcript";
import { groupMemberAvatar, groupMemberName } from "@/lib/group-chat-profile";
import { CallTranscriptBubble } from "./call-transcript-bubble";
import { BilingualTextBlock } from "./message-bubble";
import { useCallKeyboardOffsetStyle } from "./use-call-keyboard-offset";
import { CallVolumeControl, UploadedVideoVolumeControl } from "./call-volume-control";
import { useCallScreenSounds } from "@/lib/chat-sound";
import { startIncomingCallVibration } from "@/lib/call-vibration";
import { createSTTSession, type STTSession } from "@/lib/stt-service";
import { isCallRecordingSupported, resolveCloudSttConfig } from "@/lib/stt-cloud";
import { useHoldToTalk } from "./use-hold-to-talk";
import { isAndroidBrowser, isIOSDevice } from "./voice-input-platform";
import type { Character } from "@/lib/character-types";
type CallState = "CONNECTING" | "IDLE" | "USER_SPEAKING" | "PROCESSING" | "AI_SPEAKING" | "ENDED";
type SubtitleEntry = VoiceCallLine & {
    senderName?: string;
    senderCharacterId?: string;
    kind?: "speech" | "action";
};
type GroupCallScreenProps = {
    type: "voice" | "video";
    session: ChatSession;
    characters: Character[];
    onEnd: (completed?: boolean) => void;
    initiator?: "user" | "character";
    initiatorName?: string;
    answered?: boolean;
    minimized?: boolean;
    onMinimize?: () => void;
    onRestore?: () => void;
};
export function GroupCallScreen({ type, session, characters, onEnd, initiator = "user", initiatorName, answered = false, minimized = false, onMinimize, onRestore }: GroupCallScreenProps) {
    const isVideo = type === "video";
    const callTypeLabel = isVideo ? "视频通话" : "语音通话";
    const initiatingId = characters.find(c => c.name === initiatorName)?.id || characters[0]?.id;
    const [started, setStarted] = useState(initiator === "character");
    const [chosen, setChosen] = useState<string[]>(initiator === "character" && initiatingId ? [initiatingId] : []);
    const [participantIds, setParticipantIds] = useState<string[]>(initiator === "character" && initiatingId ? [initiatingId] : []);
    const presentRef = useRef(participantIds);
    const [selectedId, setSelectedId] = useState(participantIds[0] || "");
    const [membersOpen, setMembersOpen] = useState(false);
    const [inputOpen, setInputOpen] = useState(false);
    const [callState, setRawState] = useState<CallState>(answered ? "IDLE" : "CONNECTING");
    const stateRef = useRef<string>(answered ? "IDLE" : "CONNECTING");
    const setCallState = useCallback((next: CallState) => { stateRef.current = next; setRawState(next); }, []);
    const callIdRef = useRef(`call-${session.id}-${typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : Date.now()}`);
    const initialized = useRef(false), endWritten = useRef(false);
    const firstSpeakerHandled = useRef(false);
    const generationRef = useRef<AbortController | null>(null);
    const audioTokenRef = useRef(0), audioAbortRef = useRef<(() => void) | null>(null);
    const subtitleAudioCacheRef = useRef(new Map<string, Blob>());
    const [favoriteLine,setFavoriteLine]=useState<SubtitleEntry|null>(null);
    const [playingSubtitleId, setPlayingSubtitleId] = useState<string | null>(null);
    const [speakingCharId, setSpeakingCharId] = useState<string | null>(null);
    const [subtitles, setSubtitles] = useState<SubtitleEntry[]>([]);
    const [transcriptVisible039,setTranscriptVisible039]=useState(true);
    const [cameraEnabled039,setCameraEnabled039]=useState(false);
    const cameraStream039=useRef<MediaStream|null>(null);
    const cameraVideo039=useRef<HTMLVideoElement|null>(null);
    const [videos039,setVideos039]=useState<Record<string,string>>({});
    const [uploadedVideoVolume, setUploadedVideoVolume] = useState(0);
    const uploadedVideoElements = useRef<Record<string,HTMLVideoElement>>({});
    const adjustUploadedVideoVolume = (value:number) => {
        const v=Math.max(0,Math.min(1,value));
        setUploadedVideoVolume(v);
        for(const el of Object.values(uploadedVideoElements.current)){
            el.volume=v;el.muted=v===0;
            if(v>0)void el.play().catch(()=>{});
        }
    };
    const videosRef039=useRef<Record<string,string>>({});
    const uploadTarget039=useRef<string>("");
    const uploadFile039=useRef<HTMLInputElement|null>(null);
    const [uploadPicker039,setUploadPicker039]=useState(false);
    const [uploadNotice039,setUploadNotice039]=useState(false);
    const approved039=useRef(false);
    const pendingReroll039=useRef<string[]>([]);
    const resetVideo039=()=>{Object.values(videosRef039.current).forEach(u=>URL.revokeObjectURL(u));videosRef039.current={};setVideos039({});};
    const stopCamera039=()=>{cameraStream039.current?.getTracks().forEach(t=>t.stop());cameraStream039.current=null;setCameraEnabled039(false);};
    useEffect(()=>()=>{cameraStream039.current?.getTracks().forEach(t=>t.stop());Object.values(videosRef039.current).forEach(u=>URL.revokeObjectURL(u));},[]);
    useEffect(()=>{if(cameraEnabled039&&cameraVideo039.current&&cameraStream039.current){cameraVideo039.current.srcObject=cameraStream039.current;void cameraVideo039.current.play().catch(()=>{});}},[cameraEnabled039,participantIds.length]);
    const toggleCamera039=async()=>{if(cameraEnabled039){stopCamera039();return;}try{const stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:"user"},audio:false});cameraStream039.current=stream;setCameraEnabled039(true);}catch{setReplyError("摄像头授权失败，请检查系统权限");}};
    const captureCamera039=()=>{const v=cameraVideo039.current;if(!cameraEnabled039||!v||!v.videoWidth)return null;const c=document.createElement("canvas");c.width=512;c.height=Math.max(1,Math.round(v.videoHeight*512/v.videoWidth));c.getContext("2d")?.drawImage(v,0,0,c.width,c.height);return c.toDataURL("image/jpeg",0.64);};
    const uploadThisVideo039=async(file?:File)=>{if(!file)return;if(file.size>20*1024*1024){setReplyError("视频不能超过20MB");return;}
        const u=URL.createObjectURL(file);const sample=document.createElement("video");sample.preload="metadata";sample.src=u;
        const duration=await new Promise<number>(resolve=>{sample.onloadedmetadata=()=>resolve(sample.duration);sample.onerror=()=>resolve(NaN);setTimeout(()=>resolve(NaN),5000);});
        if(!Number.isFinite(duration)||duration<=0||duration>15){URL.revokeObjectURL(u);setReplyError("请选择15秒以内的可播放视频");return;}
        const key=uploadTarget039.current;if(!key){URL.revokeObjectURL(u);return;}
        if(videosRef039.current[key])URL.revokeObjectURL(videosRef039.current[key]);
        videosRef039.current[key]=u;setVideos039(prev=>({...prev,[key]:u}));};
    const openUpload039=(key:string)=>{uploadTarget039.current=key;setUploadPicker039(false);if(!approved039.current)setUploadNotice039(true);else uploadFile039.current?.click();};

    const [roundStarts, setRoundStarts] = useState<Record<string, string>>({});
    const scrollPositions = useRef(new Map<string, number>());
    const [newSpeakerIds, setNewSpeakerIds] = useState<string[]>([]);
    const [queuedTurns, setQueuedTurns] = useState(0);
    const [replyError, setReplyError] = useState<string | null>(null);
    const [outputName, setOutputName] = useState("播放设备");
    const [callDuration, setCallDuration] = useState(0);
    const callStartRef = useRef(0);
    const messagesRef = useRef<ChatMessage[]>([]);
    const userNameRef = useRef(resolveUserIdentity(undefined, "group_chat")?.name || "你");
    const minimizedRef = useRef(minimized);
    minimizedRef.current = isVideo && minimized;
    const onEndRef = useRef(onEnd);
    onEndRef.current = onEnd;
    const endTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const keyboardOffsetStyle = useCallKeyboardOffsetStyle();
    const effectiveUserAvatar = useChatUserAvatar(session), globalCallAppearance = useGlobalCallAppearance();
    const iosDevice = isIOSDevice();
    const playCallAudio = iosDevice ? playAudioBlob : playAudioBlobViaMediaElement;
    const holdToTalkRef = useRef(isVideo && !iosDevice && isCallRecordingSupported() && resolveCloudSttConfig() !== null);
    const holdToTalk = holdToTalkRef.current;
    const androidTextInputOnly = isAndroidBrowser() && !holdToTalk;
    const [inputMode, setInputMode] = useState<"voice" | "text">("text");
    const [isMuted, setIsMuted] = useState(false);
    const [typedText, setTypedText] = useState("");
    const [composeKind, setComposeKind] = useState<"speech" | "action">("speech");
    const [interimText, setInterimText] = useState("");
    const interimTextRef = useRef("");
    const sttRef = useRef<STTSession | null>(null);
    const subtitleScrollRef = useRef<HTMLDivElement>(null);
    const activeCharacters = participantIds.map(id => characters.find(c => c.id === id)).filter((c): c is Character => !!c);
    const selectedCharacter = activeCharacters.find(c => c.id === selectedId) || activeCharacters[0];
    const formatTime = (seconds: number) => `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
    const stopAudio = useCallback(() => { audioTokenRef.current++; audioAbortRef.current?.(); audioAbortRef.current = null; setPlayingSubtitleId(null); setSpeakingCharId(null); }, []);
    const endCall = useCallback((byUser = true) => {
        if (endWritten.current)
            return;
        endWritten.current = true;
        generationRef.current?.abort();
        stopAudio();
        stopCamera039();resetVideo039();
        sttRef.current?.abort();
        sttRef.current = null;
        setCallState("ENDED");
        setInputOpen(false);
        if (initialized.current)
            pushChatMessage({ sessionId: session.id, role: "user", content: byUser ? `[我挂断了群${callTypeLabel}]` : `[群${callTypeLabel}已结束]`, mediaData: { callId: callIdRef.current, callType: type, callEvent: "end", callDuration: formatTime(callStartRef.current ? Math.floor((Date.now() - callStartRef.current) / 1000) : 0), callParticipantIds: [] } });
        endTimerRef.current = setTimeout(() => onEndRef.current(), 500);
    }, [session.id, type, callTypeLabel, stopAudio, setCallState]);
    const handleHangup = () => endCall(true);
    const appendStored = (message: ChatMessage) => { messagesRef.current = [...messagesRef.current, message]; };
    const updateParticipants = useCallback((next: string[], actorId?: string, kind?: "join" | "leave") => {
        presentRef.current = next;
        setParticipantIds(next);
        if (kind && actorId) {
            const char = characters.find(c => c.id === actorId);
            appendStored(pushChatMessage({ sessionId: session.id, role: "system", content: `[${groupMemberName(session, actorId, char)}${kind === "join" ? "加入" : "退出"}了群${callTypeLabel}]`, mediaData: { callId: callIdRef.current, callType: type, callEvent: kind, callParticipantIds: [...next] } }));
        }
        setSelectedId(previous => next.includes(previous) ? previous : next[0] || "");
        if (!next.length && initialized.current)
            endCall(false);
    }, [session, characters, type, callTypeLabel, endCall]);
    const addMember = (id: string) => { if (stateRef.current !== "IDLE" || presentRef.current.includes(id) || !characters.some(c => c.id === id))
        return; updateParticipants([...presentRef.current, id], id, "join"); };
    const startSelected = () => { if (!chosen.length)
        return; updateParticipants([...chosen]); setSelectedId(chosen[0]); setStarted(true); };
    useEffect(() => {
        if (!started)
            return;
        cancelFollowUp(session.id);
        
        setCallAudioSessionActive(true);
        if (!initialized.current) {
            initialized.current = true;
            messagesRef.current = loadChatMessages(session.id);
            appendStored(pushChatMessage({ sessionId: session.id, role: initiator === "character" ? "assistant" : "user", content: `[${initiator === "character" ? initiatorName || "角色" : "我"}向群聊发起了${callTypeLabel}]`, senderCharacterId: initiator === "character" ? initiatingId : undefined, senderName: initiator === "character" ? initiatorName : undefined, mediaData: { callId: callIdRef.current, callType: type, callEvent: "start", callParticipantIds: [...presentRef.current] } }));
        }
        const timer = initiator === "user" && !answered ? setTimeout(() => setCallState("IDLE"), 1500) : undefined;
        return () => { if (timer)
            clearTimeout(timer); };
    }, [started]);
    useEffect(() => () => { stateRef.current = "ENDED"; generationRef.current?.abort(); audioTokenRef.current++; audioAbortRef.current?.(); sttRef.current?.abort(); if (endTimerRef.current)
        clearTimeout(endTimerRef.current); if (initialized.current) {
        setCallAudioSessionActive(false);
        
    } }, []);
    useEffect(() => { if (!started)
        return; window.dispatchEvent(new CustomEvent("chat-call-state", { detail: { active: callState !== "ENDED", sessionId: session.id, type, phase: callState === "CONNECTING" ? "ringing" : "connected" } })); return () => { window.dispatchEvent(new CustomEvent("chat-call-state", { detail: { active: false, sessionId: session.id } })); }; }, [started, callState, session.id, type]);
    useCallScreenSounds({ initiator, callState: started ? callState : "ENDED", session });
    useEffect(() => { if (!started || initiator !== "character" || callState !== "CONNECTING")
        return; return startIncomingCallVibration(); }, [started, initiator, callState]);
    useEffect(() => { if (!started || callState === "CONNECTING" || callState === "ENDED")
        return; if (!callStartRef.current)
        callStartRef.current = Date.now(); const timer = setInterval(() => setCallDuration(Math.floor((Date.now() - callStartRef.current) / 1000)), 1000); return () => clearInterval(timer); }, [started, callState]);
    useEffect(() => { interimTextRef.current = interimText; }, [interimText]);
    useEffect(() => { if (isVideo && subtitleScrollRef.current)
        subtitleScrollRef.current.scrollTop = subtitleScrollRef.current.scrollHeight; }, [isVideo, subtitles, interimText]);
    useEffect(() => { if (!minimized || !isVideo)
        return; stopAudio(); sttRef.current?.abort(); sttRef.current = null; setInputOpen(false); setInterimText(""); if (["AI_SPEAKING", "USER_SPEAKING"].includes(stateRef.current))
        setCallState("IDLE"); }, [minimized, stopAudio, setCallState]);
    const [resolvedBgs, setResolvedBgs] = useState<Record<string, string>>({});
    const [voiceBgResolved, setVoiceBgResolved] = useState<string | null>(null);
    useEffect(() => { let canceled = false; (async () => { const { getChatImageFromIndexedDB } = await import("@/lib/chat-asset-storage"); const resolve = async (value?: string) => !value ? "" : /^(data:|https?:)/.test(value) ? value : await getChatImageFromIndexedDB(value) || ""; const map = { ...session.groupVideoBackgrounds, self: session.groupVideoBackgrounds?.self || globalCallAppearance }; const pairs = await Promise.all(Object.entries(map).map(async ([id, value]) => [id, await resolve(value)])); const bg = await resolve(session.voiceBackground); if (!canceled) {
        setResolvedBgs(Object.fromEntries(pairs));
        setVoiceBgResolved(bg || null);
    } })(); return () => { canceled = true; }; }, [session.groupVideoBackgrounds, session.voiceBackground, globalCallAppearance]);
    const queueUserText = useCallback((userText: string, kind: "speech" | "action" = "speech") => {
        const text = userText.trim();
        if (!text || !started || !["IDLE", "USER_SPEAKING"].includes(stateRef.current) || minimizedRef.current)
            return;
        const actualKind = isVideo ? kind : "speech";
        const message = pushChatMessage({ sessionId: session.id, role: "user", content: actualKind === "action" ? `【动作】${text}` : text, mediaData: { callId: callIdRef.current, callType: type, callLineKind: actualKind, callAudienceIds: [...presentRef.current] } });
        appendStored(message);
        setSubtitles(previous => [...previous, { id: message.id, role: "user", text, kind: actualKind, senderName: groupMemberName(session, "self", null, userNameRef.current) }]);
        setInputOpen(false);
        setQueuedTurns(v => v + 1);
        setInterimText("");
        setCallState("IDLE");
    }, [started, isVideo, session, type, setCallState]);
    const runConversationTurn = useCallback(async (firstSpeakerId?: string, manual = false) => {
        if (!started || stateRef.current !== "IDLE" || !presentRef.current.length)
            return;
        setCallState("PROCESSING");
        setReplyError(null);
        setInputOpen(false);
        sttRef.current?.abort();
        sttRef.current = null;
        const request = new AbortController();
        generationRef.current = request;
        try {
            messagesRef.current = loadChatMessages(session.id);
            const dropped039=[...pendingReroll039.current];
            const rerollHistory039=messagesRef.current.filter(m=>!dropped039.includes(m.id));
            const frame039=manual?captureCamera039():null;
            const firstSpeaker = characters.find(character => character.id === firstSpeakerId);
            const results = await generateGroupChatCompletion(session, rerollHistory039, undefined, {
                directorInstruction: firstSpeaker ? `通话刚接通。只由 ${groupMemberName(session, firstSpeaker.id, firstSpeaker)} 先自然开口，其他成员等下一轮。` : undefined,
                appTags: ["group_chat", type], disableTools: true, skipMemorySummarization: true, callFormatInstruction: isVideo ? VIDEO_CALL_FORMAT : VOICE_CALL_FORMAT, attachedImages: frame039?[frame039]:undefined, signal: request.signal, activeCall: { id: callIdRef.current, type, participantIds: [...presentRef.current] } });
            if (request.signal.aborted || (stateRef.current as string) === "ENDED" || generationRef.current !== request)
                return;
            if(results.length&&dropped039.length){deleteChatMessagesByIds(session.id,dropped039);messagesRef.current=messagesRef.current.filter(m=>!dropped039.includes(m.id));
               dropped039.forEach(id=>subtitleAudioCacheRef.current.delete(id));setSubtitles(prev=>prev.filter(m=>!dropped039.includes(m.id)));}
            pendingReroll039.current=[];
            const added: SubtitleEntry[] = [], firsts: Record<string, string> = {}, spoke = new Set<string>();
            const currentBatch039="group-call-039-"+Date.now();
            for (const result of results) {
                if (request.signal.aborted || (stateRef.current as string) === "ENDED")
                    break;
                if ((firstSpeakerId && result.characterId !== firstSpeakerId) || !characters.some(c => c.id === result.characterId))
                    continue;
                for (const output of parseCallOutput(result.responseText)) {
                    if (request.signal.aborted || (stateRef.current as string) === "ENDED")
                        break;
                    if (output.kind === "join") {
                        if (!presentRef.current.includes(result.characterId))
                            updateParticipants([...presentRef.current, result.characterId], result.characterId, "join");
                        continue;
                    }
                    if (output.kind === "leave") {
                        if (presentRef.current.includes(result.characterId))
                            updateParticipants(presentRef.current.filter(id => id !== result.characterId), result.characterId, "leave");
                        continue;
                    }
                    if (output.kind === "text") {
                        if (output.text)
                            appendStored(pushChatMessage({ sessionId: session.id, role: "assistant", content: output.text, senderCharacterId: result.characterId, senderName: result.characterName }));
                        continue;
                    }
                    if (!presentRef.current.includes(result.characterId))
                        continue;
                    const parsed = parseAIResponse(output.text, getLatestCharacterStateValues(result.characterId));
                    const lines = parsed.parts.flatMap(part => part.mediaType === "audio" ? splitCallTranscript(part.mediaData?.label || part.content, isVideo) : !part.mediaType ? splitCallTranscript(part.content, isVideo) : []).filter(line => line.text.trim());
                    lines.forEach((line, index) => { const message = pushChatMessage({ sessionId: session.id, role: "assistant", content: line.kind === "action" ? `【动作】${line.text}` : line.text, senderCharacterId: result.characterId, senderName: result.characterName, mediaData: { callId: callIdRef.current, callType: type, callLineKind: line.kind, callAudienceIds: [...presentRef.current] }, statusPanel: index === 0 ? parsed.statusPanel : undefined, statusRegionMode: index === 0 && parsed.statusPanel && isCustomStatusRegionActive(getStatusRegionConfig(session.id, false)) ? "custom" : undefined, innerMonologue: index === 0 ? parsed.innerMonologue : undefined, stateValues: index === 0 ? parsed.stateValues : undefined, freshStateValues: index === 0 ? parsed.freshStateValues : undefined }); appendStored(message); added.push({ id: message.id, role: "assistant", text: line.kind === "action" ? displayCallAction(line.text) : line.text, kind: line.kind, senderCharacterId: result.characterId, senderName: groupMemberName(session, result.characterId, characters.find(c => c.id === result.characterId)) }); if (!firsts[result.characterId])
                        firsts[result.characterId] = message.id; spoke.add(result.characterId); });
                }
            }
            setSubtitles(previous => [...previous, ...added]);
            setRoundStarts(previous => ({ ...previous, ...firsts }));
            setNewSpeakerIds([...spoke]);
            setQueuedTurns(0);
            if (!results.length)
                throw new Error("没有生成回复，请重试");
        }
        catch (error) {
            if (!request.signal.aborted && (stateRef.current as string) !== "ENDED")
                setReplyError(error instanceof Error ? error.message : "回复失败，请重试");
        }
        finally {
            if (generationRef.current === request) {
                generationRef.current = null;
                if ((stateRef.current as string) !== "ENDED")
                    setCallState("IDLE");
            }
        }
    }, [started, session, type, isVideo, characters, updateParticipants, setCallState]);

    useEffect(() => {
        if (isVideo || !started || callState !== "IDLE" || firstSpeakerHandled.current || !presentRef.current.length) return;
        firstSpeakerHandled.current = true;
        const preference = loadCallFirstSpeaker(`group:${session.id}`);
        const members = presentRef.current;
        const choices = preference === "random" ? [undefined, ...members] : members;
        const first = preference === "user" ? undefined : choices[Math.floor(Math.random() * choices.length)];
        if (first) void runConversationTurn(first);
    }, [isVideo, started, callState, session.id, runConversationTurn]);
    const playSubtitle = useCallback(async (subtitle: SubtitleEntry) => {
        if (playingSubtitleId === subtitle.id) {
            stopAudio();
            if ((stateRef.current as string) !== "ENDED")
                setCallState("IDLE");
            return;
        }
        if (stateRef.current !== "IDLE" || minimizedRef.current || subtitle.kind === "action")
            return;
        const config = subtitle.role === "user" ? resolveUserVoiceConfig() : subtitle.senderCharacterId ? resolveVoiceConfig(subtitle.senderCharacterId) : null;
        if (!config) {
            setReplyError(subtitle.role === "user" ? "请先在全局聊天信息中选择用户语音配置" : "请先给该角色绑定语音配置");
            return;
        }
        const token = ++audioTokenRef.current;
        setCallState("AI_SPEAKING");
        setReplyError(null);
        sttRef.current?.abort();
        sttRef.current = null;
        try {
            let blob = subtitleAudioCacheRef.current.get(subtitle.id);
            if (!blob)
                blob = await synthesizeSpeech(originalCallSpeech(subtitle.text), config) || undefined;
            if (token !== audioTokenRef.current || (stateRef.current as string) === "ENDED" || minimizedRef.current)
                return;
            if (!blob)
                throw new Error("语音合成未返回音频");
            subtitleAudioCacheRef.current.set(subtitle.id, blob);
            let began = false;
            const { promise, abort } = playCallAudio(blob, () => { if (token === audioTokenRef.current && (stateRef.current as string) !== "ENDED") {
                began = true;
                setPlayingSubtitleId(subtitle.id);
                setSpeakingCharId(subtitle.role === "user" ? "self" : subtitle.senderCharacterId || null);
            } });
            audioAbortRef.current = abort;
            await promise;
            if (!began && token === audioTokenRef.current)
                throw new Error("播放未开始，请重听或检查浏览器音频权限");
        }
        catch (error) {
            if (token === audioTokenRef.current && (stateRef.current as string) !== "ENDED")
                setReplyError(error instanceof Error ? error.message : "播放失败");
        }
        finally {
            if (token === audioTokenRef.current) {
                audioAbortRef.current = null;
                setPlayingSubtitleId(null);
                setSpeakingCharId(null);
                if ((stateRef.current as string) !== "ENDED")
                    setCallState("IDLE");
            }
        }
    }, [playingSubtitleId, stopAudio, setCallState, playCallAudio]);
    const stateLabel = () => callState === "PROCESSING" ? "对方正在思考…" : callState === "CONNECTING" ? "正在呼叫…" : callState === "AI_SPEAKING" ? "正在播放…" : callState === "ENDED" ? "通话已结束" : "通话中";
    // ── Auto-listen ──────────────────────────────────
    const startListening = useCallback(() => {
        if (!isVideo || !started || minimizedRef.current)
            return;
        if (holdToTalk)
            return; // 按住说话模式不用 Web Speech 自动监听
        if (androidTextInputOnly) {
            setInputMode("text");
            return;
        }
        if (sttRef.current) {
            sttRef.current.abort();
            sttRef.current = null;
        }
        setInterimText("");
        interimTextRef.current = "";
        const stt = createSTTSession({
            onInterim: (text) => {
                setInterimText(text);
                interimTextRef.current = text;
                if (stateRef.current === "IDLE")
                    setCallState("USER_SPEAKING");
            },
            onFinal: (text) => {
                sttRef.current = null;
                if (text.trim())
                    queueUserText(text.trim());
                else {
                    setInterimText("");
                    setCallState("IDLE");
                }
            },
            onError: (error) => {
                console.warn("[GroupCall] STT error:", error);
                sttRef.current = null;
                setInterimText("");
                if (stateRef.current === "USER_SPEAKING" || stateRef.current === "IDLE")
                    setCallState("IDLE");
            },
            onNoSpeech: () => {
                sttRef.current = null;
                if (stateRef.current === "IDLE" || stateRef.current === "USER_SPEAKING") {
                    setTimeout(() => { if (stateRef.current === "IDLE")
                        startListening(); }, 300);
                }
            },
            onEnd: () => {
                sttRef.current = null;
                if (stateRef.current === "USER_SPEAKING" || stateRef.current === "IDLE") {
                    const fallback = interimTextRef.current;
                    if (fallback.trim())
                        queueUserText(fallback.trim());
                    else {
                        setInterimText("");
                        setCallState("IDLE");
                    }
                }
            },
        }, "zh-CN");
        sttRef.current = stt;
        if (stt.isSupported)
            stt.start();
    }, [androidTextInputOnly, holdToTalk, queueUserText, characters]);
    useEffect(() => {
        if (!isVideo || !started || minimizedRef.current)
            return;
        if (holdToTalk)
            return; // 按住说话模式无自动监听
        if (inputMode === "text" && sttRef.current) {
            sttRef.current.abort();
            sttRef.current = null;
            setInterimText("");
        }
        if (!androidTextInputOnly && inputMode === "voice" && callState === "IDLE" && !isMuted) {
            const timer = setTimeout(() => {
                if (stateRef.current === "IDLE")
                    startListening();
            }, 500);
            return () => clearTimeout(timer);
        }
        if (isMuted && sttRef.current) {
            sttRef.current.abort();
            sttRef.current = null;
        }
    }, [isVideo, started, minimized, androidTextInputOnly, holdToTalk, callState, isMuted, inputMode, startListening]);
    const handleInputModeToggle = useCallback(() => {
        if (androidTextInputOnly) {
            if (sttRef.current) {
                sttRef.current.abort();
                sttRef.current = null;
            }
            setInterimText("");
            if (stateRef.current === "USER_SPEAKING")
                setCallState("IDLE");
            setInputMode("text");
            return;
        }
        if (inputMode === "voice") {
            if (sttRef.current) {
                sttRef.current.abort();
                sttRef.current = null;
            }
            setInterimText("");
            if (stateRef.current === "USER_SPEAKING")
                setCallState("IDLE");
            setInputMode("text");
        }
        else {
            setInputMode("voice");
        }
    }, [androidTextInputOnly, inputMode]);
    const handleTextSubmit = useCallback(() => {
        const text = typedText.trim();
        if (!text || callState !== "IDLE")
            return;
        if (sttRef.current) {
            sttRef.current.abort();
            sttRef.current = null;
        }
        setTypedText("");
        queueUserText(text, isVideo ? composeKind : "speech");
    }, [typedText, callState, queueUserText, isVideo, composeKind]);
    // 按住说话（非 iOS）：按下录音，松开转写后走对话轮。群聊无单角色绑定，
    // 识别配置取第一个可用的 OpenAI 兼容语音配置。
    const holdInput = useHoldToTalk({
        canStart: () => isVideo && started && !isMuted && !minimizedRef.current && stateRef.current === "IDLE",
        onRecordingStart: () => {
            setInterimText("");
            if (stateRef.current === "IDLE")
                setCallState("USER_SPEAKING");
        },
        onTranscribeStart: () => {},
        onTranscript: (text) => { queueUserText(text); },
        onError: (message) => {
            setReplyError(message);
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
    const group039Edit=(line:Call039Line,original:string,translated:string)=>{
        const current=subtitles.find(item=>item.id===line.id);if(!current)return;
        const content=current.kind==="action"?original:original+(translated?" | "+translated:"");
        const stored=current.kind==="action"?"【动作】"+content:content;
        editChatMessage(line.id,stored);
        messagesRef.current=messagesRef.current.map(m=>m.id===line.id?{...m,content:stored}:m);
        setSubtitles(prev=>prev.map(item=>item.id===line.id?{...item,text:content}:item));
        if(originalCallSpeech(current.text)!==original)subtitleAudioCacheRef.current.delete(line.id);
    };
    const group039Action=(op:Call039Command,line:Call039Line)=>{
        if(callState!=="IDLE")return;const idx=subtitles.findIndex(item=>item.id===line.id);if(idx<0)return;
        if(op==="favorite"){if(subtitles[idx].kind!=="action")setFavoriteLine(subtitles[idx]);return;}
        if(op==="delete"||op==="delete-after"){
            const ids=op==="delete"?[line.id]:subtitles.slice(idx+1).map(item=>item.id);
            if(ids.length){deleteChatMessagesByIds(session.id,ids);messagesRef.current=messagesRef.current.filter(m=>!ids.includes(m.id));
               ids.forEach(id=>subtitleAudioCacheRef.current.delete(id));setSubtitles(prev=>prev.filter(m=>!ids.includes(m.id)));}
            return;
        }
        const start=op==="reroll-after"?idx+1:(()=>{let i=idx;while(i>0&&subtitles[i-1].role==="assistant")i--;return i;})();
        const ids=subtitles.slice(start).map(item=>item.id);
        pendingReroll039.current=ids;void runConversationTurn(undefined,false);
    };
    const renderTextInputPanel = (floating = false) => {
        if (inputMode !== "text" || callState === "CONNECTING" || callState === "ENDED")
            return null;
        return (<form className={`call-text-input-panel ${floating ? "videocall-text-input-panel gcall-video-text-input-panel" : "voicecall-text-input-panel gcall-text-input-panel"}`} onSubmit={(e) => {
                e.preventDefault();
                handleTextSubmit();
            }}>
                {isVideo && <div className="call-compose-modes" role="group" aria-label="输入内容类型">
                    <button type="button" className={composeKind === "speech" ? "selected" : ""} onClick={() => setComposeKind("speech")} aria-pressed={composeKind === "speech"}>消息</button>
                    <button type="button" className={composeKind === "action" ? "selected" : ""} onClick={() => setComposeKind("action")} aria-pressed={composeKind === "action"}>动作</button>
                </div>}
                <div className="call-text-input-shell">
                    <input value={typedText} onChange={e => setTypedText(e.target.value)} className="call-text-input" placeholder={callState === "IDLE" ? (isVideo && composeKind === "action" ? "输入你要做的动作..." : "输入你想说的话...") : "稍等对方说完..."} disabled={callState !== "IDLE"}/>
                    <button type="submit" className="call-text-send-btn" disabled={!typedText.trim() || callState !== "IDLE"} aria-label="发送">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12 19V5"/>
                            <path d="M5 12l7-7 7 7"/>
                        </svg>
                    </button>
                </div>
            </form>);
    };
    const membersDialog = membersOpen && <div className="chat-call-dialog-backdrop" onClick={() => setMembersOpen(false)}><div className="chat-call-dialog chat-call-member-dialog" role="dialog" aria-modal="true" aria-label="通话成员" onClick={e => e.stopPropagation()}><header><strong>通话成员 · {participantIds.length + 1}</strong><button onClick={() => setMembersOpen(false)} aria-label="关闭成员列表"><X /></button></header><p>已加入的成员继续通话 邀请其他群成员加入</p>{characters.map(char => <div key={char.id} className="chat-call-member-row"><span className="chat-call-member-avatar">{groupMemberAvatar(char) ? <img src={groupMemberAvatar(char) || ""} alt=""/> : char.name[0]}</span><span>{groupMemberName(session, char.id, char)}</span>{participantIds.includes(char.id) ? <small>通话中</small> : <button disabled={callState !== "IDLE"} onClick={() => addMember(char.id)}>邀请</button>}</div>)}</div></div>;
    const renderControls = () => callState === "CONNECTING" ? <><button className="ui-call-btn ui-call-btn-danger" aria-label="取消通话" onClick={() => endCall(true)}><PhoneOff /></button>{initiator === "character" && <button className="ui-call-btn" aria-label="接听通话" onClick={() => setCallState("IDLE")}><Phone /></button>}</> : callState !== "ENDED" ? <><button className="ui-call-btn ui-call-btn-sm" aria-label="召唤回复" disabled={callState !== "IDLE"} onClick={() => void runConversationTurn()}><Sparkles /></button><button className="ui-call-btn ui-call-btn-sm" aria-label={inputMode === "text" ? "切换到语音输入" : "切换到文字输入"} onClick={handleInputModeToggle}>{inputMode === "text" ? <MessageSquare /> : <Mic />}</button>{holdToTalk && inputMode === "voice" && <button className="ui-call-btn ui-call-btn-sm" aria-label="按住说话" {...holdInput.pressHandlers}><Mic /></button>}<button className="ui-call-btn ui-call-btn-sm ui-call-btn-danger" aria-label="挂断" onClick={handleHangup}><PhoneOff /></button><button className="ui-call-btn ui-call-btn-sm" aria-label="麦克风静音" onClick={() => setIsMuted(v => !v)}><Mic opacity={isMuted ? .4 : 1}/></button></> : <span>通话已结束</span>;
    if (!started)
        return <div className="gcall-setup-root voicecall-cards"><div className="chat-call-dialog-backdrop"><div className="chat-call-dialog chat-call-member-dialog" role="dialog" aria-modal="true" aria-label="选择通话成员"><header><strong>发起群{callTypeLabel}</strong><button aria-label="取消发起通话" onClick={() => onEnd(false)}><X /></button></header><p>选择本次参与的人 你会默认加入</p>{characters.map(char => <label key={char.id} className="chat-call-member-row"><span className="chat-call-member-avatar">{groupMemberAvatar(char) ? <img src={groupMemberAvatar(char) || ""} alt=""/> : char.name[0]}</span><span>{groupMemberName(session, char.id, char)}</span><input type="checkbox" checked={chosen.includes(char.id)} onChange={e => setChosen(ids => e.target.checked ? [...ids, char.id] : ids.filter(id => id !== char.id))}/></label>)}<button className="chat-call-start" disabled={!chosen.length} onClick={startSelected}>开始通话{chosen.length > 0 ? ` · ${chosen.length + 1}人` : ""}</button></div></div></div>;
    if (minimized)
        return <DraggableMediaWindow label="返回群通话" onOpen={onRestore} style={{backgroundImage:`url(${resolvedBgs[participantIds[0]]||voiceBgResolved||""})`}}><span className="call-mini-window-overlay"/><span className="call-mini-window-name">{session.groupName || "群聊"} · {participantIds.length+1}人</span></DraggableMediaWindow>;
    if (isVideo) {
        // Grid: participants + self-cam — auto layout to fit screen
        const totalSlots = activeCharacters.length + 1; // +1 for self
        // Decide columns: 1 col for ≤2, 2 cols for ≤6, 3 cols for more
        const cols = totalSlots <= 2 ? 1 : totalSlots <= 6 ? 2 : 3;
        return (<div className="gcall-video-root voicecall-controls call-keyboard-shift" style={keyboardOffsetStyle}>
                {favoriteLine&&<VoiceFavoriteDialog key={favoriteLine.id} draft={{kind:"call",sourceKey:`${session.id}:group:${favoriteLine.id}`,text:originalCallSpeech(favoriteLine.text),characterId:favoriteLine.senderCharacterId||session.contactId,role:favoriteLine.role,getAudio:async()=>subtitleAudioCacheRef.current.get(favoriteLine.id)}} onClose={()=>setFavoriteLine(null)}/>}
                <input type="file" accept="video/*" hidden ref={uploadFile039} onChange={e=>{void uploadThisVideo039(e.target.files?.[0]);e.target.value="";}}/>
                {uploadNotice039&&<div className="call039-disclaimer"><section role="dialog" aria-modal="true" aria-label="视频素材使用须知">
                    <h3>视频素材使用须知</h3><p>本功能展示的视频均由用户自行从本地选择，仅用于虚构视频通话场景的模拟与体验。{"\n\n"}视频画面及互动情节不代表现实人物的真实行为、言论或关系，请勿将虚构内容与现实人物关联，亦请勿上升真人。</p>
                    <footer><button onClick={()=>setUploadNotice039(false)}>取消</button><button onClick={()=>{approved039.current=true;setUploadNotice039(false);uploadFile039.current?.click();}}>我已知晓，继续上传</button></footer>
                </section></div>}
                {uploadPicker039&&<div className="call039-disclaimer"><section><h3>选择本次通话画面</h3>{activeCharacters.map(char=><button key={char.id} style={{display:"block",width:"100%",marginTop:5}} onClick={()=>openUpload039(char.id)}>{groupMemberName(session,char.id,char)}</button>)}<footer><button onClick={()=>setUploadPicker039(false)}>取消</button></footer></section></div>}

                <UploadedVideoVolumeControl volume={uploadedVideoVolume} onChange={adjustUploadedVideoVolume} />
                <button className="gcall-minimize" onClick={onMinimize} aria-label="缩小通话"><ChevronLeft size={22}/></button>
                <button className="gcall-members-button" style={{right:64}} onClick={() => setMembersOpen(true)} aria-label="通话成员和邀请"><Users size={15}/>{activeCharacters.length + 1}</button>
                {callState!=="ENDED"&&<button type="button" className="call039-temp-upload" title="上传本次通话成员视频" aria-label="选择成员上传临时视频" onClick={()=>setUploadPicker039(true)}><Upload size={17}/></button>}
                {/* Video grid */}
                <div className="flex-1 min-h-0 grid gap-[2px] overflow-hidden" data-cols={cols}>
                    {/* Each character's video tile */}
                    {activeCharacters.map(char => {
                const isSpeaking = speakingCharId === char.id;
                const tileBg = resolvedBgs[char.id];
                return (<div key={char.id} className="gcall-video-tile" style={tileBg ? { backgroundImage: `url(${tileBg})`, backgroundSize: "cover", backgroundPosition: "center" } : undefined}>
                                {videos039[char.id]&&<video ref={el=>{if(el){uploadedVideoElements.current[char.id]=el;el.volume=uploadedVideoVolume;el.muted=uploadedVideoVolume===0;}else delete uploadedVideoElements.current[char.id];}} src={videos039[char.id]} className="call039-temp-video" autoPlay loop muted={uploadedVideoVolume===0} playsInline/>}
                                {!tileBg && !videos039[char.id] && (groupMemberAvatar(char) ? (<img src={groupMemberAvatar(char) || ""} alt={groupMemberName(session, char.id, char)} className={`w-full h-full object-cover transition-opacity duration-300 ${callState === "CONNECTING" ? "gcall-video-avatar-dim" : "gcall-video-avatar-bright"}`}/>) : (<div className="gcall-video-tile-fallback">
                                        <span className="ts-40 opacity-60">{groupMemberName(session, char.id, char)?.[0] || "?"}</span>
                                    </div>))}
                                <div className="gcall-video-tile-name videocall-name">{groupMemberName(session, char.id, char)}</div>
                                {isSpeaking && <div className="gcall-video-speaking-ring"/>}
                            </div>);
            })}

                    {/* Self-cam tile */}
                    <div className="gcall-video-tile-self" style={resolvedBgs["self"] ? { backgroundImage: `url(${resolvedBgs["self"]})`, backgroundSize: "cover", backgroundPosition: "center" } : undefined}>
                        {cameraEnabled039&&<video ref={cameraVideo039} className="call039-temp-video" muted autoPlay playsInline/>}
                        {!resolvedBgs["self"] && (effectiveUserAvatar ? (<img src={effectiveUserAvatar} alt={userNameRef.current} className="w-full h-full object-cover"/>) : (<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity={0.5}>
                                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
                                <circle cx="12" cy="7" r="4"/>
                            </svg>))}
                        <div className="gcall-video-tile-name videocall-name">{groupMemberName(session, "self", null, userNameRef.current)}</div>
                        {speakingCharId === "self" && <div className="gcall-video-speaking-ring"/>}
                    </div>
                </div>

                {/* Top info overlay */}
                <div className="absolute top-0 left-0 right-0 z-10 gcall-topbar gcall-topbar-video">
                    <div className="gcall-topbar-title videocall-name">
                        群{callTypeLabel} ({activeCharacters.length + 1}人)
                    </div>
                    <div className="gcall-topbar-sub videocall-name" {...(callState === "CONNECTING" || callState === "PROCESSING" ? { "data-anim": "" } : {})}>
                        {callState !== "CONNECTING" && callState !== "ENDED" ? `${formatTime(callDuration)} · ` : ""}
                        {stateLabel()}
                    </div>
                </div>

                {transcriptVisible039&&<div className="call039-video-overlay" ref={subtitleScrollRef}>
                    <Call039Transcript lines={subtitles.map(item=>({id:item.id,role:item.role,kind:item.kind||"speech",text:item.text,
                        speakerName:item.role==="user"?"我":item.senderCharacterId?groupMemberName(session,item.senderCharacterId,characters.find(c=>c.id===item.senderCharacterId)):item.senderName||"成员"}))}
                        showSpeaker playingId={playingSubtitleId} onPlay={line=>{const sub=subtitles.find(v=>v.id===line.id);if(sub)void playSubtitle(sub);}}
                        onEdit={group039Edit} onCommand={group039Action}/>
                    {interimText&&<div className="call-video-action">{interimText}</div>}
                </div>}
                {transcriptVisible039&&callState!=="CONNECTING"&&callState!=="ENDED"&&<div className="call039-voice-compose">
                    <button type="button" className="call039-kind" onClick={()=>setComposeKind(k=>k==="speech"?"action":"speech")} aria-label="语言动作切换">{composeKind==="speech"?"语":"动"}</button>
                    <input value={typedText} onChange={e=>setTypedText(e.target.value)} placeholder={composeKind==="speech"?"输入语言，回车发送…":"输入动作，回车发送…"}
                        disabled={callState!=="IDLE"} onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();handleTextSubmit();}}}/>
                    <button type="button" onClick={()=>void runConversationTurn(undefined,true)} disabled={callState!=="IDLE"} aria-label="召唤成员继续">↑</button>
                </div>}
                {membersDialog}
                {replyError&&<button className="gcall-video-error" onClick={()=>setReplyError(null)}>{replyError}</button>}
                <div className={`call039-video-controls${callState==="CONNECTING" && initiator==="user" ? " call039-video-controls--outgoing" : ""}`}>
                    {callState==="CONNECTING" ? <>
                        <button className="hang" onClick={()=>endCall(true)} aria-label="取消群视频"><PhoneOff size={28}/></button>
                        {initiator==="character"&&<button onClick={()=>setCallState("IDLE")} aria-label="接听"><Video size={24}/></button>}
                    </> : callState!=="ENDED" ? <>
                        <button onClick={()=>void toggleCamera039()} aria-label={cameraEnabled039?"关闭摄像头":"打开摄像头"}>{cameraEnabled039?<Video size={24}/>:<VideoOff size={24}/>}</button>
                        <button className="hang" onClick={handleHangup} aria-label="挂断"><PhoneOff size={28}/></button>
                        <button onClick={()=>setTranscriptVisible039(v=>!v)} aria-label={transcriptVisible039?"隐藏对话":"显示对话"}>{transcriptVisible039?<MessageSquare size={24}/>:<MessageSquareOff size={24}/>}</button>
                    </> : null}
                </div>
            </div>);
    }
    const avatarStrip = <div className="chat-call-avatar-strip" aria-label="切换通话成员">{activeCharacters.map(char => <button key={char.id} type="button" className="chat-call-member-tab" data-selected={selectedCharacter?.id === char.id} data-speaking={speakingCharId === char.id} data-new={newSpeakerIds.includes(char.id) && selectedCharacter?.id !== char.id} aria-label={`查看${groupMemberName(session, char.id, char)}的台词`} aria-pressed={selectedCharacter?.id === char.id} onClick={() => { setSelectedId(char.id); setNewSpeakerIds(ids => ids.filter(id => id !== char.id)); }}><span className="chat-call-card-avatar">{groupMemberAvatar(char) ? <img src={groupMemberAvatar(char) || ""} alt=""/> : <span>{char.name[0]}</span>}</span></button>)}</div>;
    const selectedLines = subtitles.filter(line => line.role === "user" || line.senderCharacterId === selectedCharacter?.id);
    const deleteSubtitle = (id: string) => { if (callState !== "IDLE" || !subtitles.some(line => line.id === id && line.role === "assistant"))
        return; deleteChatMessagesByIds(session.id, [id]); messagesRef.current = messagesRef.current.filter(message => message.id !== id); subtitleAudioCacheRef.current.delete(id); setSubtitles(lines => lines.filter(line => line.id !== id)); };
    return <div className="gcall-voice-cards voicecall-cards" style={voiceBgResolved ? { ...keyboardOffsetStyle, background: `url(${voiceBgResolved}) center/cover no-repeat` } : keyboardOffsetStyle}>{favoriteLine&&<VoiceFavoriteDialog key={favoriteLine.id} draft={{kind:"call",sourceKey:`${session.id}:group:${favoriteLine.id}`,text:originalCallSpeech(favoriteLine.text),characterId:favoriteLine.senderCharacterId || session.contactId,role:favoriteLine.role,getAudio:async()=>subtitleAudioCacheRef.current.get(favoriteLine.id)}} onClose={()=>setFavoriteLine(null)}/>}<VoiceCallLayout name={selectedCharacter ? groupMemberName(session, selectedCharacter.id, selectedCharacter) : "通话成员"} avatar="" userName={groupMemberName(session, "self", null, userNameRef.current)} userAvatar={effectiveUserAvatar} lines={selectedLines} roundStart={roundStarts[selectedCharacter?.id || ""] || null} playingId={playingSubtitleId} state={callState} duration={formatTime(callDuration)} queued={queuedTurns} error={replyError} onClearError={() => setReplyError(null)} onMinimize={onMinimize} onSummon={() => void runConversationTurn()} onInput={() => setInputOpen(true)} onHangup={handleHangup} onAccept={() => setCallState("IDLE")} onDecline={() => endCall(true)} incoming={initiator === "character"} onPlay={line => { const subtitle = subtitles.find(item => item.id === line.id); if (subtitle)
        void playSubtitle(subtitle); }} onFavorite={id=>setFavoriteLine(subtitles.find(line=>line.id===id)||null)} onDelete={deleteSubtitle} outputName={outputName} onOutput={() => { void selectCallAudioOutput().then(() => setOutputName("已选设备")).catch(error => setReplyError(error instanceof Error ? error.message : "请在系统中选择播放设备")); }} group={{ count: participantIds.length + 1, title: session.groupName || "群聊", selectedId: selectedCharacter?.id || "", avatars: avatarStrip, onMembers: () => setMembersOpen(true), positions: scrollPositions.current }} settings={<><CallVolumeControl /><p>点击头像切换台词 点击喇叭播放原文</p><p>输入后点击召唤生成回复</p></>} input={<>{membersDialog}{inputOpen && <div className="chat-call-dialog-backdrop chat-call-input-backdrop" onClick={() => setInputOpen(false)}><div className="chat-call-dialog chat-call-input-dialog" role="dialog" aria-modal="true" aria-label="通话输入" style={keyboardOffsetStyle} onClick={e => e.stopPropagation()}><header><strong>输入消息</strong><button aria-label="关闭输入" onClick={() => setInputOpen(false)}><X /></button></header><form onSubmit={e => { e.preventDefault(); handleTextSubmit(); }}><textarea autoFocus rows={3} value={typedText} onChange={e => setTypedText(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        handleTextSubmit();
    } }} placeholder="说点什么…"/><button type="submit" disabled={!typedText.trim() || callState !== "IDLE"}><Send size={16}/>发送</button></form></div></div>}</>}/></div>;
}
