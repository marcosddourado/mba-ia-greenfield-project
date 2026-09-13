import { DomainException } from '../../common/exceptions/domain.exception';

/**
 * Video-domain exceptions, mapped to HTTP by the inherited Custom Domain
 * Exception Filter (phase-02-auth/TD-07) into `{ statusCode, error, message }`.
 * The `error` field carries the machine-readable code (see the phase-03 Error
 * Catalog). Class names follow the phase-02 `...Exception` suffix convention.
 */

export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

export class ForbiddenNotOwnerException extends DomainException {
  constructor() {
    super('FORBIDDEN_NOT_OWNER', 403, 'You are not the owner of this video');
  }
}

export class UploadNotInProgressException extends DomainException {
  constructor() {
    super('UPLOAD_NOT_IN_PROGRESS', 409, 'The video has no upload in progress');
  }
}

export class FileTooLargeException extends DomainException {
  constructor() {
    super('FILE_TOO_LARGE', 400, 'The file exceeds the maximum allowed size');
  }
}

export class UnsupportedMediaTypeException extends DomainException {
  constructor() {
    super('UNSUPPORTED_MEDIA_TYPE', 415, 'The content type is not supported');
  }
}

export class InvalidPartsException extends DomainException {
  constructor() {
    super('INVALID_PARTS', 400, 'The upload part manifest is invalid');
  }
}

export class VideoNotReadyException extends DomainException {
  constructor() {
    super('VIDEO_NOT_READY', 409, 'The video is not ready');
  }
}
