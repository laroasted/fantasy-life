import { useEffect, useRef, useState } from "react";
import { theme } from "../constants/theme";
import { PAYWALL_TOLL_CURRENCY } from "../constants/paywall";

const CLIENT_ID = process.env.REACT_APP_PAYPAL_CLIENT_ID;

// ─── Loads the PayPal JS SDK <script> once and reuses it everywhere ───
let sdkPromise = null;
function loadPayPalSdk() {
 if (!CLIENT_ID) return Promise.reject(new Error("no client id"));
 if (window.paypal) return Promise.resolve(window.paypal);
 if (sdkPromise) return sdkPromise;
 sdkPromise = new Promise((resolve, reject) => {
  var script = document.createElement("script");
  script.src = "https://www.paypal.com/sdk/js?client-id=" + encodeURIComponent(CLIENT_ID)
   + "&currency=" + encodeURIComponent(PAYWALL_TOLL_CURRENCY) + "&intent=capture";
  script.onload = function () { resolve(window.paypal); };
  script.onerror = function () { sdkPromise = null; reject(new Error("PayPal SDK failed to load")); };
  document.body.appendChild(script);
 });
 return sdkPromise;
}

// ─── Renders a standard PayPal Smart Button for one fixed-price toll ───
// This app has no backend, so the order is created and captured entirely
// client-side via the SDK. That's fine for a joke toll in a private
// friend league — there's no server-side verification of the payment,
// so treat `onApprove` as "a payment was approved by PayPal's checkout
// flow," not as a tamper-proof signal.
export default function PayPalButton({ amount, description, onApprove, onError }) {
 var containerRef = useRef(null);
 var _s = useState(CLIENT_ID ? "loading" : "unconfigured"), status = _s[0], setStatus = _s[1];

 useEffect(function () {
  if (!CLIENT_ID) return;
  var buttonsInstance = null;
  var cancelled = false;

  loadPayPalSdk().then(function (paypal) {
   if (cancelled || !containerRef.current) return;
   buttonsInstance = paypal.Buttons({
    style: { layout: "horizontal", color: "gold", shape: "pill", label: "pay", height: 40 },
    createOrder: function (data, actions) {
     return actions.order.create({
      purchase_units: [{
       amount: { value: amount, currency_code: PAYWALL_TOLL_CURRENCY },
       description: description,
      }],
     });
    },
    onApprove: function (data, actions) {
     return actions.order.capture().then(function (details) {
      if (onApprove) onApprove(details);
     });
    },
    onError: function (err) {
     console.error("PayPal checkout error:", err);
     if (onError) onError(err);
    },
   });
   buttonsInstance.render(containerRef.current).then(function () {
    if (!cancelled) setStatus("ready");
   });
  }).catch(function (err) {
   console.error("PayPal SDK load failed:", err);
   if (!cancelled) setStatus("error");
  });

  return function () {
   cancelled = true;
   if (buttonsInstance && buttonsInstance.close) buttonsInstance.close();
  };
 }, [amount, description]);

 if (!CLIENT_ID) {
  return (
   <div style={{ fontSize: 10, color: theme.dim, padding: "6px 0" }}>
    PayPal isn't configured yet (set REACT_APP_PAYPAL_CLIENT_ID).
   </div>
  );
 }

 return (
  <div>
   <div ref={containerRef} style={{ minHeight: status === "ready" ? undefined : 40 }} />
   {status === "loading" && (
    <div style={{ fontSize: 10, color: theme.dim }}>Loading PayPal…</div>
   )}
   {status === "error" && (
    <div style={{ fontSize: 10, color: theme.red }}>Couldn't load PayPal. Try refreshing.</div>
   )}
  </div>
 );
}
