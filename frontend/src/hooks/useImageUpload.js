import { useState, useCallback, useRef } from 'react';
import { uploadScreenshot } from '../utils/api';
import { normalizeClipboardImageCandidate } from '../utils/clipboardImage';

/**
 * Hook to handle image upload, drag-drop, and file input for terminal.
 */
export function useImageUpload(onUploadSuccess) {
  const [imageDragOver, setImageDragOver] = useState(false);
  const imageInputRef = useRef(null);

  const handleImageUpload = useCallback(async (file) => {
    if (!file) return;
    try {
      const normalized = await normalizeClipboardImageCandidate(file);
      if (!normalized) return;
      const path = await uploadScreenshot(normalized);
      if (path) {
        onUploadSuccess?.(path + ' ');
      }
    } catch (err) {
      console.error('[useImageUpload] Screenshot upload failed:', err);
    }
  }, [onUploadSuccess]);

  const handleImageDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setImageDragOver(false);

    const files = Array.from(e.dataTransfer?.files || []);
    const candidate = files.find((file) => (
      (file.type && file.type.startsWith('image/')) ||
      /\.(png|jpe?g|gif|webp|heic|heif|avif|tiff?|bmp)$/i.test(file.name || '') ||
      !file.type
    ));
    if (candidate) {
      handleImageUpload(candidate);
    }
  }, [handleImageUpload]);

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer?.types?.includes('Files')) {
      setImageDragOver(true);
    }
  }, []);

  const handleDragLeave = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setImageDragOver(false);
  }, []);

  const handleImageSelect = useCallback((e) => {
    const file = e.target?.files?.[0];
    if (file) {
      handleImageUpload(file);
    }
    // Reset input so same file can be selected again
    if (e.target) e.target.value = '';
  }, [handleImageUpload]);

  const triggerFileInput = useCallback(() => {
    imageInputRef.current?.click();
  }, []);

  return {
    imageDragOver,
    imageInputRef,
    handleImageUpload,
    handleImageDrop,
    handleDragOver,
    handleDragLeave,
    handleImageSelect,
    triggerFileInput
  };
}
