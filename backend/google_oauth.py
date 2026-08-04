"""
Google OAuth 2.0 (Authorization Code flow, backend-driven).

Deliberately does NOT hand access/refresh tokens to the frontend at any
point. The frontend only ever gets an httpOnly session cookie; every
Google API call happens server-side, using the refresh token stored
(encrypted) inside that cookie.

Scope is restricted to `drive.file` — the app can only see files it
creates itself, never the user's existing Drive contents. This is the
least-privilege choice: even in a worst-case token leak, the blast
radius is limited to files this app made.
"""

import os
import httpx

GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID")
GOOGLE_CLIENT_SECRET = os.getenv("GOOGLE_CLIENT_SECRET")
GOOGLE_REDIRECT_URI = os.getenv("GOOGLE_REDIRECT_URI")

AUTH_BASE = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
REVOKE_URL = "https://oauth2.googleapis.com/revoke"
USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo"

SCOPES = "openid email https://www.googleapis.com/auth/drive.file"


def is_configured() -> bool:
    return all([GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI])


def build_auth_url(state: str) -> str:
    params = {
        "client_id": GOOGLE_CLIENT_ID,
        "redirect_uri": GOOGLE_REDIRECT_URI,
        "response_type": "code",
        "scope": SCOPES,
        "access_type": "offline",   # required to receive a refresh_token
        "prompt": "consent",        # forces a fresh refresh_token every time (safe for dev/testing)
        "state": state,
        "include_granted_scopes": "true",
    }
    query = str(httpx.QueryParams(params))
    return f"{AUTH_BASE}?{query}"


async def exchange_code_for_tokens(code: str) -> dict:
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            TOKEN_URL,
            data={
                "code": code,
                "client_id": GOOGLE_CLIENT_ID,
                "client_secret": GOOGLE_CLIENT_SECRET,
                "redirect_uri": GOOGLE_REDIRECT_URI,
                "grant_type": "authorization_code",
            },
        )
        resp.raise_for_status()
        return resp.json()


async def refresh_access_token(refresh_token: str) -> dict:
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            TOKEN_URL,
            data={
                "refresh_token": refresh_token,
                "client_id": GOOGLE_CLIENT_ID,
                "client_secret": GOOGLE_CLIENT_SECRET,
                "grant_type": "refresh_token",
            },
        )
        resp.raise_for_status()
        return resp.json()


async def get_userinfo(access_token: str) -> dict:
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            USERINFO_URL, headers={"Authorization": f"Bearer {access_token}"}
        )
        resp.raise_for_status()
        return resp.json()


async def revoke_token(token: str) -> None:
    async with httpx.AsyncClient() as client:
        # Best-effort — if this fails, the token still expires naturally.
        await client.post(REVOKE_URL, params={"token": token})
