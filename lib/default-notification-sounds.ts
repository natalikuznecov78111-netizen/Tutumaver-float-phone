import type { ChatSoundConfig, ChatSoundKind } from "./chat-storage";
export const DEFAULT_CHAT_SOUNDS: Record<ChatSoundKind, string> = {
    newMessage: "/sounds/default/chat-new-message.mp3",
    sendMessage: "/sounds/default/chat-send.mp3",
    incomingCall: "/sounds/default/chat-incoming.mp3",
    outgoingCall: "/sounds/default/chat-outgoing.mp3",
    hangup: "/sounds/default/chat-hangup.mp3",
};
export const DEFAULT_SMS_SOUND = "/sounds/default/sms-new-message.mp3";
export const DEFAULT_PHONE_RINGTONE = "/sounds/default/phone-incoming.mp3";
export const DEFAULT_LYSN_SOUND = "/sounds/default/lysn-new-message.mp3";
export function withDefaultChatSound(kind: ChatSoundKind, config: ChatSoundConfig = {}): ChatSoundConfig {
    const result = { enabled: true, ...config };
    if (!result.value) { result.sourceType = "url"; result.value = DEFAULT_CHAT_SOUNDS[kind]; }
    return result;
}
