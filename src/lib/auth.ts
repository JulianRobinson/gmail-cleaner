// Google Identity Services token-client wrapper. Tokens live only in memory
// for the lifetime of the page; nothing is persisted.

export const MODIFY_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
/** Full mail access; the only scope that allows messages.batchDelete. */
export const FULL_SCOPE = 'https://mail.google.com/';

export interface AccessToken {
  accessToken: string;
  expiresAt: number;
  hasModify: boolean;
  hasFull: boolean;
}

export function clientId(): string {
  return import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '';
}

function waitForGis(timeoutMs = 10000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      if (window.google?.accounts?.oauth2) return resolve();
      if (Date.now() - started > timeoutMs) {
        return reject(new Error('Google sign-in library did not load. Check your network or ad blocker.'));
      }
      setTimeout(poll, 100);
    };
    poll();
  });
}

/**
 * Opens Google's consent popup for `scope`. Must be called from a user gesture
 * (a click handler) or the popup may be blocked.
 */
export async function requestToken(scope: string, prompt: '' | 'consent' | 'select_account' = ''): Promise<AccessToken> {
  const id = clientId();
  if (!id) throw new Error('VITE_GOOGLE_CLIENT_ID is not set. Copy .env.example to .env and add your client ID.');
  await waitForGis();
  const oauth2 = window.google!.accounts.oauth2;
  return new Promise((resolve, reject) => {
    const client = oauth2.initTokenClient({
      client_id: id,
      scope,
      include_granted_scopes: true,
      callback: (response) => {
        if (response.error) {
          reject(new Error(response.error_description || response.error));
          return;
        }
        resolve({
          accessToken: response.access_token,
          expiresAt: Date.now() + Number(response.expires_in) * 1000,
          hasModify: oauth2.hasGrantedAllScopes(response, MODIFY_SCOPE) || oauth2.hasGrantedAllScopes(response, FULL_SCOPE),
          hasFull: oauth2.hasGrantedAllScopes(response, FULL_SCOPE),
        });
      },
      error_callback: (error) => {
        reject(new Error(error.type === 'popup_closed' ? 'Sign-in window was closed.' : error.message || error.type));
      },
    });
    client.requestAccessToken({ prompt });
  });
}

export function revokeToken(accessToken: string): Promise<void> {
  return new Promise((resolve) => {
    const oauth2 = window.google?.accounts?.oauth2;
    if (!oauth2) return resolve();
    oauth2.revoke(accessToken, () => resolve());
  });
}
