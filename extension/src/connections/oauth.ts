import { updateConnection, type ConnectionRecord, type OAuthState } from './store';

/**
 * MCP authorization, as the spec lays it out for a public client: the server's 401 names its
 * protected-resource metadata (RFC 9728), which names the authorization server; that server's
 * metadata (RFC 8414 / OIDC discovery) gives the endpoints; CanvasBuddy registers itself there
 * (RFC 7591 dynamic client registration, no secret) and signs in with authorization code + PKCE in
 * a `chrome.identity.launchWebAuthFlow` window. Tokens are bound to the MCP server with the
 * RFC 8707 `resource` parameter and refreshed when they expire.
 *
 * Fetches to the server's and the authorization server's origins need those origins granted; the
 * caller requests them from the click that starts the flow (Chrome only prompts from a gesture).
 */

async function getJson(url: string): Promise<any | null> {
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/** `Bearer resource_metadata="https://…", scope="a b"` → its parameters. */
export function parseBearerChallenge(header: string | null): { resourceMetadata?: string; scope?: string } {
  if (!header) return {};
  const param = (key: string) => new RegExp(`${key}="([^"]*)"`, 'i').exec(header)?.[1];
  return { resourceMetadata: param('resource_metadata'), scope: param('scope') };
}

/**
 * The authorization server guarding this MCP server, and the scope to ask for. Servers written
 * before RFC 9728 was adopted publish no resource metadata; their own origin is the issuer then.
 */
export async function discoverIssuer(serverUrl: string, challenge: string | null): Promise<{ issuer: string; scope?: string }> {
  const { resourceMetadata, scope } = parseBearerChallenge(challenge);
  const url = new URL(serverUrl);
  const path = url.pathname.replace(/\/$/, '');
  const candidates = [
    resourceMetadata,
    path ? `${url.origin}/.well-known/oauth-protected-resource${path}` : undefined,
    `${url.origin}/.well-known/oauth-protected-resource`,
  ].filter((c): c is string => Boolean(c));
  for (const candidate of candidates) {
    const metadata = await getJson(candidate);
    const issuer = metadata?.authorization_servers?.[0];
    if (typeof issuer === 'string') {
      const supported = Array.isArray(metadata.scopes_supported) ? metadata.scopes_supported.join(' ') : undefined;
      return { issuer, scope: scope ?? supported };
    }
  }
  return { issuer: url.origin, scope };
}

interface AuthServerMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
}

async function authServerMetadata(issuer: string): Promise<AuthServerMetadata> {
  const url = new URL(issuer);
  const path = url.pathname.replace(/\/$/, '');
  const candidates = path
    ? [
        `${url.origin}/.well-known/oauth-authorization-server${path}`,
        `${url.origin}/.well-known/openid-configuration${path}`,
        `${url.origin}${path}/.well-known/openid-configuration`,
      ]
    : [`${url.origin}/.well-known/oauth-authorization-server`, `${url.origin}/.well-known/openid-configuration`];
  for (const candidate of candidates) {
    const metadata = await getJson(candidate);
    if (metadata?.authorization_endpoint && metadata?.token_endpoint) return metadata;
  }
  // The first MCP auth spec let servers publish no metadata and use these default paths
  return { authorization_endpoint: `${url.origin}/authorize`, token_endpoint: `${url.origin}/token`, registration_endpoint: `${url.origin}/register` };
}

/**
 * The endpoints sign-in fetches besides the issuer's metadata. They can sit on another origin
 * (Composio: `login.composio.dev` behind `connect.composio.dev`) that answers without CORS headers,
 * so the Sign in click asks for their origins too.
 */
export async function authEndpoints(issuer: string): Promise<string[]> {
  const metadata = await authServerMetadata(issuer);
  return [metadata.token_endpoint, metadata.registration_endpoint].filter((u): u is string => Boolean(u));
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const randomToken = (bytes: number) => base64url(crypto.getRandomValues(new Uint8Array(bytes)));

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

async function registerClient(endpoint: string, redirectUri: string): Promise<Pick<OAuthState, 'clientId' | 'clientSecret' | 'tokenAuthMethod'>> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_name: 'CanvasBuddy',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.client_id) {
    const reason = body?.error_description || body?.error || `${response.status} ${response.statusText}`;
    throw new Error(`Registering CanvasBuddy with ${new URL(endpoint).host} failed: ${reason}`);
  }
  return { clientId: body.client_id, clientSecret: body.client_secret, tokenAuthMethod: body.token_endpoint_auth_method };
}

type TokenClient = Pick<OAuthState, 'tokenEndpoint' | 'clientId' | 'clientSecret' | 'tokenAuthMethod' | 'resource'>;

async function tokenRequest(client: TokenClient, params: Record<string, string>): Promise<Pick<OAuthState, 'accessToken' | 'refreshToken' | 'expiresAt'>> {
  const body = new URLSearchParams({ ...params, resource: client.resource });
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
  if (client.clientSecret && client.tokenAuthMethod === 'client_secret_basic') {
    headers.Authorization = `Basic ${btoa(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`)}`;
  } else {
    body.set('client_id', client.clientId);
    if (client.clientSecret) body.set('client_secret', client.clientSecret);
  }
  const response = await fetch(client.tokenEndpoint, { method: 'POST', headers, body });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.access_token) {
    throw new Error(data?.error_description || data?.error || `the token endpoint answered ${response.status}`);
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: typeof data.expires_in === 'number' ? Date.now() + data.expires_in * 1000 : undefined,
  };
}

/**
 * The interactive sign-in. Reuses the client registered earlier with the same issuer; opens the
 * provider's consent page in a Chrome auth window and exchanges the code for tokens.
 */
export async function signIn(connection: ConnectionRecord): Promise<OAuthState> {
  const issuer = connection.authIssuer ?? (await discoverIssuer(connection.url, null)).issuer;
  const metadata = await authServerMetadata(issuer);
  const redirectUri = chrome.identity.getRedirectURL('oauth');

  const client =
    connection.auth?.issuer === issuer
      ? { clientId: connection.auth.clientId, clientSecret: connection.auth.clientSecret, tokenAuthMethod: connection.auth.tokenAuthMethod }
      : metadata.registration_endpoint
        ? await registerClient(metadata.registration_endpoint, redirectUri)
        : null;
  if (!client) throw new Error(`${new URL(issuer).host} does not let apps register themselves, so CanvasBuddy cannot sign in to it.`);

  const verifier = randomToken(48);
  const state = randomToken(16);
  const scope = connection.authScope ?? connection.auth?.scope;
  const authUrl = new URL(metadata.authorization_endpoint);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', client.clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('code_challenge', await pkceChallenge(verifier));
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('resource', connection.url);
  if (scope) authUrl.searchParams.set('scope', scope);

  let responseUrl: string | undefined;
  try {
    responseUrl = await chrome.identity.launchWebAuthFlow({ url: authUrl.toString(), interactive: true });
  } catch (e) {
    throw new Error(`Sign-in did not finish: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!responseUrl) throw new Error('Sign-in was cancelled.');
  const answer = new URL(responseUrl).searchParams;
  if (answer.get('error')) throw new Error(`Sign-in failed: ${answer.get('error_description') || answer.get('error')}`);
  if (answer.get('state') !== state) throw new Error('Sign-in answered a different request. Try again.');
  const code = answer.get('code');
  if (!code) throw new Error('Sign-in returned no authorization code.');

  const base: OAuthState = {
    resource: connection.url,
    issuer,
    authorizationEndpoint: metadata.authorization_endpoint,
    tokenEndpoint: metadata.token_endpoint,
    ...client,
    ...(scope ? { scope } : {}),
  };
  const tokens = await tokenRequest(base, { grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier });
  return { ...base, ...tokens };
}

/**
 * A usable access token for the connection: the stored one, or a refreshed one when it has
 * expired (or `force`, after the server rejected it). Null means the user has to sign in again.
 */
export async function accessTokenFor(connection: ConnectionRecord, force = false): Promise<string | null> {
  const auth = connection.auth;
  if (!auth?.accessToken) return null;
  const expired = auth.expiresAt !== undefined && auth.expiresAt - 60_000 < Date.now();
  if (!expired && !force) return auth.accessToken;
  if (!auth.refreshToken) return null;
  try {
    const tokens = await tokenRequest(auth, { grant_type: 'refresh_token', refresh_token: auth.refreshToken });
    const next: OAuthState = { ...auth, ...tokens, refreshToken: tokens.refreshToken ?? auth.refreshToken };
    await updateConnection(connection.id, { auth: next });
    return next.accessToken ?? null;
  } catch {
    return null;
  }
}
