"""
Google Drive API calls for template storage.

Everything writes into a single app-created folder (`DocumentScannerTemplates`)
rather than scattering files loose in the user's Drive root — keeps things
tidy and matches the drive.file scope's intent (the app manages its own space).
"""

import json
import httpx

DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files"
DRIVE_UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files"
APP_FOLDER_NAME = "DocumentScannerTemplates"


async def get_or_create_app_folder(access_token: str) -> str:
    headers = {"Authorization": f"Bearer {access_token}"}
    async with httpx.AsyncClient() as client:
        q = (
            f"name='{APP_FOLDER_NAME}' and "
            "mimeType='application/vnd.google-apps.folder' and trashed=false"
        )
        resp = await client.get(
            DRIVE_FILES_URL, headers=headers, params={"q": q, "spaces": "drive"}
        )
        resp.raise_for_status()
        files = resp.json().get("files", [])
        if files:
            return files[0]["id"]

        create_resp = await client.post(
            DRIVE_FILES_URL,
            headers=headers,
            json={"name": APP_FOLDER_NAME, "mimeType": "application/vnd.google-apps.folder"},
        )
        create_resp.raise_for_status()
        return create_resp.json()["id"]


async def list_templates(access_token: str) -> list[dict]:
    headers = {"Authorization": f"Bearer {access_token}"}
    folder_id = await get_or_create_app_folder(access_token)
    async with httpx.AsyncClient() as client:
        q = f"'{folder_id}' in parents and trashed=false"
        resp = await client.get(
            DRIVE_FILES_URL,
            headers=headers,
            params={"q": q, "fields": "files(id,name,modifiedTime)"},
        )
        resp.raise_for_status()
        return resp.json().get("files", [])


async def save_template(access_token: str, filename: str, content: dict) -> dict:
    folder_id = await get_or_create_app_folder(access_token)
    headers = {"Authorization": f"Bearer {access_token}"}
    metadata = {"name": filename, "parents": [folder_id], "mimeType": "application/json"}

    boundary = "docscannerboundary"
    body = (
        f"--{boundary}\r\n"
        "Content-Type: application/json; charset=UTF-8\r\n\r\n"
        f"{json.dumps(metadata)}\r\n"
        f"--{boundary}\r\n"
        "Content-Type: application/json\r\n\r\n"
        f"{json.dumps(content)}\r\n"
        f"--{boundary}--"
    )
    headers["Content-Type"] = f"multipart/related; boundary={boundary}"

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{DRIVE_UPLOAD_URL}?uploadType=multipart", headers=headers, content=body
        )
        resp.raise_for_status()
        return resp.json()


async def get_template_content(access_token: str, file_id: str) -> dict:
    headers = {"Authorization": f"Bearer {access_token}"}
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{DRIVE_FILES_URL}/{file_id}", headers=headers, params={"alt": "media"}
        )
        resp.raise_for_status()
        return resp.json()
