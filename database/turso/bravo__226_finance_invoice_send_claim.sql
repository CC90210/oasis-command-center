-- Serialize invoice email delivery against void/delete without pretending SMTP
-- can join a database transaction. A sender owns the nullable token from before
-- any checkout work until sent_at is recorded; lifecycle mutations require it
-- to be NULL. Claims are never auto-expired because a crash after SMTP is
-- ambiguous and automatically retrying could send the invoice twice.

ALTER TABLE fin_invoices ADD COLUMN send_claim_token TEXT;
ALTER TABLE fin_invoices ADD COLUMN send_claimed_at TEXT;
