"use client";

import { useEffect } from "react";
import { isMobileShell } from "@/lib/mobile-shell";
import { shouldRequestPwaFullscreen } from "@/lib/pwa-display-mode";


/**
 * 安卓全屏兜底：点击屏幕进入全屏模式（iOS 不支持此 API，会自动忽略）。
 *
 * 作为移动端通用兜底，浏览器支持 Fullscreen API 时允许点击进入全屏。
 */
export function AndroidFullscreen() {
  useEffect(() => {
    const isMobile = isMobileShell();
    if (!isMobile) return;

    function tryFullscreen() {
      if (!shouldRequestPwaFullscreen()) return;
      const doc = document.documentElement;
      if (document.fullscreenElement) return;
      doc.requestFullscreen?.().catch(() => { });
    }
    // 每次点击都尝试进入全屏（退出后可重新进入）；渠道默认与用户偏好由 shouldRequestPwaFullscreen 统一裁决
    document.addEventListener("click", tryFullscreen);
    return () => {
      document.removeEventListener("click", tryFullscreen);
    };
  }, []);

  return null;
}
