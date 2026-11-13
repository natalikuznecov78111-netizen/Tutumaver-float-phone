import { DEFAULT_PHONE_RINGTONE } from "./default-notification-sounds";
import { kvGet, kvSet, registerKvMigration } from "./kv-db";
import { loadSms, saveSms, phoneFromPersona } from "./sms-storage";
import { loadCharacters, saveCharacters } from "./character-storage";

export const PHONE_KEY = "ai_phone_native_phone_v1";
export const PHONE_EVENT = "phone-updated";
registerKvMigration(PHONE_KEY);

export type PhoneCallStatus = "completed" | "missed" | "declined" | "canceled" | "busy";
export type PhoneCallDirection = "incoming" | "outgoing";
export type PhoneTranscriptLine = {
  id: string;
  role: "user" | "assistant";
  original: string;
  translated?: string;
  createdAt: number;
  audioRef?: string;
  /** One manual summon generates one coherent reply batch. */
  batchId?: string;
};
export type PhoneCallRecord = {
  id: string;
  characterId: string;
  number: string;
  direction: PhoneCallDirection;
  status: PhoneCallStatus;
  startedAt: number;
  connectedAt?: number;
  endedAt: number;
  durationSec: number;
  favorite?: boolean;
  /** null 表示新未接来电尚未查看；旧记录缺失此字段时视为已看。 */
  seenAt?: number | null;
  transcript: PhoneTranscriptLine[];
  source?: "phone" | "chat" | "sms" | "system";
};
export type PhoneState = { version: 1; calls: PhoneCallRecord[]; ringtoneUrl?: string; ringtoneEnabled?: boolean };

const empty = (): PhoneState => ({ version: 1, calls: [], ringtoneEnabled: true, ringtoneUrl: DEFAULT_PHONE_RINGTONE });
export function loadPhoneState(): PhoneState {
  try {
    const raw = kvGet(PHONE_KEY);
    if (!raw) return empty();
    const parsed = JSON.parse(raw) as Partial<PhoneState>;
    return { version: 1, ringtoneEnabled: parsed.ringtoneEnabled !== false, calls: Array.isArray(parsed.calls) ? parsed.calls : [], ringtoneUrl: typeof parsed.ringtoneUrl === "string" && parsed.ringtoneUrl.trim() ? parsed.ringtoneUrl : DEFAULT_PHONE_RINGTONE };
  } catch { return empty(); }
}
export function savePhoneState(state: PhoneState): void {
  kvSet(PHONE_KEY, JSON.stringify(state));
  if (typeof window !== "undefined") window.dispatchEvent(new Event(PHONE_EVENT));
}
export function phoneId(prefix = "call"): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}
export function getUserPhoneNumber(): string { return loadSms().realNumber || ""; }
export function setUserPhoneNumber(number: string): void {
  const sms = loadSms();
  sms.realNumber = number.trim();
  sms.threads.filter(thread => thread.identityId === "real").forEach(thread => { thread.number = sms.realNumber; });
  saveSms(sms);
  if (typeof window !== "undefined") window.dispatchEvent(new Event(PHONE_EVENT));
}
export function getCharacterPhoneNumber(characterId: string): string {
  const sms = loadSms();
  const existing = sms.characterNumbers[characterId];
  if (existing) return existing.replace(/\D/g, "");
  const character = loadCharacters().find(c => c.id === characterId);
  const fromPersona = (character?.wechatID || (character ? phoneFromPersona(character.persona || "") : "")).replace(/\D/g, "");
  if (fromPersona) {
    sms.characterNumbers[characterId] = fromPersona;
    saveSms(sms);
  }
  return fromPersona;
}
export function setCharacterPhoneNumber(characterId: string, number: string): void {
  const sms = loadSms();
  const digits = number.replace(/\D/g, "");
  sms.characterNumbers[characterId] = digits;
  sms.threads.filter(thread => thread.characterId === characterId).forEach(thread => { thread.characterNumber = sms.characterNumbers[characterId]; });
  saveSms(sms);
  const characters = loadCharacters();
  if (digits && characters.some(character => character.id === characterId && character.wechatID !== digits)) {
    saveCharacters(characters.map(character => character.id === characterId ? { ...character, wechatID: digits } : character));
  }
  if (typeof window !== "undefined") window.dispatchEvent(new Event(PHONE_EVENT));
}
export function appendPhoneCall(record: PhoneCallRecord): void {
  const state = loadPhoneState();
  const idx = state.calls.findIndex(c => c.id === record.id);
  if (idx >= 0) state.calls[idx] = record;
  else state.calls.unshift(record.status === "missed" && record.direction === "incoming" ? { ...record, seenAt: null } : record);
  state.calls = state.calls.slice(0, 500);
  savePhoneState(state);
}
export function getUnseenMissedCallCount(state: PhoneState = loadPhoneState()): number {
  return state.calls.filter(call => call.status === "missed" && call.direction === "incoming" && call.seenAt === null).length;
}
export function markMissedCallsSeen(): void {
  const state = loadPhoneState();
  if (!state.calls.some(call => call.seenAt === null && call.status === "missed")) return;
  const seenAt = Date.now();
  state.calls.forEach(call => { if (call.status === "missed" && call.seenAt === null) call.seenAt = seenAt; });
  savePhoneState(state);
}
export function togglePhoneFavorite(callId: string): void {
  const state = loadPhoneState();
  const call = state.calls.find(c => c.id === callId);
  if (!call) return;
  call.favorite = !call.favorite;
  savePhoneState(state);
}
export function removePhoneCall(callId: string): void {
  const state = loadPhoneState();
  const nextCalls = state.calls.filter(c => c.id !== callId);
  if (nextCalls.length === state.calls.length) return;
  state.calls = nextCalls;
  savePhoneState(state);
}
