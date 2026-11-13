import {lysnCalendarContext} from "./lysn-calendar-context";
import { photoStoryReplyContext } from "./photo-story-data";
import { allowMediaIntent, recordMediaDecision } from "./media-preferences";
import { loadCharacters } from "./character-storage";
import { sendLLMRequest } from "./chat-engine";
import { assemblePromptPayload, type LLMMessage } from "./llm-prompt-assembler";
import { loadApiConfigs, loadBindingConfig, loadPresets, loadRegexes, loadWorldBooks, resolveBinding } from "./settings-storage";
import type { RegexConfig, WorldBookConfig } from "./settings-types";
import { buildCharacterTimeContext } from "./character-time";
import { loadLysn, type LysnMessage, type LysnQuote } from "./lysn-storage";
import { lysnAutonomousProfilePrompt } from "./lysn-profile-autonomy";
import { lysnPublicBoundary } from "./lysn-identity";
import { lysnPublicContinuityPrompt } from "./lysn-cross-app-context";
import { loadPhotoLibrary } from "./photo-library-storage";
import { getPhotoSourceStrategy } from "./photo-library-resolver";
import { canAutoUsePhoto, hasPhotoMatchDescription } from "./photo-library-usage";

export type GeneratedLysn = {
  kind: "text" | "photo" | "voice" | "sticker";
  original: string; translated: string; quote?: LysnQuote; stickerName?: string;
  photoDescription?: string;
  photoId?: string;
  profileUpdate?: { name?: string; avatarPhotoId?: string };
  mediaIntent?: "selfie" | "portrait" | "group" | "food" | "scenery" | "object" | "pet" | "other";
};
function parseJson(raw: string): Record<string, unknown> {
  const start = raw.indexOf("{"); const end = raw.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Lysn 没有返回有效消息，请重试。");
  return JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
}
const asText = (value: unknown) => typeof value === "string" ? value.trim() : "";
const claimsPhotoSent = (value: string) => /(?:发了|发给|这张|给你看|看看这张|发(?:一张|张|个)?(?:照|图)|照片(?:是|里|给你)|보냈|보내줄|사진.*(?:보여|보내)|here.*(?:photo|pic))/i.test(value);
/** Empty result is a deliberate decision to stay silent, rather than an error. */
export async function generateLysn(characterId: string, history: LysnMessage[], mode: "new" | "reply" | "opening" | "birthday", fanMessage?: string, configuredOpener?: string, birthdayYear?: number, historicalDate?: string): Promise<GeneratedLysn[]> {
  const character = loadCharacters().find(c => c.id === characterId);
  if (!character) throw new Error("角色已不存在。");
  const slot = resolveBinding(loadBindingConfig(), characterId, "lysn");
  const api = loadApiConfigs().find(x => x.id === slot.apiConfigId) || loadApiConfigs()[0];
  if (!api) throw new Error("请先为 Lysn 配置可用的文字 API。");
  const presets = loadPresets();
  const preset = presets.find(x => x.id === slot.presetId) || presets.find(x => x.builtIn) || null;
  const worldBooks = (slot.worldBookIds || []).map(id => loadWorldBooks().find(x => x.id === id)).filter(Boolean) as WorldBookConfig[];
  const regexes = (slot.regexIds || []).map(id => loadRegexes().find(x => x.id === id)).filter(Boolean) as RegexConfig[];
  const lysnState = loadLysn();
  const room = lysnState.rooms[characterId];
  const testMode = lysnState.settings.testMode === true;
  const stickers = (room?.stickerPacks || []).flatMap(p => p.stickers).filter(s => s.name.trim() && s.imageUrl);
  const album = loadPhotoLibrary();
  const imported = album.preferences.enabledCharacterIds.includes(characterId);
  const photoStrategy = imported ? getPhotoSourceStrategy("bubble") : "generated_only";
  const photoChoices = album.photos.filter(p => (imported || p.origin === "generated") && p.linkedCharacterIds.includes(characterId) && p.aiUsable && hasPhotoMatchDescription(p) && canAutoUsePhoto(p, characterId, "bubble")).slice(-20);
  // There is no private Chat history or Chat user identity in this prompt.
  const calendar=lysnCalendarContext(characterId);
  if((mode==="new"||mode==="reply")&&(!loadLysn().subscribedIds.includes(characterId)||!calendar.canSend))return [];
  const prompt = assemblePromptPayload({ character, history: [], preset, worldBooks, regexes,
    appId: "lysn", appTags: ["lysn", "bubble"], scheduleSummary: (mode==="new"||mode==="reply")?calendar.summary:undefined, timeContext: buildCharacterTimeContext(character.timeZone) });
  const timeline = history.slice(-18).map(m => `${m.sender === "fan" ? "匿名粉丝" : m.sender === "artist" ? m.opener ? "频道开场白" : "艺人" : "系统"}: ${m.original}`).join("\n");
  const photoRequest = mode === "reply" && /(?:照片|自拍|图片|发图|张图|几张|多张|photo|picture|pics|사진|셀카)/i.test(fanMessage || "");
  const multiplePhotosRequested = photoRequest && /(?:几张|多张|两张|三张|连发|一组|一堆|几[张幅]|多[张幅]|[2-9][张幅]|multiple|several|photos|pictures|여러\s*장|두\s*장|세\s*장)/i.test(fanMessage || "");
  const quoteTest = testMode && mode === "reply" && /(?:引用|测试引用|quote|인용|引用して)/i.test(fanMessage || "");
  const voiceTest = testMode && mode === "reply" && /(?:发.*语音|语音.*发|说句语音|voice|음성|보이스)/i.test(fanMessage || "");
  const photoTest = testMode && photoRequest && (photoChoices.length > 0 || photoStrategy !== "album_only");
  const mayQuote = (mode === "new" || mode === "reply") && (quoteTest || Math.random() < ({ rare: .1, normal: .32, often: .7 }[room?.quoteStyle || "normal"]));
  const quotedFan = quoteTest ? [...history].reverse().find(m => m.sender === "fan" && m.kind === "text" && m.original.trim()) : undefined;
  const profilePrompt = mode === "new" || mode === "reply" ? lysnAutonomousProfilePrompt(characterId) : null;
  const instruction: LLMMessage = { role: "system", content: [
    mode === "birthday" ? "你正在写一张仅当前订阅者能看到的 Bubble 生日卡片；这不是公开频道消息，也不进入聊天记录。按你的本来语言写祝福并附中文译文，不要声称知道订阅者真实身份或私下关系。" : "你正在 Lysn Bubble 面向全部订阅者的艺人频道发消息。回复是匿名粉丝反馈，不是与某个人的私聊。绝不识别发送者真实身份、推断私下关系或泄露秘密。",
    lysnPublicBoundary(characterId),
    mode === "new" || mode === "reply" ? lysnPublicContinuityPrompt(characterId) : "",
    `泡泡风格（仅本平台表达习惯）：${loadLysn().rooms[characterId]?.bubbleStyle||"按人设自然发挥"}`,
    "粉丝全是匿名的，不能识别当前user或照搬Chat关系；一对一男友感称呼不表示知道收件人身份。昵称用频道既有占位规则。可以自说自话、忽略来信、直接接匿名粉丝的话；例如：紧张？/替我紧张吗/我还没紧张，你怎么先紧张了。避免有人说、某位粉丝说这类播报。模拟粉丝措辞不等于user发言，不能成为user聊天或记忆。不要每轮回复当前来信。",
    "优先参考最新世界线进展、本人日历和近期WVS公开内容。已发新歌可连续几天换角度宣传；已公开节目可预告、打气、聊已公开幕后；未公开工作最多笼统卖关子，不泄露标题地点保密细节。不强迫每条谈工作，也可依人设突发聊吃饭运动上课休息。",
    (mode==="new"||mode==="reply")?`本人日程（限制优先于活跃度）：\n${calendar.summary||"当前无日程限制"}\n${calendar.level===2?"只能短暂回复，本轮最多一两句。":"空闲时按自己的来访、阅读习惯决定发不发。"}`:"历史开场白和生日内容只依据指定日期可知的事实，不借用当前日程。",
    "自然地按人设发短消息，不要总写公告。original 必须使用角色本人最自然的语言（例如人设为韩国人的角色主要用韩语，日本人的角色主要用日语）；translated 是忠实简体中文翻译，原文中文则相同。语音逐字稿也遵守这一要求，不能因为译文是中文就把原文改成中文。",
    "艺人可以使用 {{nickname}} 占位符自然称呼每位订阅者；系统会为每位订阅者替换，绝不能把某人的私密姓名写进面向全部粉丝的文本。",
    mode === "birthday" ? "生日留言写成适合卡片的一段话，可以亲切但不伪装你和这个订阅者私下相识。" : "这是面向大量订阅者的频道，不是一对一私聊。你发送的时间可以刚好和某位粉丝同步，甚至立刻再发好几条；但内容大多数时候应由自己的近况、思路、心情驱动，不默认承接刚收到的留言。看到留言也可以不答，偶尔精准回答才显得自然。可以引用你模拟的其他匿名粉丝留言；模拟粉丝不等于当前 User，不能混入其真实聊天或记忆。",
    mode === "opening" ? configuredOpener ? "这是本次订阅进入频道显示的开场白。用户提供了开场白内容：保持意思和语气，用角色本人自然的语言写 original；用户已用角色语言写成原文时保留原文措辞；translated 是忠实的简体中文翻译。只写一条，不要增添新信息。" : "这是本次订阅进入频道显示的开场白，写一条符合人设的开场消息。它不算正式到场或回复，也不要提及已经读到粉丝来信。" : "",
    mode === "opening" && historicalDate ? `这条开场白要放在订阅历史的 ${historicalDate}；不要把现实今天才发生的事情说成当年就发生，也不要声称已经认识当前订阅者。` : "",
    mode === "birthday" ? `这是订阅者 ${birthdayYear || "这一"} 年的生日卡片。只以当年为背景写符合人设的祝福，不提那一年之后才发生的事；可以使用 {{nickname}} 占位符；不要声称现实今天就是生日，用户可能在日历回看往年的卡片。` : "",
    mode === "reply" ? testMode ? "测试模式：明确让你发照片、发语音、引用时，优先按要求输出真实对应消息种类；照片可从相册或生图/文字照片中选择，不要只口头说发了。" : "拟真模式：你不一定看到了每一条匿名来信；可以完全没看到这条，接着上一段自己的话说，忽略它，或接另一位模拟粉丝的话，允许答非所问。看到来信也不一定回复；按自己的出现与看消息习惯行事。" : "",
    quoteTest && quotedFan ? `这轮粉丝明确要求测试引用。请引用这条已存在的匿名留言并自然回复，不要编造另一条替代：${quotedFan.original.slice(0, 300)}。只引用文字，不暴露发言者身份；本轮 publish=true，至少一条消息。` : mayQuote ? "如果自然合适，可以先模拟一条匿名粉丝留言并引用它，然后再作公开回复。quote 必须有 original 和 translated，两者分别是模拟留言原文和中文翻译。引用只存在于艺人消息里，不要把模拟留言当作用户发言。" : "这轮不要引用粉丝留言，也不要输出 quote。",
    profilePrompt || "这次不修改资料；即使对话提到了昵称或头像，也不要输出 profileUpdate。你可以自然问问大家的意见。",
    stickers.length ? `本聊天室可发送表情包的名称：${stickers.map(s => s.name).join("、")}。发送时 kind=sticker 且 stickerName 严格使用列表中某个名称，original 填该名称。` : "没有配置表情包，不要发送表情包。",
    photoChoices.length ? `这是已关联到你且可用的相册候选：${photoChoices.map(p => `${p.id}：${(p.generationPrompt || [p.subject, p.visionSummary, ...(p.visionTags || [])].filter(Boolean).join("、")).slice(0, 95) || "未填写内容"}`).join("；")}。画面符合时填写准确 photoId；否则填写具体 photoDescription 与 mediaIntent。缺图只发文字图片描述，等待用户手动生图。多张 photo 连排，说话另发 text。` : photoStrategy === "album_only" ? "没有可用相册照片，不能假装发了照片。" : "暂无可用相册照片，可发送文字图片描述，之后由用户手动决定是否生图。",
    photoRequest ? "匿名粉丝正在请求照片。你可以按人设决定发或不发；若明确说照片已经发出，必须输出 kind=photo 并填写画面描述，允许相册或生图。" : "",
    multiplePhotosRequested ? "若愿意发多张，连续输出 2 至 4 条不同画面的 photo，每张独立选择相册或生图，最后再用单独的 text 说话。" : "",
    voiceTest ? "测试模式：用户明确要求语音，本轮至少一条 kind=voice，original 是你本人的语言逐字稿。" : "",
    "只输出 JSON：{\"publish\":true/false,\"mediaReason\":\"真实视觉分享动机，无图留空\",\"messages\":[{\"kind\":\"text/photo/voice/sticker\",\"original\":\"...\",\"translated\":\"...\",\"quote\":{\"original\":\"...\",\"translated\":\"...\"},\"stickerName\":\"...\",\"photoId\":\"已关联相册照片ID\",\"photoDescription\":\"...\",\"mediaIntent\":\"selfie/portrait/group/food/scenery/object/pet/other\"}]}。无需 quote 时省略该字段。",
    mode === "opening" || mode === "birthday" || quoteTest && quotedFan || voiceTest || photoTest ? "publish 必须为 true，写至少一条消息。" : multiplePhotosRequested ? "可以决定 publish=false 且 messages=[]；如果发图，最多四张照片加一条文字，总共至多五条。" : "可以决定 publish=false 且 messages=[]，这表示艺人暂时没有公开消息。publish=true 时自然发一至三条。",
    "photo 必须填写照片描述，voice 的 original 是逐字稿。",
    `频道最近消息：\n${timeline || "暂无消息"}`,
    ...history.filter(message => message.sender === "artist" && message.photoStoryContext).slice(-3).map(message => photoStoryReplyContext(message.photoStoryContext, characterId)).filter(Boolean),
    fanMessage ? `频道粉丝留言样本（不代表一定被你看见或必须回应；众多留言之一）：${fanMessage}` : "",
    configuredOpener ? `用户设定的开场白内容（仅作开场白，不是粉丝来信）：${configuredOpener}` : "",
  ].filter(Boolean).join("\n") };
  const messages: LLMMessage[] = [...prompt, instruction, { role: "user", content: mode === "opening" ? configuredOpener ? "按用户设定内容，生成角色语言原文和简体中文译文的开场白。" : "生成一次性频道开场白。" : mode === "birthday" ? "今天生日，发送一条生日祝福。" : mode === "reply" ? "判断艺人此刻是否想在面向许多粉丝的频道发消息；如果想发，请优先按自己正在经历、想聊的事展开，不必回应任何一条最新来信。即便紧接着粉丝发送，也不意味着你读到了那句话。" : "判断艺人现在是否想公开发新消息。" }];
  const requestMeta = { characterName: `Lysn:${character.name}`, userName: "订阅粉丝" };
  const requestOptions = { appId: "lysn", translationCharacterId: characterId, appTags: ["lysn", "bubble"], skipOutputRegex: true, skipWorldline: Boolean(historicalDate)||mode==="birthday" };
  let raw = await sendLLMRequest(api, preset, messages, regexes, requestMeta, requestOptions);
  let data = parseJson(raw);
  const initialRows = Array.isArray(data.messages) ? data.messages as Record<string, unknown>[] : [];
  const initialPhotoRows = initialRows.filter(row => ["photo", "image", "picture", "照片", "图片", "사진"].includes(asText(row.kind).toLowerCase()));
  const missingPhotoTest = photoTest && !initialPhotoRows.length;
  const missingVoiceTest = voiceTest && !initialRows.some(row => asText(row.kind) === "voice");
  const tooFewPhotos = testMode && multiplePhotosRequested && initialPhotoRows.length > 0 && initialPhotoRows.length < 2;
  if (missingPhotoTest || missingVoiceTest || tooFewPhotos || quoteTest && quotedFan && (data.publish === false || !initialRows.length)) {
    const correction = missingPhotoTest ? "测试模式：这一轮请确实发一张 kind=photo，填写 photoDescription 与 mediaIntent；允许匹配相册或使用文字图片兜底，不能只口头声称发了。" : missingVoiceTest ? "测试模式：请确实输出至少一条 kind=voice，original 写逐字稿，不要只回复文字。" : tooFewPhotos ? "测试模式：这轮要求多张照片，输出 2 至 4 条不同内容的 kind=photo，每张分别填写 photoDescription 与 mediaIntent，说话另发 text；相册 ID 可按照片分别填写或留空。" : "测试模式：请引用最近这条已有的匿名留言并自然回复。";
    raw = await sendLLMRequest(api, preset, [...messages, { role: "assistant", content: raw }, { role: "user", content: correction }], regexes, requestMeta, requestOptions);
    data = parseJson(raw);
  }
  if (data.publish === false && mode !== "opening" && mode !== "birthday" && !(quoteTest && quotedFan) && !photoTest && !voiceTest) return [];
  const rows: GeneratedLysn[] = (Array.isArray(data.messages) ? data.messages : [data]).slice(0, multiplePhotosRequested ? 5 : 3).map((item, index) => {
    const row = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const rawKind = asText(row.kind);
    let kind: GeneratedLysn["kind"] = ["photo", "image", "picture", "照片", "图片", "사진"].includes(rawKind.toLowerCase()) ? "photo" : rawKind === "voice" || rawKind === "sticker" ? rawKind : "text";
    const sticker = kind === "sticker" ? stickers.find(s => s.name === asText(row.stickerName) || s.name === asText(row.original)) : undefined;
    if (kind === "sticker" && !sticker) kind = "text";
    const original = kind === "sticker" && sticker ? sticker.name : asText(row.original) || (kind === "photo" ? "照片" : "");
    const quoteData = mayQuote && row.quote && typeof row.quote === "object" ? row.quote as Record<string, unknown> : null;
    const quote = quoteTest && quotedFan ? index === 0 ? { original: quotedFan.original, translated: quotedFan.translated || quotedFan.original } : undefined : quoteData && asText(quoteData.original) ? { original: asText(quoteData.original), translated: asText(quoteData.translated) || asText(quoteData.original) } : undefined;
    const chosenPhotoId = photoChoices.some(p => p.id === asText(row.photoId)) ? asText(row.photoId) : undefined;
    if (kind === "text" && photoRequest && chosenPhotoId && claimsPhotoSent(original)) kind = "photo";
    return { kind, original, translated: asText(row.translated) || original, quote, stickerName: sticker?.name, photoId: chosenPhotoId, photoDescription: asText(row.photoDescription), mediaIntent: ["selfie", "portrait", "group", "food", "scenery", "object", "pet", "other"].includes(asText(row.mediaIntent)) ? asText(row.mediaIntent) as GeneratedLysn["mediaIntent"] : "other" } satisfies GeneratedLysn;
  }).filter(row => row.original);
  const mediaRows = rows.filter(row => row.kind !== "photo" || allowMediaIntent("lysn", characterId, row.photoDescription || row.original, String(data.mediaReason || ""), photoRequest));
  rows.splice(0, rows.length, ...mediaRows);
  if (mode === "new" || mode === "reply") recordMediaDecision("lysn", characterId, rows.some(row => row.kind === "photo"), rows.filter(row => row.kind === "photo").map(row => row.photoDescription || row.original).join(" "));
  if (photoRequest && rows.some(row => row.kind === "photo")) {
    const used = new Set<string>();
    const distinctPhotos = rows.filter(row => {
      if (row.kind !== "photo") return false;
      if (!row.photoId) return true;
      if (used.has(row.photoId)) return false;
      used.add(row.photoId);
      return true;
    });
    const others = rows.filter(row => row.kind !== "photo");
    rows.splice(0, rows.length, ...distinctPhotos, ...others);
  }
  if (photoRequest && photoChoices.length && rows.some(row => row.kind === "text" && claimsPhotoSent(row.original)) && !rows.some(row => row.kind === "photo")) throw new Error("艺人只描述了照片，没有真正发出图片；这次未发送虚假的照片消息，请重试。");
  if (quoteTest && quotedFan && rows.length && !rows.some(row => row.quote)) rows[0].quote = { original: quotedFan.original, translated: quotedFan.translated || quotedFan.original };
  if (!rows.length && (data.publish !== false || quoteTest && quotedFan)) throw new Error("Lysn 没有返回有效正文，请重试。");
  if (rows.length && profilePrompt && data.profileUpdate && typeof data.profileUpdate === "object") {
    const proposed = data.profileUpdate as Record<string, unknown>;
    const name = typeof proposed.name === "string" ? proposed.name.trim().slice(0, 40) : undefined;
    const avatarPhotoId = typeof proposed.avatarPhotoId === "string" ? proposed.avatarPhotoId.trim() : undefined;
    if (name || avatarPhotoId) rows[0].profileUpdate = { name, avatarPhotoId };
  }
  return rows;
}
