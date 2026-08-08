"""
Google Drive API calls.

Everything writes into app-created folders (never the user's Drive root) -
DocumentScannerTemplates, DocumentScannerExports, DocumentScannerExportMappings -
matching the drive.file scope's intent (the app manages its own space, not
the user's existing files).
"""

import base64
import json
import httpx

DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files"
DRIVE_UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files"

TEMPLATES_FOLDER = "DocumentScannerTemplates"
EXPORTS_FOLDER = "DocumentScannerExports"
MAPPINGS_FOLDER = "DocumentScannerExportMappings"

XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
JSON_MIME = "application/json"

async def get_or_create_folder(access_token: str, folder_name: str) -> str:
    headers = {"Authorization": f"Bearer {access_token}"}
    async with httpx.AsyncClient() as client:
        q = f"name='{folder_name}' and mimeType='application/vnd.google-apps.folder' and trashed=false"
        resp = await client.get(DRIVE_FILES_URL, headers=headers, params={"q": q, "spaces": "drive"})
        resp.raise_for_status()
        files = resp.json().get("files", [])
        if files:
            return files[0]["id"]

        create_resp = await client.post(
            DRIVE_FILES_URL,
            headers=headers,
            json={"name": folder_name, "mimeType": "application/vnd.google-apps.folder"},
        )
        create_resp.raise_for_status()
        return create_resp.json()["id"]


async def list_files_in_folder(access_token: str, folder_name: str) -> list[dict]:
    headers = {"Authorization": f"Bearer {access_token}"}
    folder_id = await get_or_create_folder(access_token, folder_name)
    async with httpx.AsyncClient() as client:
        q = f"'{folder_id}' in parents and trashed=false"
        resp = await client.get(
            DRIVE_FILES_URL, headers=headers, params={"q": q, "fields": "files(id,name,modifiedTime)"}
        )
        resp.raise_for_status()
        return resp.json().get("files", [])


async def find_file_by_name(access_token: str, folder_id: str, name: str) -> dict | None:
    headers = {"Authorization": f"Bearer {access_token}"}
    async with httpx.AsyncClient() as client:
        q = f"'{folder_id}' in parents and name='{name}' and trashed=false"
        resp = await client.get(DRIVE_FILES_URL, headers=headers, params={"q": q, "fields": "files(id,name)"})
        resp.raise_for_status()
        files = resp.json().get("files", [])
        return files[0] if files else None


# --- JSON file helpers (templates, export mappings) ---

async def save_json_file(access_token: str, folder_name: str, filename: str, content: dict) -> dict:
    folder_id = await get_or_create_folder(access_token, folder_name)
    headers = {"Authorization": f"Bearer {access_token}"}

    existing = await find_file_by_name(access_token, folder_id, filename)

    boundary = "docscannerboundary"
    metadata = {"name": filename, "mimeType": JSON_MIME}
    if not existing:
        metadata["parents"] = [folder_id]

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
        if existing:
            resp = await client.patch(
                f"{DRIVE_UPLOAD_URL}/{existing['id']}?uploadType=multipart", headers=headers, content=body
            )
        else:
            resp = await client.post(f"{DRIVE_UPLOAD_URL}?uploadType=multipart", headers=headers, content=body)
        resp.raise_for_status()
        return resp.json()


async def get_json_file_content(access_token: str, file_id: str) -> dict:
    headers = {"Authorization": f"Bearer {access_token}"}
    async with httpx.AsyncClient() as client:
        resp = await client.get(f"{DRIVE_FILES_URL}/{file_id}", headers=headers, params={"alt": "media"})
        resp.raise_for_status()
        return resp.json()


# --- Templates (unchanged behavior, now built on the generalized helpers) ---

async def list_templates(access_token: str) -> list[dict]:
    return await list_files_in_folder(access_token, TEMPLATES_FOLDER)


async def save_template(access_token: str, filename: str, content: dict) -> dict:
    return await save_json_file(access_token, TEMPLATES_FOLDER, filename, content)


async def get_template_content(access_token: str, file_id: str) -> dict:
    return await get_json_file_content(access_token, file_id)


# --- Binary files (Excel exports) ---

async def upload_binary(access_token: str, folder_name: str, filename: str, content: bytes, mime_type: str) -> dict:
    folder_id = await get_or_create_folder(access_token, folder_name)
    headers = {"Authorization": f"Bearer {access_token}"}
    metadata = {"name": filename, "parents": [folder_id]}

    boundary = "docscannerbinary"
    # Multipart bodies here are plain text, so binary content is base64-encoded
    # inline - Drive's API explicitly supports Content-Transfer-Encoding: base64
    # for exactly this reason.
    body = (
        f"--{boundary}\r\n"
        "Content-Type: application/json; charset=UTF-8\r\n\r\n"
        f"{json.dumps(metadata)}\r\n"
        f"--{boundary}\r\n"
        f"Content-Type: {mime_type}\r\n"
        "Content-Transfer-Encoding: base64\r\n\r\n"
        f"{base64.b64encode(content).decode()}\r\n"
        f"--{boundary}--"
    )
    headers["Content-Type"] = f"multipart/related; boundary={boundary}"

    async with httpx.AsyncClient() as client:
        resp = await client.post(f"{DRIVE_UPLOAD_URL}?uploadType=multipart", headers=headers, content=body)
        resp.raise_for_status()
        return resp.json()


async def download_binary(access_token: str, file_id: str) -> bytes:
    headers = {"Authorization": f"Bearer {access_token}"}
    async with httpx.AsyncClient() as client:
        resp = await client.get(f"{DRIVE_FILES_URL}/{file_id}", headers=headers, params={"alt": "media"})
        resp.raise_for_status()
        return resp.content


async def update_binary(access_token: str, file_id: str, content: bytes, mime_type: str) -> dict:
    headers = {"Authorization": f"Bearer {access_token}", "Content-Type": mime_type}
    async with httpx.AsyncClient() as client:
        resp = await client.patch(f"{DRIVE_UPLOAD_URL}/{file_id}?uploadType=media", headers=headers, content=content)
        resp.raise_for_status()
        return resp.json()


# --- Export mappings (template <-> workbook cell-range links) ---

def _mapping_filename(template_id: str) -> str:
    return f"mapping_{template_id}.json"


async def get_mapping(access_token: str, template_id: str) -> dict | None:
    folder_id = await get_or_create_folder(access_token, MAPPINGS_FOLDER)
    file = await find_file_by_name(access_token, folder_id, _mapping_filename(template_id))
    if not file:
        return None
    return await get_json_file_content(access_token, file["id"])


async def save_mapping(access_token: str, template_id: str, mapping: dict) -> dict:
    return await save_json_file(access_token, MAPPINGS_FOLDER, _mapping_filename(template_id), mapping)


async def list_all_mappings(access_token: str) -> list[dict]:
    """Every saved mapping, regardless of template - used for the
    same-workbook collision check when someone points a new template at a
    file another template already writes to."""
    files = await list_files_in_folder(access_token, MAPPINGS_FOLDER)
    mappings = []
    for f in files:
        try:
            content = await get_json_file_content(access_token, f["id"])
            mappings.append(content)
        except Exception:
            continue  # skip anything unreadable rather than failing the whole list
    return mappings
