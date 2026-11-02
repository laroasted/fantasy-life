import { useState, useEffect } from "react";

// Shared viewport-breakpoint hook — App.jsx and Scoreboard.jsx used to each
// register their own `resize` listener with hand-copied breakpoint numbers
// (App.jsx even had a comment flagging its isWide as "MOCK ONLY — mirrors
// Scoreboard.jsx's own 'wide' breakpoint", i.e. two places that had to be
// kept in lockstep by hand). One listener here means one source of truth
// for the breakpoints, and a resize event now triggers one re-render per
// consumer instead of two independent full-tree re-renders.
const MOBILE_BREAKPOINT = 640;
const WIDE_BREAKPOINT = 1024;

export function useViewport() {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < MOBILE_BREAKPOINT);
  const [isWide, setIsWide] = useState(() => window.innerWidth >= WIDE_BREAKPOINT);

  useEffect(() => {
    function onResize() {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
      setIsWide(window.innerWidth >= WIDE_BREAKPOINT);
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return { isMobile, isWide };
}
