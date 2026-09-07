---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.7
target_file: test/videos-upload.e2e-spec.ts
---

# Video Upload Handshake Test Plan

## Application Overview

`POST /videos` pre-registers a draft video under the authenticated user's channel and initiates a masked-gateway multipart upload: it generates the opaque `publicId` (nanoid), creates the `Video` in `draft` status, calls `CreateMultipartUpload` against storage, and returns the `uploadId` plus recommended part sizing. The remaining three routes drive the resumable transfer without the API ever touching the bytes: `POST /videos/:publicId/upload/part-urls` issues presigned `UploadPart` URLs against the **public gateway host** (never `minio:9000`), `POST /videos/:publicId/upload/complete` finalizes the multipart upload with client-collected ETags and transitions the video to `processing` (enqueuing the `video-processing` job), and `DELETE /videos/:publicId/upload` aborts an in-progress upload. All four routes require a valid JWT access token; the three per-video routes additionally require channel ownership.

## Test Scenarios

### 1. Draft pre-registration (POST /videos)

**Setup:** `beforeEach` truncates `videos`, `channels`, `users` (reverse-FK order); bootstrap the app via `Test.createTestingModule({ imports: [AppModule] }).compile()` and re-apply `main.ts` global config (`ValidationPipe`, domain exception filters). Seed one confirmed user with a channel and obtain an access token through the auth login flow.

#### 1.1. creates-draft-and-initiates-multipart-upload

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-09-06T23:28:06Z

**Steps:**
  1. POST /videos with a valid Bearer access token and body `{ filename: "clip.mp4", contentType: "video/mp4", sizeBytes: 52428800, title: "My clip" }`
    - expect: HTTP 201
    - expect: response body contains a non-empty `publicId` (nanoid alphabet/length)
    - expect: response body `status` equals `"draft"`
    - expect: response body contains a non-empty `uploadId` (storage multipart UploadId)
    - expect: response body contains numeric `partSize` and `partCount`
    - expect: a `videos` row exists with `status = 'draft'`, a persisted `upload_id`, and `channel_id` pointing to the seeded user's channel

#### 1.2. rejects-file-exceeding-10gb-ceiling

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-09-06T23:28:06Z

**Steps:**
  1. POST /videos with a valid access token and body `{ filename: "huge.mp4", contentType: "video/mp4", sizeBytes: 10737418241 }` (one byte over the 10 GB ceiling)
    - expect: HTTP 400
    - expect: response body `error` equals `"FILE_TOO_LARGE"`
    - expect: response body shape is `{ statusCode, error, message }`
    - expect: no `videos` row was created

#### 1.3. rejects-non-video-content-type

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-09-06T23:28:06Z

**Steps:**
  1. POST /videos with a valid access token and body `{ filename: "doc.pdf", contentType: "application/pdf", sizeBytes: 1024 }`
    - expect: HTTP 415
    - expect: response body `error` equals `"UNSUPPORTED_MEDIA_TYPE"`
    - expect: no `videos` row was created

#### 1.4. rejects-unauthenticated-upload-request

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-09-06T23:28:06Z

**Steps:**
  1. POST /videos with NO Authorization header and body `{ filename: "clip.mp4", contentType: "video/mp4", sizeBytes: 1024 }`
    - expect: HTTP 401
    - expect: no `videos` row was created

### 2. Upload handshake (part-urls, complete, abort)

**Setup:** same bootstrap as group 1. Additionally seed a `draft` video owned by the primary user's channel (created via `POST /videos`, capturing its `publicId`). For non-owner scenarios, seed a second confirmed user with their own channel and access token.

#### 2.1. issues-presigned-part-urls-against-public-gateway

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-09-06T23:28:06Z

**Steps:**
  1. POST /videos/:publicId/upload/part-urls (owner token) with body `{ partNumbers: [1, 2, 3] }`
    - expect: HTTP 200
    - expect: response `parts` is an array of length 3, each `{ partNumber, url }`
    - expect: every `url` targets the public gateway host (from `STORAGE_PUBLIC_HOST`) and NOT `minio:9000`
    - expect: response contains an ISO-8601 `expiresAt`

#### 2.2. owner-completes-upload-and-transitions-to-processing

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-09-06T23:28:06Z

**Steps:**
  1. POST /videos/:publicId/upload/complete (owner token) with body `{ parts: [{ partNumber: 1, eTag: "\"etag-1\"" }] }`
    - expect: HTTP 200
    - expect: response body `publicId` matches the video
    - expect: response body `status` equals `"processing"`
    - expect: the `videos` row transitioned to `status = 'processing'` and its `upload_id` was cleared
    - expect: a `video-processing` job was enqueued carrying the video's internal `videoId`

#### 2.3. rejects-complete-by-authenticated-non-owner

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-09-06T23:28:06Z

**Steps:**
  1. POST /videos/:publicId/upload/complete with the SECOND user's (non-owner) access token and body `{ parts: [{ partNumber: 1, eTag: "\"etag-1\"" }] }`
    - expect: HTTP 403
    - expect: response body `error` equals `"FORBIDDEN_NOT_OWNER"`
    - expect: the video's `status` is unchanged (still `draft`)
