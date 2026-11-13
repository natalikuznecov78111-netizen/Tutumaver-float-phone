"use client";
import { AppNotificationSetting, useSocialNotices } from "@/components/social/app-notifications";
import { readSocialTarget } from "@/lib/social-notifications";

import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Check, ChevronDown, ChevronRight, Clock3, Plus, RefreshCw, Send, Settings2, Share2, Trash2, X } from "lucide-react";
import { createOrGetSession, pushChatMessage } from "@/lib/chat-storage";
import type { QuestionBoxSnapshot } from "@/lib/question-box-chat";
import { loadCharacters } from "@/lib/character-storage";
import { generateBoxAnswers, generateBoxQuestions, generateBoxTopic, translateBoxUserAnswer } from "@/lib/question-box-engine";
import { resolveUserIdentity, USER_IDENTITIES_UPDATED_EVENT } from "@/lib/settings-storage";
import { emptyBoxState, loadBoxState, newBoxId, saveBoxState, type BoxProfile, type BoxQuestion, type BoxSession, type BoxState, type BoxTopicMode } from "@/lib/question-box-storage";
import styles from "./question-box-app.module.css";
import socialStyles from "@/components/social/social.module.css";
import { DEFAULT_ROLE_SOCIAL_SOURCES } from "@/lib/role-social-sources";

type Page = "home" | "box" | "archive";
type Modal = "user" | "characters" | "delivery" | "participants" | "refresh" | "share" | null;
const presetHours = [3, 12, 24, 72];
const pick = <T,>(rows: T[]) => rows[Math.floor(Math.random() * rows.length)];
const randomCount = (max: number) => 1 + Math.floor(Math.random() * Math.max(1, max));
const shuffle = <T,>(rows: T[]) => { const copy = [...rows]; for (let i = copy.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [copy[i], copy[j]] = [copy[j], copy[i]]; } return copy; };
const at = (time: number) => new Date(time).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const left = (end: number, now: number) => { const m = Math.max(0, Math.ceil((end - now) / 60000)); return m >= 1440 ? `${Math.ceil(m / 1440)} 天` : m >= 60 ? `${Math.ceil(m / 60)} 小时` : `${m} 分钟`; };
async function imageData(file: File, cover: boolean): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("请选择图片文件。");
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas"); canvas.width = cover ? 960 : 320; canvas.height = cover ? 440 : 320;
    const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("图片处理失败。");
    const scale = Math.max(canvas.width / bitmap.width, canvas.height / bitmap.height);
    const w = bitmap.width * scale; const h = bitmap.height * scale;
    ctx.drawImage(bitmap, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
    return canvas.toDataURL("image/webp", .76);
  } finally { bitmap.close(); }
}

export function QuestionBoxApp({ onClose, onNotice }: { onClose: () => void; onNotice?: (text: string) => void }) {
  const [state, setState] = useState<BoxState>(() => loadBoxState());
  useEffect(()=>{const fn=(e:Event)=>{const n=(e as CustomEvent).detail;if(n.app==='question_box'){setBoxId(n.targetId);setPage('box');}};window.addEventListener('social-notification-open',fn);return()=>window.removeEventListener('social-notification-open',fn);},[]);
  const [page, setPage] = useState<Page>("home");
  const [boxOrigin, setBoxOrigin] = useState<"home" | "archive">("home");
  const [modal, setModal] = useState<Modal>(null);
  const [share, setShare] = useState<QuestionBoxSnapshot | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [editOwner, setEditOwner] = useState<string | null>(null);
  const [charactersExpanded, setCharactersExpanded] = useState(false);
  const [userIdentity, setUserIdentity] = useState(() => resolveUserIdentity(undefined, "question_box"));
  const [now, setNow] = useState(() => Date.now());
  const [boxId, setBoxId] = useState<string | null>(null);
  const [expandedQuestion, setExpandedQuestion] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [topic, setTopic] = useState("");
  const [topicMode, setTopicMode] = useState<BoxTopicMode>("persona");
  const [duration, setDuration] = useState(24);
  const [customDuration, setCustomDuration] = useState("24");
  const [maxQuestions, setMaxQuestions] = useState(5);
  const [selectedCharacters, setSelectedCharacters] = useState<string[]>([]);
  const [participants, setParticipants] = useState<string[] | undefined>(undefined);
  const [draft, setDraft] = useState("");
  const [deliveryMode, setDeliveryMode] = useState<"solo" | "mixed">("solo");
  const characters = useMemo(() => loadCharacters(), []);
  useEffect(() => saveBoxState(state), [state]);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 30000); return () => window.clearInterval(timer); }, []);
  useEffect(() => { const reload = () => setUserIdentity(resolveUserIdentity(undefined, "question_box")); window.addEventListener(USER_IDENTITIES_UPDATED_EVENT, reload); return () => window.removeEventListener(USER_IDENTITIES_UPDATED_EVENT, reload); }, []);

  const activeBoxes = state.sessions.filter(box => box.endsAt > now).sort((a, b) => a.ownerId === "user" ? -1 : b.ownerId === "user" ? 1 : a.endsAt - b.endsAt);
  const closedBoxes = state.sessions.filter(box => box.endsAt <= now).sort((a, b) => b.endsAt - a.endsAt);
  const box = state.sessions.find(row => row.id === boxId) || null;
  const boxOpen = !!box && box.endsAt > now;
  const { notices } = useSocialNotices();
  const unreadBoxes = new Set(notices.filter(notice => notice.app === "question_box" && !notice.read).map(notice => notice.targetId));
  const currentBoxUnread = page === "box" && !!boxId && unreadBoxes.has(boxId);
  useEffect(() => {
    if (boxId && currentBoxUnread) readSocialTarget("question_box", boxId);
  }, [boxId, currentBoxUnread]);
  const name = (ownerId: string) => ownerId === "user" ? userIdentity?.name || "U" : characters.find(c => c.id === ownerId)?.name || "已移除的角色";
  const fallbackAvatar = (ownerId: string) => ownerId === "user" ? userIdentity?.avatarUrl || "" : characters.find(c => c.id === ownerId)?.avatar || "";
  const profile = (ownerId: string, archived = false, row?: BoxSession): BoxProfile => archived ? row?.profileSnapshot || {} : state.profiles[ownerId] || {};
  const display = (ownerId: string, archived = false, row?: BoxSession) => profile(ownerId, archived, row).nickname?.trim() || name(ownerId);
  const updateBox = (id: string, change: (row: BoxSession) => BoxSession) => setState(prev => ({ ...prev, sessions: prev.sessions.map(row => row.id === id ? change(row) : row) }));
  const setOwnerProfile = (id: string, change: Partial<BoxProfile>) => setState(prev => ({ ...prev, profiles: { ...prev.profiles, [id]: { ...prev.profiles[id], ...change } } }));
  const back = () => { if (drawer) { setDrawer(false); return; } if (modal) { setModal(null); return; } if (page === "box") { setPage(boxOrigin); return; } if (page === "archive") { setPage("home"); return; } onClose(); };
  const openBox = (row: BoxSession) => { if (page !== "box") setBoxOrigin(page); setBoxId(row.id); setPage("box"); setExpandedQuestion(null); };
  const startUser = () => {
    if (state.sessions.some(row => row.ownerId === "user" && row.endsAt > Date.now())) { onNotice?.("U 的提问箱已经在开放中。"); return; }
    const hours = duration === 0 ? Number(customDuration) : duration;
    if (!Number.isFinite(hours) || hours < 1 || hours > 720) { onNotice?.("开放时长请输入 1 至 720 小时。"); return; }
    const startAt = Date.now(); const row: BoxSession = { id: newBoxId(), ownerId: "user", startsAt: startAt, endsAt: startAt + hours * 3600000, topicMode: topic.trim() ? "custom" : "free", topic: topic.trim().slice(0, 100), maxQuestions, lastArrivalAt: startAt, questions: [], profileSnapshot: { ...state.profiles.user } };
    setState(prev => ({ ...prev, sessions: [row, ...prev.sessions] })); setBoxId(row.id); setPage("box"); setModal(null); setTopic("");
  };
  const startCharacters = () => {
    const available = characters.filter(c => !state.sessions.some(row => row.ownerId === c.id && row.endsAt > Date.now()));
    if (!available.length) { onNotice?.("目前没有可新开箱的 C。"); return; }
    const explicit = selectedCharacters.length > 0;
    const chosen = explicit ? available.filter(c => selectedCharacters.includes(c.id)) : shuffle(available).slice(0, randomCount(Math.min(3, available.length)));
    if (!chosen.length) { onNotice?.("选中的 C 已经开箱，换一位试试。"); return; }
    const hours = duration === 0 ? Number(customDuration) : duration;
    if (duration !== -1 && (!Number.isFinite(hours) || hours < 1 || hours > 720)) { onNotice?.("开放时长请输入 1 至 720 小时。"); return; }
    const startAt = Date.now();
    const rows: BoxSession[] = chosen.map(c => {
      const mode = explicit ? topicMode : pick(["persona", "free"] as BoxTopicMode[]);
      const length = duration === -1 ? pick(presetHours) : hours;
      return { id: newBoxId(), ownerId: c.id, startsAt: startAt, endsAt: startAt + length * 3600000, topicMode: mode, topic: mode === "custom" ? topic.trim().slice(0, 100) : "", maxQuestions, lastArrivalAt: startAt, questions: [], profileSnapshot: { ...state.profiles[c.id] } };
    });
    setState(prev => ({ ...prev, sessions: [...rows, ...prev.sessions] })); setModal(null); setSelectedCharacters([]); setTopic(""); setPage("home");
    onNotice?.(`已为 ${rows.length} 位 C 开箱，进各自的箱子刷新后才会收到问题。`);
  };
  const refresh = async (mode: "questions" | "answers" | "both" = "questions") => {
    const target = box; if (!target || !boxOpen || busy) return;
    setModal(null);
    setBusy(true);
    try {
      const messages: string[] = [];
      if (mode !== "answers") {
        try {
          const count = randomCount(target.maxQuestions);
          const actualTopic = target.topicMode === "persona" && !target.topic ? await generateBoxTopic(target.ownerId) : target.topic;
          const batch = await generateBoxQuestions({ ...target, topic: actualTopic }, count);
          if (Date.now() >= target.endsAt) { setNow(Date.now()); onNotice?.("本期已结束，新问题没有加入。"); return; }
          updateBox(target.id, row => ({ ...row, topic: actualTopic || row.topic, questions: [...row.questions, ...batch], lastArrivalAt: Date.now() }));
          messages.push(`收到 ${batch.length} 条新问题`);
        } catch (error) { if (mode === "questions") throw error; messages.push("收题失败"); }
      }
      if (mode !== "questions" && target.ownerId !== "user") {
        try {
          const answers = await generateBoxAnswers(target);
          if (Date.now() >= target.endsAt) { setNow(Date.now()); onNotice?.("本期已结束，没有发布新回答。"); return; }
          const found = new Map(answers.map(answer => [answer.id, answer]));
          if (found.size) updateBox(target.id, row => ({ ...row, questions: row.questions.map(question => {
            const result = !question.answer && found.get(question.id);
            return result ? { ...question, answer: { original: result.original, translated: result.translated, createdAt: Date.now() } } : question;
          }) }));
          messages.push(found.size ? `有 ${found.size} 条新回答` : "暂时没有新回答");
        } catch (error) { if (mode === "answers") throw error; messages.push("查看回答失败"); }
      }
      onNotice?.(`${messages.join("，")}。`);
    } catch (error) { onNotice?.(error instanceof Error ? error.message : "刷新失败，请重试。"); } finally { setBusy(false); }
  };
  const answer = async (questionId: string) => {
    if (!box || box.ownerId !== "user" || !boxOpen || busy || !draft.trim()) return;
    const target = box; const input = draft.trim();
    setBusy(true);
    try {
      const translated = await translateBoxUserAnswer(input);
      if (Date.now() >= target.endsAt) { setNow(Date.now()); onNotice?.("本期已结束，回答没有发布。"); return; }
      updateBox(target.id, row => ({ ...row, questions: row.questions.map(q => q.id === questionId && !q.answer ? { ...q, answer: { original: input, translated, createdAt: Date.now() } } : q) }));
      setDraft(""); setExpandedQuestion(null);
    } catch (error) { onNotice?.(error instanceof Error ? error.message : "翻译失败，请重试。"); } finally { setBusy(false); }
  };
  const deliver = async () => {
    if (!box || box.ownerId === "user" || box.endsAt <= Date.now() || !draft.trim() || busy) return;
    const target = box; const body = draft.trim().slice(0, 600);
    const userQuestion: BoxQuestion = { id: newBoxId(), recipientId: target.ownerId, senderId: "user", senderName: "匿名", text: body, createdAt: Date.now() };
    setDraft(""); setModal(null);
    if (deliveryMode === "solo" || target.maxQuestions <= 1) { updateBox(target.id, row => ({ ...row, questions: [...row.questions, userQuestion] })); onNotice?.(target.maxQuestions <= 1 && deliveryMode === "mixed" ? "每次最多 1 题，这次已单独匿名投递。" : "匿名问题已投递。"); return; }
    setBusy(true);
    try {
      const others = await generateBoxQuestions(target, randomCount(Math.max(1, target.maxQuestions - 1)), true);
      const position = Math.floor(Math.random() * (others.length + 1));
      others.splice(position, 0, userQuestion);
      if (Date.now() >= target.endsAt) { setNow(Date.now()); onNotice?.("本期已结束，问题没有投递。"); setDraft(body); return; }
      updateBox(target.id, row => ({ ...row, questions: [...row.questions, ...others], lastArrivalAt: Date.now() }));
      onNotice?.("匿名问题已混入这一批。");
    } catch { if (Date.now() < target.endsAt) { updateBox(target.id, row => ({ ...row, questions: [...row.questions, userQuestion] })); onNotice?.("其他问题暂时生成失败，你的问题已单独投递。"); } else { setDraft(body); onNotice?.("本期已结束，问题没有投递。"); } } finally { setBusy(false); }
  };
  const eraseAll = () => { if (!window.confirm("将删除全部提问箱记录、头像和封面。确定继续？")) return; if (!window.confirm("再次确认：全部提问箱数据删除后无法恢复。")) return; setState(emptyBoxState()); setPage("home"); setBoxId(null); setDrawer(false); onNotice?.("提问箱数据已清除。"); };
  const deleteBox = () => { if (!box || !window.confirm("删除这一期提问箱、全部问题和回答？删除后不会再作为角色记忆读取。")) return; const id = box.id; setState(prev => ({ ...prev, sessions: prev.sessions.filter(row => row.id !== id) })); setBoxId(null); setExpandedQuestion(null); setPage(boxOrigin); onNotice?.("本期提问箱已删除。"); };
  const deleteQuestion = (id: string) => { if (!box || !window.confirm("删除这道问题和它的回答？")) return; updateBox(box.id, row => ({ ...row, questions: row.questions.filter(q => q.id !== id) })); if (expandedQuestion === id) setExpandedQuestion(null); };
  const readImage = async (id: string, file: File | undefined, kind: "avatar" | "cover") => { if (!file) return; try { setOwnerProfile(id, { [kind === "avatar" ? "avatarUrl" : "coverUrl"]: await imageData(file, kind === "cover") }); } catch (error) { onNotice?.(error instanceof Error ? error.message : "图片导入失败。"); } };
  const updateParticipants = () => { if (!box || box.ownerId !== "user") return; updateBox(box.id, row => ({ ...row, participantIds: participants })); setModal(null); };
  const sessionCard = (row: BoxSession) => {
    const archived = row.endsAt <= now;
    const p = profile(row.ownerId, archived, row);
    const avatar = p.avatarUrl || fallbackAvatar(row.ownerId);
    const cover = p.coverUrl;
    return <button key={row.id} className={styles.boxCard} onClick={() => openBox(row)}>
      {unreadBoxes.has(row.id) && <i className={styles.unreadDot} aria-label="新互动" />}
      <div className={styles.cover} style={cover ? { backgroundImage: `url(${cover})` } : undefined}><span className={styles.coverLabel}>QUESTION BOX</span>{!cover && <span className={styles.coverMotif}>Q.</span>}</div>
      <div className={styles.cardInfo}><span className={styles.ownerAvatar}>{avatar ? <img src={avatar} alt=""/> : display(row.ownerId, archived, row).slice(0, 1)}</span><div className={styles.ownerText}><strong>{display(row.ownerId, archived, row)}</strong><span className={styles.topic}>{row.topic || (row.topicMode === "persona" ? "主题由 TA 决定" : "随便问问")}</span></div><div className={styles.cardState}><b>{archived ? "已经关闭" : "正在开箱"}</b><small>{archived ? "已结束" : `还剩 ${left(row.endsAt, now)}`}</small></div></div>
    </button>;
  };
  const shareTo = (characterId: string) => {
    if (!share) return;
    const session = createOrGetSession(characterId);
    const answer = share.answer;
    const context = [
      "[提问箱分享快照 · 以下为卡片资料]",
      `匿名问题：${share.question}`,
      ...(answer ? [`${answer.name}的回答：${answer.original}`, ...(answer.translated !== answer.original ? [`译文：${answer.translated}`] : [])] : []),
      "这是用户转发的快照。问题的发问者身份仍待确认。",
    ].join("\n");
    pushChatMessage({
      sessionId: session.id, role: "user", content: context, mediaType: "app_card",
      mediaData: {
        appId: "question_box", appName: "提问箱", appCardTitle: "匿名提问",
        appCardSummary: share.question, appHistoryText: context, questionBoxSnapshot: share,
      },
    });
    setModal(null);
    setShare(null);
    window.dispatchEvent(new CustomEvent("chat-messages-updated", { detail: { sessionId: session.id } }));
    window.dispatchEvent(new CustomEvent("open-app", { detail: { appId: "chat", sessionId: session.id } }));
  };
  const questionCard = (row: BoxQuestion) => <article key={row.id} className={styles.questionCard}>
    <div className={styles.questionTop}><span>匿名提问</span><span>{at(row.createdAt)}</span></div>
    <strong>{row.text}</strong>
    {row.answer && <div className={styles.inlineAnswer}><span>{display(box!.ownerId, !boxOpen, box!)}的回答</span><p>{row.answer.original}</p>{row.answer.translated !== row.answer.original && <p className={styles.translation}>{row.answer.translated}</p>}</div>}
    <div className={styles.questionFooter}><span className={row.answer ? styles.answered : styles.unanswered}>{row.answer ? "已回答" : "未回答"}</span><div>
      {box?.ownerId === "user" && boxOpen && !row.answer && <button onClick={() => { setExpandedQuestion(expandedQuestion === row.id ? null : row.id); setDraft(""); }}>{expandedQuestion === row.id ? "收起" : "写回答"}</button>}
      <button className={styles.shareQuestion} aria-label="分享到 Chat" title="分享到 Chat" onClick={() => {
        if (!box) return;
        setShare({ boxId: box.id, questionId: row.id, question: row.text, answer: row.answer ? {
          name: display(box.ownerId, !boxOpen, box), original: row.answer.original, translated: row.answer.translated,
        } : undefined });
        setModal("share");
      }}><Share2 size={15}/></button>
      <button aria-label="删除问题" title="删除问题" onClick={() => deleteQuestion(row.id)}><Trash2 size={15}/></button>
    </div></div>
    {expandedQuestion === row.id && !row.answer && <div className={styles.reply}><textarea placeholder="写下你的回答…" value={draft} maxLength={1400} onChange={e => setDraft(e.target.value)}/><button disabled={!draft.trim() || busy} onClick={() => void answer(row.id)}>{busy ? "正在处理…" : "发布回答"}</button></div>}
  </article>;
  const profileEditor = (ownerId: string) => {
    const avatar = state.profiles[ownerId]?.avatarUrl || fallbackAvatar(ownerId);
    const cover = state.profiles[ownerId]?.coverUrl;
    return <div className={styles.profileMiniCard} key={ownerId}>
      {ownerId !== "user" && <button className={styles.profileTitle} onClick={() => setEditOwner(editOwner === ownerId ? null : ownerId)}><span className={styles.profileTinyAvatar}>{avatar ? <img src={avatar} alt=""/> : name(ownerId).slice(0, 1)}</span><span>{display(ownerId)}</span><ChevronDown size={15} className={editOwner === ownerId ? styles.chevronOpen : ""}/></button>}
      {editOwner === ownerId && <div className={styles.profileFields}>
        <div className={styles.profileIdentity}><label className={styles.profileAvatar} title="点按头像更换"><span>{avatar ? <img src={avatar} alt=""/> : name(ownerId).slice(0, 1)}</span><input type="file" accept="image/*" onChange={e => { void readImage(ownerId, e.target.files?.[0], "avatar"); e.target.value = ""; }}/></label><label className={styles.profileNickname}>昵称<input placeholder={name(ownerId)} value={state.profiles[ownerId]?.nickname || ""} onChange={e => setOwnerProfile(ownerId, { nickname: e.target.value })}/></label></div>
        <label className={styles.profileCover} style={cover ? { backgroundImage: `url(${cover})` } : undefined} title="点按封面更换"><span>提问箱封面 · 点按更换</span>{!cover && <b>Q.</b>}<input type="file" accept="image/*" onChange={e => { void readImage(ownerId, e.target.files?.[0], "cover"); e.target.value = ""; }}/></label>
      </div>}
    </div>;
  };
  const pageTitle = page === "home" ? "提问箱" : page === "archive" ? "往期" : box ? display(box.ownerId, !boxOpen, box) + "的提问箱" : "提问箱";

  return <div className={styles.app}>
    <header className={styles.header}><button aria-label="返回" onClick={back}><ArrowLeft size={21}/></button><strong>{pageTitle}</strong><div className={styles.headerActions}>{page === "home" && <button aria-label="刷新 C 的提问箱" title="为 C 开启提问箱" onClick={() => { setSelectedCharacters([]); setTopic(""); setTopicMode("persona"); setDuration(-1); setModal("characters"); }}><RefreshCw size={19}/></button>}<button aria-label="提问箱设置" onClick={() => setDrawer(true)}><Settings2 size={20}/></button></div></header>
    <main className={styles.main}>
      {page === "home" && <><div className={styles.pageLead}><span>OPEN NOW</span><h1>正在开箱</h1><p>想回答的时候再回答。</p></div>{activeBoxes.map(row => sessionCard(row))}{!activeBoxes.length && <p className={styles.empty}>现在没有开放的提问箱。点底部 ＋ 开启自己的新一期，或点右上角刷新为 C 开箱。</p>}</>}
      {page === "archive" && <><div className={styles.pageLead}><span>PAST BOXES</span><h1>往期</h1><p>已经关闭的问题和回答都留在这里。</p></div>{closedBoxes.map(row => sessionCard(row))}{!closedBoxes.length && <p className={styles.empty}>还没有往期提问箱。</p>}</>}
      {page === "box" && box && <>{sessionCard(box)}<div className={styles.boxMeta}><span><Clock3 size={14}/> {at(box.startsAt)} — {at(box.endsAt)}</span>{box.ownerId === "user" && boxOpen && <button onClick={() => { setParticipants(box.participantIds); setModal("participants"); }}>本期提问者 <ChevronRight size={14}/></button>}</div><div className={styles.sectionTitle}><strong>收到的问题</strong><span>{box.questions.length}</span></div>{[...box.questions].reverse().map(questionCard)}{!box.questions.length && <p className={styles.empty}>现在还是空箱。点刷新，看看谁来提问。</p>}{boxOpen && <div className={styles.boxActions}><button disabled={busy} onClick={() => box.ownerId === "user" ? void refresh("questions") : setModal("refresh")}><RefreshCw size={17} className={busy ? styles.spin : ""}/>{busy ? "正在刷新" : "刷新"}</button>{box.ownerId !== "user" && <button disabled={busy} onClick={() => { setDraft(""); setDeliveryMode("solo"); setModal("delivery"); }}><Send size={17}/>投递</button>}</div>}<button className={styles.deleteBox} onClick={deleteBox}><Trash2 size={15}/> 删除本期提问箱</button></>}
    </main>
    <nav className={styles.pillNav}><button className={page === "home" || page === "box" ? styles.navSelected : ""} onClick={() => setPage("home")}>首页</button><button className={styles.navPlus} aria-label="开启 U 的新一期" onClick={() => { setDuration(24); setMaxQuestions(5); setTopic(""); setModal("user"); }}><Plus size={22}/></button><button className={page === "archive" ? styles.navSelected : ""} onClick={() => setPage("archive")}>往期</button></nav>

    {modal && <div className={styles.scrim} onClick={() => setModal(null)}><section className={styles.modal} role="dialog" aria-modal="true" onClick={e => e.stopPropagation()}><div className={styles.modalHead}><strong>{modal === "user" ? "开启我的提问箱" : modal === "characters" ? "为 C 开启提问箱" : modal === "delivery" ? "匿名投递" : modal === "refresh" ? "刷新提问箱" : modal === "share" ? "分享到 Chat" : "本期提问者"}</strong><button aria-label="关闭" onClick={() => setModal(null)}><X size={18}/></button></div>
      {modal === "user" && <><label className={styles.field}>本期主题 <small>选填</small><input placeholder="不填就随便问问" value={topic} maxLength={100} onChange={e => setTopic(e.target.value)}/></label><DurationPicker value={duration} setValue={setDuration} custom={customDuration} setCustom={setCustomDuration}/><CountPicker value={maxQuestions} setValue={setMaxQuestions}/><p className={styles.hint}>开启后是空箱，进入箱子点刷新才会收题。</p><button className={styles.primary} onClick={startUser}>开始开箱</button></>}
      {modal === "characters" && <><p className={styles.hint}>不选择 C，就随机开启一部分尚未开箱的 C；主题和开放时长也会随机。</p><div className={styles.characterGrid}>{characters.map(c => <button key={c.id} className={selectedCharacters.includes(c.id) ? styles.characterSelected : ""} onClick={() => setSelectedCharacters(prev => prev.includes(c.id) ? prev.filter(id => id !== c.id) : [...prev, c.id])}><span>{state.profiles[c.id]?.avatarUrl || c.avatar ? <img src={state.profiles[c.id]?.avatarUrl || c.avatar || ""} alt=""/> : c.name.slice(0, 1)}</span>{state.profiles[c.id]?.nickname || c.name}{selectedCharacters.includes(c.id) && <Check size={13}/>}</button>)}</div><div className={styles.field}>本期主题<div className={styles.segment}><button className={topicMode === "custom" ? styles.selected : ""} onClick={() => setTopicMode("custom")}>自己指定</button><button className={topicMode === "persona" ? styles.selected : ""} onClick={() => setTopicMode("persona")}>由 TA 定</button><button className={topicMode === "free" ? styles.selected : ""} onClick={() => setTopicMode("free")}>随便问</button></div>{topicMode === "custom" && <input placeholder="给选中的 C 设置主题" value={topic} maxLength={100} onChange={e => setTopic(e.target.value)}/>}</div><DurationPicker value={duration} setValue={setDuration} custom={customDuration} setCustom={setCustomDuration} random/><CountPicker value={maxQuestions} setValue={setMaxQuestions}/><button className={styles.primary} onClick={startCharacters}>开启提问箱</button></>}
      {modal === "delivery" && <><textarea className={styles.deliveryText} placeholder="写下想匿名问 TA 的问题…" value={draft} maxLength={600} onChange={e => setDraft(e.target.value)}/><div className={styles.segment}><button className={deliveryMode === "solo" ? styles.selected : ""} onClick={() => setDeliveryMode("solo")}>单独投递</button><button className={deliveryMode === "mixed" ? styles.selected : ""} onClick={() => setDeliveryMode("mixed")}>混入其他问题</button></div><p className={styles.hint}>两种方式对 TA 都只显示匿名；投递后不会立刻回答。</p><button className={styles.primary} disabled={!draft.trim()} onClick={() => void deliver()}>投递问题</button></>}
      {modal === "refresh" && <><p className={styles.refreshHint}>这次想更新什么？看回答不会增加问题，C 也可能暂时不答。</p><div className={styles.refreshChoices}>
        <button className={styles.refreshChoice} onClick={() => void refresh("questions")}><span className={styles.refreshIcon}><Plus size={17}/></span><span className={styles.refreshText}><strong>收新问题</strong><small>随机收到几道匿名提问</small></span><ChevronRight size={16}/></button>
        <button className={styles.refreshChoice} onClick={() => void refresh("answers")}><span className={styles.refreshIcon}><Check size={17}/></span><span className={styles.refreshText}><strong>看新回答</strong><small>只看看 C 回了哪些旧问题</small></span><ChevronRight size={16}/></button>
        <button className={styles.refreshChoice} onClick={() => void refresh("both")}><span className={styles.refreshIcon}><RefreshCw size={16}/></span><span className={styles.refreshText}><strong>同时刷新</strong><small>收新问题，也查看已有问题的回答</small></span><ChevronRight size={16}/></button>
      </div></>}
      {modal === "share" && (characters.length ? <div className={styles.characterGrid}>{characters.map(c => <button key={c.id} onClick={() => shareTo(c.id)}><span>{c.avatar ? <img src={c.avatar} alt=""/> : c.name.slice(0, 1)}</span>{c.name}</button>)}</div> : <p className={styles.hint}>还没有可以分享的角色。</p>)}
      {modal === "participants" && <><p className={styles.hint}>默认每次从引入的 C 中随机抽一部分提问，也可能有陌生人。指定后只有勾选的 C 和陌生人参与。</p><button className={styles.choiceRow} onClick={() => setParticipants(undefined)}><span>随机抽取 C</span>{!participants && <Check size={16}/>}</button><div className={styles.characterGrid}>{characters.map(c => <button key={c.id} className={participants?.includes(c.id) ? styles.characterSelected : ""} onClick={() => setParticipants(prev => prev?.includes(c.id) ? prev.filter(id => id !== c.id) : [...(prev || []), c.id])}>{state.profiles[c.id]?.nickname || c.name}{participants?.includes(c.id) && <Check size={13}/>}</button>)}</div><button className={styles.primary} onClick={updateParticipants}>保存本期设置</button></>}
    </section></div>}

    {drawer && <div className={styles.drawerScrim} onClick={() => setDrawer(false)}><aside className={styles.drawer} onClick={e => e.stopPropagation()}><div className={styles.drawerHead}><strong>提问箱设置</strong><button aria-label="关闭设置" onClick={() => setDrawer(false)}><X size={19}/></button></div><div className={styles.drawerBody}><AppNotificationSetting app="question_box" className={styles.noticeSetting} />
      <button className={styles.accordionHead} onClick={() => setEditOwner(editOwner === "user" ? null : "user")}>我的资料 <ChevronDown size={16} className={editOwner === "user" ? styles.chevronOpen : ""}/></button>
      {editOwner === "user" && profileEditor("user")}
      <button className={styles.accordionHead} onClick={() => { setCharactersExpanded(!charactersExpanded); setEditOwner(null); }}>角色资料 <ChevronDown size={16} className={charactersExpanded ? styles.chevronOpen : ""}/></button>
      {charactersExpanded && (characters.length ? characters.map(c => profileEditor(c.id)) : <p className={styles.hint}>还没有引入角色。</p>)}
      <h3>角色关联来源</h3><p className={styles.hint}>逐个角色开启，默认关闭；匿名发问者不会知道私人日历。</p>
      <div className={socialStyles.grid}>{characters.map(char => {
        const linked = (state.socialSourcesByCharacter[char.id] || DEFAULT_ROLE_SOCIAL_SOURCES).includeCalendar;
        const avatar = state.profiles[char.id]?.avatarUrl || char.avatar;
        const nickname = state.profiles[char.id]?.nickname || char.name;
        return <button key={`source-${char.id}`} type="button" className={socialStyles.person} aria-label={`${nickname}的手机日历`} aria-pressed={linked} onClick={() => setState(current => {
          const source = current.socialSourcesByCharacter[char.id] || DEFAULT_ROLE_SOCIAL_SOURCES;
          return { ...current, socialSourcesByCharacter: { ...current.socialSourcesByCharacter, [char.id]: { ...source, includeCalendar: !source.includeCalendar } } };
        })}><span>{avatar ? <img src={avatar} alt=""/> : char.name.slice(0, 1)}</span><b>{nickname}</b><small>{linked ? "已关联日历" : "未关联日历"}</small></button>;
      })}</div>
      <p className={styles.hint}>这里的头像、昵称和封面只用于提问箱展示，不修改身份或人设。</p><button className={styles.eraseAll} onClick={eraseAll}><Trash2 size={16}/> 清除所有提问箱数据</button>
    </div></aside></div>}
  </div>;
}

function DurationPicker({ value, setValue, custom, setCustom, random = false }: { value: number; setValue: (v: number) => void; custom: string; setCustom: (v: string) => void; random?: boolean }) {
  return <div className={styles.field}>开放时长<div className={styles.segment}>{presetHours.map(hour => <button key={hour} className={value === hour ? styles.selected : ""} onClick={() => setValue(hour)}>{hour < 24 ? `${hour} 小时` : `${hour / 24} 天`}</button>)}<button className={value === 0 ? styles.selected : ""} onClick={() => setValue(0)}>自定</button>{random && <button className={value === -1 ? styles.selected : ""} onClick={() => setValue(-1)}>随机</button>}</div>{value === 0 && <label className={styles.durationInput}><input type="number" min="1" max="720" value={custom} onChange={e => setCustom(e.target.value)} placeholder="输入时长"/><span>小时</span></label>}</div>;
}
function CountPicker({ value, setValue }: { value: number; setValue: (v: number) => void }) {
  return <div className={styles.field}>每次最多收几题<div className={styles.segment}>{[1, 2, 3, 4, 5].map(count => <button key={count} className={value === count ? styles.selected : ""} onClick={() => setValue(count)}>{count}</button>)}</div><small>这是上限；选 5 题也可能只收到 3 题。</small></div>;
}

