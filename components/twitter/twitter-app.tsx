"use client";

import {TwitterRecipientPicker,TwitterFrozenCard} from "./twitter-sharing";
import {knownTwitterAccount,twitterRecognizes,twitterMessagePreview} from "@/lib/twitter-storage";
import {prepareSocialMedia,markMediaSent,type SocialMedia} from '@/lib/social-media';
import {OnceMedia} from '@/components/once-media';

import { twitterAccountEnabled } from "@/lib/twitter-storage";
import { useGenerationFeedback } from "@/components/generation-feedback";
import { preparePhotoStoryCaption } from "@/lib/photo-story-caption";
import type { PhotoStorySnapshot } from "@/lib/photo-story-data";

import { formatTwitterCount } from "@/lib/twitter-metrics";
import { twitterThreadReplies } from "@/lib/twitter-thread";

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties } from "react";
import {
  ArrowLeft, Bell, Bookmark, Heart, Home, ImagePlus, MessageCircle,
  MoreHorizontal, Plus, RefreshCw, Repeat2, Search, Send, Settings2, Sparkles, Trash2, UserRoundPlus, X, Camera, MapPin, ListPlus, CalendarDays, BadgeCheck, ChevronDown, Share2,
} from "lucide-react";
import { CHARACTERS_UPDATED_EVENT, loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import { resolveUserIdentity } from "@/lib/settings-storage";
import { getChatImageFromIndexedDB, saveChatImageToIndexedDB } from "@/lib/chat-asset-storage";
import { appendPhotoRecords, createPhotoId, loadPhotoLibrary } from "@/lib/photo-library-storage";
import { generateImageFromConfiguredApi, type ImageGenerationResult } from "@/lib/image-generation-service";
import { recordPreparedPhotoUse, resolveMediaForUse } from "@/lib/media-resolver";
import { generateTwitterText, type TwitterGeneratedLine, type TwitterCommentDraft } from "@/lib/twitter-engine";
import { generateTwitterComments, generateTwitterCommunityText, generateTwitterDelayedReply, generateTwitterStrangerDms, generateTwitterStrangerReply, generateTwitterTrends, generateTwitterWorldBatch, translateTwitterLegacy, type TwitterWorldComment } from "@/lib/twitter-world-engine";
import { TwitterManagement } from "./twitter-management";
import { refreshCommentTimes, refreshPostTimes } from "@/lib/social-post-time";
import {
  createTwitterId, loadTwitterState, saveTwitterState, TWITTER_UPDATED_EVENT,
  type TwitterEngagement, type TwitterMessage, type TwitterPost, type TwitterProfile, type TwitterState,
} from "@/lib/twitter-storage";
import styles from "./twitter-app.module.css";

type Tab = "home" | "explore" | "notices" | "messages";
type Picker = "post" | "reply" | "dm" | null;
type Props = { onClose: () => void; onNotice?: (text: string) => void };

const timestamp = (value: number) => {
  const delta = Date.now() - value;
  if (delta < 60_000) return "刚刚";
  if (delta < 3600_000) return `${Math.max(1, Math.floor(delta / 60_000))} 分钟`;
  if (delta < 86400_000) return `${Math.floor(delta / 3600_000)} 小时`;
  return new Date(value).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
};
const messageDay = (value: number) => new Date(value).toLocaleDateString("zh-CN", { year: "numeric", month: "numeric", day: "numeric" });
const messageDate = (value: number) => new Date(value).toLocaleString("zh-CN", { month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" });
const stableFraction = (key: string) => {
  let value = 2166136261;
  for (let i = 0; i < key.length; i++) value = Math.imul(value ^ key.charCodeAt(i), 16777619);
  return (value >>> 0) / 4294967295;
};
const engagementFor = (id: string, followers = 0, initialComments = 0): TwitterEngagement => {
  const reach = Math.max(9, Math.round(Math.sqrt(Math.max(0, followers)) * (4 + stableFraction(`${id}reach`) * 12)));
  return { views: reach, likes: Math.floor(reach * (.03 + stableFraction(`${id}likes`) * .18)), reposts: Math.floor(reach * (.002 + stableFraction(`${id}shares`) * .028)), comments: Math.max(initialComments, Math.floor(reach * (.001 + stableFraction(`${id}comments`) * .026))) };
};
const countLabel = (count: number) => count >= 10000 ? `${(count / 10000).toFixed(1)}万` : count ? String(count) : "";
const accountHandle = (text: string) => text.replace(/^@/, "").replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 28).toLowerCase() || "visitor";
const sourceLanguage = (original: string) => {
  const body = original.replace(/#[\p{L}\p{N}_]+/gu, "");
  return /[가-힣ㄱ-ㅎㅏ-ㅣ]/.test(body) ? "韩语" : /[ぁ-ゟ゠-ヿ]/.test(body) ? "日语" : /[ก-๙]/.test(body) ? "泰语" : /[麼個這為來說會們]/.test(body) ? "繁体中文" : !/[\u3400-\u9fff]/.test(body) && /[A-Za-z]{4,}/.test(body) ? "英语" : "";
};
const tagsIn = (text: string) => [...text.matchAll(/#[\p{L}\p{N}_]+/gu)].map(match => match[0]);
const translatedBody = (original: string, translated?: string) => {
  const tags = tagsIn(original);
  const body = translated || original;
  return { body: body.replace(/#[\p{L}\p{N}_]+/gu, "").trim(), tags };
};
const hasTranslatedVersion = (original: string, translated?: string) => !!translated && translated !== original && (!/[\u3400-\u9fff]/.test(original.replace(/#[\p{L}\p{N}_]+/gu, "")) || !!sourceLanguage(original));
const STRANGER_AVATAR = "/npc-default-avatar.png";

function StoredImage({ imageRef, className = "" }: { imageRef?: string; className?: string }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    if (!imageRef) { setUrl(""); return; }
    if (/^(https?:|data:)/.test(imageRef)) { setUrl(imageRef); return; }
    let live = true;
    getChatImageFromIndexedDB(imageRef).then(value => { if (live) setUrl(value || ""); });
    return () => { live = false; };
  }, [imageRef]);
  return url ? <img className={className} src={url} alt="" /> : null;
}

function Avatar({ image, label, size = "" }: { image?: string; label: string; size?: string }) {
  return <span className={`${styles.avatar} ${size === "large" ? styles.largeAvatar : ""}`}>
    {image ? <StoredImage imageRef={image} /> : <span>{label.slice(0, 1) || "?"}</span>}
  </span>;
}

function DmMessage({ message, reference, speaker, avatar, onJump, onContext }: {
  message: TwitterMessage;
  reference?: TwitterMessage;
  speaker: string;
  avatar?: string;
  onJump: (id: string) => void;
  onContext: () => void;
}) {
  const [showOriginal, setShowOriginal] = useState(false);
  const mine = message.role === "user";
  const canTranslate = !mine && hasTranslatedVersion(message.original, message.translated);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelPress = () => { if (pressTimer.current) clearTimeout(pressTimer.current); pressTimer.current = null; };
  return <div id={`tw-dm-${message.id}`} className={`${styles.messageRow} ${mine ? styles.myMessageRow : ""}`}>
    {!mine && <Avatar image={avatar} label={speaker} />}
    <div className={styles.messageColumn}>
      {reference && <button type="button" className={styles.messageQuote} onClick={() => onJump(reference.id)}>
        <span>回复 {reference.role === "user" ? "你" : speaker}</span>
        <span className={styles.quoteText}>{twitterMessagePreview(reference)}</span>
      </button>}
      <div className={`${styles.message} ${mine ? styles.mine : styles.theirs}`} title={messageDate(message.createdAt)} onContextMenu={event => { event.preventDefault(); cancelPress(); onContext(); }} onTouchStart={() => { cancelPress(); pressTimer.current = setTimeout(onContext, 520); }} onTouchEnd={cancelPress} onTouchMove={cancelPress} onTouchCancel={cancelPress}>
        {canTranslate && <div className={styles.dmTranslationLine}><span>{sourceLanguage(message.original) ? `翻译自${sourceLanguage(message.original)}` : "已翻译"}</span><button type="button" className={styles.translateToggle} onClick={() => setShowOriginal(open => !open)}>{showOriginal ? "显示译文" : "显示原文"}</button></div>}
        <span className={styles.messageText}>{message.postSnapshot?<TwitterFrozenCard snapshot={message.postSnapshot}/>:canTranslate&&!showOriginal?message.translated:message.original}</span>
      </div>
    </div>
  </div>;
}

export function TwitterApp({ onClose, onNotice: externalNotice }: Props) {
  const [state, setState] = useState<TwitterState>(() => loadTwitterState());
  const stateRef = useRef(state);
  const [characters, setCharacters] = useState<Character[]>(() => loadCharacters());
  const [tab, setTab] = useState<Tab>("home");
  const [feedMode, setFeedMode] = useState<"forYou" | "following">("forYou");
  const [activeAccount, setActiveAccount] = useState("user");
  const [manageOpen, setManageOpen] = useState(false);
  const [managementOptions, setManagementOptions] = useState<{ initialTab?: "accounts" | "characters" | "communities" | "world"; initialAccountId?: string; createCommunity?: boolean; closeOnSave?: boolean; onlyCharacters?: boolean }>({});
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [followPageOpen, setFollowPageOpen] = useState(false);
  const [dmMenuOpen, setDmMenuOpen] = useState(false);
  const [dmContextId, setDmContextId] = useState<string | null>(null);
  const [dmEditDraft, setDmEditDraft] = useState<string | null>(null);
  const [dmTranslationDraft, setDmTranslationDraft] = useState("");
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [profileFeedTab, setProfileFeedTab] = useState<"posts" | "replies" | "reposts" | "media" | "bookmarks">("posts");
  const [selectedAccounts, setSelectedAccounts] = useState<string[]>([]);
  const [repostTarget, setRepostTarget] = useState<string | null>(null);
  const [postMenuId, setPostMenuId] = useState<string | null>(null);
  const [editPostId, setEditPostId] = useState<string | null>(null);
  const [editPostDraft, setEditPostDraft] = useState("");
  const [editPostTranslationDraft, setEditPostTranslationDraft] = useState("");
  const [composeKind, setComposeKind] = useState<"post" | "reply" | "quote">("post");
  const [composeTarget, setComposeTarget] = useState<string | null>(null);
  const [attachmentMenu, setAttachmentMenu] = useState(false);
  const [albumOpen, setAlbumOpen] = useState(false);
  const [albumAssets, setAlbumAssets] = useState<Array<{ id: string; assetId: string }>>([]);
  const [imagePromptOpen, setImagePromptOpen] = useState(false);
  const [textImagePostId, setTextImagePostId] = useState<string | null>(null);
  const [imagePrompt, setImagePrompt] = useState("");
  const [textImageDescription, setTextImageDescription] = useState("");
  const [generatedPreview, setGeneratedPreview] = useState<ImageGenerationResult | null>(null);
  const [generatedPreviewUrl, setGeneratedPreviewUrl] = useState("");
  const [replyPermission, setReplyPermission] = useState<"everyone" | "following" | "mentioned">("everyone");
  const [pollEnabled, setPollEnabled] = useState(false);
  const [pollOptions, setPollOptions] = useState(["", ""]);
  const [locationDraft, setLocationDraft] = useState("");
  const [locationOpen, setLocationOpen] = useState(false);
  const [pullDistance, setPullDistance] = useState(0);
  const pullStartRef = useRef<number | null>(null);
  const communityPullStartRef = useRef<number | null>(null);
  const [communityPullDistance, setCommunityPullDistance] = useState(0);
  const [communityBusyKind, setCommunityBusyKind] = useState<"members" | "characters" | null>(null);
  const [communityId, setCommunityId] = useState<string | null>(null);
  const [communityFootprintId, setCommunityFootprintId] = useState<string | null>(null);
  const [footprintActorId, setFootprintActorId] = useState<string | null>(null);
  const [composeCommunityId, setComposeCommunityId] = useState<string | null>(null);
  const [trendFilter, setTrendFilter] = useState<string | null>(null);
  const [feedHint, setFeedHint] = useState("");
  const [originalShown, setOriginalShown] = useState<Record<string, boolean>>({});
  const [sensitiveRevealed, setSensitiveRevealed] = useState<Record<string, boolean>>({});
  const [search, setSearch] = useState("");
  const [submittedSearch, setSubmittedSearch] = useState("");
  const [searchResultIds, setSearchResultIds] = useState<string[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [dmFilter, setDmFilter] = useState<"all" | "strangers" | "following">("all");
  const [dmSearchOpen, setDmSearchOpen] = useState(false);
  const [dmSearch, setDmSearch] = useState("");
  useEffect(()=>{const fn=(e:Event)=>{const n=(e as CustomEvent).detail;if(n.app!=='twitter')return;if(n.accountId)setActiveAccount(n.accountId);if(n.targetType==='dm'){setConversationId(n.targetId);setTab('messages');}else setThreadId(n.targetId);};window.addEventListener('social-notification-open',fn);return()=>window.removeEventListener('social-notification-open',fn);},[]);
  const [sharePostId,setSharePostId]=useState<string|undefined>(undefined);
  const [dmConfirmation, setDmConfirmation] = useState<{ characterId: string; accountId: string } | null>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [compose, setCompose] = useState(false);
  const [draft, setDraft] = useState("");
  const [imageRef, setImageRef] = useState("");
  const [imageRefs, setImageRefs] = useState<string[]>([]);
  const [replyDraft, setReplyDraft] = useState("");
  const [replyAccountPicker,setReplyAccountPicker]=useState(false);
  const replyComposerRef=useRef<HTMLFormElement>(null);
  const [replyReserve,setReplyReserve]=useState(84);
  useEffect(()=>{
    if(!threadId||!replyComposerRef.current)return;
    const element=replyComposerRef.current;
    const measure=()=>setReplyReserve(Math.ceil(element.getBoundingClientRect().height)+24);
    measure();
    if(typeof ResizeObserver==="undefined"){window.addEventListener("resize",measure);return()=>window.removeEventListener("resize",measure);}
    const observer=new ResizeObserver(measure);observer.observe(element);return()=>observer.disconnect();
  },[threadId]);

  const [replyTextImageEditor,setReplyTextImageEditor]=useState(false);
  const [composeMedia,setComposeMedia]=useState<SocialMedia|null>(null),[replyMedia,setReplyMedia]=useState<SocialMedia|null>(null),[replyTextImage,setReplyTextImage]=useState(''),[replyMediaMenu,setReplyMediaMenu]=useState(false),[mediaBusy,setMediaBusy]=useState(false);
  const mediaInput=useRef<HTMLInputElement>(null),mediaTarget=useRef<'post'|'reply'>('post');
  const pickMedia=(target:'post'|'reply',kind:'gif'|'live')=>{mediaTarget.current=target;if(mediaInput.current){mediaInput.current.accept=kind==='gif'?'image/gif':'video/*,image/jpeg,.jpg,.jpeg';mediaInput.current.click();}};
  const readMedia=async(file:File,target:'post'|'reply')=>{setMediaBusy(true);try{const media=await prepareSocialMedia(file);if(target==='post')setComposeMedia(media);else setReplyMedia(media);}catch(e){alert(e instanceof Error?e.message:'媒体处理失败');}finally{setMediaBusy(false);}};
  const [replyImages,setReplyImages]=useState<string[]>([]);
  const replyFileRef=useRef<HTMLInputElement>(null);
  const uploadReplyImage=async(event:ChangeEvent<HTMLInputElement>)=>{const files=Array.from(event.target.files||[]).slice(0,4-replyImages.length);event.target.value="";try{const gifs=files.filter(f=>f.type==='image/gif');if(gifs[0])await readMedia(gifs[0],'reply');const refs=await Promise.all(files.filter(f=>f.type.startsWith("image/")&&f.type!=='image/gif').map(f=>saveChatImageToIndexedDB(f)));setReplyImages(old=>[...old,...refs].slice(0,4));}catch{alert("图片保存失败，请重试。");}};

  const [commentTargetId, setCommentTargetId] = useState<string | null>(null);
  const [messageDraft, setMessageDraft] = useState("");
  const [replyingToId, setReplyingToId] = useState<string | null>(null);
  const [picker, setPicker] = useState<Picker>(null);
  useEffect(()=>setSelectedAccounts([]),[picker]);
  const [busy, setBusy] = useState(false);
  const [generationKind, setGenerationKind] = useState("");
  const generationRef = useRef("");
  const { onNotice, feedback: generationFeedback } = useGenerationFeedback(busy ? `正在生成${generationKind || " X 内容"}…` : null, externalNotice);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const userIdentity = resolveUserIdentity(undefined, "twitter");
  const user = { ...state.profile, avatarUrl: state.profile.avatarUrl || userIdentity?.avatarUrl || "" };
  const currentUserAccount = state.accounts[activeAccount] || user;
  const openManagement = (options: typeof managementOptions = {}) => { setManagementOptions(options); setManageOpen(true); };

  const commit = useCallback((change: (current: TwitterState) => TwitterState) => {
    const next = change(stateRef.current);
    saveTwitterState(next);
    const saved=loadTwitterState();
    stateRef.current = saved;
    setState(saved);
  }, []);
  useEffect(() => {
    const onStorage = () => { const next = loadTwitterState(); stateRef.current = next; setState(next); };
    const onCharacters = () => setCharacters(loadCharacters());
    window.addEventListener(TWITTER_UPDATED_EVENT, onStorage);
    window.addEventListener(CHARACTERS_UPDATED_EVENT, onCharacters);
    return () => { window.removeEventListener(TWITTER_UPDATED_EVENT, onStorage); window.removeEventListener(CHARACTERS_UPDATED_EVENT, onCharacters); };
  }, []);
  useEffect(() => {
    const ids = characters.map(char => char.id);
    if (ids.some(id => !stateRef.current.importedCharacterIds.includes(id))) {
      commit(current => ({ ...current, importedCharacterIds: [...new Set([...current.importedCharacterIds, ...ids])] }));
    }
  }, [characters, commit]);

  const display = useCallback((id: string): TwitterProfile => {
    if (id === "user") return user;
    if (state.communityCharacters[id]) {
      const item = state.communityCharacters[id]; const override = state.accounts[id];
      return { name: override?.name || item.name, handle: override?.handle || item.handle, bio: override?.bio || item.bio, avatarUrl: STRANGER_AVATAR, bannerUrl: override?.bannerUrl, visibility: override?.visibility || "public", followers: override?.followers, followingCount: override?.followingCount };
    }
    if (state.accounts[id]) return id.startsWith("npc:") ? {...state.accounts[id],avatarUrl:STRANGER_AVATAR} : state.accounts[id];
    const char = characters.find(c => c.id === id);
    const own = state.characterProfiles[id];
    return { ...own, name: own?.name || char?.name || "已移除角色", handle: own?.handle || (char?.name || "character").replace(/\s+/g, "_").toLowerCase(), avatarUrl: own?.avatarUrl || char?.avatar || "", bannerUrl: own?.bannerUrl || "", bio: own?.bio || "" };
  }, [characters, state.characterProfiles, state.communityCharacters, state.accounts, user]);

  const posts = useMemo(() => state.posts.filter(p => !p.replyToId).sort((a, b) => b.createdAt - a.createdAt), [state.posts]);
  const currentThread = state.posts.find(p => p.id === threadId);
  const currentConversation = state.conversations.find(c => c.id === conversationId);
  const threadReplies = useMemo(() => threadId ? twitterThreadReplies(state.posts, threadId) : [], [state.posts, threadId]);

  const alert = (message: string) => { onNotice?.(message); };
  const claimGeneration = (label: string) => {
    if (generationRef.current) { alert(`${generationRef.current}正在生成中，稍后再试。`); return false; }
    generationRef.current = label;
    setGenerationKind(label);
    setBusy(true);
    return true;
  };
  const finishGeneration = () => {
    generationRef.current = "";
    setGenerationKind("");
    setBusy(false);
  };
  const openProfile = (id: string) => {
    if (id.startsWith("npc:")) { alert("陌生人主页不可查看。"); return; }
    setProfileId(id); setProfileFeedTab("posts"); setProfileMenuOpen(false); setThreadId(null);
  };
  const processPendingReplies = async () => {
    const snapshot = stateRef.current;
    const pending = snapshot.pendingReplies.find(item => snapshot.posts.some(p => p.id === item.commentId));
    if (!pending) return;
    const comment = snapshot.posts.find(p => p.id === pending.commentId);
    const target = snapshot.posts.find(p => p.id === pending.targetPostId);
    if (!comment || !target) { commit(current => ({ ...current, pendingReplies: current.pendingReplies.filter(row => row.id !== pending.id) })); return; }
    try {
      const response = await generateTwitterDelayedReply(snapshot, target, comment, display(target.authorId).name);
      commit(current => {
        if (!current.pendingReplies.some(row => row.id === pending.id) || !current.posts.some(p => p.id === comment.id)) return current;
        const next = { ...current, pendingReplies: current.pendingReplies.filter(row => row.id !== pending.id) };
        if (!response) return next;
        const authorId = target.authorId.startsWith("user") ? `npc:${createTwitterId()}` : target.authorId;
        const accounts = authorId.startsWith("npc:") && !next.accounts[authorId] ? { ...next.accounts, [authorId]: { name: "路人", handle: "visitor", bio: "", visibility: "public" as const, avatarUrl: STRANGER_AVATAR } } : next.accounts;
        const reply: TwitterPost = { id: createTwitterId(), authorId, replyToId: comment.id, original: response.original, translated: response.translated, createdAt: Date.now() };
        return { ...next, accounts, posts: [...next.posts, reply], notices: [{ id: createTwitterId(), kind: "reply", actorId: authorId, postId: comment.id, text: reply.original, createdAt: reply.createdAt }, ...next.notices] };
      });
    } catch { commit(current => ({ ...current, pendingReplies: current.pendingReplies.map(row => row.id === pending.id ? { ...row, attempts: row.attempts + 1 } : row) })); }
  };
  const addComments = (current: TwitterState, parentId: string, entries: TwitterWorldComment[], createdAt: number): TwitterState => {
    const accounts = { ...current.accounts };
    const replies = twitterThreadReplies(current.posts, parentId);
    const validTargets = new Set([parentId, ...replies.map(item => item.post.id)]);
    const existing = new Set(replies.map(item => item.post.original.trim()));
    const removed = new Set(current.deletedCommentFingerprints[parentId] || []);
    const accepted = entries.filter(entry => { const text = entry.original.trim(); if (!text || existing.has(text) || removed.has(text)) return false; existing.add(text); return true; });
    const postAt = current.posts.find(post => post.id === parentId)?.createdAt ?? createdAt;
    const times = refreshCommentTimes(postAt, accepted.length, createdAt);
    const newPosts: TwitterPost[] = accepted.map((entry, index) => {
      const commenterId = `npc:${createTwitterId()}`;
      accounts[commenterId] = { name: entry.name || "路人", handle: accountHandle(entry.handle || entry.name), bio: "", visibility: "public", avatarUrl: STRANGER_AVATAR };
      return { id: createTwitterId(), authorId: commenterId, original: entry.original, translated: entry.translated, replyToId: entry.replyToId && validTargets.has(entry.replyToId) ? entry.replyToId : parentId, createdAt: times[index] };
    });
    return { ...current, accounts, posts: [...current.posts.map(p => p.id === parentId ? { ...p, commentsGenerated: true, engagement: { ...(p.engagement || engagementFor(p.id)), comments: Math.max(p.engagement?.comments || 0, current.posts.filter(c => c.replyToId === parentId).length + newPosts.length) } } : p), ...newPosts] };
  };
  const refreshComments = async (post: TwitterPost) => {
    if ((stateRef.current.accounts[post.authorId] || stateRef.current.characterProfiles[post.authorId] || (post.authorId === "user" ? stateRef.current.profile : undefined))?.visibility === "protected") { alert("私密账号暂不生成路人评论，避免出现未授权的围观者。"); return; }
    if (!claimGeneration("评论")) return;
    try {
      const snapshot = stateRef.current;
      const previous = [...snapshot.posts.filter(p => p.replyToId === post.id).map(p => p.original), ...(snapshot.deletedCommentFingerprints[post.id] || [])];
      const comments = await generateTwitterComments(snapshot, post, display(post.authorId).name, previous);
      commit(current => addComments(current, post.id, comments, Date.now()));
      await processPendingReplies();
    } catch (error) { alert(error instanceof Error ? `生成失败：${error.message}` : "评论刷新失败。"); }
    finally { finishGeneration(); }
  };
  const refreshWorld = async (targetCommunityId?: string, topicHint?: string, queryHint?: string) => {
    if (!claimGeneration(targetCommunityId ? "社群" : topicHint || queryHint ? "话题" : "首页")) return;
    if (targetCommunityId) setCommunityBusyKind("members");
    if (topicHint || queryHint) setSearchLoading(true);
    try {
      const targetCommunity = stateRef.current.communities.find(c => c.id === targetCommunityId);
      const communityHint = targetCommunity ? `围绕“${targetCommunity.name}”社群写日常讨论，讨论主题：${targetCommunity.description || "日常交流"}；关联角色：${[...targetCommunity.characterIds, ...(targetCommunity.communityCharacterIds || [])].map(id => display(id).name).join("、") || "无"}。${targetCommunity.includeUserPersona ? `社群也公开关联用户人设“${stateRef.current.profile.name}”。` : "不要把用户描写成主持人或公开关联人物。"}只使用公开信息，不揭露角色副账号身份。` : "";
      const searchHint = queryHint ? `每条帖子和评论都须与搜索词“${queryHint}”相关；不生成无关内容。` : topicHint ? `所有新帖子都围绕当前热门“${topicHint}”，trend 字段填写这条话题原文。` : "";
      const seenResultText = topicHint || queryHint ? stateRef.current.posts.filter(post => searchResultIds.includes(post.id)).slice(-8).map(post => post.original.slice(0, 90)).join("；") : "";
      const hint = [feedHint, communityHint, searchHint, seenResultText ? `不要重复已经显示的帖子：${seenResultText}` : ""].filter(Boolean).join("。");
      const desired = topicHint || queryHint ? 10 : 5;
      const config = stateRef.current.sensitiveTopics;
      const specialCount = !targetCommunityId && !topicHint && !queryHint && config.frequency && config.description.trim()
        ? Array.from({ length: desired }, () => Math.random() * 100 < config.frequency).filter(Boolean).length : 0;
      const batch: Awaited<ReturnType<typeof generateTwitterWorldBatch>> = { posts: [], trends: [] };
      for (const segment of [{ count: desired - specialCount, sensitive: false }, { count: specialCount, sensitive: true }]) {
        if (!segment.count) continue;
        const part = await generateTwitterWorldBatch(stateRef.current, hint, Math.min(5, segment.count), segment.sensitive, targetCommunity ? [...targetCommunity.characterIds, ...(targetCommunity.includeUserPersona ? ["user"] : [])] : []);
        for (let attempt = 0; attempt < 3 && part.posts.length < segment.count; attempt++) {
          try {
            const previous = part.posts.map(post => post.original).slice(-10);
            const extra = await generateTwitterWorldBatch(stateRef.current, `${hint}。避开已生成的内容：${previous.join("；").slice(0, 800)}`, Math.min(5, segment.count - part.posts.length), segment.sensitive, targetCommunity ? [...targetCommunity.characterIds, ...(targetCommunity.includeUserPersona ? ["user"] : [])] : []);
            const seen = new Set(part.posts.map(post => post.original.trim()));
            for (const post of extra.posts) if (!seen.has(post.original.trim())) { part.posts.push(post); seen.add(post.original.trim()); }
          } catch { break; }
        }
        batch.posts.push(...part.posts.slice(0, segment.count));
        if (!segment.sensitive) batch.trends.push(...part.trends);
      }
      for (let i = batch.posts.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [batch.posts[i], batch.posts[j]] = [batch.posts[j], batch.posts[i]];
      }
      const generatedIds: string[] = [];
      commit(current => {
        const now = Date.now();
        const postTimes = refreshPostTimes(batch.posts.length, now);
        const trends = targetCommunity ? [] : batch.trends.map(t => ({ id: createTwitterId(), label: t.label, scope: t.scope, volume: Math.round(90 + stableFraction(t.label) * 9500), createdAt: now }));
        let next: TwitterState = { ...current };
        batch.posts.forEach((entry, index) => {
          const id = createTwitterId();
          generatedIds.push(id);
          const authorId = `npc:${createTwitterId()}`;
          next = { ...next, accounts: { ...next.accounts, [authorId]: { name: entry.name, handle: accountHandle(entry.handle || entry.name), bio: "", followers: Math.floor(stableFraction(id) * 600), visibility: "public", avatarUrl: STRANGER_AVATAR } } };
          const trend = current.trends.find(t => t.label === topicHint) || trends.find(t => t.label === entry.trend) || current.trends.find(t => t.label === entry.trend);
          const post: TwitterPost = { id, authorId, original: entry.original, translated: entry.translated, imageDescription: entry.imageDescription || undefined, sensitive: entry.sensitive || undefined, trendId: targetCommunity ? undefined : trend?.id, communityId: targetCommunity?.id, createdAt: postTimes[index], engagement: engagementFor(id, next.accounts[authorId].followers, entry.comments.length), commentsGenerated: true };
          next = { ...next, posts: [...next.posts, post] };
          next = addComments(next, id, entry.comments, now);
        });
        return next;
      });
      if (topicHint || queryHint) setSearchResultIds(ids => [...ids, ...generatedIds]);
      setFeedHint("");
      await processPendingReplies();
    } catch (error) { alert(error instanceof Error ? `生成失败：${error.message}` : "动态刷新失败。"); }
    finally { finishGeneration(); setSearchLoading(false); if (targetCommunityId) setCommunityBusyKind(null); }
  };
  const refreshTrends = async () => {
    if (!claimGeneration("热门")) return;
    try {
      const labels = await generateTwitterTrends(stateRef.current);
      commit(current => ({ ...current, trends: labels.map(label => ({ id: createTwitterId(), label, scope: "world" as const, volume: Math.round(90 + stableFraction(label) * 9500), createdAt: Date.now() })) }));
      setTrendFilter(null);
      await processPendingReplies();
    } catch (error) { alert(error instanceof Error ? `生成失败：${error.message}` : "热门刷新失败。"); }
    finally { finishGeneration(); }
  };
  const refreshStrangerDms = async () => {
    if (!claimGeneration("私信")) return;
    try {
      const generated = await generateTwitterStrangerDms(stateRef.current, activeAccount);
      commit(current => {
        const accounts = { ...current.accounts };
        const conversations = generated.map(item => {
          const id = `npc:${createTwitterId()}`;
          accounts[id] = { name: item.name, handle: accountHandle(item.handle || item.name), bio: "", visibility: "public" as const, avatarUrl: STRANGER_AVATAR };
          return { id: createTwitterId(), characterId: id, recipientAccountId: id, userAccountId: activeAccount, stranger: true, mode: "real" as const, messages: [{ id: createTwitterId(), role: "character" as const, original: item.original, translated: item.translated, createdAt: Date.now() }], createdAt: Date.now() };
        });
        return { ...current, accounts, conversations: [...conversations, ...current.conversations] };
      });
      await processPendingReplies();
    } catch (error) { alert(error instanceof Error ? `生成失败：${error.message}` : "私信刷新失败。"); }
    finally { finishGeneration(); }
  };
  const backfillTranslations = async () => {
    const snapshot = stateRef.current;
    const likelyForeign = (value: string) => /[가-힣ぁ-ゟ゠-ヿ]/.test(value.replace(/#[\p{L}\p{N}_]+/gu, "")) || (!/[\u3400-\u9fff]/.test(value) && /[A-Za-z]{4,}/.test(value));
    const entries = [...snapshot.posts.filter(post => (!post.translated || post.translated === post.original) && likelyForeign(post.original)).map(post => ({ id: post.id, original: post.original })), ...snapshot.conversations.flatMap(convo => convo.messages.filter(message => message.role === "character" && (!message.translated || message.translated === message.original) && likelyForeign(message.original)).map(message => ({ id: message.id, original: message.original })))];
    if (!entries.length) { alert("没有需要补译的旧内容。"); return; }
    if (!claimGeneration("旧内容翻译")) return;
    try {
      let completed = 0;
      for (let index = 0; index < entries.length; index += 10) {
        const translations = await translateTwitterLegacy(entries.slice(index, index + 10));
        completed += translations.size;
        commit(current => ({ ...current, posts: current.posts.map(post => translations.has(post.id) ? { ...post, translated: translations.get(post.id) } : post), conversations: current.conversations.map(convo => ({ ...convo, messages: convo.messages.map(message => translations.has(message.id) ? { ...message, translated: translations.get(message.id) } : message) })) }));
      }
      alert(`已补译 ${completed} 条旧内容。`);
    } catch (error) { alert(error instanceof Error ? `生成失败：${error.message}` : "旧内容补译失败。"); }
    finally { finishGeneration(); }
  };
  const uploadImage = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []).slice(0, 4);
    event.target.value = "";
    if (!files.length) return;
    if (files.some(file => !file.type.startsWith("image/"))) { alert("请选择图片文件。"); return; }
    try {
      const gif=files.find(file=>file.type==='image/gif');if(gif)await readMedia(gif,'post');
      const refs = await Promise.all(files.filter(file=>file.type!=='image/gif').map(file => saveChatImageToIndexedDB(file)));
      setImageRefs(current => [...current, ...refs].slice(0, 4));
    } catch { alert("图片保存失败，请重试。"); }
  };
  const openComposer = (kind: "post" | "reply" | "quote" = "post", targetId?: string) => {
    setReplyTextImageEditor(false); setReplyMediaMenu(false); setComposeKind(kind); setComposeTarget(targetId || null); setCompose(true); setAttachmentMenu(false);
  };
  const openAlbum = () => { setAlbumAssets(loadPhotoLibrary().photos.map(photo => ({ id: photo.id, assetId: photo.assetId }))); setAlbumOpen(true); };
  const generateComposerImage = async () => {
    if (!imagePrompt.trim() || !claimGeneration("图片")) return;
    try {
      const result = await generateImageFromConfiguredApi({ description: imagePrompt.trim(), appId: "twitter" });
      if (!result) throw new Error("请先配置并启用小手机的图片生成方案。");
      setGeneratedPreview(result);
      setGeneratedPreviewUrl(result.dataUrl);
    } catch (error) { alert(error instanceof Error ? `生成失败：${error.message}` : "图片生成失败。"); }
    finally { finishGeneration(); }
  };
  const attachGeneratedImage = async (addToPost = true) => {
    if (!generatedPreview) return;
    try {
      const ref = await saveChatImageToIndexedDB(generatedPreview.blob);
      const now = Date.now();
      appendPhotoRecords([{
        id: createPhotoId(), assetId: ref, originalName: `X-image-${now}.png`,
        linkedCharacterIds: [], sharedPairIds: [], aiUsable: false, visionStatus: "unprocessed", usageHistory: [],
        origin: "generated", generationPrompt: generatedPreview.prompt, sourceAppId: "twitter",
        sourceAccountId: activeAccount.endsWith(":alt") ? activeAccount : undefined, createdAt: now, updatedAt: now,
      }]);
      if (addToPost && textImagePostId) commit(current => ({ ...current, posts: current.posts.map(post => post.id === textImagePostId ? { ...post, imageRef: ref, imageDescription: undefined } : post) }));
      else if (addToPost && replyTextImageEditor) { setReplyImages(current => [...current, ref].slice(0, 4)); setReplyTextImageEditor(false); }
      else if (addToPost) setImageRefs(current => [...current, ref].slice(0, 4));
      else alert("已保存到相册。");
      setImagePromptOpen(false);
      setTextImagePostId(null);
      setGeneratedPreview(null);
      setGeneratedPreviewUrl("");
    }
    catch { alert("保存图片失败。"); }
  };
  const publish = () => {
    const text = draft.trim();
    if (mediaBusy)return;
    if (!text && !composeMedia && !imageRefs.length && !imageRef && !textImageDescription && !pollEnabled && composeKind !== "quote") return;
    const id = createTwitterId();
    const authorId = activeAccount === "user" || stateRef.current.accounts[activeAccount] ? activeAccount : "user";
    const target = composeTarget;
    const kind = composeKind;
    commit(current => ({ ...current, posts: [...current.posts, { id, authorId, original: text, media:composeMedia || undefined, imageRef: imageRefs[0] || imageRef || undefined, imageRefs: imageRefs.length ? imageRefs : undefined, imageDescription: textImageDescription || undefined, communityId: composeCommunityId || undefined, replyToId: kind === "reply" ? target || undefined : undefined, quotePostId: kind === "quote" ? target || undefined : undefined, replyPermission, location: locationDraft.trim() || undefined, poll: pollEnabled && pollOptions.filter(Boolean).length >= 2 ? { options: pollOptions.filter(Boolean), votes: pollOptions.filter(Boolean).map(() => 0) } : undefined, createdAt: Date.now(), engagement: kind === "reply" ? undefined : engagementFor(id, (authorId === "user" ? current.profile : current.accounts[authorId])?.followers), commentsGenerated: false }], pendingReplies: kind === "reply" && target ? [...current.pendingReplies, { id: createTwitterId(), commentId: id, targetPostId: target, createdAt: Date.now(), attempts: 0 }] : current.pendingReplies }));
    if(composeMedia)markMediaSent(id);setComposeMedia(null);
    setDraft(""); setImageRef(""); setImageRefs([]); setTextImageDescription(""); setPollEnabled(false); setPollOptions(["", ""]); setLocationDraft(""); setCompose(false); setComposeTarget(null); setComposeCommunityId(null);
    if (kind !== "reply") { setTab("home"); setFeedMode("forYou"); }
  };
  const reply = () => {
    const text = replyDraft.trim();
    if(mediaBusy)return;
    if ((!text&&!replyImages.length&&!replyMedia&&!replyTextImage) || !threadId) return;
    const targetId = commentTargetId && stateRef.current.posts.some(p => p.id === commentTargetId) ? commentTargetId : threadId;
    const commentId = createTwitterId();
    commit(current => ({ ...current, posts: [...current.posts, { id: commentId, authorId: activeAccount, original: text, media:replyMedia || undefined, imageDescription:replyTextImage||undefined, imageRef:replyImages[0],imageRefs:replyImages.length?replyImages:undefined, replyToId: targetId, createdAt: Date.now() }], pendingReplies: [...current.pendingReplies, { id: createTwitterId(), commentId, targetPostId: targetId, createdAt: Date.now(), attempts: 0 }] }));
    if(replyMedia)markMediaSent(commentId);setReplyMedia(null);setReplyTextImage("");
    setReplyDraft(""); setReplyImages([]);setCommentTargetId(null);
  };
  const changePost = (id: string, field: "liked" | "bookmarked") => {
    const kind = field === "liked" ? "like" : "bookmark";
    commit(current => {
      const exists = current.actions.some(action => action.targetPostId === id && action.actorId === activeAccount && action.kind === kind);
      return { ...current, actions: exists ? current.actions.filter(action => !(action.targetPostId === id && action.actorId === activeAccount && action.kind === kind)) : [...current.actions, { id: createTwitterId(), actorId: activeAccount, targetPostId: id, kind, communityId: current.posts.find(post => post.id === id)?.communityId, createdAt: Date.now() }] };
    });
  };
  const repost = (targetId: string) => {
    if (stateRef.current.posts.some(p => p.authorId === activeAccount && p.repostOfId === targetId)) { commit(current => ({ ...current, posts: current.posts.filter(p => !(p.authorId === activeAccount && p.repostOfId === targetId)) })); setRepostTarget(null); return; }
    commit(current => ({ ...current, posts: [...current.posts, { id: createTwitterId(), authorId: activeAccount, original: "", repostOfId: targetId, createdAt: Date.now() }] }));
    setRepostTarget(null);
  };
  const deletePost = (id: string) => {
    commit(current => { const post = current.posts.find(p => p.id === id); return { ...current, posts: current.posts.filter(p => p.id !== id && p.replyToId !== id), notices: current.notices.filter(n => n.postId !== id), actions: current.actions.filter(a => a.targetPostId !== id), pendingReplies: current.pendingReplies.filter(p => p.commentId !== id && p.targetPostId !== id), deletedCommentFingerprints: post?.replyToId ? { ...current.deletedCommentFingerprints, [post.replyToId]: [...(current.deletedCommentFingerprints[post.replyToId] || []), post.original.trim()] } : current.deletedCommentFingerprints }; });
    if (threadId === id) setThreadId(null);
  };
  const openConversation = (characterId: string, mode: "real" | "anonymous", recipientAccountId = characterId) => {
    const userAccountId = activeAccount;
    const actualMode = twitterRecognizes(stateRef.current,userAccountId,recipientAccountId)?"real":"anonymous";
    let convo = stateRef.current.conversations.find(c => c.characterId === characterId && (c.userAccountId || "user") === userAccountId && (c.recipientAccountId || c.characterId) === recipientAccountId);
    if (!convo) {
      convo = { id: createTwitterId(), characterId, userAccountId, recipientAccountId, mode: actualMode, messages: [], createdAt: Date.now() };
      const created = convo;
      commit(current => ({ ...current, conversations: [created, ...current.conversations] }));
    }
    setConversationId(convo.id); setReplyingToId(null); setDmContextId(null); setDmMenuOpen(false); setPicker(null); setDmSearchOpen(false); setDmConfirmation(null); setProfileId(null); setFollowPageOpen(false); setTab("messages");
  };
  const confirmConversation = (characterId: string, recipientAccountId = characterId) => setDmConfirmation({ characterId, accountId: recipientAccountId });
  const sendMessage = () => {
    const text = messageDraft.trim();
    if (!text || !conversationId) return;
    commit(current => ({ ...current, conversations: current.conversations.map(c => c.id === conversationId ? { ...c, messages: [...c.messages, { id: createTwitterId(), role: "user", original: text, replyToId: replyingToId && c.messages.some(m => m.id === replyingToId) ? replyingToId : undefined, createdAt: Date.now() }] } : c) }));
    setMessageDraft(""); setReplyingToId(null);
  };
  const aiGenerate = async (characterId: string, kind: "post" | "reply" | "dm", postAccountId = characterId, replaceMessageId?: string) => {
    if (!claimGeneration(kind === "dm" ? "私信回复" : kind === "post" ? "角色动态" : "角色回复")) return;
    setPicker(null);
    if (kind === "post" && communityId) setCommunityBusyKind("characters");
    try {
      const snapshot = stateRef.current;
      const thread = snapshot.posts.find(p => p.id === (commentTargetId || threadId));
      const actionTarget = kind === "post" ? snapshot.posts.filter(p => !p.replyToId && !p.repostOfId && p.authorId !== postAccountId && (p.original || p.imageRef) && (!communityId || p.communityId === communityId)).sort((a, b) => b.createdAt - a.createdAt)[0] : undefined;
      const actionRoll = stableFraction(`${postAccountId}-${Date.now()}-${Math.random()}`);
      const actionType = kind === "post" && actionTarget && actionRoll < .44 ? (communityId && actionRoll < .1 ? "like" : actionRoll < .17 ? "repost" : actionRoll < .3 ? "reply" : "quote") : "post";
      if (kind === "post" && actionType === "like" && actionTarget) {
        commit(current => ({ ...current, actions: [...current.actions, { id: createTwitterId(), actorId: postAccountId, targetPostId: actionTarget.id, kind: "like", communityId: communityId || undefined, createdAt: Date.now() }],notices:actionTarget.authorId.startsWith("user")?[{id:createTwitterId(),kind:"like",actorId:postAccountId,recipientId:actionTarget.authorId,postId:actionTarget.id,createdAt:Date.now()},...current.notices]:current.notices }));
        await processPendingReplies(); return;
      }
      const convo = snapshot.conversations.find(c => c.id === conversationId);
      const priorMessages = replaceMessageId && convo ? convo.messages.slice(0, convo.messages.findIndex(message => message.id === replaceMessageId)) : convo?.messages;
      const requestedReplyId = replyingToId;
      if (kind === "reply" && !thread) throw new Error("先选择一条帖子。");
      if (kind === "dm" && !convo) throw new Error("先进入一段私信。");
      const speakingAccountId = kind === "dm" ? convo?.recipientAccountId || characterId : postAccountId;
      const communityCharacter = snapshot.communityCharacters[characterId];
      const generatedKind = kind === "post" && actionType === "reply" ? "reply" : kind;
      const lines: TwitterGeneratedLine[] & { comments?: TwitterCommentDraft[] } = kind === "post" && actionType === "repost" ? [{ original: "", translated: "" }] : communityCharacter ? [await generateTwitterCommunityText(snapshot, communityCharacter, generatedKind, kind === "dm" ? (priorMessages || []).map(m => m.original).join("\n") : actionTarget?.original || snapshot.publicWorldContext).then(result => ({ original: result.original, translated: result.translated || "" }))] : kind === "dm" && convo?.stranger ? [await generateTwitterStrangerReply(snapshot, snapshot.accounts[speakingAccountId]?.name || "陌生人", priorMessages || [], convo.userAccountId || "user").then(reply => ({ original: reply.original, translated: reply.translated || "" }))] : await generateTwitterText({ characterId, state: snapshot, kind: generatedKind, targetPost: kind === "post" ? actionTarget : thread, conversation: priorMessages, replyToMessage: convo?.messages.find(msg => msg.id === requestedReplyId), anonymous: convo?.mode === "anonymous", senderAccountId: convo?.userAccountId, senderName: snapshot.accounts[convo?.userAccountId || ""]?.name, accountProfile: snapshot.accounts[speakingAccountId] || snapshot.characterProfiles[speakingAccountId], accountKind: speakingAccountId.endsWith(":alt") ? "alternate" : undefined, communityName: snapshot.communities.find(c => c.id === communityId)?.name, withComments: kind === "post" && actionType !== "reply" && actionType !== "repost" && snapshot.accounts[postAccountId]?.visibility !== "protected" && snapshot.characterProfiles[postAccountId]?.visibility !== "protected" });
      if (kind === "post" && postAccountId.endsWith(":alt") && snapshot.accounts[postAccountId]?.disclosure !== "full") {
        const main = snapshot.characterProfiles[characterId] || characters.find(c => c.id === characterId);
        const publicName = main?.name?.trim() || "";
        const mainHandle = snapshot.characterProfiles[characterId]?.handle || "";
        const text = [lines[0]?.original, ...(lines.comments || []).map(c => c.original)].join(" ");
        if (snapshot.accounts[postAccountId]?.disclosure !== "clues" && ((publicName.length >= 2 && text.includes(publicName)) || (mainHandle.length >= 3 && text.includes(`@${mainHandle}`)))) throw new Error("这条副账号内容可能暴露主账号身份，已取消发布。可以重试。");
      }
      const now = Date.now();
      if (kind === "dm") {
        const targetId = convo!.id;
        commit(current => ({ ...current, conversations: current.conversations.map(c => c.id === targetId ? { ...c, messages: replaceMessageId ? c.messages.map(message => message.id === replaceMessageId ? { ...message, original: lines[0].original, translated: lines[0].translated } : message) : [...c.messages, ...lines.map((line, index) => ({ id: createTwitterId(), role: "character" as const, ...line, replyToId: index === 0 && requestedReplyId && c.messages.some(m => m.id === requestedReplyId) ? requestedReplyId : undefined, createdAt: now + index }))] } : c) }));
        setReplyingToId(current => current === requestedReplyId ? null : current);
      } else {
        const id = createTwitterId();
        const actorId = postAccountId;
        let photoLibraryId: string | undefined;
        let photoStoryContext: PhotoStorySnapshot | undefined;
        let photoRef: string | undefined;
        let photoCard: string | undefined;
        const photoDescription = kind === "post" && actionType !== "repost" ? lines[0]?.photoDescription : undefined;
        if (photoDescription && !snapshot.communityCharacters[characterId]) {
          const alternate = actorId.endsWith(":alt");
          const isolated = alternate && snapshot.accounts[actorId]?.disclosure !== "full";
          const media = await resolveMediaForUse({ deferUsage: true, actor: isolated ? { type: "character", characterId, photoIds: snapshot.alternateMediaPhotoIds[actorId] || [] } : { type: "character", characterId }, description: photoDescription, intentKind: /自拍|人像|selfie|portrait/i.test(photoDescription) ? "portrait" : "other", channel: alternate ? "twitter_alt" : "twitter_main", accountId: alternate ? actorId : undefined, appId: "twitter", targetId: communityId || id }).catch(() => null);
          const prefs = loadPhotoLibrary().preferences;
          if (!media && prefs.importedStrategy === "album_only" && (isolated ? prefs.enabledAlternateIds.includes(actorId) : prefs.enabledCharacterIds.includes(characterId))) { alert("这次没有合适的照片，角色没有发布照片。可在 Photos 补充素材或切换匹配方式。"); return; }
          photoRef = media?.imageUrl?.replace(/^asset:\/\//, "");
          photoCard = media?.placeholderDescription;
          photoLibraryId = media?.photoLibraryId;
          if (media?.imageUrl) {
            const revised = await preparePhotoStoryCaption({ photoId: photoLibraryId, characterId, appId: "twitter", original: lines[0].original, translated: lines[0].translated,
              allowedPhotoIds: isolated ? snapshot.alternateMediaPhotoIds[actorId] || [] : undefined,
              accountContext: isolated ? `这是身份隔离的副账号。对外身份：${snapshot.accounts[actorId]?.identity || "未设定"}；不得暴露主账号姓名、账号或后台角色身份。` : undefined });
            lines[0].original = revised.original; lines[0].translated = revised.translated;
            photoStoryContext = revised.photoStoryContext;
            if (photoStoryContext) lines.comments = []; // Regenerate readers from the corrected PUBLIC post only.
            if (isolated && snapshot.accounts[actorId]?.disclosure !== "clues") {
              const publicName = snapshot.characterProfiles[characterId]?.name || characters.find(c => c.id === characterId)?.name || "";
              const mainHandle = snapshot.characterProfiles[characterId]?.handle || "";
              const text = revised.original + " " + revised.translated;
              if ((publicName.length >= 2 && text.includes(publicName)) || (mainHandle.length >= 3 && text.includes(`@${mainHandle}`))) throw new Error("配图文案可能暴露主账号身份，已取消发布。");
            }
          }
        }
        const created: TwitterPost = { id, authorId: actorId, original: lines[0].original, translated: lines[0].translated, imageRef: photoRef, imageDescription: photoCard, photoLibraryId, photoStoryContext, communityId: kind === "post" ? communityId || undefined : thread?.communityId, replyToId: kind === "reply" ? commentTargetId || threadId || undefined : kind === "post" && actionType === "reply" ? actionTarget?.id : undefined, repostOfId: kind === "post" && actionType === "repost" ? actionTarget?.id : undefined, quotePostId: kind === "post" && actionType === "quote" ? actionTarget?.id : undefined, createdAt: now, engagement: kind === "post" && actionType !== "reply" && actionType !== "repost" ? engagementFor(id, (snapshot.accounts[actorId] || snapshot.characterProfiles[actorId])?.followers, lines.comments?.length || 0) : undefined, commentsGenerated: kind === "post" && actionType === "post" };
        const protectedPost = snapshot.accounts[actorId]?.visibility === "protected" || snapshot.characterProfiles[actorId]?.visibility === "protected";
        let initialComments = lines.comments || [];
        if (kind === "post" && actionType !== "reply" && actionType !== "repost" && !protectedPost && initialComments.length < 5) {
          try { initialComments = [...initialComments, ...await generateTwitterComments(snapshot, created, display(actorId).name, initialComments.map(c => c.original))].slice(0, 10); }
          catch { alert("帖子已生成，评论暂时失败；可以进入帖子后刷新评论。"); }
        }
        recordPreparedPhotoUse(photoLibraryId, actorId.endsWith(":alt") ? "twitter_alt" : "twitter_main", characterId, communityId || id, actorId.endsWith(":alt") ? actorId : undefined);
        commit(current => {
          const repliedUser = kind === "reply" && thread?.authorId.startsWith("user") || kind === "post" && actionType === "reply" && actionTarget?.authorId.startsWith("user");
          let next = { ...current, posts: [...current.posts, created], notices: repliedUser ? [{ id: createTwitterId(), kind: "reply" as const, actorId, postId: kind === "reply" ? thread!.id : actionTarget!.id, text: created.original, createdAt: now }, ...current.notices] : current.notices };
          if (kind === "post" && actionType !== "reply" && actionType !== "repost" && !protectedPost && initialComments.length) next = addComments(next, id, initialComments, now + 1);
          if (kind === "post" && actionTarget?.authorId.startsWith("user") && stableFraction(`${id}-like`) > .69) next = { ...next, actions: [...next.actions, { id: createTwitterId(), actorId, targetPostId: actionTarget.id, kind: "like", createdAt: now }], notices: [{ id: createTwitterId(), kind: "like", actorId, postId: actionTarget.id, createdAt: now }, ...next.notices] };
          return next;
        });
        if (kind === "reply") setCommentTargetId(null);
      }
      await processPendingReplies();
    } catch (error) { alert(error instanceof Error ? `生成失败：${error.message}` : "生成失败，请重试。"); }
    finally { finishGeneration(); if (kind === "post" && communityId) setCommunityBusyKind(null); }
  };

  const renderPost = (post: TwitterPost, compact = false) => {
    const repostedSource = post.repostOfId ? state.posts.find(p => p.id === post.repostOfId) : undefined;
    if (post.repostOfId && !repostedSource) return null;
    if (repostedSource) return <div key={post.id} className={styles.repostContainer}><div className={styles.repostedBy}><Repeat2 size={14} />{display(post.authorId).name} 已转帖<button className={styles.repostMenuButton} onClick={() => setPostMenuId(post.id)} aria-label="转帖操作"><MoreHorizontal size={18} /></button></div>{renderPost(repostedSource, true)}</div>;
    const author = display(post.authorId);
    const replies = Math.max(state.posts.filter(row => row.replyToId === post.id).length, post.engagement?.comments || 0);
    const translated = hasTranslatedVersion(post.original, post.translated);
    const showOriginal = !!originalShown[post.id];
    const content = translatedBody(post.original, translated && !showOriginal ? post.translated : undefined);
    const liked = state.actions.some(a => a.actorId === activeAccount && a.targetPostId === post.id && a.kind === "like");
    const bookmarked = state.actions.some(a => a.actorId === activeAccount && a.targetPostId === post.id && a.kind === "bookmark");
    const reposted = state.posts.some(p => p.authorId === activeAccount && p.repostOfId === post.id);
    const quote = post.quotePostId ? state.posts.find(p => p.id === post.quotePostId) : undefined;
    return <article className={`${styles.post} ${post.replyToId ? styles.commentPost : ""}`} key={post.id}>
      <button className={styles.avatarButton} onClick={() => openProfile(post.authorId)}><Avatar image={author.avatarUrl} label={author.name} /></button>
      <div className={styles.postBody}>
        <div className={styles.postHeader}><button onClick={() => openProfile(post.authorId)}><b>{author.name}</b>{author.verification && author.verification !== "none" && <BadgeCheck size={15} className={`${styles.verifyBadge} ${styles[`badge${author.verification}`]}`} />} <span>@{author.handle} · {timestamp(post.createdAt)}</span></button><button aria-label="帖子操作" onClick={() => setPostMenuId(post.id)}><MoreHorizontal size={18} /></button></div>
        {post.replyToId && <div className={styles.replyContext}>回复 @{display(state.posts.find(p => p.id === post.replyToId)?.authorId || "user").handle}</div>}
        {translated && <div className={styles.postTranslationLine}><span>{sourceLanguage(post.original) ? `翻译自${sourceLanguage(post.original)}` : "已翻译"}</span><button className={styles.postTranslationToggle} onClick={() => setOriginalShown(current => ({ ...current, [post.id]: !current[post.id] }))}>{showOriginal ? "显示译文" : "显示原文"}</button></div>}
        <button className={styles.postText} onClick={() => { if (!compact) { setThreadId(post.replyToId || post.id); setCommentTargetId(null); } }}>{content.body}</button>
        {content.tags.length > 0 && <div className={styles.postTags}>{content.tags.map((tag, index) => <button key={`${tag}-${index}`} onClick={() => { setTab("explore"); setSearch(tag); setSubmittedSearch(tag); setSearchResultIds([]); setTrendFilter(null); setThreadId(null); void refreshWorld(undefined, undefined, tag); }}>{tag}</button>)}</div>}
        {post.sensitive && (post.imageDescription || post.imageRefs?.length || post.imageRef) && !sensitiveRevealed[post.id] ? <button type="button" className={styles.sensitiveCover} onClick={() => setSensitiveRevealed(current => ({ ...current, [post.id]: true }))} aria-label="查看遮罩下的内容">{state.sensitiveTopics.coverRef && <StoredImage imageRef={state.sensitiveTopics.coverRef} />}</button> : <>
          {post.media && <OnceMedia media={post.media} mediaKey={post.id}/>}
          {(post.imageRefs?.length || post.imageRef) && <div className={styles.postImageGrid}>{(post.imageRefs?.length ? post.imageRefs : [post.imageRef!]).map((ref, i) => <button className={styles.postImage} key={`${ref}-${i}`} onClick={() => { setThreadId(post.id); }}><StoredImage imageRef={ref} /></button>)}</div>}
          {post.imageDescription && <div className={post.sensitive ? styles.sensitiveRevealed : ""}><button className={styles.textImageCard} onClick={() => { setTextImagePostId(post.id); setImagePrompt(post.imageDescription || ""); setGeneratedPreview(null); setGeneratedPreviewUrl(""); }}>{post.imageDescription}</button>{post.sensitive && <button type="button" className={styles.sensitiveEdit} onClick={() => { setTextImagePostId(post.id); setImagePrompt(post.imageDescription || ""); setGeneratedPreview(null); setGeneratedPreviewUrl(""); }}>编辑或生成图片</button>}</div>}
        </>}
        {quote && <button className={styles.quotedPost} onClick={() => { setThreadId(quote.id); }}><span><b>{display(quote.authorId).name}</b> @{display(quote.authorId).handle}</span><span>{quote.translated || quote.original}</span>{quote.imageRef && <StoredImage imageRef={quote.imageRef} />}</button>}
        {post.poll && <div className={styles.pollResults}>{post.poll.options.map((option, index) => <button key={index} onClick={() => commit(current => ({ ...current, posts: current.posts.map(p => p.id === post.id && p.poll && !p.poll.votedBy?.includes(activeAccount) ? { ...p, poll: { ...p.poll, votes: p.poll.votes.map((count, i) => i === index ? count + 1 : count), votedBy: [...(p.poll.votedBy || []), activeAccount] } } : p) }))}>{option} <span>{post.poll!.votes[index] || 0}</span></button>)}</div>}
        {post.location && <span className={styles.postLocation}><MapPin size={13} />{post.location}</span>}
        <div className={styles.actions}>
          <button title="回复" onClick={() => openComposer("reply", post.id)}><MessageCircle size={17} />{countLabel(replies)}</button>
          <button title="转帖或引用" className={reposted ? styles.engaged : ""} onClick={() => setRepostTarget(post.id)}><Repeat2 size={18} />{countLabel((post.engagement?.reposts || 0) + Number(reposted))}</button>
          <button title="喜欢" className={liked ? styles.liked : ""} onClick={() => changePost(post.id, "liked")}><Heart size={17} fill={liked ? "currentColor" : "none"} />{countLabel((post.engagement?.likes || 0) + Number(liked))}</button>
          <button title="分享帖子" onClick={()=>setSharePostId(post.id)}><Share2 size={17}/></button><button title="收藏" className={bookmarked ? styles.engaged : ""} onClick={() => changePost(post.id, "bookmarked")}><Bookmark size={17} fill={bookmarked ? "currentColor" : "none"} /></button>
        </div>
      </div>
    </article>;
  };

  const profile = profileId ? display(profileId) : null;
  const profileCharacterId = profileId ? state.importedCharacterIds.find(id => id === profileId || `${id}:alt` === profileId) || (state.communityCharacters[profileId] ? profileId : undefined) : undefined;
  const filtered = posts.filter(post => {
    if (post.communityId) return false;
    const mine = post.authorId.startsWith("user");
    if (feedMode === "following") return mine || state.following.includes(post.authorId) || state.importedCharacterIds.includes(post.authorId.replace(/:alt$/, "")) || !!state.communityCharacters[post.authorId];
    return mine || (!state.importedCharacterIds.includes(post.authorId.replace(/:alt$/, "")) && !state.communityCharacters[post.authorId] && !post.authorId.startsWith("group:"));
  });
  const selectedCommunity = state.communities.find(c => c.id === communityId);
  const pickerCharacters = characters.filter(char => !selectedCommunity || picker !== "post" || selectedCommunity.characterIds.includes(char.id));
  const activeCommunityIds = Object.keys(state.communityCharacters).filter(id => state.communities.some(c => c.communityCharacterIds?.includes(id)));
  const pickerAccountIds = picker !== "dm" ? [...pickerCharacters.flatMap(char => [...(twitterAccountEnabled(state,char.id)?[char.id]:[]), ...(state.accounts[`${char.id}:alt`] ? [`${char.id}:alt`] : [])]), ...activeCommunityIds.filter(id => !selectedCommunity || selectedCommunity.communityCharacterIds?.includes(id))] : [];
  const visibleNotices = state.notices.filter(notice => {
    const recipient=notice.recipientId||state.posts.find(p=>p.id===notice.postId)?.authorId;if(recipient!==activeAccount)return false;
    const role = state.importedCharacterIds.includes(notice.actorId.replace(/:alt$/, "")) || !!state.communityCharacters[notice.actorId];
    if (role) return notice.kind === "reply" || notice.kind === "like";
    return notice.kind === "reply" && !!state.posts.find(post => post.id === notice.postId && post.authorId.startsWith("user") && !!post.replyToId);
  });

  return <div className={styles.app}>
      {generationFeedback}
    <header className={styles.header}>
      <button className={styles.headerAvatar} onClick={() => setDrawerOpen(true)} aria-label="打开我的菜单"><Avatar image={currentUserAccount.avatarUrl} label={currentUserAccount.name} /></button>
      <strong className={tab === "home" ? styles.xMark : ""}>{tab === "home" ? "𝕏" : tab === "explore" ? "搜索" : tab === "notices" ? "通知" : "私信"}</strong>
      <button className={styles.headerPeople} onClick={() => setFollowPageOpen(true)} aria-label="角色关注列表"><UserRoundPlus size={27} strokeWidth={2.2} /></button>
    </header>

    <main className={styles.main} onTouchStart={event => { pullStartRef.current = tab === "home" && event.currentTarget.scrollTop <= 1 ? event.touches[0].clientY : null; }} onTouchMove={event => { if (pullStartRef.current !== null) setPullDistance(Math.max(0, Math.min(175, event.touches[0].clientY - pullStartRef.current))); }} onTouchEnd={event => { const start = pullStartRef.current; pullStartRef.current = null; setPullDistance(0); if (start !== null && event.changedTouches[0].clientY - start > 140) { if (feedMode === "forYou") void refreshWorld(); else if (generationRef.current) alert(`${generationRef.current}正在生成中，稍后再试。`); else { setSelectedAccounts([]); setPicker("post"); } } }}>
      {tab === "home" && <><div className={styles.homeTabs}><div className={styles.homeTabScroll}><button className={feedMode === "forYou" ? styles.homeTabSelected : ""} onClick={() => setFeedMode("forYou")}>为你推荐</button><button className={feedMode === "following" ? styles.homeTabSelected : ""} onClick={() => setFeedMode("following")}>正在关注</button></div></div>
        {(pullDistance > 12 || generationKind === "首页" && feedMode === "forYou") && <div className={styles.pullStatus} style={{ height: generationKind === "首页" ? 45 : pullDistance * .4 }}><RefreshCw size={17} className={generationKind === "首页" ? styles.spinning : ""} />{generationKind === "首页" ? "正在生成动态…" : pullDistance > 140 ? feedMode === "following" ? "松开选择角色账号" : "松开刷新" : "继续下拉"}</div>}
        {filtered.length ? filtered.map(post => renderPost(post)) : <div className={styles.empty}><b>{feedMode === "following" ? "还没有角色动态" : "这里还没有动态"}</b><p>{feedMode === "following" ? "下拉选择角色账号，生成帖子。" : "下拉刷新，看看世界里发生了什么。"}</p></div>}
        
      </>}
      {tab === "explore" && <><form className={styles.searchBox} onSubmit={event => { event.preventDefault(); const term = search.trim(); if (!term) return; setTrendFilter(null); setSubmittedSearch(term); setSearchResultIds([]); void refreshWorld(undefined, undefined, term); }}><Search size={19} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索帖子或话题" /><button type="submit" disabled={!search.trim()}>搜索</button></form>
        {!submittedSearch && !trendFilter ? <><div className={styles.feedTools}><strong>当前热门</strong><button onClick={() => { void refreshTrends(); }}><RefreshCw size={15} />刷新趋势</button></div>{state.trends.length ? state.trends.map(trend => <button className={styles.trend} key={trend.id} onClick={() => { setTrendFilter(trend.id); setSubmittedSearch(""); setSearchResultIds([]); setSearch(""); void refreshWorld(undefined, trend.label); }}><span>当前热门</span><b>{trend.label}</b><small>{countLabel(trend.volume)} 次讨论</small></button>) : <div className={styles.empty}>刷新趋势，生成五条符合世界观的热门话题。</div>}</> : <><div className={styles.resultHeading}><button onClick={() => { setTrendFilter(null); setSubmittedSearch(""); setSearchResultIds([]); }}><ArrowLeft size={18} />返回热门</button><b>{submittedSearch || state.trends.find(t => t.id === trendFilter)?.label}</b></div>{searchResultIds.map(id => posts.find(post => post.id === id)).filter((post): post is TwitterPost => !!post).map(post => renderPost(post))}{searchLoading && <div className={styles.loadingResults}><RefreshCw className={styles.spinning} size={18} />正在生成相关帖子…</div>}{!searchLoading && searchResultIds.length === 0 && <div className={styles.empty}>还没有相关帖子，重新搜索试试。</div>}{searchResultIds.length > 0 && <button className={styles.loadMore} onClick={() => { void refreshWorld(undefined, trendFilter ? state.trends.find(t => t.id === trendFilter)?.label : undefined, submittedSearch || undefined); }}>查看更多</button>}</>}
      </>}
      {tab === "notices" && <><div className={styles.feedTools}><span>与你有关的互动</span>{visibleNotices.some(n => !n.read) && <button onClick={() => commit(current => ({ ...current, notices: current.notices.map(n => (n.recipientId||current.posts.find(p=>p.id===n.postId)?.authorId)===activeAccount?{...n,read:true}:n) }))}>全部已读</button>}</div>
        {visibleNotices.length ? visibleNotices.map(notice => <button className={styles.notice} key={notice.id} onClick={() => { if (notice.postId) setThreadId(notice.postId); commit(current => ({ ...current, notices: current.notices.map(n => n.id === notice.id ? { ...n, read: true } : n) })); }}><Avatar label={display(notice.actorId).name} image={display(notice.actorId).avatarUrl} /><span><b>{display(notice.actorId).name}</b> {notice.kind === "reply" ? "回复了你的内容" : "喜欢了你的帖子"}<small>{notice.text}</small></span>{!notice.read && <i className={styles.dot} />}</button>) : <div className={styles.empty}><b>还没有通知</b><p>角色与你互动，或陌生人回复你的评论时，会显示在这里。</p></div>}
      </>}
      {tab === "messages" && <><div className={styles.dmTopControls}><b>私信</b><div><button onClick={() => { void refreshStrangerDms(); }} aria-label="刷新陌生人私信" title="刷新陌生人私信"><RefreshCw size={18} className={generationKind === "私信" ? styles.spinning : ""} /></button><select value={dmFilter} onChange={event => setDmFilter(event.target.value as typeof dmFilter)} aria-label="筛选私信"><option value="all">全部</option><option value="strangers">陌生人</option><option value="following">已关注</option></select></div></div><button className={styles.dmSearchLaunch} onClick={() => setDmSearchOpen(true)}><Search size={20} />搜索或开始新私信</button>
        {state.conversations.filter(c=>(c.userAccountId||"user")===activeAccount).filter(convo => dmFilter === "all" || (dmFilter === "strangers") === !!convo.stranger).length ? [...state.conversations].filter(c=>(c.userAccountId||"user")===activeAccount).filter(convo => dmFilter === "all" || (dmFilter === "strangers") === !!convo.stranger).sort((a, b) => (b.messages.at(-1)?.createdAt || b.createdAt) - (a.messages.at(-1)?.createdAt || a.createdAt)).map(convo => <div className={styles.conversationRow} key={convo.id}><button onClick={() => { setActiveAccount(convo.userAccountId || "user"); setConversationId(convo.id); setDmContextId(null); setDmMenuOpen(false); }}><span className={styles.conversationAvatar}><Avatar image={display(convo.recipientAccountId || convo.characterId).avatarUrl} label={display(convo.recipientAccountId || convo.characterId).name} /><span className={styles.ownAccountBadge} title={`我使用的账号：${display(convo.userAccountId || "user").name}`}><Avatar image={display(convo.userAccountId || "user").avatarUrl} label={display(convo.userAccountId || "user").name} /></span></span><span><b>{display(convo.recipientAccountId || convo.characterId).name}</b><small>{twitterMessagePreview(convo.messages.at(-1))}</small></span></button><button className={styles.rowDelete} onClick={() => commit(current => ({ ...current, conversations: current.conversations.filter(c => c.id !== convo.id) }))} title="删除对话"><Trash2 size={16} /></button></div>) : <div className={styles.empty}><b>还没有私信</b><p>点击搜索，选择角色开始聊天。</p></div>}
      </>}
    </main>

    {tab === "home" && <button className={styles.fab} onClick={() => { setComposeCommunityId(null); openComposer(); }} aria-label="发帖">＋</button>}
    <nav className={styles.nav}>
      {([["home", Home, "主页"], ["explore", Search, "搜索"], ["notices", Bell, "通知"], ["messages", MessageCircle, "私信"]] as const).map(([key, Icon, label]) => <button key={key} className={tab === key ? styles.navActive : ""} onClick={() => { setTab(key); setThreadId(null); setProfileId(null); setConversationId(null); }} aria-label={label}><Icon size={23} fill={tab === key && key !== "explore" ? "currentColor" : "none"} />{key === "notices" && visibleNotices.some(n => !n.read) && <span className={styles.navDot} />}</button>)}
    </nav>

    {drawerOpen && <div className={styles.drawerScrim} onClick={() => setDrawerOpen(false)}><aside className={styles.drawer} onClick={event => event.stopPropagation()}>
      <div className={styles.drawerAccountSwitch}><div className={styles.drawerAvatars}><button onClick={() => { setDrawerOpen(false); openProfile(activeAccount); }} aria-label="打开当前账号主页"><Avatar image={currentUserAccount.avatarUrl} label={currentUserAccount.name} size="large" /></button><button className={styles.drawerAltAvatar} onClick={() => { const next = activeAccount === "user" ? "user:alt" : "user"; if (!state.accounts["user:alt"]) { setDrawerOpen(false); openManagement({ initialAccountId: "user:alt", closeOnSave: true }); } else { setActiveAccount(next); setConversationId(null); setDrawerOpen(false); } }} title="切换主账号与副账号"><Avatar image={display(activeAccount === "user" ? "user:alt" : "user").avatarUrl} label={activeAccount === "user" ? state.accounts["user:alt"]?.name || "＋" : user.name} /></button></div><button className={styles.drawerIdentity} onClick={() => { setDrawerOpen(false); openProfile(activeAccount); }}><b>{currentUserAccount.name}</b><span>@{currentUserAccount.handle}</span><small>{formatTwitterCount(currentUserAccount.followingCount)} 正在关注　{formatTwitterCount(currentUserAccount.followers)} 关注者</small></button></div>
      <div className={styles.drawerLinks}>
        <button onClick={() => { setDrawerOpen(false); setProfileId(activeAccount === "user:alt" ? "user:alt" : "user"); }}><Home size={22} />个人资料</button>
        <button onClick={() => { setDrawerOpen(false); openManagement({ initialTab: "accounts", onlyCharacters: true }); }}><UserRoundPlus size={22} />角色资料</button>
        <button onClick={() => { setDrawerOpen(false); openManagement({ initialTab: "world" }); }}><Sparkles size={22} />世界观</button>
        <button onClick={() => { setDrawerOpen(false); openManagement({ initialTab: "communities" }); }}><MessageCircle size={22} />社群</button>
      </div>
      <button className={styles.drawerExit} onClick={onClose}>退出 X</button>
    </aside></div>}

    {followPageOpen && <div className={`${styles.page} ${styles.followPage}`}><div className={styles.pageHeader}><button onClick={() => setFollowPageOpen(false)} aria-label="返回"><ArrowLeft size={23} /></button><b>关注</b></div><div className={styles.followList}>
      {[...characters.map(char => char.id), ...activeCommunityIds].map(id => [id, ...(state.accounts[`${id}:alt`] ? [`${id}:alt`] : [])]).flat().map(id => { const info = display(id); const followed = state.following.includes(id); return <div className={`${styles.followRow} ${id.endsWith(":alt") ? styles.followAltRow : ""}`} key={id}><button className={styles.followPerson} onClick={() => openProfile(id)}><Avatar image={info.avatarUrl} label={info.name} size="large" /><span><b>{info.name}</b><small>@{info.handle} · {state.communityCharacters[id] ? "社群角色" : id.endsWith(":alt") ? "副账号" : "主账号"}</small>{info.bio && <span className={styles.followBio}>{info.bio}</span>}</span></button><button className={followed ? styles.followingButton : styles.followButton} onClick={() => commit(current => ({ ...current, following: followed ? current.following.filter(item => item !== id) : [...current.following, id] }))}>{followed ? "正在关注" : "关注"}</button></div>; })}
      {!characters.length && !Object.keys(state.communityCharacters).length && <div className={styles.empty}><b>还没有角色</b><p>小手机里的角色会自动显示在这里。</p></div>}
    </div></div>}


    {threadId && <div className={`${styles.page} ${styles.topPage}`} style={{"--tw-reply-reserve":`${replyReserve}px`} as CSSProperties}><div className={styles.pageHeader}><button onClick={() => setThreadId(null)} aria-label="返回"><ArrowLeft size={21} /></button><b>帖子</b></div><div className={`${styles.pageScroll} ${styles.threadScroll}`}>{currentThread && <div className={styles.threadPrimary}>{renderPost(currentThread, true)}</div>}{currentThread && <><div className={styles.threadMeta}>{new Date(currentThread.createdAt).toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" })}, {new Date(currentThread.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })} · <b>{countLabel(currentThread.engagement?.views || 0)}</b> 次查看</div><div className={styles.threadActions}><button title="回复" onClick={() => openComposer("reply", currentThread.id)}><MessageCircle size={20} />{countLabel(Math.max(threadReplies.length, currentThread.engagement?.comments || 0))}</button><button title="转帖或引用" onClick={() => setRepostTarget(currentThread.id)}><Repeat2 size={20} />{countLabel(currentThread.engagement?.reposts || 0)}</button><button title="喜欢" className={state.actions.some(a => a.actorId === activeAccount && a.targetPostId === currentThread.id && a.kind === "like") ? styles.liked : ""} onClick={() => changePost(currentThread.id, "liked")}><Heart size={20} />{countLabel(currentThread.engagement?.likes || 0)}</button><button title="收藏" className={state.actions.some(a => a.actorId === activeAccount && a.targetPostId === currentThread.id && a.kind === "bookmark") ? styles.engaged : ""} onClick={() => changePost(currentThread.id, "bookmarked")}><Bookmark size={20} />{countLabel(Math.round((currentThread.engagement?.likes || 0) * .14))}</button><button aria-label="分享帖子" onClick={()=>setSharePostId(currentThread.id)}><Share2 size={20}/></button></div></>}{threadReplies.map(({post},index)=>{const rootOf=(p:TwitterPost)=>{let id=p.id,parent=p.replyToId;const seen=new Set<string>();while(parent&&parent!==threadId&&!seen.has(parent)){seen.add(parent);const item=state.posts.find(x=>x.id===parent);if(!item)break;id=item.id;parent=item.replyToId;}return id;};const root=rootOf(post),prev=threadReplies[index-1]?.post,next=threadReplies[index+1]?.post;return <div key={post.id} className={styles.replyChainItem} data-linked-before={!!prev&&rootOf(prev)===root} data-linked-after={!!next&&rootOf(next)===root}>{renderPost(post,true)}</div>;})}{currentThread && <button className={styles.aiReply} onClick={() => { void refreshComments(currentThread); }} disabled={busy}>{busy ? "加载评论中…" : "查看更多评论"}</button>}</div><form ref={replyComposerRef} className={styles.bottomComposer} onSubmit={event=>{event.preventDefault();reply();}}>
{commentTargetId&&<button type="button" className={styles.replyingTo} onClick={()=>setCommentTargetId(null)}>回复 @{display(state.posts.find(p=>p.id===commentTargetId)?.authorId||"user").handle} ×</button>}
{replyImages.length>0&&<div className={styles.replyAttachments}>{replyImages.map((ref,i)=><button key={ref} type="button" title="移除图片" onClick={()=>setReplyImages(old=>old.filter((_,n)=>n!==i))}><StoredImage imageRef={ref}/><span>×</span></button>)}</div>}
<div className={styles.replyCapsule}>
{replyAccountPicker&&<div className={styles.replyAccountPicker}>{["user","user:alt"].map(id=><button type="button" key={id} onClick={()=>{setReplyAccountPicker(false);if(id==="user:alt"&&!state.accounts[id])openManagement({initialAccountId:id,closeOnSave:true});else setActiveAccount(id);}}><Avatar image={display(id).avatarUrl} label={display(id).name}/><span>{id==="user"?"主账号":"副账号"} · {display(id).name}</span>{activeAccount===id&&"✓"}</button>)}</div>}
<button className={styles.replyAvatar} type="button" aria-label="切换回复主副账号" aria-expanded={replyAccountPicker} onClick={()=>setReplyAccountPicker(v=>!v)}><Avatar image={currentUserAccount.avatarUrl} label={currentUserAccount.name}/></button>
<input value={replyDraft} onChange={event=>setReplyDraft(event.target.value)} placeholder="发布你的回复"/>
{replyMediaMenu && <div style={{position:'absolute',bottom:65,left:10,zIndex:35,background:'var(--c-card,#fff)',color:'var(--c-text,#111)',borderRadius:15,padding:8,boxShadow:'0 5px 24px #0003',display:'grid',gap:4}} role="menu"><button type="button" onClick={()=>{setReplyMediaMenu(false);replyFileRef.current?.click();}}>从相册发图</button><button type="button" onClick={()=>{setReplyMediaMenu(false);setReplyTextImageEditor(true);setImagePrompt(replyTextImage);setImagePromptOpen(true);}}>文字描述</button><button type="button" onClick={()=>{setReplyMediaMenu(false);pickMedia('reply','live');}}>实况照片</button></div>}
{replyMedia && <button type="button" onClick={()=>setReplyMedia(null)}>已选{replyMedia.kind==='gif'?' GIF':'实况'} · 点击移除</button>}{replyTextImage && <button type="button" onClick={()=>setReplyTextImage('')}>文字图 · 点击移除</button>}
<input ref={replyFileRef} type="file" accept="image/*" multiple hidden onChange={event=>{void uploadReplyImage(event);}}/>
<button type="button" aria-label="添加回复图片" disabled={replyImages.length>=4} onClick={()=>setReplyMediaMenu(v=>!v)}><ImagePlus size={22}/></button>
<button disabled={mediaBusy || (!replyDraft.trim()&&!replyImages.length&&!replyMedia&&!replyTextImage)} aria-label="发送回复"><Send size={21}/></button>
</div></form></div>}

    {dmSearchOpen && <div className={`${styles.page} ${styles.topPage}`}><div className={styles.pageHeader}><button onClick={() => { setDmSearchOpen(false); setDmSearch(""); }} aria-label="返回"><ArrowLeft size={21} /></button><b>新私信</b></div><div className={styles.searchBox}><Search size={18} /><input autoFocus value={dmSearch} onChange={event => setDmSearch(event.target.value)} placeholder="搜索已关注的角色账号" /></div><div className={styles.followList}>{[...characters.map(char => char.id), ...activeCommunityIds].filter(id => state.following.includes(id) || state.following.includes(`${id}:alt`)).flatMap(id => [id, ...(state.accounts[`${id}:alt`] ? [`${id}:alt`] : [])]).filter(id=>knownTwitterAccount(state,id)).filter(id => `${display(id).name} ${display(id).handle}`.toLowerCase().includes(dmSearch.toLowerCase())).map(id => <button key={id} className={`${styles.dmSearchResult} ${id.endsWith(":alt") ? styles.dmSearchAlt : ""}`} onClick={() => confirmConversation(id.replace(/:alt$/, ""), id)}><Avatar image={display(id).avatarUrl} label={display(id).name} /><span><b>{display(id).name}</b><small>@{display(id).handle} · {id.endsWith(":alt") ? "副账号" : state.communityCharacters[id] ? "社群角色" : "主账号"}</small></span></button>)}</div></div>}
    {(dmConfirmation||sharePostId)&&<TwitterRecipientPicker state={state} initialSender={activeAccount} initialRecipient={dmConfirmation?.accountId} postId={sharePostId} commit={commit} onClose={()=>{setDmConfirmation(null);setSharePostId(undefined);}} onDone={(id,sender)=>{setActiveAccount(sender);setConversationId(id);setDmConfirmation(null);setSharePostId(undefined);setDmSearchOpen(false);setTab('messages');}}/>}

    {profileId && profile && <div className={`${styles.page} ${styles.topPage}`}>
      <div className={styles.profileTopBar}><button onClick={() => { setProfileId(null); setProfileMenuOpen(false); }} aria-label="返回"><ArrowLeft size={23} /></button><span className={styles.profileTopSpacer} />{(profileCharacterId || profileId === "user" || profileId === "user:alt" || profileId.startsWith("group:")) && <button onClick={() => setProfileMenuOpen(open => !open)} aria-label="主页设置"><Settings2 size={22} /></button>}</div>
      {profileMenuOpen && <div className={styles.profileMenu}>
        <button onClick={() => { setProfileMenuOpen(false); openManagement({ initialAccountId: profileId, closeOnSave: true }); }}>编辑主页</button>
        {profileCharacterId && !profileId.endsWith(":alt") && !state.communityCharacters[profileCharacterId] && <button onClick={() => { setProfileMenuOpen(false); openManagement({ initialAccountId: `${profileCharacterId}:alt`, closeOnSave: true }); }}>设置该角色副账号</button>}
        {(profileId === "user" || profileId === "user:alt") && <button onClick={() => { setProfileMenuOpen(false); openManagement({ initialAccountId: "user:alt", closeOnSave: true }); }}>设置我的副账号</button>}
      </div>}
      <div className={styles.pageScroll}>
        <div className={styles.profileBanner}>{profile.bannerUrl && <StoredImage imageRef={profile.bannerUrl} />}</div>
        <div className={styles.profileIdentity}>
          <div className={styles.profilePortrait}><Avatar label={profile.name} image={profile.avatarUrl} size="large" /></div>
          <h2>{profile.name}{profile.verification && profile.verification !== "none" && <BadgeCheck size={20} className={`${styles.verifyBadge} ${styles[`badge${profile.verification}`]}`} />}</h2>
          <div className={styles.profileHandle}>@{profile.handle}{profile.visibility === "protected" ? " · 私密账号" : ""}</div>
          {profile.bio && <p className={styles.profileBio}>{profile.bio}</p>}
          {(profile.birthday || profile.createdAt) && <p className={styles.profileJoined}>{profile.birthday && <span><CalendarDays size={14} /> 生于 {new Date(`${profile.birthday}T00:00:00`).toLocaleDateString("zh-CN", { month: "long", day: "numeric" })}</span>}{profile.createdAt && <span>加入于 {new Date(profile.createdAt).toLocaleDateString("zh-CN", { year: "numeric", month: "long" })}</span>}</p>}
          <div className={styles.profileCounts}><b>{formatTwitterCount(profile.followingCount)}</b> 正在关注 <b>{formatTwitterCount(profile.followers)}</b> 关注者</div>
          {profileCharacterId ? <div className={styles.profileControls}><button className={styles.profileDm} onClick={() => confirmConversation(profileCharacterId, profileId)}>私信</button><button className={state.following.includes(profileId) ? styles.profileFollowing : styles.profileFollow} onClick={() => commit(current => ({ ...current, following: current.following.includes(profileId) ? current.following.filter(id => id !== profileId) : [...current.following, profileId] }))}>{state.following.includes(profileId) ? "正在关注" : "关注"}</button></div> : (profileId === "user" || profileId === "user:alt") ? <button className={styles.profileEdit} onClick={() => openManagement({ initialAccountId: profileId, closeOnSave: true })}>编辑个人资料</button> : null}
        </div>
        <div className={styles.profileTabs} style={{ "--profile-tab-count": profileId.startsWith("user") ? 5 : 4, "--profile-tab-index": ["posts", "replies", "reposts", "media", "bookmarks"].indexOf(profileFeedTab) } as CSSProperties}>{(["posts", "replies", "reposts", "media", ...(profileId.startsWith("user") ? ["bookmarks"] : [])] as Array<typeof profileFeedTab>).map((item) => <button key={item} className={profileFeedTab === item ? styles.profileTabSelected : ""} onClick={() => setProfileFeedTab(item)}>{({ posts: "帖子", replies: "回复", reposts: "转帖", media: "媒体", bookmarks: "收藏" })[item]}</button>)}</div>
        <div className={styles.profileTabContent} key={`${profileId}-${profileFeedTab}`}>{state.posts.filter(p => profileFeedTab === "bookmarks" ? state.actions.some(a => a.actorId === profileId && a.targetPostId === p.id && a.kind === "bookmark") : p.authorId === profileId && (profileFeedTab === "replies" ? !!p.replyToId : profileFeedTab === "reposts" ? !!p.repostOfId || !!p.quotePostId : profileFeedTab === "media" ? !!p.imageRef || !!p.imageRefs?.length || !!p.imageDescription : !p.replyToId && !p.repostOfId)).sort((a, b) => b.createdAt - a.createdAt).map(p => renderPost(p))}</div>
      </div>
    </div>}

    {conversationId && currentConversation && <div className={`${styles.page} ${styles.topPage}`}><div className={styles.pageHeader}><button onClick={() => { setConversationId(null); setReplyingToId(null); setDmMenuOpen(false); setDmContextId(null); }} aria-label="返回"><ArrowLeft size={21} /></button><Avatar label={display(currentConversation.recipientAccountId || currentConversation.characterId).name} image={display(currentConversation.recipientAccountId || currentConversation.characterId).avatarUrl} /><b>{display(currentConversation.recipientAccountId || currentConversation.characterId).name}{currentConversation.mode === "anonymous" && <span className={styles.anon}> · 匿名</span>}</b><button onClick={() => setDmMenuOpen(open => !open)} aria-label="私信设置"><MoreHorizontal size={21} /></button></div>{dmMenuOpen && <div className={styles.dmMenu}><button onClick={() => { commit(current => ({ ...current, conversations: current.conversations.map(c => c.id === conversationId ? { ...c, messages: [] } : c) })); setDmMenuOpen(false); setReplyingToId(null); }}>清除聊天记录</button><button onClick={() => { commit(current => ({ ...current, conversations: current.conversations.map(c => c.id === conversationId ? { ...c, blocked: !c.blocked } : c) })); setDmMenuOpen(false); }}>{currentConversation.blocked ? "取消屏蔽" : "屏蔽此人"}</button></div>}<div className={styles.messages}>
      {currentConversation.messages.map((msg, index) => <div key={msg.id} className={styles.messageGroup}>
        {(index === 0 || messageDay(msg.createdAt) !== messageDay(currentConversation.messages[index - 1].createdAt) || msg.createdAt - currentConversation.messages[index - 1].createdAt > 20 * 60_000) && <div className={styles.messageDate}>{messageDate(msg.createdAt)}</div>}
        <DmMessage message={msg} reference={currentConversation.messages.find(row => row.id === msg.replyToId)} speaker={display(currentConversation.recipientAccountId || currentConversation.characterId).name} avatar={display(currentConversation.recipientAccountId || currentConversation.characterId).avatarUrl} onContext={() => { setDmContextId(msg.id); setDmEditDraft(null); }} onJump={id => document.getElementById(`tw-dm-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" })} />
      </div>)}
      {generationKind === "私信回复" && <div className={styles.typing}>正在输入…</div>}
    </div>{replyingToId && currentConversation.messages.some(msg => msg.id === replyingToId) && <div className={styles.dmReplyPreview}><span>回复 {currentConversation.messages.find(msg => msg.id === replyingToId)?.role === "user" ? "你" : display(currentConversation.recipientAccountId || currentConversation.characterId).name}<small>{currentConversation.messages.find(msg => msg.id === replyingToId)?.original}</small></span><button type="button" onClick={() => setReplyingToId(null)} aria-label="取消回复"><X size={18} /></button></div>}<div className={styles.dmBottom}><button aria-label="切换私信账号" onClick={()=>setDmConfirmation({characterId:currentConversation.characterId,accountId:currentConversation.recipientAccountId||currentConversation.characterId})}><Avatar image={display(currentConversation.userAccountId||"user").avatarUrl} label={display(currentConversation.userAccountId||"user").name}/></button><input value={messageDraft} onChange={event => setMessageDraft(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); sendMessage(); } }} placeholder={currentConversation.blocked ? "已屏蔽此会话" : "发送私信 · 回车发送"} disabled={currentConversation.blocked} /><button onClick={() => { void aiGenerate(currentConversation.characterId, "dm"); }} disabled={busy || currentConversation.blocked} aria-label="召唤回复" title="点击请求对方回复"><Send size={20} /></button></div></div>}

    {dmContextId && currentConversation && <div className={styles.overlay} onClick={() => { setDmContextId(null); setDmEditDraft(null); }}><div className={styles.sheet} onClick={event => event.stopPropagation()}><div className={styles.sheetHeader}><b>消息操作</b><button onClick={() => setDmContextId(null)} aria-label="关闭"><X size={20} /></button></div>{dmEditDraft !== null ? <div className={styles.dmEditArea}><label>正文<textarea value={dmEditDraft} onChange={event => setDmEditDraft(event.target.value)} /></label>{currentConversation.messages.find(message => message.id === dmContextId)?.role === "character" && <label>中文译文<textarea value={dmTranslationDraft} onChange={event => setDmTranslationDraft(event.target.value)} placeholder="原文是中文可留空" /></label>}<button onClick={() => { const value = dmEditDraft.trim(); if (!value) return; commit(current => ({ ...current, conversations: current.conversations.map(c => c.id === conversationId ? { ...c, messages: c.messages.map(message => message.id === dmContextId ? { ...message, original: value, translated: message.role === "character" ? dmTranslationDraft.trim() || undefined : undefined } : message) } : c) })); setDmContextId(null); setDmEditDraft(null); }}>保存编辑</button></div> : <div className={styles.dmContextActions}><button onClick={() => { setReplyingToId(dmContextId); setDmContextId(null); }}>回复</button><button onClick={() => { const row = currentConversation.messages.find(message => message.id === dmContextId); setDmEditDraft(row?.original || ""); setDmTranslationDraft(row?.translated || ""); }}>编辑{currentConversation.messages.find(message => message.id === dmContextId)?.role === "character" ? "正文与译文" : ""}</button>{currentConversation.messages.find(message => message.id === dmContextId)?.role === "character" && <button onClick={() => { const id = dmContextId; setDmContextId(null); void aiGenerate(currentConversation.characterId, "dm", currentConversation.characterId, id); }}>重回</button>}<button className={styles.destructive} onClick={() => { commit(current => ({ ...current, conversations: current.conversations.map(c => c.id === conversationId ? { ...c, messages: c.messages.filter(message => message.id !== dmContextId).map(message => message.replyToId === dmContextId ? { ...message, replyToId: undefined } : message) } : c) })); setDmContextId(null); }}>删除</button></div>}</div></div>}

    {communityId && selectedCommunity && <div className={styles.page}><div className={styles.pageHeader}><button onClick={() => { setCommunityId(null); setCommunityFootprintId(null); setFootprintActorId(null); }} aria-label="返回"><ArrowLeft size={21} /></button><b>社群</b><button onClick={() => openManagement({ initialTab: "communities" })}>设置</button></div><div className={styles.pageScroll} onTouchStart={event => { communityPullStartRef.current = event.currentTarget.scrollTop <= 1 ? event.touches[0].clientY : null; }} onTouchMove={event => { if (communityPullStartRef.current !== null) setCommunityPullDistance(Math.max(0, Math.min(175, event.touches[0].clientY - communityPullStartRef.current))); }} onTouchEnd={event => { const start = communityPullStartRef.current; communityPullStartRef.current = null; setCommunityPullDistance(0); if (start !== null && event.changedTouches[0].clientY - start > 140) void refreshWorld(communityId); }}><div className={styles.banner}>{selectedCommunity.bannerUrl && <StoredImage imageRef={selectedCommunity.bannerUrl} />}</div><div className={styles.communityInfo}><Avatar image={selectedCommunity.avatarUrl} label={selectedCommunity.name} size="large" /><div className={styles.communityQuickActions}><button onClick={() => { setSelectedAccounts([]); setPicker("post"); }} disabled={busy}>叫 TA 过来</button><button onClick={() => { setCommunityFootprintId(communityId); setFootprintActorId(null); }}>查看足迹</button></div><h2>{selectedCommunity.name}</h2><span>{selectedCommunity.fans.toLocaleString()} 位粉丝 · {selectedCommunity.characterIds.length + (selectedCommunity.communityCharacterIds || []).length} 位关联人物</span>{selectedCommunity.description && <p>{selectedCommunity.description}</p>}<p>{[...selectedCommunity.characterIds, ...(selectedCommunity.communityCharacterIds || [])].map(id => display(id).name).join("、")}</p></div>{(communityPullDistance > 12 || communityBusyKind && !communityFootprintId) && <div className={styles.pullStatus}><RefreshCw size={16} className={communityBusyKind ? styles.spinning : ""} />{communityBusyKind ? communityBusyKind === "characters" ? "正在生成关联角色动态…" : "正在生成社群成员动态…" : communityPullDistance > 140 ? "松开刷新社群" : "继续下拉"}</div>}{communityFootprintId === communityId ? <><div className={styles.footprintTitle}><button onClick={() => { setCommunityFootprintId(null); setFootprintActorId(null); }}><ArrowLeft size={17} />返回社群</button><b>角色在该社群的足迹</b></div><div className={styles.footprintChoices}>{[...selectedCommunity.characterIds, ...(selectedCommunity.communityCharacterIds || [])].map(id => <button key={id} className={footprintActorId === id ? styles.footprintSelected : ""} onClick={() => setFootprintActorId(id)}>{display(id).name}</button>)}</div>{footprintActorId && <>{state.actions.filter(action => action.communityId === communityId && action.actorId.replace(/:alt$/, "") === footprintActorId && action.kind === "like").map(action => <button key={action.id} className={styles.footprintLike} onClick={() => setThreadId(action.targetPostId)}><Heart size={17} />{display(footprintActorId).name} 喜欢了社群帖子 · {timestamp(action.createdAt)}</button>)}{state.posts.filter(post => post.communityId === communityId && post.authorId.replace(/:alt$/, "") === footprintActorId).sort((a, b) => b.createdAt - a.createdAt).map(post => renderPost(post))}{!state.actions.some(action => action.communityId === communityId && action.actorId.replace(/:alt$/, "") === footprintActorId) && !state.posts.some(post => post.communityId === communityId && post.authorId.replace(/:alt$/, "") === footprintActorId) && <div className={styles.empty}>TA 还没有留下足迹</div>}</>}</> : posts.filter(post => post.communityId === communityId).map(post => renderPost(post))}</div><button className={`${styles.fab} ${styles.communityFab}`} onClick={() => { setComposeCommunityId(communityId); openComposer(); }} aria-label="在社群发帖">＋</button></div>}

    {postMenuId && <div className={styles.overlay} onClick={() => setPostMenuId(null)}><div className={styles.repostSheet} onClick={event => event.stopPropagation()}><div className={styles.sheetGrip} />{(() => { const authorId = state.posts.find(p => p.id === postMenuId)?.authorId || ""; return !state.posts.find(p => p.id === postMenuId)?.repostOfId && (authorId.startsWith("user") || state.importedCharacterIds.includes(authorId.replace(/:alt$/, "")) || !!state.communityCharacters[authorId]); })() && <button onClick={() => { const post = state.posts.find(p => p.id === postMenuId); setEditPostDraft(post?.original || ""); setEditPostTranslationDraft(post?.translated || ""); setEditPostId(postMenuId); setPostMenuId(null); }}>编辑内容</button>}<button onClick={() => { deletePost(postMenuId); setPostMenuId(null); }}>删除{state.posts.find(p => p.id === postMenuId)?.replyToId ? "评论" : state.posts.find(p => p.id === postMenuId)?.repostOfId ? "转帖" : "帖子"}</button></div></div>}
    {editPostId && <div className={styles.overlay} onClick={() => setEditPostId(null)}><div className={styles.sheet} onClick={event => event.stopPropagation()}><div className={styles.sheetHeader}><b>编辑内容</b><button onClick={() => setEditPostId(null)}><X size={18} /></button></div><div className={styles.dmEditArea}><label>原文<textarea value={editPostDraft} onChange={event => setEditPostDraft(event.target.value)} /></label>{!state.posts.find(p => p.id === editPostId)?.authorId.startsWith("user") && <label>中文译文（可选）<textarea value={editPostTranslationDraft} onChange={event => setEditPostTranslationDraft(event.target.value)} /></label>}<button onClick={() => { if (!editPostDraft.trim()) return; commit(current => ({ ...current, posts: current.posts.map(p => p.id === editPostId ? { ...p, original: editPostDraft.trim(), translated: p.authorId.startsWith("user") ? undefined : editPostTranslationDraft.trim() || undefined } : p) })); setEditPostId(null); }}>保存</button></div></div></div>}
    {repostTarget && <div className={styles.overlay} onClick={() => setRepostTarget(null)}><div className={styles.repostSheet} onClick={event => event.stopPropagation()}><div className={styles.sheetGrip} /><button onClick={() => repost(repostTarget)}><Repeat2 size={23} />{state.posts.some(p => p.repostOfId === repostTarget && p.authorId === activeAccount) ? "撤销转帖" : "转帖"}</button><button onClick={() => { const id = repostTarget; setRepostTarget(null); openComposer("quote", id); }}><MessageCircle size={23} />引用</button></div></div>}

    {compose && <div className={`${styles.page} ${styles.composePage}`}><div className={styles.composeHeader}><button onClick={() => { setCompose(false); setComposeCommunityId(null); setComposeTarget(null); }} aria-label="取消"><X size={24} /></button><button className={styles.publish} onClick={publish} disabled={mediaBusy || (!composeMedia && !textImageDescription && !draft.trim() && !imageRefs.length && !pollEnabled && composeKind !== "quote")}>{composeKind === "reply" ? "回复" : "发帖"}</button></div><div className={styles.composeScroll}>
      <div className={styles.composeAuthorLine}><button onClick={() => { if (!state.accounts["user:alt"]) { openManagement({ initialAccountId: "user:alt", closeOnSave: true }); return; } setActiveAccount(id => id === "user" ? "user:alt" : "user"); }} title="切换我的主账号与副账号" aria-label="切换发帖身份"><Avatar image={currentUserAccount.avatarUrl} label={currentUserAccount.name} /></button>{composeKind === "reply" && composeTarget && <span>回复 @{display(state.posts.find(p => p.id === composeTarget)?.authorId || "user").handle}</span>}</div>
      <div className={styles.composeBody}><textarea autoFocus value={draft} onChange={event => setDraft(event.target.value)} placeholder={composeKind === "reply" ? "发布你的回复" : "有什么新鲜事？"} maxLength={1200} /></div>
      {composeKind === "quote" && composeTarget && state.posts.find(p => p.id === composeTarget) && <div className={styles.composeQuote}><button className={styles.removeQuote} onClick={() => { setComposeKind("post"); setComposeTarget(null); }} aria-label="移除引用"><X size={16} /></button><div><Avatar image={display(state.posts.find(p => p.id === composeTarget)!.authorId).avatarUrl} label={display(state.posts.find(p => p.id === composeTarget)!.authorId).name} /><b>{display(state.posts.find(p => p.id === composeTarget)!.authorId).name}</b><span>@{display(state.posts.find(p => p.id === composeTarget)!.authorId).handle}</span></div><p>{state.posts.find(p => p.id === composeTarget)!.translated || state.posts.find(p => p.id === composeTarget)!.original}</p></div>}
      {composeMedia && <div><img src={composeMedia.cover} style={{maxWidth:120}} alt="媒体预览"/><button onClick={()=>setComposeMedia(null)}>移除{composeMedia.kind==='gif'?'GIF':'实况'}</button></div>}<div className={styles.composeImages}>{imageRefs.map((ref, i) => <div key={`${ref}-${i}`}><StoredImage imageRef={ref} /><button onClick={() => setImageRefs(current => current.filter((_, j) => i !== j))} aria-label="移除图片"><X size={18} /></button></div>)}</div>{textImageDescription && <button className={styles.textImageCard} onClick={() => setTextImageDescription("")}>{textImageDescription}　×</button>}
      {pollEnabled && <div className={styles.pollEditor}>{pollOptions.map((option, index) => <input key={index} value={option} onChange={event => setPollOptions(current => current.map((v, i) => i === index ? event.target.value : v))} placeholder={`选项 ${index + 1}`} />)}<button onClick={() => setPollOptions(current => [...current, ""])}>添加选项</button><button onClick={() => setPollEnabled(false)}>移除投票</button></div>}
      {locationDraft && <button className={styles.composeLocation} onClick={() => setLocationDraft("")}><MapPin size={15} />{locationDraft} ×</button>}
      <div className={styles.cameraRail}><button onClick={() => { setImagePrompt(""); setImagePromptOpen(true); }} aria-label="描述图片并生成"><Camera size={31} /><span>描述图片</span></button>{imageRefs.map((ref, i) => <button key={i} onClick={() => setImageRefs(current => current.filter((_, j) => j !== i))}><StoredImage imageRef={ref} /></button>)}</div>
      <div className={styles.replyPermission}><button tabIndex={-1}><MessageCircle size={15} />{replyPermission === "everyone" ? "所有人可以回复" : replyPermission === "following" ? "关注的账号可以回复" : "仅提及的账号可以回复"}<ChevronDown size={15} /></button><select value={replyPermission} onChange={event => setReplyPermission(event.target.value as typeof replyPermission)} aria-label="谁可以回复"><option value="everyone">所有人可以回复</option><option value="following">关注的账号可以回复</option><option value="mentioned">仅提及的账号可以回复</option></select></div>
    </div><div className={styles.composeToolbar}><input ref={fileInputRef} type="file" multiple accept="image/*" hidden onChange={event => { void uploadImage(event); }} /><input ref={cameraInputRef} type="file" accept="image/*" capture="environment" hidden onChange={event => { void uploadImage(event); }} /><button onClick={() => fileInputRef.current?.click()} title="打开设备相册"><ImagePlus size={22} /></button><button type="button" aria-label="选择GIF" onClick={()=>pickMedia("post","gif")}><span style={{border:"1.5px solid currentColor",borderRadius:4,fontSize:11,padding:2}}>GIF</span></button><button type="button" aria-label="选择实况视频" onClick={()=>pickMedia("post","live")}><span style={{fontSize:23}}>◉</span></button><button onClick={() => cameraInputRef.current?.click()} title="拍照"><Camera size={22} /></button><button onClick={() => setPollEnabled(open => !open)} title="投票"><ListPlus size={22} /></button><button onClick={() => setLocationOpen(true)} title="添加位置"><MapPin size={22} /></button></div></div>}
    <input ref={mediaInput} type="file" hidden onChange={event=>{const file=event.target.files?.[0];event.target.value='';if(file)void readMedia(file,mediaTarget.current);}}/>
    {locationOpen && <div className={styles.overlay} onClick={() => setLocationOpen(false)}><div className={styles.repostSheet} onClick={event => event.stopPropagation()}><div className={styles.sheetGrip} /><label className={styles.locationEditor}>输入要显示的位置<input value={locationDraft} onChange={event => setLocationDraft(event.target.value)} placeholder="例如：霓湾区" autoFocus /></label><button onClick={() => setLocationOpen(false)}><MapPin size={19} />保存位置</button></div></div>}
    {attachmentMenu && <div className={styles.overlay} onClick={() => setAttachmentMenu(false)}><div className={styles.repostSheet} onClick={e => e.stopPropagation()}><div className={styles.sheetGrip} /><button onClick={() => { setAttachmentMenu(false); openAlbum(); }}><ImagePlus size={22} />从小手机相册选择</button><button onClick={() => { setAttachmentMenu(false); fileInputRef.current?.click(); }}><Camera size={22} />从设备添加照片</button><button onClick={() => { setAttachmentMenu(false); setImagePromptOpen(true); }}><Sparkles size={22} />文字描述图片</button></div></div>}
    {albumOpen && <div className={styles.overlay} onClick={() => setAlbumOpen(false)}><div className={styles.albumSheet} onClick={event => event.stopPropagation()}><div className={styles.sheetHeader}><b>选择照片 · {imageRefs.length}/4</b><button onClick={() => setAlbumOpen(false)}><X size={20} /></button></div><div className={styles.albumGrid}>{albumAssets.length ? albumAssets.map(photo => <button key={photo.id} className={imageRefs.includes(photo.assetId) ? styles.albumSelected : ""} onClick={() => setImageRefs(current => current.includes(photo.assetId) ? current.filter(ref => ref !== photo.assetId) : [...current, photo.assetId].slice(0, 4))}><StoredImage imageRef={photo.assetId} />{imageRefs.includes(photo.assetId) && <span>✓</span>}</button>) : <p>相册里还没有照片。可以先从设备添加。</p>}</div><div className={styles.albumFooter}><button onClick={() => { setAlbumOpen(false); fileInputRef.current?.click(); }}>从设备添加</button><button onClick={() => setAlbumOpen(false)}>完成</button></div></div></div>}
      {(imagePromptOpen || textImagePostId) && <div className={styles.overlay} onClick={() => { setImagePromptOpen(false); setTextImagePostId(null); setGeneratedPreview(null); setGeneratedPreviewUrl(""); }}><div className={styles.imagePromptDialog} onClick={event => event.stopPropagation()}><div className={styles.imagePromptTitle}><b>描述图片</b><button onClick={() => { setImagePromptOpen(false); setTextImagePostId(null); setGeneratedPreview(null); setGeneratedPreviewUrl(""); }} aria-label="关闭"><X size={21} /></button></div><div className={styles.imagePromptBody}><textarea value={imagePrompt} onChange={event => setImagePrompt(event.target.value)} placeholder="写下要发布的图片…" />{generatedPreviewUrl && <img src={generatedPreviewUrl} alt="生成预览" />}<div><button onClick={() => { if (!imagePrompt.trim()) return; if (textImagePostId) commit(current => ({ ...current, posts: current.posts.map(post => post.id === textImagePostId ? { ...post, imageDescription: imagePrompt.trim() } : post) })); else if(replyTextImageEditor){setReplyTextImage(imagePrompt.trim());setReplyTextImageEditor(false);}else setTextImageDescription(imagePrompt.trim()); setImagePromptOpen(false); setTextImagePostId(null); setGeneratedPreview(null); setGeneratedPreviewUrl(""); }}>保存为文字卡片</button><button disabled={busy || !imagePrompt.trim()} onClick={() => { void generateComposerImage(); }}>{generatedPreview ? "重新生成" : "生成图片"}</button></div>{generatedPreview && <div><button onClick={() => { void attachGeneratedImage(false); }}>保存到相册</button><button onClick={() => { void attachGeneratedImage(); }}>{textImagePostId ? "替换这张文字图" : "添加到帖子"}</button></div>}</div></div></div>}

    {picker && <div className={styles.overlay} onClick={() => setPicker(null)}><div className={styles.sheet} onClick={event => event.stopPropagation()}>
      <div className={styles.sheetHeader}><b>{picker === "post" ? "选择要发帖的角色账号" : picker === "reply" ? "选择回复账号 · 可多选" : "开始私信"}</b><button onClick={() => setPicker(null)} aria-label="关闭"><X size={20} /></button></div>
      <div className={styles.sheetList}>{picker !== "dm" ? pickerAccountIds.map(id => <label className={styles.pickRow} key={id}><Avatar label={display(id).name} image={display(id).avatarUrl} /><span><b>{display(id).name}</b><small>@{display(id).handle} · {state.communityCharacters[id] ? "社群角色" : id.endsWith(":alt") ? "副账号" : "主账号"}</small></span><input type="checkbox" checked={selectedAccounts.includes(id)} onChange={event => setSelectedAccounts(current => event.target.checked ? [...current, id] : current.filter(item => item !== id))} /></label>) : [...characters.map(c => c.id), ...activeCommunityIds].map(id => <div className={styles.pickRow} key={id}><Avatar label={display(id).name} image={display(id).avatarUrl} /><b>{display(id).name}</b>{picker === "dm" ? <>{twitterAccountEnabled(state,id)&&<button onClick={() => openConversation(id, "real")}>主账号</button>}{state.accounts[`${id}:alt`] && <button onClick={() => openConversation(id, "real", `${id}:alt`)}>副账号</button>}</> : <button onClick={() => { void aiGenerate(id, "reply"); }} disabled={busy}>选择</button>}</div>)}
        {picker !== "dm" && <button className={styles.generateSelected} disabled={!selectedAccounts.length || busy} onClick={() => { const ids = selectedAccounts; setPicker(null); setSelectedAccounts([]); void (async () => { for (const id of ids) await aiGenerate(id.replace(/:alt$/, ""), picker === "reply" ? "reply" : "post", id); })(); }}>生成选中的 {selectedAccounts.length} 个账号</button>}
      </div>
    </div></div>}

    {manageOpen && <TwitterManagement key={`${managementOptions.initialTab || "accounts"}-${managementOptions.initialAccountId || ""}-${managementOptions.createCommunity || ""}`} {...managementOptions} state={state} characters={characters} onChange={commit} onClose={() => setManageOpen(false)} onNotice={alert} onUserAccount={id => { setActiveAccount(id); setManageOpen(false); setProfileId(null); }} onCommunity={id => { setThreadId(null); setProfileId(null); setConversationId(null); setCommunityId(id); setManageOpen(false); }} />}
  </div>;
}
