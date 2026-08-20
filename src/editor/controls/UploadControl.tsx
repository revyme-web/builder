// UploadControl.tsx — Reusable file upload control for Code component @controls.
// SINGLE image mode opens the NATIVE media picker (ImageSearchModal — the same
// Unsplash / upload / URL modal the Fill tool and the imageList control use).
// Multi-file (image sequences) and non-image accepts (video/audio) keep the
// plain file input + direct /api/upload (R2 CDN) flow.

import { useState, useRef, useCallback } from 'react';
import { ColorSwatch } from './ColorSwatch';
import ImageSearchModal from '../ui/ImageSearchModal';
import { getProjectId } from '@/backend/project-id';
import { trace } from '@/shared/debug-trace';

interface UploadControlProps {
  value: string;
  onChange: (value: string) => void;
  /** File types to accept (default: "image/*") */
  accept?: string;
  /** Allow multiple file selection (for image sequences) */
  multiple?: boolean;
  /** R2 source folder name (default: "uploaded") */
  uploadSource?: string;
  /** Callback with total file count after batch upload (for auto-setting totalFrames) */
  onBatchComplete?: (count: number) => void;
  /** Label shown on the button */
  label?: string;
}

export default function UploadControl({
  value,
  onChange,
  accept = 'image/*',
  multiple = false,
  uploadSource = 'uploaded',
  onBatchComplete,
  label,
}: UploadControlProps) {
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Single image → full media picker; sequences/videos → raw file input.
  const usesMediaPicker = !multiple && accept.startsWith('image');

  const handleUpload = useCallback(async (files: FileList) => {
    if (files.length === 0) return;

    const websiteId = getProjectId();
    setUploading(true);
    trace.action('upload-control:start', { fileCount: files.length, multiple, uploadSource });

    try {
      if (multiple) {
        // Batch upload: upload all files, use the base URL path as value
        const sortedFiles = Array.from(files).sort((a, b) => a.name.localeCompare(b.name));
        const uploadedUrls: string[] = [];

        for (let i = 0; i < sortedFiles.length; i++) {
          const file = sortedFiles[i];
          setProgress(`${i + 1}/${sortedFiles.length}`);

          // Rename file to sequential name (frame-001.png, frame-002.png, etc.)
          // The upload API will convert to .webp but keeps the base name
          const seqName = `frame-${String(i + 1).padStart(3, '0')}.png`;
          const renamedFile = new File([file], seqName, { type: file.type });

          const formData = new FormData();
          formData.append('file', renamedFile);
          formData.append('type', 'image');
          formData.append('source', uploadSource);
          formData.append('websiteId', websiteId);

          const res = await fetch('/api/upload', { method: 'POST', body: formData });
          const data = await res.json();

          if (!res.ok) {
            trace.error('upload-control:file-failed', { file: file.name, error: data.error });
            continue;
          }

          uploadedUrls.push(data.url);
          trace.action('upload-control:file-uploaded', { file: seqName, url: data.url });
        }

        if (uploadedUrls.length > 0) {
          // Store as pipe-separated URLs (safe for JSX string attributes — no quotes)
          onChange(uploadedUrls.join('|'));
          onBatchComplete?.(uploadedUrls.length);
          trace.action('upload-control:batch-complete', { count: uploadedUrls.length });
        }
      } else {
        // Single file upload
        const file = files[0];
        setProgress('Uploading...');

        const formData = new FormData();
        formData.append('file', file);
        formData.append('type', file.type.startsWith('video/') ? 'video' : 'image');
        formData.append('source', uploadSource);
        formData.append('websiteId', websiteId);

        const res = await fetch('/api/upload', { method: 'POST', body: formData });
        const data = await res.json();

        if (res.ok && data.url) {
          onChange(data.url);
          trace.action('upload-control:uploaded', { url: data.url });
        } else {
          trace.error('upload-control:failed', { error: data.error || data.message });
        }
      }
    } catch (err) {
      trace.error('upload-control:error', { error: String(err) });
    } finally {
      setUploading(false);
      setProgress('');
    }
  }, [multiple, uploadSource, onChange, onBatchComplete]);

  // The inline preview swatch shows the FIRST image (multi = pipe-separated).
  const firstUrl = value ? value.split('|')[0] : '';

  return (
    <div className="w-full">
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        className="hidden"
        onChange={(e) => {
          if (e.target.files) handleUpload(e.target.files);
          e.target.value = ''; // reset for re-upload
        }}
      />

      {/* Mirrors the Color control: image-preview swatch + label, whole row re-uploads. */}
      <button
        type="button"
        onClick={() => {
          if (usesMediaPicker) {
            trace.action('upload-control:open-picker');
            setPickerOpen(true);
          } else {
            inputRef.current?.click();
          }
        }}
        disabled={uploading}
        title={value || undefined}
        className="w-full h-8 flex items-center gap-2 px-1 bg-[var(--grid-line)] border border-[var(--control-border)] hover:border-[var(--control-border-hover)] cut-corners cut-border hover:[--cut-border-color:var(--control-border-hover)] cursor-pointer transition-colors min-w-0 overflow-hidden disabled:opacity-60"
      >
        <ColorSwatch
          style={firstUrl
            ? { backgroundColor: '#ffffff', backgroundImage: `url("${firstUrl}")`, backgroundSize: 'contain', backgroundPosition: 'center', backgroundRepeat: 'no-repeat' }
            : { backgroundColor: 'var(--grid-line)' }}
        />
        <span className="text-xs text-[var(--text-primary)] truncate flex-1 text-left">
          {uploading
            ? `Uploading ${progress}`
            : value
              ? (label || 'Change')
              : (label || (multiple ? 'Upload Files' : 'Choose image'))}
        </span>
      </button>

      {/* Native media picker (Unsplash / upload / URL) — self-closes on select. */}
      {usesMediaPicker && (
        <ImageSearchModal
          isOpen={pickerOpen}
          onClose={() => setPickerOpen(false)}
          onSelect={(url) => {
            onChange(url);
            trace.action('upload-control:picked', { url: url.slice(0, 80) });
          }}
        />
      )}
    </div>
  );
}
