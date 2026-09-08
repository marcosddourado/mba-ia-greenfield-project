/**
 * Video upload/orchestration constants.
 * `public_id` uses a URL-safe fixed-length nanoid alphabet (per phase-03-videos/TD-05);
 * the `videos.public_id` column (varchar(16)) comfortably holds the 11-char id.
 */
export const PUBLIC_ID_ALPHABET =
  '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ' as const;
export const PUBLIC_ID_LENGTH = 11 as const;

/** Bounded retries when a generated `public_id` collides with an existing row. */
export const PUBLIC_ID_MAX_RETRIES = 5 as const;

/** 10 GB ceiling on a declared upload size (per phase-03-videos/TD-04). */
export const MAX_FILE_SIZE_BYTES = 10_737_418_240 as const;

/** Recommended multipart part size handed back to the browser (100 MiB). */
export const RECOMMENDED_PART_SIZE_BYTES = 100 * 1024 * 1024;
