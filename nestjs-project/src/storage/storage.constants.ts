// Lifetime (in seconds) of every presigned URL the API hands to the browser.
// One hour comfortably covers a large multipart part upload or a stream/download.
export const PRESIGN_EXPIRES_IN_SECONDS = 3600 as const;
