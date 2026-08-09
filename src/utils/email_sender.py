import os
import smtplib
from email.message import EmailMessage


def is_email_configured():
    return bool(os.environ.get('SMTP_HOST') and os.environ.get('SMTP_USERNAME') and os.environ.get('SMTP_PASSWORD'))


def send_email(to_address, subject, body):
    """Sends one plain-text email via SMTP, configured entirely through environment
    variables (SMTP_HOST, SMTP_PORT, SMTP_USERNAME, SMTP_PASSWORD, SMTP_FROM) instead of a
    specific provider's SDK — works with whatever free account the lab already has (Gmail
    with an App Password, Outlook/Office365, Zoho, a transactional provider's SMTP relay,
    etc.) without adding a dependency or locking in a vendor. Port 465 uses implicit SSL;
    anything else uses STARTTLS (587 is the common default) — inferred from the port the same
    way most mail clients do, so the caller doesn't need to know which mode their provider
    wants. Raises on failure; callers decide how to report it (see send_hr_email() in
    main.py, which does one call per recipient and collects successes/failures)."""
    host = os.environ.get('SMTP_HOST')
    port = int(os.environ.get('SMTP_PORT', 587))
    username = os.environ.get('SMTP_USERNAME')
    password = os.environ.get('SMTP_PASSWORD')
    sender = os.environ.get('SMTP_FROM') or username

    msg = EmailMessage()
    msg['Subject'] = subject
    msg['From'] = sender
    msg['To'] = to_address
    msg.set_content(body)

    if port == 465:
        with smtplib.SMTP_SSL(host, port, timeout=15) as server:
            server.login(username, password)
            server.send_message(msg)
    else:
        with smtplib.SMTP(host, port, timeout=15) as server:
            server.starttls()
            server.login(username, password)
            server.send_message(msg)
