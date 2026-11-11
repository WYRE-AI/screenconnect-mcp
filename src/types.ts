export interface ScreenConnectCredentials {
  baseUrl: string;
  apiSecret: string;
  origin?: string;
  extensionId?: string;
}
export class ScreenConnectApiError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}
export class ScreenConnectAuthError extends ScreenConnectApiError {}
export class ScreenConnectNotFoundError extends ScreenConnectApiError {}
export class ArgumentError extends Error {}
export class UnsafeBaseUrlError extends Error {}
