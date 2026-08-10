"""
Document Scanner - Backend entrypoint

Auth model: backend-for-frontend OAuth, using a bearer token instead of a
cross-site cookie for the frontend<->backend session link.

Why not a cookie: the frontend (github.io) and backend (onrender.com) are
different sites, so a session cookie between them needs SameSite=None -
exactly the kind of cookie modern browsers increasingly restrict or block
as third-party tracking protection (Safari and Firefox block it outright
by default; Chrome's policy has shifted more than once). Rather than
depend on that working consistently for every visitor, the backend hands
the frontend an explicit bearer token after login, which the frontend
attaches manually via an Authorization header on every request. This
can't be silently dropped by cookie policy since it isn't a cookie.

The OAuth *login* flow itself still uses one short-lived cookie
(STATE_COOKIE) for CSRF protection - that one is same-site the whole
time (set and read back on this same backend domain during a top-level
browser redirect), so it's unaffected by any of the above.
"""

import os
import secrets
import time

from fastapi import FastAPI, Request, Response, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from urllib.parse import urlparse

import google_oauth
import security
import drive

FRONTEND_URL = os.getenv("FRONTEND_URL", "").rstrip("/")
_parsed = urlparse(FRONTEND_URL)
FRONTEND_ORIGIN = f"{_parsed.scheme}://{_parsed.netloc}" if _parsed.scheme else ""

app = FastAPI(title="Document Scanner API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[FRONTEND_ORIGIN] if FRONTEND_ORIGIN else [],
    allow_credentials=False,  # no longer needed - auth travels via header, not cookies
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["*"],
)

STATE_COOKIE = "oauth_state"

# Short-lived one-time exchange codes: code -> (encrypted_session_token, expires_at).
# Deliberately in-memory and short-lived (2 min) by design - unlike the actual
# session, this only needs to survive the few seconds between the OAuth
# redirect landing and the frontend's follow-up exchange call, so an
# occasional Render restart mid-flight (rare) just means a retry, not a
# real problem.
_exchange_codes: dict[str, tuple[str, float]] = {}
EXCHANGE_CODE_TTL = 120


def _prune_expired_codes():
    now = time.time()
    expired = [c for c, (_, exp) in _exchange_codes.items() if exp < now]
    for c in expired:
        _exchange_codes.pop(c, None)


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
        raise HTTPException(status_code=400, detail="Invalid OAuth state.")

    if not code:
        return RedirectResponse(f"{FRONTEND_URL}?auth=error")

    tokens = await google_oauth.exchange_code_for_tokens(code)
    userinfo = await google_oauth.get_userinfo(tokens["access_token"])

    refresh_token = tokens.get("refresh_token")
    if not refresh_token:
        return RedirectResponse(f"{FRONTEND_URL}?auth=needs_consent")

    session_token = security.encrypt_session({
        "refresh_token": refresh_token,
        "email": userinfo.get("email"),
    })

    # Don't put the actual session token in the URL - it's a long-lived
    # credential and URLs leak into browser history, referrer headers, and
    # server logs. Instead, hand back a short opaque one-time code, and
    # make the frontend exchange it for the real token via a POST body.
    _prune_expired_codes()
    exchange_code = secrets.token_urlsafe(24)
    _exchange_codes[exchange_code] = (session_token, time.time() + EXCHANGE_CODE_TTL)

    resp = RedirectResponse(f"{FRONTEND_URL}?auth=success&code={exchange_code}")
    resp.delete_cookie(STATE_COOKIE)
    return resp


@app.post("/auth/exchange")
async def auth_exchange(request: Request):
    body = await request.json()
    code = body.get("code")

    entry = _exchange_codes.pop(code, None) if code else None
    if not entry:
        raise HTTPException(status_code=400, detail="Invalid or already-used code.")

    session_token, expires_at = entry
    if time.time() > expires_at:
        raise HTTPException(status_code=400, detail="Code expired - please sign in again.")

    data = security.decrypt_session(session_token)
    if not data:
        raise HTTPException(status_code=400, detail="Invalid session.")

    return {"session_token": session_token, "email": data["email"]}


def _get_session(request: Request) -> dict:
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Not signed in.")

    token = auth_header[len("Bearer "):]
    data = security.decrypt_session(token)
    if not data:
        raise HTTPException(status_code=401, detail="Invalid session.")
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
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        data = security.decrypt_session(auth_header[len("Bearer "):])
        if data and data.get("refresh_token"):
            await google_oauth.revoke_token(data["refresh_token"])
    return Response(status_code=204)


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


# --- Export routes (Excel workbooks) ---

@app.get("/exports")
async def list_exports(request: Request):
    access_token = await _get_access_token(request)
    files = await drive.list_files_in_folder(access_token, drive.EXPORTS_FOLDER)
    return {"exports": files}


@app.post("/exports")
async def create_export(request: Request):
    access_token = await _get_access_token(request)
    form = await request.form()
    upload = form.get("file")
    filename = form.get("filename") or (upload.filename if upload else "export.xlsx")
    content = await upload.read() if upload else b""
    result = await drive.upload_binary(access_token, drive.EXPORTS_FOLDER, filename, content, drive.XLSX_MIME)
    return result


@app.get("/exports/{file_id}")
async def get_export_file(file_id: str, request: Request):
    access_token = await _get_access_token(request)
    content = await drive.download_binary(access_token, file_id)
    return Response(content=content, media_type=drive.XLSX_MIME)


@app.put("/exports/{file_id}")
async def update_export_file(file_id: str, request: Request):
    access_token = await _get_access_token(request)
    content = await request.body()
    result = await drive.update_binary(access_token, file_id, content, drive.XLSX_MIME)
    return result


# --- Export mapping routes (which template writes to which cell range) ---

@app.get("/export-mappings/{template_id}")
async def get_mapping_route(template_id: str, request: Request):
    access_token = await _get_access_token(request)
    mapping = await drive.get_mapping(access_token, template_id)
    if not mapping:
        raise HTTPException(status_code=404, detail="No export mapping yet for this template.")
    return mapping


@app.post("/export-mappings/{template_id}")
async def save_mapping_route(template_id: str, request: Request):
    access_token = await _get_access_token(request)
    body = await request.json()
    result = await drive.save_mapping(access_token, template_id, body)
    return result


@app.get("/export-mappings")
async def list_all_mappings_route(request: Request):
    # Used for the collision check: before writing a new template's block
    # into a workbook, check every other mapping that already points at
    # that same file so overlapping cell ranges get caught before they
    # silently corrupt someone else's data.
    access_token = await _get_access_token(request)
    mappings = await drive.list_all_mappings(access_token)
    return {"mappings": mappings}


# --- Correction history routes (per template, per field OCR learning) ---

@app.get("/corrections/{template_id}")
async def get_corrections_route(template_id: str, request: Request):
    access_token = await _get_access_token(request)
    data = await drive.get_corrections(access_token, template_id)
    if not data:
        raise HTTPException(status_code=404, detail="No correction history yet for this template.")
    return data


@app.post("/corrections/{template_id}")
async def save_corrections_route(template_id: str, request: Request):
    access_token = await _get_access_token(request)
    body = await request.json()
    result = await drive.save_corrections(access_token, template_id, body)
    return result


# --- Alignment learning routes (corner-detection bias + alignment-offset bias) ---

@app.get("/alignment-learning/{template_id}")
async def get_alignment_learning_route(template_id: str, request: Request):
    access_token = await _get_access_token(request)
    data = await drive.get_alignment_learning(access_token, template_id)
    if not data:
        raise HTTPException(status_code=404, detail="No alignment learning yet for this template.")
    return data


@app.post("/alignment-learning/{template_id}")
async def save_alignment_learning_route(template_id: str, request: Request):
    access_token = await _get_access_token(request)
    body = await request.json()
    result = await drive.save_alignment_learning(access_token, template_id, body)
    return result
