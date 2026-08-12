import { useState } from 'react';
import { API_BASE_URL } from '../config.js';
import './MobileCapture.css';

export default function MobileCapture({ pairingId }) {
  const [status, setStatus] = useState('idle'); // idle | uploading | error
  const [count, setCount] = useState(0);
  const [selectedFiles, setSelectedFiles] = useState([]); // chosen from gallery, awaiting explicit upload
  const [galleryUploading, setGalleryUploading] = useState(false);
  const [galleryProgress, setGalleryProgress] = useState(null); // "2 of 5" while uploading

  const uploadOne = async (file) => {
    const form = new FormData();
    form.append('file', file, file.name);
    // No auth header here - the pairing code itself is the permission,
    // matching the whole point of not requiring a phone login.
    const res = await fetch(`${API_BASE_URL}/pairing/${pairingId}/upload`, {
      method: 'POST',
      body: form,
    });
    if (!res.ok) throw new Error('Upload failed');
  };

  // Camera capture uploads immediately, one at a time - this already
  // worked well as an in-the-moment scanning flow (take photo, see it
  // land on desktop, take the next one).
  const handleCameraCapture = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setStatus('uploading');
    try {
      await uploadOne(file);
      setCount((c) => c + 1);
      setStatus('idle');
    } catch (err) {
      console.error(err);
      setStatus('error');
    } finally {
      e.target.value = '';
    }
  };

  // Gallery selection is different: multiple existing files picked at
  // once shouldn't fire off silently - the person should see what's
  // selected and explicitly confirm before it sends.
  const handleGalleryPick = (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length > 0) setSelectedFiles((prev) => [...prev, ...files]);
    e.target.value = '';
  };

  const removeSelected = (index) => {
    setSelectedFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const uploadSelectedFiles = async () => {
    if (selectedFiles.length === 0) return;
    setGalleryUploading(true);
    try {
      for (let i = 0; i < selectedFiles.length; i++) {
        setGalleryProgress(`${i + 1} of ${selectedFiles.length}`);
        await uploadOne(selectedFiles[i]);
        setCount((c) => c + 1);
      }
      setSelectedFiles([]);
    } catch (err) {
      console.error(err);
      setStatus('error');
    } finally {
      setGalleryUploading(false);
      setGalleryProgress(null);
    }
  };

  if (!pairingId) {
    return (
      <div className="mobile-capture-page">
        <p className="capture-error">Missing pairing code — scan the QR code again from your computer.</p>
      </div>
    );
  }

  return (
    <div className="mobile-capture-page">
      <div className="capture-brand">
        <span className="brand-mark" />
        Document Scanner
      </div>
      <p className="capture-connected">Connected to your computer</p>

      <div className="capture-buttons">
        <label className={`capture-btn ${status === 'uploading' ? 'busy' : ''}`}>
          {status === 'uploading' ? 'Uploading…' : 'Take Photo'}
          <input
            type="file"
            accept="image/*"
            capture="environment"
            hidden
            onChange={handleCameraCapture}
            disabled={status === 'uploading'}
          />
        </label>

        <label className="capture-btn secondary">
          Choose from Files
          <input
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={handleGalleryPick}
          />
        </label>
      </div>

      {selectedFiles.length > 0 && (
        <div className="selected-files-panel">
          <p className="mono-label">{selectedFiles.length} FILE{selectedFiles.length === 1 ? '' : 'S'} SELECTED</p>
          <ul className="selected-files-list">
            {selectedFiles.map((f, i) => (
              <li key={i}>
                <span>{f.name}</span>
                <button onClick={() => removeSelected(i)} disabled={galleryUploading}>×</button>
              </li>
            ))}
          </ul>
          <button className="upload-btn" onClick={uploadSelectedFiles} disabled={galleryUploading}>
            {galleryUploading
              ? `Uploading ${galleryProgress}…`
              : `Upload ${selectedFiles.length} photo${selectedFiles.length === 1 ? '' : 's'}`}
          </button>
        </div>
      )}

      {status === 'error' && (
        <p className="capture-error">Upload failed — check your connection and try again.</p>
      )}

      {count > 0 && (
        <div className="capture-done-panel">
          <p className="capture-success">✓ Sent to your computer ({count} so far)</p>
          <p className="capture-hint">You can keep adding photos, or you're done — it's safe to close this tab.</p>
        </div>
      )}

      {count === 0 && (
        <p className="capture-hint">Take a photo, or choose one or more existing photos from your gallery.</p>
      )}
    </div>
  );
}
