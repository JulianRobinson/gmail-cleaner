// Just the parts of the Google Identity Services API this app uses.
// https://developers.google.com/identity/oauth2/web/reference/js-reference

declare namespace google.accounts.oauth2 {
  interface TokenResponse {
    access_token: string;
    expires_in: string;
    scope: string;
    token_type: string;
    error?: string;
    error_description?: string;
  }

  interface ClientConfigError {
    type: 'popup_failed_to_open' | 'popup_closed' | 'unknown';
    message: string;
  }

  interface TokenClientConfig {
    client_id: string;
    scope: string;
    include_granted_scopes?: boolean;
    prompt?: string;
    callback: (response: TokenResponse) => void;
    error_callback?: (error: ClientConfigError) => void;
  }

  interface OverridableTokenClientConfig {
    scope?: string;
    prompt?: string;
    include_granted_scopes?: boolean;
  }

  interface TokenClient {
    requestAccessToken(overrides?: OverridableTokenClientConfig): void;
  }

  function initTokenClient(config: TokenClientConfig): TokenClient;
  function hasGrantedAllScopes(response: TokenResponse, ...scopes: string[]): boolean;
  function revoke(accessToken: string, done?: () => void): void;
}

interface Window {
  google?: { accounts: { oauth2: typeof google.accounts.oauth2 } };
}

interface ImportMetaEnv {
  readonly VITE_GOOGLE_CLIENT_ID?: string;
}
