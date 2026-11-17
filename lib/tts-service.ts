import { fetchAndroidTts, usesAndroidTtsTransport } from "./android-tts";
import { loadChatAppSettings } from "./chat-storage";
// lib/tts-service.ts — 语音合成服务

import type { VoiceApiConfig, ContentAppId } from "./settings-types";
import { loadVoiceConfigs, loadBindingConfig, resolveBinding } from "./settings-storage";

export function resolveUserVoiceConfig(): VoiceApiConfig | null {
    const id = loadChatAppSettings().globalUserVoiceConfigId;
    return id ? loadVoiceConfigs().find(c => c.id === id) || null : null;
}

export type VoiceApiConfigResolved = VoiceApiConfig;

/**
 * Resolve the TTS voice config for a character via the binding cascade.
 * Returns null if no voice config is bound or found.
 */
export function resolveVoiceConfig(characterId: string, appId?: ContentAppId): VoiceApiConfig | null {
    const bindings = loadBindingConfig();
    const slot = resolveBinding(bindings, characterId, appId ?? "chat");
    if (!slot.voiceConfigId) return null;

    const configs = loadVoiceConfigs();
    return configs.find(c => c.id === slot.voiceConfigId) || null;
}

/**
 * Synthesize speech from text using the given voice config.
 * Returns an audio Blob (mp3/wav) or null if synthesis failed.
 *
 * Supported providers:
 * - Minimax: REST API → hex-encoded mp3
 * - OpenAI: REST API → binary audio blob
 * - Fish Audio: REST API → binary mp3 blob
 * - ElevenLabs: REST API → binary mp3 blob
 */
export async function synthesizeSpeech(
    text: string,
    voiceConfig: VoiceApiConfig,
    options?: { emotion?: string },
): Promise<Blob | null> {
    if (!text.trim()) return null;

    const provider = voiceConfig.provider;

    if (provider === "Minimax") {
        return synthesizeMinimax(text, voiceConfig, options?.emotion);
    }

    if (provider === "OpenAI") {
        return synthesizeOpenAI(text, voiceConfig);
    }

    if (provider === "FishAudio") {
        return synthesizeFishAudio(text, voiceConfig);
    }

    if (provider === "ElevenLabs") {
        return synthesizeElevenLabs(text, voiceConfig);
    }

    return null;
}

// A stalled TTS request (TCP connected but no response — cold start, rate-limit
// hold, network blip) would otherwise hang forever, since fetch has no default
// timeout. That froze voice/video calls at "对方正在说话..." until the user
// toggled the mic. Abort after a ceiling so the caller can recover.
const TTS_TIMEOUT_MS = 120_000;

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = TTS_TIMEOUT_MS, androidDirect = false): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const request = { ...init, signal: controller.signal };
        return await (androidDirect ? fetchAndroidTts(url, request) : fetch(url, request));
    } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") {
            throw new Error(`语音合成超时（超过 ${Math.round(timeoutMs / 1000)} 秒无响应）`);
        }
        throw e;
    } finally {
        clearTimeout(timer);
    }
}

// ── Minimax TTS ─────────────────────────────────────

// MiniMax voice_setting.emotion 支持的取值（speech-01-turbo/hd、speech-02-turbo/hd 等）。
const MINIMAX_EMOTIONS = new Set([
    "happy", "sad", "angry", "fearful", "disgusted", "surprised", "calm", "neutral", "fluent",
]);

const MINIMAX_SPEED_MIN = 0.5;
const MINIMAX_SPEED_MAX = 2.0;
const MINIMAX_PITCH_MIN = -12;
const MINIMAX_PITCH_MAX = 12;

function normalizeMinimaxSpeed(speed: number | undefined): number {
    if (typeof speed !== "number" || !Number.isFinite(speed)) return 1.0;
    return Math.min(MINIMAX_SPEED_MAX, Math.max(MINIMAX_SPEED_MIN, speed));
}

function normalizeMinimaxPitch(pitch: number | undefined): number {
    if (typeof pitch !== "number" || !Number.isFinite(pitch)) return 0;
    return Math.min(MINIMAX_PITCH_MAX, Math.max(MINIMAX_PITCH_MIN, Math.round(pitch)));
}

async function synthesizeMinimax(text: string, config: VoiceApiConfig, emotion?: string): Promise<Blob | null> {
    if (!config.apiKey) throw new Error("Minimax API Key 未配置");

    const baseUrl = (config.baseUrl || "https://api.minimaxi.com/v1").replace(/\/$/, "");
    const voiceSetting: Record<string, unknown> = {
        voice_id: config.defaultVoice || "male-qn-qingse",
        speed: normalizeMinimaxSpeed(config.speechSpeed),
        vol: 1.0,
        pitch: normalizeMinimaxPitch(config.speechPitch),
    };
    const normalizedEmotion = emotion?.trim().toLowerCase();
    if (normalizedEmotion && MINIMAX_EMOTIONS.has(normalizedEmotion)) {
        voiceSetting.emotion = normalizedEmotion;
    }

    const response = await fetchWithTimeout(`${baseUrl}/t2a_v2`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${config.apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model: config.model || "speech-01-turbo",
            text,
            stream: false,
            output_format: "hex",
            ...(config.languageBoost ? { language_boost: config.languageBoost } : {}),
            voice_setting: voiceSetting,
            // 44100/256k 是 Minimax 支持的最高档;之前 32000/128k 会把 hd 模型
            // 的输出压闷(用户反馈"声音糊"),各模型均支持该档位。
            audio_setting: {
                sample_rate: 44100,
                bitrate: 256000,
                format: "mp3",
                channel: 1,
            },
        }),
    });

    if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.base_resp?.status_msg || `Minimax API 请求失败 (${response.status})`);
    }

    const data = await response.json();
    const code = data.base_resp?.status_code;
    if (code !== undefined && Number(code) !== 0) {
        throw new Error(`MiniMax 合成失败（${code}）：${data.base_resp?.status_msg || '未知错误'}`);
    }
    const audio = data.data?.audio;
    if (typeof audio !== 'string' || !audio.trim()) {
        throw new Error(data.base_resp?.status_msg && data.base_resp.status_msg !== 'success' ? data.base_resp.status_msg : 'MiniMax 未返回音频数据');
    }
    // Some compatible endpoints return a download URL even when hex was requested.
    if (/^https?:\/\//i.test(audio)) {
        const download = await fetchWithTimeout(audio, { credentials: 'omit' });
        if (!download.ok) throw new Error(`MiniMax 音频下载失败（${download.status}）`);
        const blob = await download.blob();
        if (!blob.size || /json|text\//i.test(blob.type)) throw new Error('MiniMax 返回的链接不是有效音频');
        return blob.type ? blob : new Blob([blob], { type: 'audio/mpeg' });
    }
    const hex = audio.replace(/\s/g, '');
    if (!hex.length || hex.length % 2 || !/^[0-9a-f]+$/i.test(hex)) {
        throw new Error('MiniMax 返回的音频编码无效，请重试');
    }
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
    return new Blob([bytes], { type: 'audio/mpeg' });
}

// ── Fish Audio TTS ───────────────────────────────────

async function synthesizeFishAudio(text: string, config: VoiceApiConfig): Promise<Blob | null> {
    if (!config.apiKey) throw new Error("Fish Audio API Key 未配置");

    const baseUrl = (config.baseUrl || "https://api.fish.audio/v1").replace(/\/+$/, "");
    const voiceId = (config.defaultVoice || "").trim();
    const model = (config.model || "s2.1-pro-free").trim();
    const isOfficialFishApi = /^https:\/\/api\.fish\.audio\/v1$/i.test(baseUrl);

    // Fish Audio's cloud endpoint is intended for server-side API calls. Calling it
    // directly from the browser can fail at the CORS/preflight layer before Fish
    // returns an HTTP status at all (surfacing only as `Failed to fetch`). Route the
    // official endpoint through our same-origin Next API proxy so browser CORS never
    // enters the path. Android uses its native HTTP transport directly, without this proxy.
    // A custom Base URL is still called directly, which keeps support
    // for user-owned reverse proxies that explicitly enable browser CORS.
    const response = isOfficialFishApi && !usesAndroidTtsTransport()
        ? await fetchWithTimeout("/api/voice/fish-tts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                apiKey: config.apiKey,
                model,
                voiceId,
                text,
            }),
        })
        : await fetchWithTimeout(`${baseUrl}/tts`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${config.apiKey}`,
                "Content-Type": "application/json",
                model,
            },
            body: JSON.stringify({
                text,
                format: "mp3",
                ...(voiceId ? { reference_id: voiceId } : {}),
            }),
        }, TTS_TIMEOUT_MS, usesAndroidTtsTransport()).catch((error: unknown) => {
            if (error instanceof TypeError && !usesAndroidTtsTransport()) {
                throw new Error("Fish Audio 自定义 Base URL 无法从浏览器访问（可能被 CORS 或网络策略拦截）；请使用默认官方 Base URL，或使用已开启 CORS 的自有反代。");
            }
            throw error;
        });

    if (!response.ok) {
        const contentType = response.headers.get("content-type") || "";
        let detail = "";
        if (contentType.includes("application/json")) {
            const data = await response.json().catch(() => null) as { message?: unknown; error?: unknown } | null;
            detail = String(data?.message || data?.error || "").trim();
        } else {
            detail = (await response.text().catch(() => "")).trim();
        }
        throw new Error(`Fish Audio TTS 请求失败 (${response.status})${detail ? `: ${detail}` : ""}`);
    }

    const blob = await response.blob();
    return new Blob([await blob.arrayBuffer()], { type: blob.type || "audio/mpeg" });
}

// ── ElevenLabs TTS ──────────────────────────────────

async function synthesizeElevenLabs(text: string, config: VoiceApiConfig): Promise<Blob> {
    const apiKey = config.apiKey.trim();
    const voiceId = (config.defaultVoice || "").trim();
    if (!apiKey) throw new Error("ElevenLabs API Key 未配置");
    if (!voiceId) throw new Error("请先填写 ElevenLabs Voice ID");

    const baseUrl = (config.baseUrl?.trim() || "https://api.elevenlabs.io/v1").replace(/\/+$/, "");
    const model = config.model?.trim() || "eleven_multilingual_v2";
    const response = /^https:\/\/api\.elevenlabs\.io\/v1$/i.test(baseUrl) && !usesAndroidTtsTransport()
        ? await fetchWithTimeout("/api/voice/elevenlabs-tts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ apiKey, voiceId, model, text }),
        })
        : await fetchWithTimeout(`${baseUrl}/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
            method: "POST",
            headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
            body: JSON.stringify({ text, model_id: model }),
        }, TTS_TIMEOUT_MS, usesAndroidTtsTransport()).catch((error: unknown) => {
            if (error instanceof TypeError && !usesAndroidTtsTransport()) {
                throw new Error("ElevenLabs 自定义 Base URL 无法从浏览器访问；请使用默认官方地址，或使用已开启 CORS 的自有反代。");
            }
            throw error;
        });

    if (!response.ok) {
        const raw = await response.text().catch(() => "");
        let detail = raw;
        try {
            const data = JSON.parse(raw);
            const message = data?.message || data?.detail?.message || data?.detail || data?.error;
            detail = typeof message === "string" ? message : message ? JSON.stringify(message) : raw;
        } catch { /* 非 JSON 错误保留原文 */ }
        throw new Error(`ElevenLabs TTS 请求失败 (${response.status})${detail ? `: ${detail.slice(0, 1200)}` : ""}`);
    }

    const blob = await response.blob();
    if (!blob.size) throw new Error("ElevenLabs 未返回音频数据");
    return new Blob([await blob.arrayBuffer()], { type: blob.type || "audio/mpeg" });
}

// ── OpenAI TTS ──────────────────────────────────────

async function synthesizeOpenAI(text: string, config: VoiceApiConfig): Promise<Blob | null> {
    if (!config.apiKey) throw new Error("OpenAI API Key 未配置");

    const baseUrl = config.baseUrl || "https://api.openai.com/v1";
    const response = await fetchWithTimeout(`${baseUrl.replace(/\/$/, "")}/audio/speech`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${config.apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model: config.model || "tts-1",
            input: text,
            voice: config.defaultVoice || "alloy",
            response_format: "mp3",
            ...(typeof config.speechSpeed === "number" && Number.isFinite(config.speechSpeed)
                ? { speed: Math.min(2, Math.max(0.5, config.speechSpeed)) }
                : {}),
        }),
    });

    if (!response.ok) {
        const errText = await response.text().catch(() => "");
        throw new Error(`OpenAI TTS 请求失败 (${response.status}): ${errText}`);
    }

    const blob = await response.blob();
    return new Blob([await blob.arrayBuffer()], { type: "audio/mpeg" });
}

// ── iOS audio playback that coexists with speech recognition ──────────
// On iOS Safari, playing TTS through an <audio> element keeps the system audio
// session in "playback" mode, which steals the mic from webkitSpeechRecognition
// and stops it from restarting on the next turn (calls go silent after one
// round). To keep hands-free multi-turn working we play through a Web Audio
// AudioContext and explicitly suspend() it after each clip so iOS hands the
// audio session back to the microphone. A shared <audio> element is kept as a
// fallback for browsers without AudioContext.

let _audioCtx: AudioContext | null = null;
let _sharedAudio: HTMLAudioElement | null = null;
let _audioUnlocked = false;
let _unlockListenerInstalled = false;

// ── In-app TTS volume (0..1) ──
// iOS plays Web Audio on the ringer/voice stream, so the hardware volume keys
// don't control character speech. This in-app gain does. Synced to localStorage.
const TTS_VOLUME_KEY = "ai_phone_tts_volume_v1";
let _ttsVolume = ((): number => {
    if (typeof window === "undefined") return 1;
    try {
        const raw = window.localStorage.getItem(TTS_VOLUME_KEY);
        const v = raw == null ? 1 : Number(raw);
        return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
    } catch { return 1; }
})();
// Live gain node of the currently-playing AudioContext clip, so the slider can
// adjust volume mid-sentence.
let _activeGain: GainNode | null = null;

export function getTtsVolume(): number {
    return _ttsVolume;
}

export function setTtsVolume(volume: number): void {
    _ttsVolume = Math.min(1, Math.max(0, volume));
    try { window.localStorage.setItem(TTS_VOLUME_KEY, String(_ttsVolume)); } catch { /* ignore */ }
    if (_activeGain) { try { _activeGain.gain.value = _ttsVolume; } catch { /* ignore */ } }
    if (_sharedAudio) { try { _sharedAudio.volume = _ttsVolume; } catch { /* ignore */ } }
}

// ── 通话音频会话开关 ──
// 只有通话界面在场时才让 Web Audio 上下文保持 running。此前全局点击解锁会把
// 上下文永久 resume，页面从第一次点击起就一直持有系统音频会话；叠加通话退出
// 后识别泄漏，整页音频会被钉在"通话模式"（语音条/试听音量巨大且音量键失灵）。
let _callAudioSessionActive = false;
export function isCallAudioSessionActive(){return _callAudioSessionActive;}

/** 通话界面挂载时置 true、卸载/挂断时置 false（false 时立即挂起空闲的上下文）。 */
export function setCallAudioSessionActive(active: boolean): void {
    _callAudioSessionActive = active;
    if (!active && _audioCtx && !_activeGain) {
        try { void _audioCtx.suspend(); } catch { /* ignore */ }
    }
}

function getAudioContext(): AudioContext | null {
    if (typeof window === "undefined") return null;
    const Ctor = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctor) return null;
    if (!_audioCtx) {
        // 不要钉 sampleRate:部分 iOS 版本上非硬件采样率的 ctx 会"时钟照走、
        // 输出全静音"(比闷更糟)。防发闷靠 TTS 请求参数(44100/256k)兜底。
        try { _audioCtx = new Ctor(); } catch { return null; }
    }
    return _audioCtx;
}

function getSharedAudio(): HTMLAudioElement {
    if (!_sharedAudio) {
        _sharedAudio = new Audio();
        _sharedAudio.setAttribute("playsinline", "");
    }
    return _sharedAudio;
}

function silentWavUrl(): string {
    // A few ms of 16-bit mono PCM silence — a valid source so play() actually
    // starts (and thus unlocks the element) on iOS.
    // 采样率用 48kHz 而不是 8kHz：iOS 的系统音频会话采样率会跟着刚播放的媒体走，
    // 解锁音若是 8kHz，紧接着播的 TTS 会被压到 4kHz 以下而发闷（与保活音同理）。
    const sampleRate = 48000;
    const numSamples = 96; // 2ms
    const dataSize = numSamples * 2;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);
    const writeStr = (off: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
    writeStr(0, "RIFF"); view.setUint32(4, 36 + dataSize, true); writeStr(8, "WAVE");
    writeStr(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
    view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    writeStr(36, "data"); view.setUint32(40, dataSize, true);
    // 16-bit PCM 静音为 0，ArrayBuffer 默认全 0，无需再写
    return URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
}

/** Prime the exact element that will play a newly synthesized chat message. */
export function primeSpeechAudioElement(audio: HTMLAudioElement): void {
    const url = silentWavUrl();
    audio.setAttribute('playsinline', '');
    audio.muted = false;
    audio.src = url;
    try { void audio.play().catch(() => {}).finally(() => URL.revokeObjectURL(url)); }
    catch { URL.revokeObjectURL(url); }
}

export function speechPlaybackError(error?: unknown): Error {
    if (error instanceof Error && error.name === 'NotAllowedError') return new Error('播放被浏览器拦截，请点击重试');
    return new Error('音频播放失败，请检查音量或音频格式后重试');
}

/**
 * Unlock audio playback. Must run inside (or synchronously from) a user gesture.
 * Resumes the AudioContext (primary path) and unlocks the <audio> fallback.
 * Safe to call repeatedly.
 */
export function unlockAudioPlayback(): void {
    if (typeof window === "undefined") return;

    // Primary path: resume the Web Audio context within the gesture. Once
    // resumed under a gesture, subsequent programmatic resume()s are allowed.
    // 非通话期只借这次手势拿"授权"，随即挂起——不让页面平时一直持有音频会话。
    const ctx = getAudioContext();
    if (ctx && ctx.state === "suspended") {
        const keepRunning = _callAudioSessionActive;
        ctx.resume().then(() => {
            if (!keepRunning && !_activeGain && !_callAudioSessionActive) {
                try { void ctx.suspend(); } catch { /* ignore */ }
            }
        }).catch(() => {});
    }

    // Fallback path: unlock the shared <audio> element once.
    if (_audioUnlocked) return;
    const audio = getSharedAudio();
    const url = silentWavUrl();
    audio.muted = true;
    audio.src = url;
    const finish = () => {
        try { audio.pause(); audio.currentTime = 0; } catch {}
        audio.muted = false;
        URL.revokeObjectURL(url);
        _audioUnlocked = true;
    };
    try {
        const p = audio.play();
        if (p && typeof p.then === "function") {
            p.then(finish).catch(() => { audio.muted = false; URL.revokeObjectURL(url); });
        } else {
            finish();
        }
    } catch {
        audio.muted = false;
        URL.revokeObjectURL(url);
    }
}

function installUnlockListener(): void {
    if (_unlockListenerInstalled || typeof window === "undefined") return;
    _unlockListenerInstalled = true;
    const handler = () => { unlockAudioPlayback(); };
    window.addEventListener("touchend", handler, { passive: true });
    window.addEventListener("pointerdown", handler, { passive: true });
    window.addEventListener("mousedown", handler, { passive: true });
}

// Install the first-gesture unlock as soon as this module loads on the client.
// The call screens import this module statically (via chat-room), so the
// listener is in place well before the user taps the call button.
if (typeof window !== "undefined") installUnlockListener();

function decodeAudio(ctx: AudioContext, data: ArrayBuffer): Promise<AudioBuffer> {
    // Support both the promise and legacy callback forms (older webkitAudioContext).
    return new Promise((resolve, reject) => {
        const ret = ctx.decodeAudioData(data, resolve, reject);
        if (ret && typeof (ret as Promise<AudioBuffer>).then === "function") {
            (ret as Promise<AudioBuffer>).then(resolve, reject);
        }
    });
}

/**
 * Playback via a shared <audio> element. Used as the fallback when AudioContext
 * is unavailable, and as the PRIMARY path for gesture-less auto-play scenarios
 * (e.g. VN/漫卷 auto voice): a media element that was unlocked once keeps playing
 * programmatically, whereas resuming a suspended AudioContext far from any user
 * gesture is often rejected on Android Chrome/Edge (the "only plays with WeChat
 * keep-alive on" bug — the keep-alive's looping silent <audio> was what kept the
 * context alive). Bonus: media-element playback also obeys hardware volume keys.
 */
export function playAudioBlobViaMediaElement(blob: Blob, onStart?: () => void, reportErrors = false): { promise: Promise<void>; abort: () => void } {
    return playAudioBlobElement(blob, onStart, reportErrors);
}

function playAudioBlobElement(blob: Blob, onStart?: () => void, reportErrors = false): { promise: Promise<void>; abort: () => void } {
    const url = URL.createObjectURL(blob);
    const audio = getSharedAudio();
    audio.muted = false;
    audio.volume = _ttsVolume;
    audio.src = url;

    let settled = false;
    let resolveFn: () => void = () => {};
    let rejectFn: (error: Error) => void = () => {};
    const finalize = (error?: Error) => {
        if (settled) return;
        settled = true;
        audio.onended = null;
        audio.onerror = null;
        URL.revokeObjectURL(url);
        try { audio.pause(); audio.removeAttribute("src"); audio.load(); } catch {}
        if (error && reportErrors) rejectFn(error); else resolveFn();
    };
    const promise = new Promise<void>((resolve, reject) => {
        resolveFn = resolve;
        rejectFn = reject;
        audio.onended = () => finalize();
        audio.onerror = () => finalize(speechPlaybackError());
        audio.play().then(() => { if (!settled) onStart?.(); }).catch((error) => {
            finalize(speechPlaybackError(error));
        });
    });
    return { promise, abort: () => finalize() };
}

/**
 * Play an audio blob through the Web Audio context and resolve when playback
 * ends. After playback the context is suspended so iOS releases the audio
 * session back to the microphone (lets SpeechRecognition restart next turn).
 * Returns an abort function to stop playback early. Playback is sequential.
 */
export function playAudioBlob(blob: Blob, onStart?: () => void, reportErrors = false): { promise: Promise<void>; abort: () => void } {
    const ctx = getAudioContext();
    if (!ctx) return playAudioBlobElement(blob, onStart, reportErrors);

    let settled = false;
    let resolveFn: () => void = () => {};
    let rejectFn: (error: Error) => void = () => {};
    let source: AudioBufferSourceNode | null = null;

    let gain: GainNode | null = null;
    let fallbackAbort: (() => void) | null = null;

    const cleanupWebAudio = () => {
        if (source) {
            source.onended = null;
            try { source.stop(); } catch {}
            try { source.disconnect(); } catch {}
            source = null;
        }
        if (gain) { try { gain.disconnect(); } catch {} }
        if (_activeGain === gain) _activeGain = null;
        gain = null;
        // Suspend so iOS hands the audio session back to the microphone.
        try { ctx.suspend(); } catch {}
    };

    const finalize = () => {
        if (settled) return;
        settled = true;
        cleanupWebAudio();
        if (fallbackAbort) { fallbackAbort(); fallbackAbort = null; }
        resolveFn();
    };

    const promise = new Promise<void>((resolve, reject) => {
        resolveFn = resolve;
        rejectFn = reject;
        (async () => {
            try {
                if (ctx.state === "suspended") {
                    // 程序化 resume 在部分安卓浏览器上会被拒绝，甚至让 promise 永远
                    // 悬着（要等下一次用户手势）。限时等待后检查状态，走不通就回落。
                    await Promise.race([
                        ctx.resume().catch(() => {}),
                        new Promise(r => setTimeout(r, 800)),
                    ]);
                }
                if (ctx.state !== "running") throw new Error("audio_context_not_running");
                const audioBuffer = await decodeAudio(ctx, await blob.arrayBuffer());
                if (settled) return;
                source = ctx.createBufferSource();
                source.buffer = audioBuffer;
                // Route through a gain node so the in-app volume slider applies.
                gain = ctx.createGain();
                gain.gain.value = _ttsVolume;
                source.connect(gain);
                gain.connect(ctx.destination);
                _activeGain = gain;
                source.onended = finalize;
                source.start();
                onStart?.();
            } catch {
                // Web Audio 走不通（resume 被拒/解码失败等）时回落媒体元素播放：
                // 宁可这一段绕过「iOS 归还麦克风」的优化，也不要静默无声——
                // 此前这里直接 finalize，正是「语音条有声、通话没声」的来源之一。
                if (settled) return;
                cleanupWebAudio();
                const fallback = playAudioBlobElement(blob, onStart, reportErrors);
                fallbackAbort = fallback.abort;
                void fallback.promise.then(() => {
                    if (settled) return;
                    settled = true;
                    fallbackAbort = null;
                    resolveFn();
                }, error => {
                    if (settled) return;
                    settled = true; fallbackAbort = null; rejectFn(error);
                });
            }
        })();
    });

    return { promise, abort: finalize };
}

export async function selectCallAudioOutput(): Promise<string> {
    const devices = navigator.mediaDevices as MediaDevices & { selectAudioOutput?: () => Promise<MediaDeviceInfo> };
    if (!devices?.selectAudioOutput) throw new Error("此浏览器的播放设备由系统控制，请从系统音频菜单选择耳机或扬声器");
    const output = await devices.selectAudioOutput();
    const audio = getSharedAudio() as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
    if (!audio.setSinkId) throw new Error("此浏览器暂不支持网页切换播放设备，请使用系统音频菜单");
    const ctx = _audioCtx as (AudioContext & { setSinkId?: (id: string) => Promise<void> }) | null;
    // iOS/Web Audio must support the same output route before reporting a successful switch.
    if (typeof navigator !== "undefined" && /iPad|iPhone|iPod/.test(navigator.userAgent) && !ctx?.setSinkId) throw new Error("请从系统音频菜单选择播放设备");
    await audio.setSinkId(output.deviceId);
    if (ctx?.setSinkId) await ctx.setSinkId(output.deviceId);
    return output.label || "已选设备";
}
