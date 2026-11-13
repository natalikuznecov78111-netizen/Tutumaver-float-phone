"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useAppBack } from "@/lib/back-navigation";
import type { ReactNode } from "react";
import { BadgeCheck, ChevronRight, Heart, LoaderCircle, Play, Plus, Send, Square, Volume2, X } from "lucide-react";
import type { WeverseLive } from "@/lib/weverse-storage";
import {isCallAudioSessionActive, playAudioBlobViaMediaElement, resolveUserVoiceConfig, resolveVoiceConfig, synthesizeSpeech, unlockAudioPlayback } from "@/lib/tts-service";
import styles from "./weverse-app.module.css";

type Props = {
  isUserGuest?: boolean;
  artistViewer?: boolean;
  onLiveActions?: () => void;
  onLeaveStage?: () => void;
  generationFeedback?: ReactNode;
  isUserHost?: boolean; onHostSend?:(text:string,kind:"speech"|"action")=>void;
  live: WeverseLive;
  speakerNames: Record<string, string>;
  speakerAvatars: Record<string, string>;
  userName: string;
  busy?: boolean;
  onBack: () => void;
  onAdvance: () => void;
  onSendComment: (body: string) => void;
  onHeart: () => void;
  onFinalizeEnd: () => void;
  onManualEnd: () => void;
};

const liveVoiceCache = new Map<string, Blob>();
const LIVE_VOICE_CACHE_LIMIT = 36;

function cacheLiveVoice(key: string, blob: Blob): void {
  if (liveVoiceCache.has(key)) liveVoiceCache.delete(key);
  liveVoiceCache.set(key, blob);
  while (liveVoiceCache.size > LIVE_VOICE_CACHE_LIMIT) {
    const oldest = liveVoiceCache.keys().next().value as string | undefined;
    if (!oldest) break;
    liveVoiceCache.delete(oldest);
  }
}

function compact(value: number): string {
  const n = Math.max(0, Math.round(value || 0));
  if (n < 1000) return String(n);
  if (n < 10000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K`;
  if (n < 100000000) return `${(n / 10000).toFixed(1).replace(/\.0$/, "")}万`;
  return `${(n / 100000000).toFixed(1).replace(/\.0$/, "")}亿`;
}

function liveElapsed(startedAt: number, endAt: number): string {
  const ms = Math.max(0, endAt - startedAt);
  const sec = Math.floor(ms / 1000);
  const min = Math.floor(sec / 60);
  const hour = Math.floor(min / 60);
  if (hour) return `${hour}:${String(min % 60).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
  return `${String(min).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
}

export function WeverseLiveView({ isUserHost, isUserGuest, artistViewer, onLiveActions, onLeaveStage, generationFeedback, onHostSend, live, speakerNames, speakerAvatars, userName, busy, onBack, onAdvance, onSendComment, onHeart, onFinalizeEnd, onManualEnd }: Props) {
  const [clock, setClock] = useState(() => Date.now());
  const [hostKind,setHostKind]=useState<"speech"|"action">("speech");
  const commentsFollow=useRef(true);
  const [draft, setDraft] = useState("");
  useEffect(() => { setDraft(""); setHostKind("speech"); }, [isUserHost]);
  const [exitSheetOpen, setExitSheetOpen] = useState(false);
  const liveRootRef = useRef<HTMLDivElement>(null);
  // Back gesture behaves like the Live close button rather than silently leaving.
  useAppBack(() => {
    if (exitSheetOpen) setExitSheetOpen(false);
    else setExitSheetOpen(true);
  }, () => live.status === "live" && !!liveRootRef.current?.getClientRects().length, 25);
  const [artistCommentsOpen, setArtistCommentsOpen] = useState(false);
  const [transcriptPinned, setTranscriptPinned] = useState(true);
  const [heartBursts, setHeartBursts] = useState<Array<{ id: number; x: number }>>([]);
  const [voiceLoadingSegmentId, setVoiceLoadingSegmentId] = useState<string | null>(null);
  const [playingVoiceSegmentId, setPlayingVoiceSegmentId] = useState<string | null>(null);
  const [selectedVoiceSegmentId, setSelectedVoiceSegmentId] = useState<string | null>(null);
  const [voiceNotice, setVoiceNotice] = useState<string | null>(null);
  const heartIdRef = useRef(0);
  const voiceRequestIdRef = useRef(0);
  const voicePlaybackRef = useRef<{ promise: Promise<void>; abort: () => void } | null>(null);
  const voiceNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commentBoxRef = useRef<HTMLDivElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);

  useEffect(()=>{const fn=(event:Event)=>{if((event as CustomEvent).detail?.active){voiceRequestIdRef.current++;voicePlaybackRef.current?.abort();voicePlaybackRef.current=null;setPlayingVoiceSegmentId(null);}};window.addEventListener('chat-call-state',fn);return()=>window.removeEventListener('chat-call-state',fn);},[]);
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 300);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => () => {
    voiceRequestIdRef.current += 1;
    voicePlaybackRef.current?.abort();
    voicePlaybackRef.current = null;
    if (voiceNoticeTimerRef.current) clearTimeout(voiceNoticeTimerRef.current);
  }, [live.id]);

  const visibleSegments = useMemo(
    () => [...live.segments].filter((item) => item.createdAt <= clock).sort((a, b) => a.createdAt - b.createdAt),
    [live.segments, clock],
  );
  const visibleComments = useMemo(
    () => [...live.comments].filter((item) => item.createdAt <= clock).sort((a, b) => a.createdAt - b.createdAt),
    [live.comments, clock],
  );
  const visibleArtistComments = useMemo(() => visibleComments.filter((item) => item.authorType === "artist"), [visibleComments]);
  const isVoiceLive = live.liveType === "voice";
  const latestVoiceSegment = useMemo(() => [...visibleSegments].reverse().find((item) => item.kind === "speech"), [visibleSegments]);
  const displayedVoiceSegment = useMemo(() => visibleSegments.find((item) => item.id === selectedVoiceSegmentId && item.kind === "speech") || [...visibleSegments].reverse().find(item => item.kind === "action" && item.createdAt > (latestVoiceSegment?.createdAt || 0)) || latestVoiceSegment, [latestVoiceSegment, selectedVoiceSegmentId, visibleSegments]);
  const latestVoiceSystem = useMemo(() => [...visibleSegments].reverse().find((item) => item.kind === "system"), [visibleSegments]);
  const voiceParticipantIds = useMemo(() => {
    const ids = live.status === "live" && live.activeCharacterIds.length ? live.activeCharacterIds : live.hostCharacterIds;
    return [...new Set(ids)].slice(0, 4);
  }, [live.activeCharacterIds, live.hostCharacterIds, live.status]);
  const bufferedUntil = Math.max(live.startedAt, ...live.segments.map((item) => item.createdAt), ...live.comments.map((item) => item.createdAt));
  const isPlaying = live.status === "live" && bufferedUntil > clock;
  const isEnding = live.status === "live" && Boolean(live.endedAt);

  useEffect(() => {
    if (live.status === "live" && live.endedAt && clock >= live.endedAt) onFinalizeEnd();
  }, [clock, live.status, live.endedAt, onFinalizeEnd]);

  useEffect(() => { setSelectedVoiceSegmentId(null); }, [visibleSegments.length]);

  useEffect(() => {
    const box = commentBoxRef.current;
    if (!box) return;
    if(commentsFollow.current) box.scrollTo({top:box.scrollHeight,behavior:"smooth"});
  }, [visibleComments.length]);

  useEffect(() => {
    const box = transcriptRef.current;
    if (!box || !transcriptPinned) return;
    box.scrollTop = box.scrollHeight;
  }, [visibleSegments.length, transcriptPinned]);

  const showVoiceNotice = (message: string) => {
    setVoiceNotice(message);
    if (voiceNoticeTimerRef.current) clearTimeout(voiceNoticeTimerRef.current);
    voiceNoticeTimerRef.current = setTimeout(() => setVoiceNotice(null), 2600);
  };

  const stopVoice = () => {
    voiceRequestIdRef.current += 1;
    voicePlaybackRef.current?.abort();
    voicePlaybackRef.current = null;
    setVoiceLoadingSegmentId(null);
    setPlayingVoiceSegmentId(null);
  };

  const playSegmentVoice = async (segment: WeverseLive["segments"][number]) => {
    if (segment.kind !== "speech" || !segment.original.trim()) return;

    if (playingVoiceSegmentId === segment.id || voiceLoadingSegmentId === segment.id) {
      stopVoice();
      return;
    }

    const characterId = segment.characterId || live.hostCharacterIds[0];
    if (!characterId) {
      showVoiceNotice("这段发言没有对应的角色语音");
      return;
    }

    const voiceConfig = characterId.startsWith("user:") ? resolveUserVoiceConfig() : resolveVoiceConfig(characterId, "weverse");
    if (!voiceConfig || !voiceConfig.enableTTS) {
      showVoiceNotice("请先在配置绑定中为 Weverse 绑定可用的语音方案");
      return;
    }

    if(isCallAudioSessionActive()){setVoiceNotice("通话进行中，直播暂时静音");return;}
    unlockAudioPlayback();
    stopVoice();
    const requestId = ++voiceRequestIdRef.current;
    setVoiceLoadingSegmentId(segment.id);

    try {
      const cacheKey = [
        voiceConfig.id,
        voiceConfig.defaultVoice || "",
        voiceConfig.speechSpeed ?? 1,
        voiceConfig.speechPitch ?? 0,
        segment.original,
      ].join("::");
      let blob = liveVoiceCache.get(cacheKey) || null;
      if (!blob) {
        blob = await synthesizeSpeech(segment.original, voiceConfig);
        if (blob) cacheLiveVoice(cacheKey, blob);
      }
      if (requestId !== voiceRequestIdRef.current) return;
      if (!blob) throw new Error("语音服务没有返回音频");

      setVoiceLoadingSegmentId(null);
      setPlayingVoiceSegmentId(segment.id);
      const playback = playAudioBlobViaMediaElement(blob);
      voicePlaybackRef.current = playback;
      await playback.promise;
    } catch (error) {
      if (requestId === voiceRequestIdRef.current) {
        showVoiceNotice(error instanceof Error ? error.message : "语音播放失败，请检查语音配置");
      }
    } finally {
      if (requestId === voiceRequestIdRef.current) {
        voicePlaybackRef.current = null;
        setVoiceLoadingSegmentId(null);
        setPlayingVoiceSegmentId(null);
      }
    }
  };

  const sendDraft = () => {
    const value = draft.trim();
    if (!value || live.status === "ended") return;
    if(isUserHost)onHostSend?.(value,hostKind);else onSendComment(value);
    setDraft("");
  };

  const tapHeart = () => {
    onHeart();
    const id = ++heartIdRef.current;
    const x = 18 + Math.random() * 64;
    setHeartBursts((prev) => [...prev.slice(-11), { id, x }]);
    window.setTimeout(() => setHeartBursts((prev) => prev.filter((item) => item.id !== id)), 1250);
  };

  const canAdvance = live.status === "live" && !busy && !isPlaying && !isEnding;

  return (
    <div ref={liveRootRef} className={styles.liveRoom}>
      <header className={styles.liveWvsHeader}>
        {onLiveActions ? <button type="button" className={styles.liveActionTrigger} aria-label="合播选项" onClick={onLiveActions}><Plus size={20} /></button>
          : isUserGuest ? <span className={styles.liveOnStageLabel}>合播中</span> : <span />}
        <div className={styles.liveWvsStatus}>{live.status === "live" ? <><i /> Live</> : "REPLAY"}</div>
        <button type="button" onClick={() => live.status === "live" ? setExitSheetOpen(true) : onBack()} aria-label="关闭"><X size={25} /></button>
      </header>

      <section className={`${styles.liveStage} ${isVoiceLive ? styles.voiceLiveStage : ""}`}>
        {isVoiceLive ? <>
          <div className={styles.voiceLiveMetrics}>
            <span><Play size={12} fill="currentColor" /> {compact(live.viewerCount)}</span>
            <span><Heart size={13} fill="currentColor" /> {compact(live.heartCount)}</span>
          </div>
          <div className={styles.voiceLiveFocus}>
            {displayedVoiceSegment ? <div className={styles.voiceLiveBubble}>
              <b>{displayedVoiceSegment.characterId ? (speakerNames[displayedVoiceSegment.characterId] || displayedVoiceSegment.characterId) : "Live"}</b>
              <p>{displayedVoiceSegment.original}</p>
              {displayedVoiceSegment.translated && displayedVoiceSegment.translated !== displayedVoiceSegment.original ? <small>{displayedVoiceSegment.translated}</small> : null}
            </div> : <div className={styles.voiceLiveBubble}><p>正在连接 Voice Live…</p></div>}
            <div className={styles.voiceLiveAvatars}>{voiceParticipantIds.map((characterId) => {
              const segment = [...visibleSegments].reverse().find((item) => item.kind === "speech" && item.characterId === characterId);
              const active = Boolean(segment && (voiceLoadingSegmentId === segment.id || playingVoiceSegmentId === segment.id));
              return <button type="button" key={characterId} className={active ? styles.voiceLiveAvatarActive : ""} onClick={() => { if (segment) { setSelectedVoiceSegmentId(segment.id); void playSegmentVoice(segment); } }} aria-label={`播放 ${speakerNames[characterId] || characterId} 的当前发言`}>
                {speakerAvatars[characterId] ? <img src={speakerAvatars[characterId]} alt="" /> : <span>{(speakerNames[characterId] || characterId).slice(0,1)}</span>}
                <i>{active ? (voiceLoadingSegmentId === segment?.id ? <LoaderCircle size={16} className={styles.liveVoiceSpinner} /> : <Square size={12} fill="currentColor" />) : <Volume2 size={16} />}</i>
              </button>;
            })}</div>
            {latestVoiceSystem ? <div className={styles.voiceLiveSystem}>{latestVoiceSystem.original}</div> : null}
          </div>
          <div ref={commentBoxRef} className={`${styles.liveComments} ${styles.voiceLiveComments}`} onWheel={e=>{if(e.deltaY<0)commentsFollow.current=false;}} onTouchStart={()=>{commentsFollow.current=false;}} onPointerDown={()=>{commentsFollow.current=false;}} onScroll={e=>{const b=e.currentTarget;if(b.scrollHeight-b.scrollTop-b.clientHeight<40)commentsFollow.current=true;}}>
            {visibleComments.map((comment) => (
              <div key={comment.id} className={`${styles.liveComment} ${comment.authorType === "user" ? styles.liveCommentMe : ""} ${comment.authorType === "artist" ? styles.liveCommentArtist : ""}`}>
                {comment.authorType === "artist" ? <span className={styles.liveArtistCommentAvatar}>{comment.authorAvatarUrl ? <img src={comment.authorAvatarUrl} alt="" /> : comment.authorName.slice(0,1)}</span> : null}
                <div className={styles.liveCommentBody}><div className={styles.liveCommentMeta}><b>{comment.authorType === "user" ? userName : comment.authorName}{comment.authorType === "artist" ? <BadgeCheck size={12} fill="currentColor" /> : null}</b><time>{new Date(comment.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}</time></div><p>{comment.originalBody || comment.body}</p>{comment.originalBody && comment.originalBody !== comment.body ? <small>{comment.body}</small> : null}</div>
              </div>
            ))}
            {!visibleComments.length ? <div className={styles.liveWaiting}>观众正在进来…</div> : null}
          </div>
        </> : <div ref={transcriptRef} className={styles.liveTranscript} onScroll={(event) => {
          const box = event.currentTarget;
          setTranscriptPinned(box.scrollHeight - box.scrollTop - box.clientHeight < 38);
        }}>
          {visibleSegments.length ? visibleSegments.map((segment) => {
            const speaker = segment.characterId ? (speakerNames[segment.characterId] || segment.characterId) : "";
            const isVoiceLoading = voiceLoadingSegmentId === segment.id;
            const isVoicePlaying = playingVoiceSegmentId === segment.id;
            return <div key={segment.id} className={segment.kind === "action" ? styles.liveActionLine : segment.kind === "system" ? styles.liveSystemLine : styles.liveSpeechLine}>
              {speaker && segment.kind !== "system" ? <b>{speaker}</b> : null}
              {segment.kind === "speech" ? <div className={styles.liveSpeechAudioRow}>
                <button
                  type="button"
                  className={`${styles.liveSpeechVoiceButton} ${isVoiceLoading || isVoicePlaying ? styles.liveSpeechVoiceButtonActive : ""}`}
                  onClick={() => void playSegmentVoice(segment)}
                  aria-label={isVoiceLoading ? "停止生成语音" : isVoicePlaying ? "停止播放" : "播放这条发言"}
                  title={isVoiceLoading ? "停止生成语音" : isVoicePlaying ? "停止播放" : "播放这条发言"}
                >
                  {isVoiceLoading ? <LoaderCircle size={12} className={styles.liveVoiceSpinner} /> : isVoicePlaying ? <Square size={10} fill="currentColor" /> : <Volume2 size={13} />}
                </button>
                <p>{segment.original}</p>
              </div> : <p>{segment.original}</p>}
              {segment.kind === "speech" && segment.translated && segment.translated !== segment.original ? <small className={styles.liveSpeechTranslation}>{segment.translated}</small> : null}
            </div>;
          }) : <div className={styles.liveConnecting}>正在连接 Live…</div>}
        </div>}
        <time className={styles.liveStageTime}>{liveElapsed(live.startedAt, live.status === "ended" && live.endedAt ? live.endedAt : clock)}</time>
        {voiceNotice ? <div className={styles.liveVoiceNotice}>{voiceNotice}</div> : null}
      </section>

      {!isVoiceLive ? <div className={styles.liveMetricRow}>
        <span><Play size={13} fill="currentColor" /> {compact(live.viewerCount)}</span>
        <span><Heart size={14} /> {compact(live.heartCount)}</span>
      </div> : null}

      {visibleArtistComments.length ? <button
        type="button"
        className={styles.liveArtistCommentEntry}
        data-open={artistCommentsOpen ? "true" : "false"}
        onClick={() => setArtistCommentsOpen((value) => !value)}
        aria-expanded={artistCommentsOpen}
      >
        <span className={styles.liveArtistEntryAvatars}>{visibleArtistComments.slice(-3).map((comment) => <i key={comment.id}>{comment.authorAvatarUrl ? <img src={comment.authorAvatarUrl} alt="" /> : comment.authorName.slice(0, 1)}</i>)}</span>
        <b>{visibleArtistComments.length} 条艺人评论</b><ChevronRight size={16} />
      </button> : null}

      {artistCommentsOpen && visibleArtistComments.length ? <div className={styles.liveArtistDrawer}>
        <div className={styles.liveArtistPanelList}>{visibleArtistComments.map((comment) => <article key={comment.id}>
          <span className={styles.liveArtistPanelAvatar}>{comment.authorAvatarUrl ? <img src={comment.authorAvatarUrl} alt="" /> : comment.authorName.slice(0,1)}</span>
          <div><div><b>{comment.authorName} <BadgeCheck size={13} fill="currentColor" /></b><time>{new Date(comment.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}</time></div><p>{comment.originalBody || comment.body}</p>{comment.originalBody && comment.originalBody !== comment.body ? <small>{comment.body}</small> : null}</div>
        </article>)}</div>
      </div> : null}

      {!isVoiceLive ? <div ref={commentBoxRef} className={styles.liveComments} onWheel={e=>{if(e.deltaY<0)commentsFollow.current=false;}} onTouchStart={()=>{commentsFollow.current=false;}} onPointerDown={()=>{commentsFollow.current=false;}} onScroll={e=>{const b=e.currentTarget;if(b.scrollHeight-b.scrollTop-b.clientHeight<40)commentsFollow.current=true;}}>
        {visibleComments.map((comment) => (
          <div key={comment.id} className={`${styles.liveComment} ${comment.authorType === "user" ? styles.liveCommentMe : ""} ${comment.authorType === "artist" ? styles.liveCommentArtist : ""}`}>
            {comment.authorType === "artist" ? <span className={styles.liveArtistCommentAvatar}>{comment.authorAvatarUrl ? <img src={comment.authorAvatarUrl} alt="" /> : comment.authorName.slice(0,1)}</span> : null}
            <div className={styles.liveCommentBody}>
              <div className={styles.liveCommentMeta}><b>{comment.authorType === "user" ? userName : comment.authorName}{comment.authorType === "artist" ? <BadgeCheck size={12} fill="currentColor" /> : null}</b><time>{new Date(comment.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}</time></div>
              <p>{comment.originalBody || comment.body}</p>
              {comment.originalBody && comment.originalBody !== comment.body ? <small>{comment.body}</small> : null}
            </div>
          </div>
        ))}
        {!visibleComments.length ? <div className={styles.liveWaiting}>观众正在进来…</div> : null}
      </div> : null}

      <div className={styles.liveBottomPanel}>
        {live.status === "live" ? <div className={`${styles.liveComposer}${isUserHost ? ` ${styles.liveArtistComposer}` : ""}`}>
          {isUserHost && <button type="button" onClick={()=>setHostKind(k=>k==="speech"?"action":"speech")}>{hostKind==="speech"?"语":"动"}</button>}
          <input
            value={draft}
            disabled={isEnding}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); sendDraft(); } }}
            placeholder={isUserHost ? (hostKind==="speech"?"说点什么…":"写下动作…") : isEnding ? "角色正在收尾…" : artistViewer ? "输入艺人评论，回车发送" : "输入评论，回车发送"}
          />
          <button type="button" className={styles.livePlaneButton} onClick={() => { if (isUserHost && draft.trim()) sendDraft(); onAdvance(); }} disabled={isUserHost ? busy : !canAdvance} aria-label={busy ? "生成中" : isPlaying ? "播放中" : "召唤或继续播放"}><Send size={18} /></button>
          {!isUserHost && <>
            <button type="button" className={styles.liveHeartButton} onClick={tapHeart} aria-label="点赞"><Heart size={20} fill="currentColor" /></button>
            <div className={styles.liveHeartFloatLayer}>{heartBursts.map((item) => <Heart key={item.id} className={styles.liveHeartFloat} style={{ left: `${item.x}%` }} size={19} fill="currentColor" />)}</div>
          </>}
        </div> : <div className={styles.liveEndedBanner}>Live 已结束</div>}
      </div>

      {generationFeedback && <div className={styles.liveGenerationFeedback}>{generationFeedback}</div>}
      {exitSheetOpen ? <div className={styles.liveExitMask} onMouseDown={(event) => { if (event.currentTarget === event.target) setExitSheetOpen(false); }}>
        <section className={styles.liveExitSheet}>
          <div className={styles.liveExitHandle} />
          <h3>退出直播？</h3>
          <p>{isUserGuest ? "退出合播后，主持艺人会继续直播。" : "可以只退出页面并保留后台播放，或者直接结束本场直播。"}</p>
          <button type="button" className={styles.liveExitKeepBtn} onClick={() => { setExitSheetOpen(false); (isUserGuest ? onLeaveStage : onBack)?.(); }}>{isUserGuest ? "退出合播" : "仅退出，保留后台播放"}</button>
          {!isUserGuest && <button type="button" className={styles.liveExitEndBtn} disabled={busy} onClick={() => { setExitSheetOpen(false); onManualEnd(); }}>结束直播</button>}
          <button type="button" className={styles.liveExitCancelBtn} onClick={() => setExitSheetOpen(false)}>取消</button>
        </section>
      </div> : null}
    </div>
  );
}
