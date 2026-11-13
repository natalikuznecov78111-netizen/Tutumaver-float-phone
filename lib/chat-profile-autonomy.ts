import { hasPhotoMatchDescription } from "./photo-library-usage";
import type { Character } from "./character-types";
import type { ChatMessage } from "./chat-storage";
import { getChatCharacterProfile, updateChatCharacterProfile } from "./chat-profile-storage";
import { loadPhotoLibrary } from "./photo-library-storage";
import { getChatImageFromIndexedDB } from "./chat-asset-storage";

const AUTONOMOUS_NAME_COOLDOWN_MS = 72 * 60 * 60 * 1000;
const AUTONOMOUS_AVATAR_COOLDOWN_MS = 72 * 60 * 60 * 1000;
const MAX_AVATAR_CANDIDATES = 10;

/**
 * 判断本轮是否明确在谈“让角色修改自己的 Chat 资料”。
 * 这类请求本身不需要任何外部工具；若仍把原生工具定义暴露给模型，
 * 模型可能错误地把“换头像”理解成生图/文件/其它动作，进入多轮 tool calling。
 */
export function isExplicitChatProfileRequestTurn(history: ChatMessage[], sessionId: string): boolean {
  const sessionMessages = history.filter((message) => message.sessionId === sessionId);
  if (sessionMessages.length === 0) return false;

  const currentUserTurn: ChatMessage[] = [];
  for (let index = sessionMessages.length - 1; index >= 0; index -= 1) {
    const message = sessionMessages[index];
    if (message.role === "assistant") break;
    if (message.role === "user") currentUserTurn.unshift(message);
  }
  if (currentUserTurn.length === 0) return false;

  const text = currentUserTurn
    .map((message) => [message.content, message.mediaData?.label].filter(Boolean).join(" "))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return false;
  // 显式点名 WVS/Weverse 的资料请求由 WVS Profile 行为层处理，不要误改 Chat Profile。
  if (/(?:\bwvs\b|weverse|위버스)/i.test(text)) return false;

  const target = "(?:头像|头图|昵称|网名|显示名|名字)";
  const change = "(?:换|改|设置|设成|设为|用作|当作|换上)";
  const directed = new RegExp(`(?:给你|帮你|让你|你(?:自己|的)?|把你(?:的)?).{0,12}${change}.{0,10}${target}|${target}.{0,10}${change}.{0,10}(?:你|你的|自己)`, "i");
  if (directed.test(text)) return true;

  // “我换头像了 / 我想改昵称”是在说用户自己，不要误判成角色资料请求。
  const describesUser = new RegExp(`(?:^|[，。！？!?\\s])我.{0,10}(?:想|要|刚|已经|又)?${change}.{0,8}${target}`, "i");
  if (describesUser.test(text)) return false;

  // 私聊里省略主语的“换个头像吧 / 改下昵称”通常就是在对角色说。
  const bareRequest = new RegExp(`${change}.{0,8}(?:个|一下|一个|新的)?${target}(?:吧|呗|呀|啊|看看|试试|好吗|行吗)?[。！!？?]*$|${target}.{0,8}${change}(?:一下|一个|个)?(?:吧|呗|呀|啊)?[。！!？?]*$`, "i");
  return bareRequest.test(text);
}

function cleanSummary(value: unknown, max = 140): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

function buildPhotoSummary(photo: ReturnType<typeof loadPhotoLibrary>["photos"][number], characterId: string): string {
  const mapped = (photo.people || []).find((person) => person.mappedCharacterId === characterId);
  const appearance = mapped?.appearance || photo.appearance;
  return [
    cleanSummary(photo.subject, 60),
    cleanSummary(photo.generationPrompt || photo.visionSummary, 110),
    cleanSummary(appearance?.hair, 40),
    cleanSummary(appearance?.outfit, 50),
    cleanSummary(appearance?.accessories, 40),
    cleanSummary(appearance?.scene, 50),
    ...(photo.visionTags || []).slice(0, 5).map((item) => cleanSummary(item, 30)),
  ].filter(Boolean).join(" / ").slice(0, 260);
}

function resolveCurrentAvatarPhotoId(characterId: string, avatarUrl?: string): string | undefined {
  if (!avatarUrl?.startsWith("asset://")) return undefined;
  const assetId = avatarUrl.slice("asset://".length);
  if (!assetId) return undefined;
  return loadPhotoLibrary().photos.find((photo) => photo.assetId === assetId && photo.linkedCharacterIds.includes(characterId))?.id;
}

/**
 * Chat 平台角色资料自主行为提示词。
 * 这里只授予“极低频、由角色自己决定”的能力；绝大多数普通回复不应触发资料修改。
 */
export function buildChatProfileAutonomyPrompt(character: Character, now = Date.now()): string | null {
  const profile = getChatCharacterProfile(character.id);
  const nameEligible = !profile?.lastAutonomousNameAt || now - profile.lastAutonomousNameAt >= AUTONOMOUS_NAME_COOLDOWN_MS;
  const avatarEligible = !profile?.lastAutonomousAvatarAt || now - profile.lastAutonomousAvatarAt >= AUTONOMOUS_AVATAR_COOLDOWN_MS;
  if (!nameEligible && !avatarEligible) return null;

  const library = loadPhotoLibrary();
  const currentAvatarPhotoId = resolveCurrentAvatarPhotoId(character.id, profile?.avatarUrl);
  const photoCandidates = avatarEligible
    ? library.photos
      .filter((photo) => photo.aiUsable && hasPhotoMatchDescription(photo) && photo.linkedCharacterIds.includes(character.id) && Boolean(photo.assetId))
      .filter((photo) => photo.id !== currentAvatarPhotoId)
      .sort((a, b) => Math.max(b.updatedAt || 0, b.createdAt || 0) - Math.max(a.updatedAt || 0, a.createdAt || 0))
      .slice(0, MAX_AVATAR_CANDIDATES)
    : [];

  const currentTraits = cleanSummary(library.currentTraitsByCharacter[character.id]?.text, 220);
  const currentName = profile?.displayName?.trim() || character.name;
  const candidateLines = photoCandidates.map((photo) => `- ${photo.id} | ${buildPhotoSummary(photo, character.id) || "已识别的角色照片"}`);

  return [
    "【Chat 平台资料自主行为】",
    `你在 Chat 里的当前显示名：${currentName}。`,
    profile?.displayName ? "这是你自己设置的 Chat 昵称，不是用户给你的备注。" : `你目前没有单独设置 Chat 昵称，界面回退显示角色本名「${character.name}」。`,
    profile?.avatarUrl ? `你目前有独立 Chat 头像${currentAvatarPhotoId ? `（素材 ${currentAvatarPhotoId}）` : ""}。` : "你目前没有独立 Chat 头像，界面回退使用角色默认头像。",
    currentTraits ? `你的当前外观参考：${currentTraits}` : "当前没有额外外观参考。",
    "你拥有偶尔主动修改自己 Chat 昵称或头像的能力，但这是低频的真实账号行为，不是每轮必做任务。绝大多数普通聊天不要改资料，也不要因为看见这段说明就立刻改。只有当当下情境、心情、纪念日、新发色、玩笑、小名、刚拍到很适合的照片等真的让你自然想改时才行动。",
    "用户给你推荐头像是另一条独立机制；如果本轮用户正在推荐某张头像，请走接受/拒绝推荐机制，不要用这里的自主行为绕开用户推荐。",
    "修改 Chat Profile 不需要、也不允许调用任何外部工具、联网、搜索、生图、文件或发送照片动作。头像只能从下方已经给出的真实候选 photoId 中直接选择；昵称直接用资料更新动作完成。",
    nameEligible
      ? "如果你确实主动决定改 Chat 昵称，在自然回复末尾额外输出一个隐藏动作，格式严格为：[资料更新 \"chat\"]{\"displayName\":\"你的新昵称\"}[/资料更新]。昵称应符合你的人设和使用语言，简短自然，不要把角色本名永久改掉。"
      : "本轮不要主动改 Chat 昵称。",
    avatarEligible && candidateLines.length
      ? [
          "如果你确实主动决定换 Chat 头像，只能从下面真实可用素材里挑一个明确适合作为你本人头像的 photoId；不要选纯风景、食物、物品，群像也要慎重。",
          ...candidateLines,
          "选定后在自然回复末尾额外输出隐藏动作，格式严格为：[资料更新 \"chat\"]{\"avatarPhotoId\":\"photoId\"}[/资料更新]。不要编造列表外的 photoId。",
        ].join("\n")
      : "本轮没有可用于自主更换 Chat 头像的真实候选素材，因此不要输出头像资料更新动作。",
    "如果本轮没有真心想改资料，就完全不要输出任何[资料更新]标签。资料更新标签不会展示给用户，不要解释标签，也不要把标签写进代码块。",
  ].join("\n");
}


async function assetToAvatarDataUrl(assetId: string): Promise<string | null> {
  const source = await getChatImageFromIndexedDB(assetId).catch(() => null);
  if (!source) return null;
  if (typeof document === "undefined" || typeof Image === "undefined") return source;

  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      try {
        const maxSize = 640;
        const width = image.naturalWidth || image.width;
        const height = image.naturalHeight || image.height;
        if (!width || !height) { resolve(source); return; }
        const scale = Math.min(1, maxSize / Math.max(width, height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));
        const ctx = canvas.getContext("2d");
        if (!ctx) { resolve(source); return; }
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.86));
      } catch {
        resolve(source);
      }
    };
    image.onerror = () => resolve(source);
    image.src = source;
  });
}

function parseJsonObject(content: string): Record<string, unknown> | null {
  const trimmed = content.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** 执行已经由 action parser 隐藏掉的 Chat Profile 自主更新。 */
export async function applyAutonomousChatProfileAction(characterId: string, content: string): Promise<boolean> {
  const payload = parseJsonObject(content);
  if (!payload) return false;

  const profile = getChatCharacterProfile(characterId);
  const now = Date.now();
  const patch: Parameters<typeof updateChatCharacterProfile>[1] = {};

  if (typeof payload.displayName === "string") {
    const nextName = payload.displayName.replace(/\s+/g, " ").trim().slice(0, 40);
    const currentName = profile?.displayName?.trim() || "";
    const cooldownReady = !profile?.lastAutonomousNameAt || now - profile.lastAutonomousNameAt >= AUTONOMOUS_NAME_COOLDOWN_MS;
    if (nextName && nextName !== currentName && cooldownReady) {
      patch.displayName = nextName;
      patch.lastAutonomousNameAt = now;
    }
  }

  if (typeof payload.avatarPhotoId === "string") {
    const requestedId = payload.avatarPhotoId.trim();
    const cooldownReady = !profile?.lastAutonomousAvatarAt || now - profile.lastAutonomousAvatarAt >= AUTONOMOUS_AVATAR_COOLDOWN_MS;
    if (requestedId && cooldownReady) {
      const photo = loadPhotoLibrary().photos.find((item) =>
        item.id === requestedId
        && item.aiUsable
        && hasPhotoMatchDescription(item)
        && item.linkedCharacterIds.includes(characterId)
        && Boolean(item.assetId),
      );
      if (photo) {
        const nextAvatar = await assetToAvatarDataUrl(photo.assetId);
        if (nextAvatar && nextAvatar !== profile?.avatarUrl) {
          patch.avatarUrl = nextAvatar;
          patch.lastAutonomousAvatarAt = now;
        }
      }
    }
  }

  if (Object.keys(patch).length === 0) return false;
  updateChatCharacterProfile(characterId, patch);
  return true;
}
