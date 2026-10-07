export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export class AuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthorizationError";
  }
}

export class CredentialDenied extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialDenied";
  }
}
