//! OpenAPI contract types

export interface ApiError {
  error: string;
  message?: string;
}

export interface HealthResponse {
  status: 'ok';
  version: string;
}
