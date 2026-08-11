import { useState } from 'react';
import { API_BASE_URL } from '../config.js';
import './MobileCapture.css';

export default function MobileCapture({ pairingId }) {
  const [status, setStatus] = useState('idle'); // idle | uploading | uploaded | error
  const [count, setCount] = useState(0);

  const handleCapture = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setStatus('uploading');

    try {
      const form = new FormData();
      form.append('file', file, file.name);
      // No auth header here - the pairing code itself is the permission,
      // matching the whole point of not requiring a phone login.
      const res = await fetch(`${API_BASE_URL}/pairing/${pairingId}/upload`, {
        method: 'POST',
        body: form,
      });
      if (!res.ok) throw new Error('Upload failed');
      setCount((c) => c + 1);
      setStatus('uploaded');
    } catch (err) {
      console.error(err);
      setStatus('error');
    } finally {
      e.target.value = ''; // lets the same input be used again for the next photo
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

      <label className={`capture-btn ${status === 'uploading' ? 'busy' : ''}`}>
        {status === 'uploading' ? 'Uploading…' : 'Take Photo'}
        <input
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          onChange={handleCapture}
          disabled={status === 'uploading'}
        />
      </label>

      {status === 'uploaded' && (
        <p className="capture-success">✓ Sent to your computer ({count} so far)</p>
      )}
      {status === 'error' && (
        <p className="capture-error">Upload failed — check your connection and try again.</p>
      )}

      <p className="capture-hint">You can take more than one photo — each one sends automatically.</p>
    </div>
  );
}
