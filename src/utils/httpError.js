'use strict';

/** Error HTTP berstruktur: dilempar di model/service, diubah jadi JSON oleh errorHandler. */
class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
  }
}

module.exports = { HttpError };
