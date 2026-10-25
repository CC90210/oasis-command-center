import "./audit-document.css";

/** The one page every unusable audit link gets: missing, expired, revoked or replaced. */
export function LinkUnavailable() {
  return (
    <div className="aa">
      <article className="aa-paper" style={{ maxWidth: 560 }}>
        <div className="aa-brand">
          OASIS AI <span>Solutions</span>
        </div>
        <h1 style={{ fontSize: 26 }}>This link is not available</h1>
        <p style={{ marginTop: 14 }}>It may have expired or been replaced by a newer one. Reply to the email from OASIS and we will send you a current link.</p>
      </article>
    </div>
  );
}
