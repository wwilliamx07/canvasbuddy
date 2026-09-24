import { beforeEach, describe, expect, it } from 'vitest';
import { accessTokenFor, discoverIssuer, parseBearerChallenge, signIn } from '../../src/connections/oauth';
import { dropSession, listTools } from '../../src/connections/mcp';
import { getConnection, type OAuthState } from '../../src/connections/store';
import { chromeState } from '../setup';
import { AUTH_ORIGIN, MCP_URL, storeConnection, stubMcp } from '../helpers/mcp';

beforeEach(() => dropSession('conn-1'));

const base64url = (bytes: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A consent screen that approves: answers the redirect URI with a code and the request's state. */
function approve(code = 'auth-code') {
  const seen: URL[] = [];
  chromeState.authFlow = (url) => {
    const u = new URL(url);
    seen.push(u);
    return `${u.searchParams.get('redirect_uri')}?code=${code}&state=${u.searchParams.get('state')}`;
  };
  return seen;
}

const auth = (over: Partial<OAuthState> = {}): OAuthState => ({
  resource: MCP_URL,
  issuer: AUTH_ORIGIN,
  authorizationEndpoint: `${AUTH_ORIGIN}/authorize`,
  tokenEndpoint: `${AUTH_ORIGIN}/token`,
  clientId: 'client-123',
  accessToken: 'access-0',
  refreshToken: 'refresh-0',
  expiresAt: Date.now() + 3_600_000,
  ...over,
});

describe('discovery', () => {
  it('parses the bearer challenge', () => {
    expect(parseBearerChallenge('Bearer resource_metadata="https://x.test/m", scope="a b"')).toEqual({ resourceMetadata: 'https://x.test/m', scope: 'a b' });
    expect(parseBearerChallenge(null)).toEqual({});
  });

  it('follows resource_metadata to the authorization server; the challenge scope wins', async () => {
    stubMcp();
    expect(await discoverIssuer(MCP_URL, 'Bearer resource_metadata="https://mcp.test/.well-known/oauth-protected-resource/mcp", scope="read"')).toEqual({
      issuer: AUTH_ORIGIN,
      scope: 'read',
    });
  });

  it('finds the metadata at the well-known path without a challenge, with its supported scopes', async () => {
    stubMcp();
    expect(await discoverIssuer(MCP_URL, null)).toEqual({ issuer: AUTH_ORIGIN, scope: 'everything' });
  });

  it('falls back to the server origin when nothing is published', async () => {
    stubMcp({ resourceMetadata: false });
    expect(await discoverIssuer(MCP_URL, null)).toEqual({ issuer: 'https://mcp.test', scope: undefined });
  });
});

describe('signIn', () => {
  it('registers, runs authorization code + PKCE in the auth window, and exchanges the code', async () => {
    const server = stubMcp();
    const seen = approve();
    const connection = await storeConnection({ status: 'needs-auth', authIssuer: AUTH_ORIGIN, authScope: 'read write' });
    const result = await signIn(connection);

    expect(server.registrations[0]).toMatchObject({
      client_name: 'CanvasBuddy',
      redirect_uris: ['https://testextensionid.chromiumapp.org/oauth'],
      token_endpoint_auth_method: 'none',
    });

    const authorize = seen[0];
    expect(authorize.origin + authorize.pathname).toBe(`${AUTH_ORIGIN}/authorize`);
    expect(Object.fromEntries(authorize.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: 'client-123',
      code_challenge_method: 'S256',
      resource: MCP_URL,
      scope: 'read write',
    });

    const token = server.tokenRequests[0];
    expect(Object.fromEntries(token)).toMatchObject({
      grant_type: 'authorization_code',
      code: 'auth-code',
      client_id: 'client-123',
      redirect_uri: 'https://testextensionid.chromiumapp.org/oauth',
      resource: MCP_URL,
    });
    // The verifier sent to the token endpoint hashes to the challenge sent to the consent screen
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token.get('code_verifier')!));
    expect(base64url(digest)).toBe(authorize.searchParams.get('code_challenge'));

    expect(result).toMatchObject({ accessToken: 'access-1', refreshToken: 'refresh-1', clientId: 'client-123', issuer: AUTH_ORIGIN, resource: MCP_URL });
    expect(result.expiresAt).toBeGreaterThan(Date.now());
  });

  it('reuses the client registered with the same issuer', async () => {
    const server = stubMcp();
    approve();
    await signIn(await storeConnection({ authIssuer: AUTH_ORIGIN, auth: auth({ clientId: 'kept' }) }));
    expect(server.registrations).toHaveLength(0);
    expect(server.tokenRequests[0].get('client_id')).toBe('kept');
  });

  it('refuses an answer for a different request (state mismatch)', async () => {
    stubMcp();
    chromeState.authFlow = (url) => `${new URL(url).searchParams.get('redirect_uri')}?code=x&state=forged`;
    await expect(signIn(await storeConnection({ authIssuer: AUTH_ORIGIN }))).rejects.toThrow(/different request/);
  });

  it('reports a denied consent and a closed window', async () => {
    stubMcp();
    chromeState.authFlow = (url) => `${new URL(url).searchParams.get('redirect_uri')}?error=access_denied&error_description=User+said+no`;
    await expect(signIn(await storeConnection({ authIssuer: AUTH_ORIGIN }))).rejects.toThrow('Sign-in failed: User said no');
    chromeState.authFlow = null;
    await expect(signIn(await storeConnection({ id: 'conn-2', authIssuer: AUTH_ORIGIN }))).rejects.toThrow(/Sign-in did not finish/);
  });

  it('cannot sign in where apps may not register', async () => {
    stubMcp({ registration: false });
    approve();
    await expect(signIn(await storeConnection({ authIssuer: AUTH_ORIGIN }))).rejects.toThrow(/does not let apps register/);
  });
});

describe('tokens', () => {
  it('uses a valid token without asking the token endpoint', async () => {
    const server = stubMcp();
    expect(await accessTokenFor(await storeConnection({ auth: auth() }))).toBe('access-0');
    expect(server.tokenRequests).toHaveLength(0);
  });

  it('refreshes a token about to expire, binding it to the resource, and stores the rotation', async () => {
    const server = stubMcp();
    const connection = await storeConnection({ auth: auth({ expiresAt: Date.now() + 30_000 }) });
    expect(await accessTokenFor(connection)).toBe('access-1');
    expect(Object.fromEntries(server.tokenRequests[0])).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'refresh-0', resource: MCP_URL, client_id: 'client-123' });
    expect((await getConnection('conn-1'))?.auth).toMatchObject({ accessToken: 'access-1', refreshToken: 'refresh-1' });
  });

  it('a failed refresh means signing in again', async () => {
    stubMcp();
    expect(await accessTokenFor(await storeConnection({ auth: auth({ expiresAt: 0, refreshToken: 'revoked' }) }))).toBeNull();
    expect(await accessTokenFor(await storeConnection({ id: 'conn-2', auth: auth({ accessToken: undefined }) }))).toBeNull();
  });

  it('a 401 on a live token forces one refresh and retries', async () => {
    const server = stubMcp({ tools: [{ name: 'search' }] });
    server.token = 'access-1'; // the server revoked access-0; a refresh yields access-1
    const connection = await storeConnection({ auth: auth() });
    expect(await listTools(connection)).toHaveLength(1);
    expect(server.tokenRequests).toHaveLength(1);
    expect(server.requests.filter((r) => r.method === 'initialize').map((r) => r.headers.authorization)).toEqual(['Bearer access-0', 'Bearer access-1']);
  });
});
