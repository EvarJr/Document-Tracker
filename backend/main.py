"""
Document Scanner - Backend entrypoint

Auth model: backend-for-frontend OAuth. The frontend never touches a
Google token directly - it only ever holds an httpOnly session cookie.
All Google API calls happen here, server-side.
"""

import os
import secrets

from fastapi import FastAPI, Request, Response, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse

import google_oauth
import security
import drive

FRONTEND_URL = os.getenv("FRONTEND_URL", "")

app = FastAPI(title="Document Scanner API")

# CORS is locked to the exact frontend origin, not "*" - required anyway
# once cookies are involved (browsers reject wildcard origins when
# allow_credentials is True), but it's the right call regardless.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[FRONTEND_URL] if FRONTEND_URL else [],
    allow_credentials=True,
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["*"],
)

SESSION_COOKIE = "session"
STATE_COOKIE = "oauth_state"


@app.get("/health")
async def health_check():
    return {"status": "ok"}


@app.get("/")
async def root():
    return {"message": "Document Scanner API is running."}


# --- Auth routes ---

@app.get("/auth/google/login")
async def google_login():
    if not google_oauth.is_configured() or not security.is_configured():
        raise HTTPException(status_code=503, detail="Google sign-in is not configured on the server yet.")

    state = secrets.token_urlsafe(24)
    auth_url = google_oauth.build_auth_url(state)

    resp = RedirectResponse(auth_url)
    # SameSite=Lax is correct here (not None) - this cookie only needs to
    # survive a top-level redirect back from Google, and Lax is the more
    # restrictive, safer choice for anything that doesn't need cross-site delivery.
    resp.set_cookie(
        STATE_COOKIE, state,
        httponly=True, secure=True, samesite="lax", max_age=600,
    )
    return resp


@app.get("/auth/google/callback")
async def google_callback(request: Request, code: str | None = None, state: str | None = None, error: str | None = None):
    if error:
        return RedirectResponse(f"{FRONTEND_URL}?auth=error")

    saved_state = request.cookies.get(STATE_COOKIE)
    if not state or not saved_state or state != saved_state:
        # Mismatched/missing state means this request didn't originate from
        # our own login flow - reject it outright rather than guessing.
        raise HTTPException(status_code=400, detail="Invalid OAuth state.")

    if not code:
        return RedirectResponse(f"{FRONTEND_URL}?auth=error")

    tokens = await google_oauth.exchange_code_for_tokens(code)
    userinfo = await google_oauth.get_userinfo(tokens["access_token"])

    refresh_token = tokens.get("refresh_token")
    if not refresh_token:
        # Google only issues a refresh_token on the first-ever consent for
        # this app+account. If the user previously authorized and revoked
        # some other way, we won't get one back here - send them through
        # consent again rather than silently failing later.
        return RedirectResponse(f"{FRONTEND_URL}?auth=needs_consent")

    session_cookie = security.encrypt_session({
        "refresh_token": refresh_token,
        "email": userinfo.get("email"),
    })

    resp = RedirectResponse(f"{FRONTEND_URL}?auth=success")
    resp.delete_cookie(STATE_COOKIE)
    # SameSite=None is required here because the frontend (github.io) and
    # backend (onrender.com) are different sites, so this cookie must be
    # sent on cross-site requests - which is why Secure is mandatory too.
    resp.set_cookie(
        SESSION_COOKIE, session_cookie,
        httponly=True, secure=True, samesite="none", max_age=60 * 60 * 24 * 30,
    )
    return resp


def _get_session(request: Request) -> dict:
    raw = request.cookies.get(SESSION_COOKIE)
    data = security.decrypt_session(raw) if raw else None
    if not data:
        raise HTTPException(status_code=401, detail="Not signed in.")
    return data


async def _get_access_token(request: Request) -> str:
    session = _get_session(request)
    tokens = await google_oauth.refresh_access_token(session["refresh_token"])
    return tokens["access_token"]


@app.get("/auth/me")
async def auth_me(request: Request):
    session = _get_session(request)
    return {"email": session["email"]}


@app.post("/auth/logout")
async def logout(request: Request):
    raw = request.cookies.get(SESSION_COOKIE)
    if raw:
        data = security.decrypt_session(raw)
        if data and data.get("refresh_token"):
            await google_oauth.revoke_token(data["refresh_token"])

    resp = Response(status_code=204)
    resp.delete_cookie(SESSION_COOKIE, samesite="none", secure=True)
    return resp


# --- Template routes (Drive-backed) ---

@app.get("/templates")
async def get_templates(request: Request):
    access_token = await _get_access_token(request)
    files = await drive.list_templates(access_token)
    return {"templates": files}


@app.post("/templates")
async def create_template(request: Request):
    access_token = await _get_access_token(request)
    body = await request.json()
    filename = f"{body.get('name', 'template')}.json"
    result = await drive.save_template(access_token, filename, body)
    return result


@app.get("/templates/{file_id}")
async def get_template(file_id: str, request: Request):
    access_token = await _get_access_token(request)
    return await drive.get_template_content(access_token, file_id)
