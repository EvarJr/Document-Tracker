"""
Document Scanner - Backend entrypoint

This is the starting skeleton. It currently only exposes a health check
endpoint (used by the keep-alive workflow to prevent Render free-tier
cold starts). OCR, template alignment, Google OAuth, and Drive endpoints
get added on top of this in later steps.
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="Document Scanner API")

# Allow the frontend (GitHub Pages / Vercel / localhost during dev) to call this API.
# Replace "*" with your actual frontend URL(s) once deployed, for tighter security.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health_check():
    """
    Lightweight endpoint with no dependencies (no DB, no external calls).
    Used by:
      - GitHub Actions keep-alive workflow (pings every ~10 min)
      - Frontend warm-up ping on page load
    """
    return {"status": "ok"}


@app.get("/")
async def root():
    return {"message": "Document Scanner API is running."}
