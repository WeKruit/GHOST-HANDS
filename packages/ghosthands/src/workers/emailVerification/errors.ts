export class MissingEmailConnectionError extends Error {
  constructor(message = 'No Gmail connection found for user') {
    super(message);
    this.name = 'MissingEmailConnectionError';
  }
}

export class TokenRefreshFailedError extends Error {
  constructor(message = 'Failed to refresh Gmail access token') {
    super(message);
    this.name = 'TokenRefreshFailedError';
  }
}
