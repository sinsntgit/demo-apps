"""Outgoing email through configured senders (Admin > Email senders). Every attempt is logged."""
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formataddr

from sqlalchemy import select

from . import security
from .db import now
from .models import EmailLog, EmailSender


class MailError(Exception):
    pass


def pick_sender(db, sender_id=None) -> EmailSender | None:
    """The requested sender if it is active, otherwise the default, otherwise any active one."""
    if sender_id:
        s = db.get(EmailSender, int(sender_id))
        if s and s.active:
            return s
    return db.scalar(select(EmailSender).where(EmailSender.active)
                     .order_by(EmailSender.is_default.desc(), EmailSender.id))


def configured(db) -> bool:
    return pick_sender(db) is not None


def _connect(s: EmailSender) -> smtplib.SMTP:
    if not s.host:
        raise MailError("This sender has no SMTP host.")
    ctx = ssl.create_default_context()
    try:
        if s.secure:
            server = smtplib.SMTP_SSL(s.host, s.port, timeout=20, context=ctx)
        else:
            server = smtplib.SMTP(s.host, s.port, timeout=20)
            server.ehlo()
            if server.has_extn("starttls"):
                server.starttls(context=ctx)
                server.ehlo()
        if s.username:
            server.login(s.username, security.decrypt(s.password_enc))
        return server
    except smtplib.SMTPAuthenticationError:
        raise MailError("The mail server rejected the username or password. Many providers need an app password.")
    except smtplib.SMTPNotSupportedError:
        raise MailError("This mail server does not accept a username and password on this port. "
                        "Clear the username if it is an open internal relay, or check the port and SSL/TLS setting.")
    except ssl.SSLError:
        raise MailError("Secure connection failed. Port 465 needs SSL/TLS switched on; port 587 needs it off.")
    except (smtplib.SMTPException, OSError, ValueError) as e:
        raise MailError(f"Could not connect to {s.host}:{s.port} - {str(e)[:200]}")


def verify(db, s: EmailSender) -> str:
    """Connect and sign in without sending anything."""
    if s.mode == "simulate":
        return "Simulation mode - nothing to verify, and nothing will be sent."
    try:
        _connect(s).quit()
    except MailError as e:
        s.last_error = str(e)
        raise
    s.last_error, s.verified_at = "", now()
    return "Connection and sign-in OK."


def send(db, s: EmailSender | None, to: list[str], subject: str, body: str,
         attachment: tuple[str, bytes] | None = None, context: str = "") -> str:
    """Send one message to all `to` addresses. Returns 'sent' or 'simulated'; raises MailError."""
    if s is None:
        raise MailError("No email sender is set up. An administrator can add one under Admin > Email senders.")
    if not to:
        raise MailError("No recipients.")

    def record(status, error=""):
        for addr in to:
            db.add(EmailLog(sender_label=s.label, to_addr=addr, subject=subject[:500], status=status,
                            error=error[:1000], context=context[:200]))

    if s.mode == "simulate":
        record("simulated")
        return "simulated"
    msg = EmailMessage()
    msg["From"] = formataddr((s.from_name, s.from_email)) if s.from_name else s.from_email
    msg["To"], msg["Subject"] = ", ".join(to), subject
    if s.reply_to:
        msg["Reply-To"] = s.reply_to
    msg.set_content(body)
    if attachment:
        msg.add_attachment(attachment[1], maintype="application", subtype="pdf", filename=attachment[0])
    try:
        with _connect(s) as server:
            refused = server.send_message(msg)
    except MailError as e:
        s.last_error = str(e)
        record("failed", str(e))
        raise
    except (smtplib.SMTPException, OSError) as e:
        s.last_error = f"Sending failed: {str(e)[:200]}"
        record("failed", s.last_error)
        raise MailError(s.last_error)
    s.last_error = ""
    record("sent")
    if refused:
        raise MailError("Refused by the mail server for: " + ", ".join(refused))
    return "sent"
