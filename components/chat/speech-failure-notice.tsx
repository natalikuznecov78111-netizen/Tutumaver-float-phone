'use client';
import { useCallback, useState } from 'react';
import './speech-failure-notice.css';

type SpeechFailure = { label: string; reason: string; retry: () => void };

export function useSpeechFailure() {
    const [speechFailure, setFailure] = useState<SpeechFailure | null>(null);
    const clearSpeechFailure = useCallback(() => setFailure(null), []);
    const reportSpeechFailure = useCallback((stage: 'synthesis' | 'playback', error: unknown, retry: () => void) => {
        setFailure({ label: stage === 'synthesis' ? '语音合成失败' : '语音播放失败', reason: error instanceof Error ? error.message : '请重试', retry });
    }, []);
    return { speechFailure, clearSpeechFailure, reportSpeechFailure };
}

export function SpeechFailureNotice({ failure, onClose, busy = false }: { failure: SpeechFailure | null; onClose: () => void; busy?: boolean }) {
    if (!failure) return null;
    return <div className="speech-failure-notice" role="alert" title={failure.reason}>
        <span>{failure.label}</span>
        <button type="button" disabled={busy} onClick={() => { onClose(); failure.retry(); }}>重试</button>
        <button type="button" aria-label="关闭语音错误提示" onClick={onClose}>×</button>
    </div>;
}
