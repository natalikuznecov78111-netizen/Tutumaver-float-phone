"use client";
import { forwardRef, type CSSProperties, type PointerEventHandler, type ReactNode } from "react";

/**
 * One shared context-menu surface for ordinary Chat messages and call transcripts.
 * These are the original Chat menu classes, controls and triangle; only the
 * actionable items differ between messages and call bubbles.
 */
export const ChatContextMenuSurface = forwardRef<HTMLDivElement, {
  children: ReactNode;
  style?: CSSProperties;
  dataRole?: string;
  className?: string;
  onPointerDown?: PointerEventHandler<HTMLDivElement>;
  ariaLabel?: string;
}>(function ChatContextMenuSurface({ children, style, dataRole, className = "", onPointerDown, ariaLabel }, ref) {
  return <div
    ref={ref}
    style={style}
    onPointerDown={onPointerDown}
    className={`ctx-menu chat-floating-ctx-menu flex flex-col items-center gap-[6px] py-[4px] px-0 ${className}`.trim()}
    data-role={dataRole}
    role="menu"
    aria-label={ariaLabel}
  >
    {children}
    <div data-menu-triangle className="ctx-menu-triangle absolute -top-[6px] w-0 h-0" />
  </div>;
});

export function ChatContextMenuRow({children}: {children: ReactNode}) {
  return <div className="flex">{children}</div>;
}

export function ChatContextMenuButton({
  children, danger=false, onClick, disabled=false,
}: {
  children: ReactNode;
  danger?: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  return <button type="button" role="menuitem" disabled={disabled}
    className={danger ? "ctx-menu-btn ctx-menu-btn-danger" : "ctx-menu-btn"} onClick={onClick}>{children}</button>;
}
