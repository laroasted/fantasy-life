import { useEffect, useRef } from "react";

const AD_CLIENT = "ca-pub-2732222008616840";
const ADSENSE_SRC = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${AD_CLIENT}`;

// Injected here on mount rather than unconditionally in public/index.html —
// this component only ever mounts once real Scoreboard content is already on
// screen, so the AdSense loader (and any Auto ads scanning tied to the
// account) never sees the pre-data "Loading scores..." shell, or any other
// tab, as a candidate screen for ads.
function loadAdsenseScript() {
  if (document.querySelector(`script[src^="${ADSENSE_SRC}"]`)) return;
  const script = document.createElement("script");
  script.async = true;
  script.src = ADSENSE_SRC;
  script.crossOrigin = "anonymous";
  document.head.appendChild(script);
}

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
    loadAdsenseScript();
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
