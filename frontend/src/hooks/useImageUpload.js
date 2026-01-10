import { useState, useCallback, useRef } from 'react';
import { uploadScreenshot } from '../utils/api';

/**
 * Hook to handle image upload, drag-drop, and file input for terminal.
 */
export function useImageUpload(onUploadSuccess) {
  const [imageDragOver, setImageDragOver] = useState(false);
  const imageInputRef = useRef(null);

  const handleImageUpload = useCallback(async (file) => {
    if (!file) return;
    try {
      const path = await uploadScreenshot(file);
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
    const imageFile = files.find(f => f.type.startsWith('image/'));
    if (imageFile) {
      handleImageUpload(imageFile);
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
    if (file && file.type.startsWith('image/')) {
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
