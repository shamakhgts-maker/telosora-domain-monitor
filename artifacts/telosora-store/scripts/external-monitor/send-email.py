"""Send one notification using verified TLS. Never print SMTP credentials."""
import os
from pathlib import Path
import smtplib
import ssl
import sys
from email.message import EmailMessage


def send():
    required = ("SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "SMTP_USER",
                "SMTP_PASSWORD", "SMTP_FROM", "ALERT_TO",
                "ALERT_SUBJECT", "ALERT_MESSAGE_FILE")
    if any(not os.environ.get(key) for key in required):
        raise ValueError("Missing email configuration")
    secure = os.environ["SMTP_SECURE"].lower()
    if secure not in ("true", "false"):
        raise ValueError("SMTP_SECURE must be true or false")
    message = EmailMessage()
    message["From"] = os.environ["SMTP_FROM"]
    message["To"] = os.environ["ALERT_TO"]
    message["Subject"] = os.environ["ALERT_SUBJECT"]
    message.set_content(Path(os.environ["ALERT_MESSAGE_FILE"]).read_text())
    context = ssl.create_default_context()
    host, port = os.environ["SMTP_HOST"], int(os.environ["SMTP_PORT"])
    client = (smtplib.SMTP_SSL(host, port, timeout=30, context=context)
              if secure == "true" else smtplib.SMTP(host, port, timeout=30))
    with client:
        if secure == "false":
            client.ehlo()
            client.starttls(context=context)
            client.ehlo()
        client.login(os.environ["SMTP_USER"], os.environ["SMTP_PASSWORD"])
        refused = client.send_message(message)
        if refused:
            raise RuntimeError("Recipient rejected")


if __name__ == "__main__":
    try:
        send()
        print("SMTP server accepted notification for delivery.")
    except Exception as error:
        # SMTP exceptions can contain private server responses; expose type only.
        print(f"Notification failed ({type(error).__name__}); no automatic retry.", file=sys.stderr)
        sys.exit(1)