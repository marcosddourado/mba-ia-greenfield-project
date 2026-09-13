/**
 * Single source of truth for a video's object-storage key layout. Shared by the
 * API (`VideosService`, which writes the source key) and the worker
 * (`VideoProcessingProcessor`, which writes the thumbnail key) so the
 * `videos/<publicId>/…` scheme is defined in exactly one place.
 */
export function sourceKeyFor(publicId: string): string {
  return `videos/${publicId}/source`;
}

export function thumbnailKeyFor(publicId: string): string {
  return `videos/${publicId}/thumbnail.jpg`;
}
