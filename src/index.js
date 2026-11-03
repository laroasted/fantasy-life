import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initAnalytics } from "./utils/analytics";
import * as serviceWorkerRegistration from "./serviceWorkerRegistration";

initAnalytics();

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// A new deployment's service worker installs into the "waiting" state but
// never actually takes over an open tab unless something tells it to —
// without this, every update sits inert until every single tab on this
// origin is fully closed and reopened, which is exactly why a just-shipped
// change can be live on the server yet invisible to someone who's had the
// app open the whole time. onUpdate fires the SKIP_WAITING message
// service-worker.js already listens for; controllerchange (the new worker
// actually taking control) then reloads once so the fresh bundle renders,
// guarded so a stray second event can't bounce the page in a loop.
let refreshingForUpdate = false;
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (refreshingForUpdate) return;
    refreshingForUpdate = true;
    window.location.reload();
  });
}

serviceWorkerRegistration.register({
  onUpdate: (registration) => {
    if (registration.waiting) {
      registration.waiting.postMessage({ type: "SKIP_WAITING" });
    }
  },
});