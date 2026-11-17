import { loadPhoneLock, type PhoneLockConfig } from './phone-lock';
import { getChatImageFromIndexedDB } from './chat-asset-storage';

export type PreparedPhoneLock = { config: PhoneLockConfig; wallpaper: string };

// Call after KV hydration, before mounting the desktop or its lock screen.
export async function preparePhoneLockForFirstPaint(): Promise<PreparedPhoneLock> {
    const config = loadPhoneLock();
    if (!config.enabled) return { config, wallpaper: '' };

    let wallpaper = '';
    try {
        const ref = config.wallpaper;
        wallpaper = /^(data:|https?:|blob:)/.test(ref)
            ? ref
            : ref ? await getChatImageFromIndexedDB(ref) || '' : '';
        if (wallpaper) {
            const image = new Image();
            const loaded = new Promise<void>((resolve, reject) => {
                image.onload = () => resolve();
                image.onerror = () => reject(new Error('Lock wallpaper unavailable'));
            });
            image.src = wallpaper;
            await loaded;
            if (typeof image.decode === 'function') await image.decode();
        }
    } catch (error) {
        console.warn('[PhoneLock] wallpaper preload failed:', error);
        wallpaper = '';
    }

    // The clock has its own bundled font; uploaded app fonts do not affect it.
    if (typeof document !== 'undefined' && document.fonts) {
        await document.fonts.load('300 120px PhoneLockClock', '0123456789:').catch(() => []);
    }
    return { config, wallpaper };
}
