"""Outgoing email (scheduled reports). Settings live in Admin > Settings."""
import smtplib
import ssl
from email.message import EmailMessage

from . import security


class MailError(Exception):
    pass


def configured(cfg: dict) -> bool:
    return bool(cfg.get("smtp_host") and cfg.get("smtp_from"))


def send(cfg: dict, to: list[str], subject: str, body: str, attachment: tuple[str, bytes] | None = None):
    if not configured(cfg):
        raise MailError("Email is not set up. An administrator must enter the mail server under Admin > Settings.")
    if not to:
        raise MailError("No recipients.")
    msg = EmailMessage()
    msg["From"], msg["To"], msg["Subject"] = cfg["smtp_from"], ", ".join(to), subject
    msg.set_content(body)
    if attachment:
        msg.add_attachment(attachment[1], maintype="application", subtype="pdf", filename=attachment[0])
    host, port, mode = cfg["smtp_host"], int(cfg.get("smtp_port") or 587), cfg.get("smtp_security", "starttls")
    try:
        if mode == "ssl":
            server = smtplib.SMTP_SSL(host, port, timeout=20, context=ssl.create_default_context())
        else:
            server = smtplib.SMTP(host, port, timeout=20)
        with server:
            if mode == "starttls":
                server.starttls(context=ssl.create_default_context())
            if cfg.get("smtp_user"):
                server.login(cfg["smtp_user"], security.decrypt(cfg.get("smtp_password") or ""))
            server.send_message(msg)
    except smtplib.SMTPAuthenticationError:
        raise MailError("The mail server rejected the username or password.")
    except (smtplib.SMTPException, OSError, ValueError) as e:
        raise MailError(f"Could not send email: {str(e)[:200]}")
