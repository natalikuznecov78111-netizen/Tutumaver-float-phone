'use client';
import { useEffect, useState, useId } from 'react';
import { hashPhonePin, loadPhoneLock, formatPhoneLockDate } from '@/lib/phone-lock';
import './phone-lock.css';
export function PhoneLockScreen({ ready, wallpaper = '', onEnter }: {
    ready: boolean;
    wallpaper?: string;
    onEnter: () => void;
}) {
    const [clock, setClock] = useState<Date | null>(null), [pin, setPin] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
    const config = ready ? loadPhoneLock() : null;
    const glassId="phone-clock-"+useId().replace(/[^a-zA-Z0-9_-]/g,"");
    const clockText=(clock ? `${String(clock.getHours()).padStart(2, '0')}:${String(clock.getMinutes()).padStart(2, '0')}` : null)||"--:--";
    useEffect(() => { setClock(new Date()); const t = setInterval(() => setClock(new Date()), 1000); return () => clearInterval(t); }, []);
    async function digit(d: string) { if (!ready || busy || !config?.pinHash)
        return; const next = (pin + d).slice(0, config.pinLength); setPin(next); setError(''); if (next.length === config.pinLength) {
        setBusy(true);
        try {
            if (await hashPhonePin(next) === config.pinHash)
                onEnter();
            else {
                setPin('');
                setError('密码不正确，请重试');
            }
        }
        finally {
            setBusy(false);
        }
    } }
    if (!ready || !config?.enabled) return null;
    return <div className="phone-lock" style={wallpaper ? { backgroundImage: `linear-gradient(#0002,#0005),url("${wallpaper}")` } : undefined}>
 <div className="phone-lock-clock"><div className="phone-lock-date">{clock?formatPhoneLockDate(clock):' '}</div><time aria-label={clockText}><svg viewBox="0 0 360 225" role="img" aria-label={clockText}><defs><linearGradient id={glassId} x1="0" y1="0" x2="0.85" y2="1"><stop offset="0%" stopColor="#ffffff" stopOpacity=".93"/><stop offset="23%" stopColor="#ffffff" stopOpacity=".5"/><stop offset="48%" stopColor="#d8e5ef" stopOpacity=".19"/><stop offset="72%" stopColor="#ffffff" stopOpacity=".3"/><stop offset="100%" stopColor="#f2f7ff" stopOpacity=".76"/></linearGradient><linearGradient id={glassId+'-edge'} x1="0" y1="0" x2="1" y2="1"><stop stopColor="#fff" stopOpacity=".95"/><stop offset=".45" stopColor="#fff" stopOpacity=".13"/><stop offset="1" stopColor="#e8f2ff" stopOpacity=".7"/></linearGradient></defs>{Array.from(clockText, (digit, index) => <text key={index} x={[42, 118, 180, 242, 318][index]} y="122" transform="scale(1 1.65)" textAnchor="middle" fill={`url(#${glassId})`} stroke={`url(#${glassId}-edge)`} strokeWidth=".8">{digit}</text>)}</svg></time></div>
 <section className="phone-lock-auth" aria-label="解锁">
 <div className="phone-lock-title">{!ready ? '正在读取本机数据…' : config?.pinHash ? '输入密码' : '轻触进入'}</div>
 {config?.pinHash ? <><div className="phone-lock-dots" aria-label={`已输入 ${pin.length} 位密码`}>{Array.from({ length: config.pinLength }, (_, i) => <span key={i} data-filled={i < pin.length}/>)}</div><div className="phone-lock-error" role="status">{error}</div><div className="phone-lock-keys">{'1234567890'.split('').map(d => <button key={d} disabled={busy} onClick={() => void digit(d)}>{d}</button>)}</div></> : <button className="phone-lock-enter" disabled={!ready} onClick={onEnter}>进入</button>}
 </section><div className="phone-lock-bottom"><button disabled={!ready} onClick={onEnter}>紧急情况</button><button disabled={!ready || busy} onClick={() => { setPin(p => p.slice(0, -1)); setError(''); }}>取消</button></div></div>;
}
