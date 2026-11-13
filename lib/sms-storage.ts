import { DEFAULT_SMS_SOUND } from "./default-notification-sounds";
import { kvGet, kvSet, registerKvMigration } from "./kv-db";

export const SMS_KEY = "ai_phone_sms_v1";
export const SMS_EVENT = "sms-updated";
export const SMS_INCOMING_EVENT = "sms-incoming-message";
registerKvMigration(SMS_KEY);

export type SmsIdentity = { id: string; number: string; region: string; createdAt: number };
export type SmsReaction = { id: string; emoji: string; by: "user" | "character" };
export type SmsMessage = { id: string; threadId: string; direction: "outgoing" | "incoming"; original: string; translated?: string; createdAt: number; delivered: boolean; batchId?: string; awarenessAt?: SmsThread["awareness"]; reactions?: SmsReaction[] };
export type SmsThread = { id: string; characterId: string; identityId: string; number: string; characterNumber: string; alias?: string; backgroundUrl?: string; blockedByMe: boolean; blockedByCharacter: boolean; awareness: "unknown" | "suspected" | "confirmed"; suspicion?: string; summary?: string; updatedAt: number; readAt: number };
export const DEFAULT_SMS_EMOJI = ["❤️", "👍", "😂", "😮", "😢", "👀", "🔥", "🫶", "🐰", "🥺", "😍", "✨", "💀", "👏", "😡", "💕"];
export type SmsState = { version: 1; contactAliases?: Record<string, string>; realNumber: string; characterNumbers: Record<string,string>; identities: SmsIdentity[]; threads: SmsThread[]; messages: SmsMessage[]; background: string; proactive: "off" | "on" | "rare" | "normal" | "often"; autoExpandTranslation: boolean; ringtoneUrl?: string; soundEnabled?: boolean; emojiChoices: string[]; lastAutoAt: Record<string,number>; contactAttempts: Record<string,number> };
const empty = (): SmsState => ({ version: 1, realNumber: "", characterNumbers: {}, identities: [], threads: [], messages: [], background: "", proactive: "off", autoExpandTranslation: false, soundEnabled: true, ringtoneUrl: DEFAULT_SMS_SOUND, emojiChoices: [...DEFAULT_SMS_EMOJI], lastAutoAt: {}, contactAttempts: {} });
export function loadSms(): SmsState {
  try {
    const raw = kvGet(SMS_KEY);
    if (!raw) return empty();
    const parsed = JSON.parse(raw) as Partial<SmsState>;
    return { ...empty(), ...parsed, autoExpandTranslation: parsed.autoExpandTranslation === true, ringtoneUrl: typeof parsed.ringtoneUrl === "string" && parsed.ringtoneUrl.trim() ? parsed.ringtoneUrl : DEFAULT_SMS_SOUND, emojiChoices: Array.isArray(parsed.emojiChoices) ? parsed.emojiChoices.filter((value): value is string => typeof value === "string" && value.length <= 32).slice(0, 80) : [...DEFAULT_SMS_EMOJI], characterNumbers: parsed.characterNumbers ?? {}, identities: Array.isArray(parsed.identities) ? parsed.identities : [], threads: Array.isArray(parsed.threads) ? parsed.threads : [], messages: Array.isArray(parsed.messages) ? parsed.messages : [], lastAutoAt: parsed.lastAutoAt ?? {}, contactAttempts: parsed.contactAttempts ?? {} };
  } catch { return empty(); }
}
export function saveSms(state: SmsState): void {
  const previousIds = new Set(loadSms().messages.map(message => message.id));
  kvSet(SMS_KEY, JSON.stringify(state));
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(SMS_EVENT));
    for (const message of state.messages) {
      if (previousIds.has(message.id) || message.direction !== "incoming" || !message.delivered) continue;
      const thread = state.threads.find(item => item.id === message.threadId);
      if (thread) window.dispatchEvent(new CustomEvent(SMS_INCOMING_EVENT, { detail: { message, thread } }));
    }
  }
}
export function getSmsThreadUnreadCount(state: SmsState, threadId: string): number {
  const thread = state.threads.find(item => item.id === threadId);
  if (!thread) return 0;
  return state.messages.filter(message => message.threadId === threadId && message.direction === "incoming" && message.delivered && message.createdAt > thread.readAt).length;
}
export function getSmsUnreadCount(state: SmsState = loadSms()): number {
  return state.threads.reduce((count, thread) => count + getSmsThreadUnreadCount(state, thread.id), 0);
}
export function markSmsThreadRead(threadId: string): void {
  const state = loadSms();
  const thread = state.threads.find(item => item.id === threadId);
  if (!thread) return;
  const latest = state.messages.filter(message => message.threadId === threadId && message.direction === "incoming" && message.delivered).at(-1)?.createdAt || 0;
  if (latest <= thread.readAt) return;
  thread.readAt = Math.max(Date.now(), latest);
  saveSms(state);
}
export function smsId(): string { return `sms_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`; }
export function ensureSmsThread(state: SmsState, characterId: string, identityId: string, characterNumber = ""): SmsThread {
  const id = `${characterId}:${identityId}`;
  let thread = state.threads.find(item => item.id === id);
  if (!thread) {
    thread = { id, characterId, identityId, number: identityId === "real" ? state.realNumber : state.identities.find(x => x.id === identityId)?.number ?? "", characterNumber: characterNumber || state.characterNumbers[characterId] || "", blockedByMe: false, blockedByCharacter: false, awareness: identityId === "real" ? "confirmed" : "unknown", updatedAt: Date.now(), readAt: Date.now() };
    state.threads.push(thread);
  }
  return thread;
}
export function addSmsMessage(state: SmsState, thread: SmsThread, direction: SmsMessage["direction"], original: string, translated?: string, batchId?: string): SmsMessage {
  const now = Math.max(Date.now(), thread.updatedAt + 1);
  const message: SmsMessage = { id: smsId(), threadId: thread.id, direction, original: original.trim(), translated: translated?.trim(), createdAt: now, delivered: direction === "outgoing" ? !thread.blockedByCharacter : !thread.blockedByMe, batchId, awarenessAt: thread.awareness };
  state.messages.push(message);
  thread.updatedAt = now;
  return message;
}
export const SMS_REGIONS = [
  { code: "KR", name: "韩国 +82", prefix: "+82 10", groups: [4,4] },
  { code: "CN", name: "中国 +86", prefix: "+86 1", groups: [2,4,4] },
  { code: "JP", name: "日本 +81", prefix: "+81 90", groups: [4,4] },
  { code: "US", name: "美国 +1", prefix: "+1", groups: [3,3,4] },
  { code: "GB", name: "英国 +44", prefix: "+44 7", groups: [3,3,3] },
] as const;
export function createVirtualIdentity(state: SmsState, region: string): SmsIdentity {
  const spec = SMS_REGIONS.find(r => r.code === region) ?? SMS_REGIONS[0];
  let number = "";
  do { number = `${spec.prefix} ${spec.groups.map(n => Array.from({length:n}, () => Math.floor(Math.random()*10)).join("")).join(" ")}`; }
  while (state.identities.some(x => x.number === number) || state.realNumber === number);
  const identity = { id: smsId(), number, region: spec.code, createdAt: Date.now() };
  state.identities.push(identity);
  return identity;
}

/** A WeChat ID can look like a phone number but is not proof of a real SMS number. */
export function phoneFromPersona(persona: string): string {
  const match = persona.match(/(?:韩国电话|手机号码|手机(?:号|电话)|联系电话|phone\s*number|전화번호)\s*[：:]\s*(\+?\d[\d\s-]{7,19}\d)/i);
  return match?.[1]?.replace(/\D/g, "") ?? "";
}

/** Compact shared-memory view. Keep full threads and virtual-number identity in SMS storage. */
export function loadSmsProjectionEntries(characterId: string, options: { afterTimestamp?: string; userName?: string; charName?: string; excludeThreadId?: string } = {}): Array<{ id: string; timestamp: string; content: string }> {
  const state = loadSms();
  const threads = new Map(state.threads.filter(thread => thread.characterId === characterId && thread.id !== options.excludeThreadId).map(thread => [thread.id, thread]));
  const after = options.afterTimestamp ? Date.parse(options.afterTimestamp) : 0;
  return state.messages.flatMap(message => {
    const thread = threads.get(message.threadId);
    if (!thread || !message.delivered || (Number.isFinite(after) && message.createdAt <= after)) return [];
    const name = message.direction === "incoming" ? (options.charName || "对方")
      : message.awarenessAt === "confirmed" || thread.identityId === "real" ? (options.userName || "用户") : "未确认身份的号码";
    return [{ id: message.id, timestamp: new Date(message.createdAt).toISOString(), content: `[短信] ${name}：${message.original}` }];
  });
}

/** Shared Phone/SMS remark. Legacy thread remarks remain a read-only fallback. */
export function smsContactAlias(characterId: string, state: SmsState = loadSms()): string {
  if (Object.prototype.hasOwnProperty.call(state.contactAliases ?? {}, characterId)) return state.contactAliases![characterId].trim();
  const legacy = state.threads.filter(item => item.characterId === characterId && item.alias?.trim());
  return (legacy.find(item => item.identityId === "real") ?? legacy.sort((a,b) => b.updatedAt-a.updatedAt)[0])?.alias?.trim() || "";
}
export function smsContactDisplayName(characterId: string, realName: string, state: SmsState = loadSms()): string {
  return smsContactAlias(characterId, state) || realName || "联系人";
}
export function setSmsContactAlias(state: SmsState, characterId: string, value: string): void {
  state.contactAliases = { ...state.contactAliases, [characterId]: value.trim() };
  for (const thread of state.threads) if (thread.characterId === characterId) thread.alias = value.trim();
}
