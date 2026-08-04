"""
Session cookie encryption.

We deliberately avoid server-side session storage (a dict or DB keyed by
session ID) because Render's free tier can restart/sleep the process at
any time, which would silently log everyone out. Instead, the encrypted
session data travels inside the cookie itself — the server only needs
SESSION_SECRET_KEY to decrypt it, and never has to remember anything
between requests. This is what makes the backend stateless.

The cookie itself is still safe to store client-side because:
  - It's httpOnly, so JavaScript (and therefore XSS) can never read it
  - It's encrypted, so even someone who did get the raw cookie value
    couldn't extract the refresh token without SESSION_SECRET_KEY
"""

import json
import os
from cryptography.fernet import Fernet, InvalidToken

_key = os.getenv("SESSION_SECRET_KEY")
_fernet = Fernet(_key.encode()) if _key else None


def is_configured() -> bool:
    return _fernet is not None


def encrypt_session(data: dict) -> str:
    if not _fernet:
        raise RuntimeError("SESSION_SECRET_KEY is not set on the server.")
    payload = json.dumps(data).encode()
    return _fernet.encrypt(payload).decode()


def decrypt_session(token: str) -> dict | None:
    if not _fernet or not token:
        return None
    try:
        payload = _fernet.decrypt(token.encode())
        return json.loads(payload)
    except (InvalidToken, ValueError):
        return None
