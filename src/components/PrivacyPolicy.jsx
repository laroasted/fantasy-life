import { theme, cardStyle } from "../constants/theme";

const LAST_UPDATED = "October 2026";

export default function PrivacyPolicy() {
  return (
    <div style={{ maxWidth: 760, margin: "0 auto", ...cardStyle, padding: 24, lineHeight: 1.6 }}>
      <h2 style={{ margin: "0 0 4px", fontSize: 22 }}>Privacy Policy</h2>
      <p style={{ color: theme.dim, fontSize: 12, margin: "0 0 20px" }}>Last updated {LAST_UPDATED}</p>

      <p style={{ fontSize: 14, margin: "0 0 16px" }}>
        Fantasy Life Hub is a private fantasy league scoreboard. This page covers what data
        is collected from visitors and why.
      </p>

      <h3 style={{ fontSize: 15, margin: "20px 0 8px" }}>Analytics</h3>
      <p style={{ fontSize: 14, margin: "0 0 10px", color: theme.dim }}>
        We use Mixpanel to understand how the league uses the site (which tabs get viewed,
        draft activity, etc.). Anonymous visitors are tracked only by a device-generated ID —
        we don't know who you are. The league commissioner is identified by an internal
        account ID when signed in; this is never your name or email.
      </p>
      <p style={{ fontSize: 14, margin: "0 0 10px", color: theme.dim }}>
        We also use a Pinterest conversion tag for marketing analytics.
      </p>

      <h3 style={{ fontSize: 15, margin: "20px 0 8px" }}>Advertising</h3>
      <p style={{ fontSize: 14, margin: "0 0 10px", color: theme.dim }}>
        This site displays ads served by Google AdSense. Google and its partners use cookies
        to serve ads based on your visits to this and other sites. You can opt out of
        personalized advertising by visiting{" "}
        <a href="https://adssettings.google.com" target="_blank" rel="noreferrer" style={{ color: theme.acc }}>
          Google Ads Settings
        </a>{" "}
        or{" "}
        <a href="https://optout.aboutads.info" target="_blank" rel="noreferrer" style={{ color: theme.acc }}>
          optout.aboutads.info
        </a>.
      </p>

      <h3 style={{ fontSize: 15, margin: "20px 0 8px" }}>Account sign-in</h3>
      <p style={{ fontSize: 14, margin: "0 0 10px", color: theme.dim }}>
        The league commissioner signs in with Google via Supabase Auth. Regular visitors never
        need to sign in or create an account.
      </p>

      <h3 style={{ fontSize: 15, margin: "20px 0 8px" }}>Payments</h3>
      <p style={{ fontSize: 14, margin: "0 0 10px", color: theme.dim }}>
        If a league member chooses to unlock a paywalled scoreboard row, payment is processed
        directly by PayPal. We don't receive or store your card details.
      </p>

      <h3 style={{ fontSize: 15, margin: "20px 0 8px" }}>What we don't do</h3>
      <p style={{ fontSize: 14, margin: "0 0 10px", color: theme.dim }}>
        We don't sell your data. We don't collect anything you type into search or note fields
        on this site — those stay local to your session.
      </p>

      <h3 style={{ fontSize: 15, margin: "20px 0 8px" }}>Contact</h3>
      <p style={{ fontSize: 14, margin: 0, color: theme.dim }}>
        Questions about this policy? Contact the league commissioner at{" "}
        {/* TODO: replace with a real contact address before this page goes live */}
        <span style={{ color: theme.yel }}>[add contact email here]</span>.
      </p>
    </div>
  );
}
