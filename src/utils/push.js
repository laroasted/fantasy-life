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

export async function subscribeToPush() {
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
      body: JSON.stringify({ endpoint, keys }),
    });
    if (!res.ok) return { ok: false, reason: "server_error" };
    return { ok: true };
  } catch (e) {
    console.warn("Push: subscribe failed.", e);
    return { ok: false, reason: "error" };
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
