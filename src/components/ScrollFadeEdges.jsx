import { useState, useEffect } from "react";
import { theme } from "../constants/theme";

// Wraps a horizontally-scrolling row (tab bar, category pills) and shows a
// real edge fade only on whichever side actually has more content to
// scroll to — not a static "always on mobile" hint, which would show on
// rows short enough to fit without scrolling. The caller creates the ref,
// attaches it to its own scrollable element, and passes it in here.
export default function ScrollFadeEdges({ scrollRef, children, fadeColor }) {
  var color = fadeColor || theme.bg;
  var _o = useState({ left: false, right: false }), overflow = _o[0], setOverflow = _o[1];

  function check() {
    var el = scrollRef.current;
    if (!el) { setOverflow({ left: false, right: false }); return; }
    setOverflow({
      left: el.scrollLeft > 4,
      right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4,
    });
  }

  useEffect(function () {
    check();
    var el = scrollRef.current;
    if (!el) return;
    el.addEventListener("scroll", check, { passive: true });
    window.addEventListener("resize", check);
    return function () {
      el.removeEventListener("scroll", check);
      window.removeEventListener("resize", check);
    };
  });

  return (
    <div style={{ position: "relative" }}>
      {children}
      {overflow.left && (
        <div aria-hidden="true" style={{ position: "absolute", top: 0, bottom: 0, left: 0, width: 24,
          background: `linear-gradient(90deg, ${color}, transparent)`, pointerEvents: "none" }} />
      )}
      {overflow.right && (
        <div aria-hidden="true" style={{ position: "absolute", top: 0, bottom: 0, right: 0, width: 24,
          background: `linear-gradient(270deg, ${color}, transparent)`, pointerEvents: "none" }} />
      )}
    </div>
  );
}
