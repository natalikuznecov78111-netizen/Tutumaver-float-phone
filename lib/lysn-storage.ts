import { DEFAULT_LYSN_SOUND } from "./default-notification-sounds";
import type { PhotoStorySnapshot } from "./photo-story-data";
import { kvGet, kvSet, registerKvMigration } from "./kv-db";

export const LYSN_KEY = "ai_phone_lysn_v1";
export const LYSN_EVENT = "lysn-updated";
registerKvMigration(LYSN_KEY);

export type LysnQuote = { original: string; translated: string };
export type LysnMessage = {
  photoStoryContext?: PhotoStorySnapshot;
  id: string; characterId: string; sender: "artist" | "fan" | "system";
  kind: "text" | "photo" | "voice" | "sticker" | "notice";
  original: string; translated?: string; imageUrl?: string; photoId?: string;
  quote?: LysnQuote; opener?: boolean; createdAt: number;
  sourceText?: string; seenAt?: number;
  photoCaptionDetached?: boolean;
  photoDescription?: string;
  celebration?: { kind: "birthday"; year: number } | { kind: "anniversary"; days: number };
};
export type LysnProfile = { name: string; avatar: string; cover?: string; bio?: string; group?: string; updatedAt: number };
export type LysnUserProfile = { name: string; avatar: string; cover: string; birthday: string; gender: string; stickers?: LysnSticker[]; stickerPacks?: LysnStickerPack[] };
export type LysnSettings = {
  notificationSound?: string;
  notificationSoundEnabled?: boolean;
  notificationsEnabled: boolean; fontSize: "small" | "normal" | "large";
  enterToSend: boolean; translationMode: "replace" | "fold";
  autonomousMessages: boolean; deepRealism: boolean;
  testMode?: boolean;
};
export type LysnSticker = { id: string; name: string; imageUrl: string };
export type LysnStickerPack = { id: string; name: string; note?: string; stickers: LysnSticker[] };
export type LysnRoom = {
  cancelledAt?: number; cancelledDays?: number; bubbleStyle?: string;
  subscriptionDate?: string; nickname?: string; avatar?: string; chatName?: string;
  backgroundUrl?: string;
  pinned?: boolean; muted?: boolean; foldPhotos?: boolean;
  openerText?: string; openerShown?: boolean;
  onboardingComplete?: boolean; historyInitialized?: boolean;
  nextArrivalAt?: number;
  activity?: "quiet" | "normal" | "frequent";
  quoteStyle?: "rare" | "normal" | "often";
  readStyle?: "rare" | "normal" | "often"; nextFanReadAt?: number;
  stickerPacks?: LysnStickerPack[];
  favoriteMessageIds?: string[];
  birthdayCelebratedYear?: number; anniversariesShown?: number[];
  birthdayCards?: Record<string, { original: string; translated: string }>;
  identitySuspicion?: number; identityClueCount?: number;
  identityHintedInChatAt?: number; identityDisclosed?: boolean;
  identityMatchedAt?: number;
};
export const DEFAULT_LYSN_SETTINGS: LysnSettings = {
  notificationSound: DEFAULT_LYSN_SOUND, notificationSoundEnabled: true,
  notificationsEnabled: true, fontSize: "normal", enterToSend: true,
  translationMode: "fold", autonomousMessages: true, deepRealism: false, testMode: false,
};
export const DEFAULT_LYSN_USER: LysnUserProfile = { name: "我", avatar: "", cover: "", birthday: "", gender: "" };
export type LysnState = {
  version: 1; subscribedIds: string[]; profiles: Record<string, LysnProfile>;
  messages: LysnMessage[]; readAt: Record<string, number>;
  subscribedAt: Record<string, number>; lastAutoAt: Record<string, number>;
  rooms: Record<string, LysnRoom>;
  userProfile: LysnUserProfile; settings: LysnSettings;
};
const empty = (): LysnState => ({ version: 1, subscribedIds: [], profiles: {}, messages: [], readAt: {}, subscribedAt: {}, lastAutoAt: {}, rooms: {}, userProfile: { ...DEFAULT_LYSN_USER }, settings: { ...DEFAULT_LYSN_SETTINGS } });
export function loadLysn(): LysnState {
  try {
    const value = kvGet(LYSN_KEY);
    if (!value) return empty();
    const parsed = JSON.parse(value) as Partial<LysnState>;
    return {
      version: 1,
      subscribedIds: Array.isArray(parsed.subscribedIds) ? parsed.subscribedIds.filter((x): x is string => typeof x === "string") : [],
      profiles: parsed.profiles && typeof parsed.profiles === "object" ? parsed.profiles : {},
      messages: Array.isArray(parsed.messages) ? parsed.messages.filter(x => x && typeof x.id === "string" && typeof x.characterId === "string" && !(x.sender === "system" && (x.original === "🎂 生日快乐！今天是你的特别日子。" || /^💜 今天是你订阅这间聊天室的第 \d+ 天！/.test(x.original)))) : [],
      readAt: parsed.readAt && typeof parsed.readAt === "object" ? parsed.readAt : {},
      subscribedAt: parsed.subscribedAt && typeof parsed.subscribedAt === "object" ? parsed.subscribedAt : {},
      lastAutoAt: parsed.lastAutoAt && typeof parsed.lastAutoAt === "object" ? parsed.lastAutoAt : {},
      rooms: parsed.rooms && typeof parsed.rooms === "object" ? parsed.rooms : {},
      userProfile: { name: parsed.userProfile?.name || "我", avatar: parsed.userProfile?.avatar || "", cover: parsed.userProfile?.cover || "", birthday: parsed.userProfile?.birthday || "", gender: parsed.userProfile?.gender || "", stickers: Array.isArray(parsed.userProfile?.stickers) ? parsed.userProfile.stickers.filter(s => s && typeof s.id === "string" && typeof s.name === "string" && typeof s.imageUrl === "string") : [], stickerPacks: Array.isArray(parsed.userProfile?.stickerPacks) ? parsed.userProfile.stickerPacks : undefined },
      settings: { ...DEFAULT_LYSN_SETTINGS, ...Object.fromEntries(Object.entries(parsed.settings || {}).filter(([key]) => key !== "translationApiUrl" && key !== "translationApiKey")), notificationSound: parsed.settings?.notificationSound?.trim() || DEFAULT_LYSN_SOUND },
    };
  } catch { return empty(); }
}
export function saveLysn(state: LysnState): void {
  kvSet(LYSN_KEY, JSON.stringify(state));
  if (typeof window !== "undefined") window.dispatchEvent(new Event(LYSN_EVENT));
}
export function lysnId(): string { return `lysn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`; }
export function appendLysn(characterId: string, rows: Omit<LysnMessage, "id" | "characterId" | "createdAt">[]): LysnState {
  const state = loadLysn();
  if(!state.subscribedIds.includes(characterId))return state;
  const now = Date.now();
  const quoted=new Set(rows.filter(row=>row.sender==="artist"&&row.quote?.original).map(row=>row.quote!.original));
  if (quoted.size) {
    for (const message of state.messages) {
      if (message.characterId === characterId && message.sender === "fan" && !message.seenAt && quoted.has(message.original)) message.seenAt = now;
    }
  }
  state.messages.push(...rows.map((row, i) => ({ ...row, id: lysnId(), characterId, createdAt: now + i })));
  saveLysn(state);
  return state;
}
export function localDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
export function subscriptionDays(state: LysnState, id: string, today = new Date()): number {
  if (!state.subscribedIds.includes(id) && state.rooms[id]?.cancelledDays) return state.rooms[id].cancelledDays!;
  const initial = state.rooms[id]?.subscriptionDate || (state.subscribedAt[id] ? localDay(new Date(state.subscribedAt[id])) : localDay(today));
  const start = new Date(`${initial}T12:00:00`);
  if (Number.isNaN(start.getTime())) return 1;
  const d = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) - Date.UTC(start.getFullYear(), start.getMonth(), start.getDate());
  return Math.max(1, Math.floor(d / 86400000) + 1);
}
export function replyCharacterLimit(days: number): number {
  const milestones = [30, 50, 77, 100, 150, 200, 300, 365, 400, 500];
  return milestones.filter(n => n <= days).at(-1) || 30;
}
export function countReplyCharacters(value: string): number {
  return Array.from(value).reduce((sum, char) => sum + (/\p{Extended_Pictographic}/u.test(char) ? 2 : 1), 0);
}
export function remainingFanReplies(state: LysnState, id: string, now = Date.now()): number {
  const history = state.messages.filter(m => m.characterId === id);
  const latestArtist = Math.max(history.filter(m => m.sender === "artist" && !m.opener).at(-1)?.createdAt || 0, state.subscribedAt[id] || 0);
  const fanReplies = history.filter(m => m.sender === "fan" && m.createdAt > latestArtist);
  if (!fanReplies.length) return 3;
  const firstAt = fanReplies[0].createdAt;
  const currentWindow = Math.max(0, Math.floor((now - firstAt) / 86400000));
  const windowStart = firstAt + currentWindow * 86400000;
  return Math.max(0, 3 - fanReplies.filter(m => m.createdAt >= windowStart).length);
}
