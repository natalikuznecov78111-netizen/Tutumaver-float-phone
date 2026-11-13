"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { splitBilingualText } from "@/lib/bilingual-text";
import { Call039LineView, VIDEO_LONG_PRESS_OPTIONS, type Call039Line } from "./call039-shared-ui";
import {
  ChatContextMenuSurface,
  ChatContextMenuRow,
  ChatContextMenuButton,
} from "./chat-context-menu-surface";

export type Call039Command = "favorite" | "reroll-batch" | "reroll-after" | "delete" | "delete-after";

type Bounds = { left: number; top: number; right: number; bottom: number };
type MenuAnchor = { x: number; y: number; bounds: Bounds };

/**
 * Transcript uses Chat's actual online message context-menu surface/buttons.
 * Only the set of actions differs. The popup portals to <body>, so the call's
 * scrolling, fading and backdrop layers cannot clip or blur it.
 */
export function Call039Transcript({
  lines, showSpeaker = false, playingId = null, onPlay, onEdit, onCommand,
}: {
  lines: Call039Line[];
  showSpeaker?: boolean;
  playingId?: string | null;
  onPlay: (line: Call039Line) => void;
  onEdit: (line: Call039Line, original: string, translated: string) => void;
  onCommand: (command: Call039Command, line: Call039Line) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<Call039Line | null>(null);
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const [editing, setEditing] = useState<Call039Line | null>(null);
  const [original, setOriginal] = useState("");
  const [translation, setTranslation] = useState("");

  const closeMenu = useCallback(() => {
    setMenu(null);
    setAnchor(null);
  }, []);

  const openMenu = (line: Call039Line, bubble: DOMRect) => {
    const host = container.current?.closest(
      ".videocall-redesign,.gcall-video-root,[class*='phone039Call'],[class*='callScreen']"
    ) as HTMLElement | null;
    const frame = host?.getBoundingClientRect() ?? new DOMRect(0, 0, window.innerWidth, window.innerHeight);
    setAnchor({
      x: bubble.left + bubble.width / 2,
      y: bubble.top,
      bounds: {
        left: Math.max(0, frame.left),
        right: Math.min(window.innerWidth, frame.right),
        top: Math.max(0, frame.top),
        bottom: Math.min(window.innerHeight, frame.bottom),
      },
    });
    setMenu(line);
  };

  const positionMenu = useCallback((el: HTMLDivElement | null) => {
    if (!el || !anchor) return;
    const margin = 8;
    const gap = 12;
    const { bounds } = anchor;
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    // Same placement as Chat: centered around the long-pressed bubble, prefer above,
    // else flip below. Constrain to the actual phone window, not the desktop page.
    const left = Math.max(bounds.left + margin,
      Math.min(anchor.x - width / 2, bounds.right - width - margin));
    const below = anchor.y - height - gap < bounds.top + margin;
    const top = Math.max(bounds.top + margin,
      Math.min(below ? anchor.y + gap : anchor.y - height - gap,
        bounds.bottom - height - margin));
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.right = "auto";
    el.style.bottom = "auto";
    const triangle = el.querySelector<HTMLElement>("[data-menu-triangle]");
    if (triangle) {
      triangle.style.left = `${Math.max(14, Math.min(anchor.x - left, width - 14))}px`;
      triangle.style.right = "auto";
      triangle.style.transform = "translateX(-50%)";
      if (below) {
        triangle.style.top = "-6px";
        triangle.style.bottom = "auto";
        triangle.style.borderTop = "none";
        triangle.style.borderBottom = "6px solid var(--ctx-menu-bg, #2c2c2c)";
      } else {
        triangle.style.top = "auto";
        triangle.style.bottom = "-6px";
        triangle.style.borderBottom = "none";
        triangle.style.borderTop = "6px solid var(--ctx-menu-bg, #2c2c2c)";
      }
    }
  }, [anchor]);

  useEffect(() => {
    if (!menu) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu, closeMenu]);

  const choose = (id: string) => {
    const selected = menu;
    closeMenu();
    if (!selected) return;
    if (id === "edit") {
      const parsed = splitBilingualText(selected.text);
      setOriginal(selected.kind === "action" ? selected.text : parsed?.original || selected.text);
      setTranslation(selected.kind === "action" ? "" : parsed?.translated || "");
      setEditing(selected);
    } else {
      onCommand(id as Call039Command, selected);
    }
  };

  const actions = menu
    ? VIDEO_LONG_PRESS_OPTIONS.filter(item => menu.kind === "action"
      ? ["edit", "reroll-after", "delete", "delete-after"].includes(item.id)
      : item.id !== "reroll-batch" || menu.role === "assistant")
    : [];

  return <>
    <div ref={container} className="call039-transcript">
      {lines.map(line => <Call039LineView key={line.id} line={line}
        showSpeaker={showSpeaker} playing={playingId === line.id}
        onPlay={onPlay} onMenu={openMenu}/>)}
    </div>

    {menu && createPortal(
      <div className="call039-menu-layer" onPointerDown={e => {
        if (e.target === e.currentTarget) closeMenu();
      }}>
        <ChatContextMenuSurface
          ref={positionMenu}
          dataRole={menu.role}
          ariaLabel="通话台词操作"
          className="call039-native-chat-menu"
          style={{left: anchor?.x ?? 0, top: anchor?.y ?? 0, zIndex: 2147483000}}
          onPointerDown={e => e.stopPropagation()}
        >
          {actions.map(item =>
            <ChatContextMenuRow key={item.id}>
              <ChatContextMenuButton
                danger={"destructive" in item && !!item.destructive}
                onClick={() => choose(item.id)}>
                {menu.kind === "action" && item.id === "edit" ? "编辑" : item.label}
              </ChatContextMenuButton>
            </ChatContextMenuRow>)}
        </ChatContextMenuSurface>
      </div>, document.body
    )}

    {editing && createPortal(
      <div className="call039-edit-backdrop" onPointerDown={e => {
        if (e.target === e.currentTarget) setEditing(null);
      }}>
        <div className="call039-edit" role="dialog" aria-modal="true" aria-label="编辑通话内容">
          <h3>{editing.kind === "action" ? "编辑动作" : "编辑原文与翻译"}</h3>
          <label>{editing.kind === "action" ? "动作内容" : "原文"}
            <textarea value={original} onChange={e => setOriginal(e.target.value)}/>
          </label>
          {editing.kind === "speech" && <label>中文翻译
            <textarea value={translation} onChange={e => setTranslation(e.target.value)}/>
          </label>}
          <div className="call039-edit-actions">
            <button type="button" onClick={() => setEditing(null)}>取消</button>
            <button type="button" onClick={() => {
              if (!original.trim()) return;
              onEdit(editing, original.trim(), translation.trim());
              setEditing(null);
            }}>保存</button>
          </div>
        </div>
      </div>, document.body
    )}
  </>;
}
