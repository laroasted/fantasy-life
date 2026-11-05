// Browser-side half of Web Push notifications. Requests permission,
// subscribes via the service worker's PushManager, and syncs the
// subscription to Supabase through api/push.js (?action=subscribe /
// ?action=unsubscribe) — api/_lib/push.js reads push_subscriptions back
// out to actually send. See src/service-worker.js for the receiving half
// (push/notificationclick handlers) and AGENTS.md's "Push notifications"
// section for the full picture. Every export stays a silent, typed
// failure rather than a thrown error — same defensive stance as
// src/utils/analytics.js, since this must never be able to break the app
// for visitors on browsers/OSes without push support (notably iOS Safari
// unless the site's been added to the home screen).

import { supabase } from "./storage";

const VAPID_PUBLIC_KEY = process.env.REACT_APP_VAPID_PUBLIC_KEY;

export function isPushSupported() {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window &&
    !!VAPID_PUBLIC_KEY
  );
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

export async function getExistingPushSubscription() {
  if (!isPushSupported()) return null;
  try {
    const registration = await navigator.serviceWorker.ready;
    return await registration.pushManager.getSubscription();
  } catch (e) {
    console.warn("Push: failed to read existing subscription.", e);
    return null;
  }
}

export async function subscribeToPush(memberId = null) {
  if (!isPushSupported()) return { ok: false, reason: "unsupported" };

  const permission = await Notification.requestPermission();
  if (permission !== "granted") return { ok: false, reason: permission };

  try {
    const registration = await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
    }

    const { endpoint, keys } = subscription.toJSON();
    const res = await fetch("/api/push?action=subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint, keys, memberId }),
    });
    if (!res.ok) return { ok: false, reason: "server_error" };
    return { ok: true };
  } catch (e) {
    console.warn("Push: subscribe failed.", e);
    return { ok: false, reason: "error" };
  }
}

// Fire-and-forget: tells the server to push whoever is currently on the
// clock in the live draft (see api/push.js's own comment on
// ?action=notify-turn for why this call carries no memberId itself — the
// server derives the target from draft_sessions directly). Called right
// after a pick lands, win or lose a race; never awaited for its result
// by the caller, and never allowed to surface as a user-visible error —
// a missed "it's your turn" push is a worse UX than a thrown exception
// breaking the pick flow that just succeeded.
export async function notifyTurn() {
  try {
    await fetch("/api/push?action=notify-turn", { method: "POST" });
  } catch (e) {
    console.warn("Push: notify-turn failed.", e);
  }
}

/**
* Commissioner-only: sends a one-off test push to a specific member's
* subscribed device(s), for the Settings "push" tab's per-member test
* button (SeasonSettings.jsx) — lets the commissioner confirm a given
* member will actually receive a draft "it's your turn" or score push
* before relying on it live, without waiting for a real event.
*
* Unlike every other export here, this one DOES surface a specific
* reason on failure rather than just swallowing it — the whole point of
* this button is telling the commissioner whether it worked, not hiding
* that from them the way a background push-infra failure elsewhere
* should stay invisible to an ordinary visitor.
*/
export async function sendTestPush(memberId) {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return { ok: false, reason: "not_signed_in" };
    const res = await fetch("/api/push?action=test-member", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ memberId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: data.error || "server_error" };
    // data.reason (not_configured / lookup_failed / no_subscriptions) is
    // only ever set when sent === 0 && failed === 0 — see sendPush()'s
    // own comment (api/_lib/push.js) for why that one shape otherwise
    // can't be told apart from a genuine "no subscription".
    return { ok: true, sent: data.sent || 0, failed: data.failed || 0, reason: data.reason };
  } catch (e) {
    console.warn("Push: test-member failed.", e);
    return { ok: false, reason: "network_error" };
  }
}

export async function unsubscribeFromPush() {
  if (!("serviceWorker" in navigator)) return { ok: true };
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return { ok: true };

    const endpoint = subscription.endpoint;
    await subscription.unsubscribe();
    await fetch("/api/push?action=unsubscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint }),
    }).catch(() => {});
    return { ok: true };
  } catch (e) {
    console.warn("Push: unsubscribe failed.", e);
    return { ok: false };
  }
}
