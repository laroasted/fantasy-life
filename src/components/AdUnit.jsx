import { useEffect, useRef } from "react";

const AD_CLIENT = "ca-pub-2732222008616840";

/**
 * Manual AdSense ad unit. Auto ads doesn't reliably rescan after a client-side
 * tab switch in this app (App.jsx renders tabs via conditional render, not
 * real navigation), so each placement pushes itself to adsbygoogle on mount.
 */
export default function AdUnit({ slot, format = "auto", style }) {
  const pushedRef = useRef(false);

  useEffect(() => {
    if (pushedRef.current) return;
    pushedRef.current = true;
    try {
      (window.adsbygoogle = window.adsbygoogle || []).push({});
    } catch (e) {
      // AdSense script blocked or not yet loaded — fail silently
    }
  }, []);

  return (
    <ins
      className="adsbygoogle"
      style={style || { display: "block" }}
      data-ad-client={AD_CLIENT}
      data-ad-slot={slot}
      data-ad-format={format}
      data-full-width-responsive="true"
    />
  );
}
