"use client";

import { useRef, useState } from "react";
import { isRingtoneSource, isLocalRingtone } from "@/lib/ringtone-source";

/** Stored data URLs survive reloads and travel with ordinary settings backups. */
export function AudioSourcePicker({ value, onChange, onNotice, label = "提示音", defaultHint = "恢复默认后静音。", defaultValue = "" }: {
  value: string; onChange: (value: string) => void; onNotice?: (text: string) => void; label?: string; defaultHint?: string; defaultValue?: string;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const local = isLocalRingtone(value);
  const isDefault = !!defaultValue && value === defaultValue;
  return <div style={{ display: "grid", gap: 10 }}>
    <label>{label} URL<input type="url" aria-label={`${label} URL`} value={local || isDefault ? "" : value} placeholder={isDefault ? "使用内置默认音效" : local ? "已保存本地音频；填网址可替换" : "https://.../sound.mp3"} onChange={event => onChange(event.target.value)} /></label>
    <input ref={fileInput} type="file" accept="audio/*,.mp3" hidden onChange={event => {
      const file = event.target.files?.[0]; event.target.value = "";
      if (!file) return;
      if (!file.type.startsWith("audio/") && !/\.mp3$/i.test(file.name)) return onNotice?.("请选择 MP3 或其他音频文件");
      if (file.size > 10 * 1024 * 1024) return onNotice?.("音频请控制在 10 MB 以内");
      setUploading(true);
      const reader = new FileReader();
      reader.onerror = () => { setUploading(false); onNotice?.("音频读取失败，请重试"); };
      reader.onload = () => {
        setUploading(false);
        const data = String(reader.result || "");
        // Some file pickers omit the MIME type for MP3s.
        const source = /\.mp3$/i.test(file.name) ? `data:audio/mpeg;base64,${data.slice(data.indexOf(",")+1)}` : data;
        if (!isRingtoneSource(source)) return onNotice?.("无法识别音频格式");
        onChange(source); onNotice?.("音频已选好，可在下方试听");
      };
      reader.readAsDataURL(file);
    }} />
    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      <button type="button" disabled={uploading} onClick={() => fileInput.current?.click()}>{uploading ? "正在读取…" : local ? "替换本地音频" : "上传 MP3"}</button>
      <button type="button" disabled={(!value || isDefault) || uploading} onClick={() => onChange(defaultValue)}>恢复默认</button>
      {local && <small>本地音频已保存</small>}
    </div>
    {isRingtoneSource(value) && <audio key={value} src={value} controls preload="none" aria-label={`${label}试听`} style={{ width: "100%", maxWidth: "100%", height: 36 }} />}
    <small>{defaultHint}</small>
  </div>;
}
