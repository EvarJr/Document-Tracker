"""
Mobile pairing: lets a phone browser upload photos into a desktop session
via a short-lived QR pairing code, with no separate login required on the
phone - the pairing code itself (created by the already-authenticated
desktop session) is the permission.

Deliberately in-memory and short-lived by design - the same tradeoff
already accepted for the OAuth exchange-code flow. A pairing only needs
to survive the few minutes someone is actively standing at their phone
taking photos; losing one to a rare mid-session Render restart just
means generating a new QR code, not a real problem.
"""

import secrets
import time

PAIRING_TTL_SECONDS = 30 * 60  # 30 minutes

_pairings: dict[str, dict] = {}


def _prune_expired():
    now = time.time()
    expired = [pid for pid, p in _pairings.items() if p["expires_at"] < now]
    for pid in expired:
        _pairings.pop(pid, None)


def create_pairing(owner_email: str) -> dict:
    _prune_expired()
    pairing_id = secrets.token_urlsafe(16)
    now = time.time()
    _pairings[pairing_id] = {
        "owner_email": owner_email,
        "created_at": now,
        "expires_at": now + PAIRING_TTL_SECONDS,
        "images": [],
    }
    return {"pairingId": pairing_id, "expiresAt": _pairings[pairing_id]["expires_at"]}


def get_pairing(pairing_id: str) -> dict | None:
    _prune_expired()
    return _pairings.get(pairing_id)


def add_image(pairing_id: str, data_url: str) -> bool:
    pairing = get_pairing(pairing_id)
    if not pairing:
        return False
    pairing["images"].append({"dataUrl": data_url, "uploadedAt": time.time()})
    return True


def pop_images(pairing_id: str) -> list[dict]:
    pairing = get_pairing(pairing_id)
    if not pairing:
        return []
    images = pairing["images"]
    pairing["images"] = []
    return images
