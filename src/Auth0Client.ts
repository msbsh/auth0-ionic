import Lock from 'browser-tabs-lock';

import {
  bufferToBase64UrlEncoded,
  createQueryParams,
  createRandomString,
  encode,
  oauthToken,
  parseQueryResult,
  sha256,
  validateCrypto
} from './utils';

import { getUniqueScopes } from './scope';
import { ICache, IonicStorage } from './cache';
import TransactionManager from './transaction-manager';
import { verify as verifyIdToken } from './jwt';
import { AuthenticationError } from './errors';
import * as ClientStorage from './storage';

import {
  CACHE_LOCATION_IONIC,
  DEFAULT_SCOPE,
  RECOVERABLE_ERRORS
} from './constants';

import version from './version';

import {
  Auth0ClientOptions,
  AuthorizeOptions,
  BaseLoginOptions,
  CacheLocation,
  GetIdTokenClaimsOptions,
  GetTokenSilentlyOptions,
  GetUserOptions,
  LogoutOptions,
  OAuthTokenOptions,
  RedirectLoginOptions,
  RedirectLoginResult,
  RefreshTokenOptions
} from './global';
// @ts-ignore

/**
 * @ignore
 */
const lock = new Lock();

/**
 * @ignore
 */
const GET_TOKEN_SILENTLY_LOCK_KEY = 'auth0.lock.getTokenSilently';

/**
 * @ignore
 */
const cacheLocationBuilders = {
  ionic: () => new IonicStorage()
};

/**
 * @ignore
 */
const cacheFactory = (location: string) => {
  return cacheLocationBuilders[location];
};

/**
 * Auth0 SDK for Single Page Applications using [Authorization Code Grant Flow with PKCE](https://auth0.com/docs/api-auth/tutorials/authorization-code-grant-pkce).
 */
export default class Auth0Client {
  private cache: ICache;
  private transactionManager: TransactionManager;
  private readonly domainUrl: string;
  private readonly tokenIssuer: string;
  private readonly defaultScope: string;
  private readonly scope: string;

  cacheLocation: CacheLocation;
  private worker: Worker;

  constructor(private options: Auth0ClientOptions) {
    typeof window !== 'undefined' && validateCrypto();
    this.cacheLocation = CACHE_LOCATION_IONIC;

    if (!cacheFactory(this.cacheLocation)) {
      throw new Error(`Invalid cache location "${this.cacheLocation}"`);
    }

    this.cache = cacheFactory(this.cacheLocation)();
    this.scope = this.options.scope;
    this.transactionManager = new TransactionManager();
    this.domainUrl = `https://${this.options.domain}`;

    this.tokenIssuer = this.options.issuer
      ? `https://${this.options.issuer}/`
      : `${this.domainUrl}/`;

    this.defaultScope = getUniqueScopes(
      'openid',
      this.options?.advancedOptions?.defaultScope !== undefined
        ? this.options.advancedOptions.defaultScope
        : DEFAULT_SCOPE
    );

    // If using refresh tokens, automatically specify the `offline_access` scope.
    // Note we cannot add this to 'defaultScope' above as the scopes are used in the
    // cache keys - changing the order could invalidate the keys
    if (this.options.useRefreshTokens) {
      this.scope = getUniqueScopes(this.scope, 'offline_access');
    }
  }

  private _url(path) {
    const auth0Client = encodeURIComponent(
      btoa(
        JSON.stringify(
          this.options.auth0Client || {
            name: 'auth0-spa-js',
            version: version
          }
        )
      )
    );
    return `${this.domainUrl}${path}&auth0Client=${auth0Client}`;
  }

  private _getParams(
    authorizeOptions: BaseLoginOptions,
    state: string,
    nonce: string,
    code_challenge: string,
    redirect_uri: string
  ): AuthorizeOptions {
    const {
      domain,
      leeway,
      useRefreshTokens,
      auth0Client,
      cacheLocation,
      advancedOptions,
      ...withoutDomain
    } = this.options;

    return {
      ...withoutDomain,
      ...authorizeOptions,
      scope: getUniqueScopes(
        this.defaultScope,
        this.scope,
        authorizeOptions.scope
      ),
      response_type: 'code',
      response_mode: 'query',
      state,
      nonce,
      redirect_uri: redirect_uri || this.options.redirect_uri,
      code_challenge,
      code_challenge_method: 'S256'
    };
  }
  private _authorizeUrl(authorizeOptions: AuthorizeOptions) {
    return this._url(`/authorize?${createQueryParams(authorizeOptions)}`);
  }

  private _verifyIdToken(id_token: string, nonce?: string) {
    return verifyIdToken({
      iss: this.tokenIssuer,
      aud: this.options.client_id,
      id_token,
      nonce,
      leeway: this.options.leeway,
      max_age: Auth0Client._parseNumber(this.options.max_age)
    });
  }

  private static _parseNumber(value: any): number {
    if (typeof value !== 'string') {
      return value;
    }
    return parseInt(value, 10) || undefined;
  }

  /**
   * ```js
   * await auth0.buildAuthorizeUrl(options);
   * ```
   *
   * Builds an `/authorize` URL for loginWithRedirect using the parameters
   * provided as arguments. Random and secure `state` and `nonce`
   * parameters will be auto-generated.
   *
   * @param options
   */

  public async buildAuthorizeUrl(
    options: RedirectLoginOptions = {}
  ): Promise<string> {
    const { redirect_uri, appState, ...authorizeOptions } = options;

    const stateIn = encode(createRandomString());
    const nonceIn = encode(createRandomString());
    const code_verifier = createRandomString();
    const code_challengeBuffer = await sha256(code_verifier);
    const code_challenge = bufferToBase64UrlEncoded(code_challengeBuffer);
    const fragment = options.fragment ? `#${options.fragment}` : '';

    const params = this._getParams(
      authorizeOptions,
      stateIn,
      nonceIn,
      code_challenge,
      redirect_uri
    );

    const url = this._authorizeUrl(params);

    await this.transactionManager.create(stateIn, {
      nonce: nonceIn,
      code_verifier,
      appState,
      scope: params.scope,
      audience: params.audience || 'default',
      redirect_uri: params.redirect_uri
    });

    return url + fragment;
  }

  /**
   * ```js
   * const user = await auth0.getUser();
   * ```
   *
   * Returns the user information if available (decoded
   * from the `id_token`).
   *
   * @param options
   */
  public async getUser(
    options: GetUserOptions = {
      audience: this.options.audience || 'default',
      scope: this.scope || this.defaultScope
    }
  ) {
    options.scope = getUniqueScopes(this.defaultScope, options.scope);

    const cache = await this.cache.get({
      client_id: this.options.client_id,
      ...options
    });

    return cache && cache.decodedToken && cache.decodedToken.user;
  }

  /**
   * ```js
   * const claims = await auth0.getIdTokenClaims();
   * ```
   *
   * Returns all claims from the id_token if available.
   *
   * @param options
   */
  public async getIdTokenClaims(
    options: GetIdTokenClaimsOptions = {
      audience: this.options.audience || 'default',
      scope: this.scope || this.defaultScope
    }
  ) {
    options.scope = getUniqueScopes(
      this.defaultScope,
      this.scope,
      options.scope
    );

    const cache = await this.cache.get({
      client_id: this.options.client_id,
      ...options
    });

    return cache && cache.decodedToken && cache.decodedToken.claims;
  }

  /**
   * ```js
   * await auth0.loginWithRedirect(options);
   * ```
   *
   * Performs a redirect to `/authorize` using the parameters
   * provided as arguments. Random and secure `state` and `nonce`
   * parameters will be auto-generated.
   *
   * @param options
   */
  public async loginWithRedirect(options: RedirectLoginOptions = {}) {
    const url = await this.buildAuthorizeUrl(options);
    window.location.assign(url);
  }

  /**
   * After the browser redirects back to the callback page,
   * call `handleRedirectCallback` to handle success and error
   * responses from Auth0. If the response is successful, results
   * will be valid according to their expiration times.
   */
  public async handleRedirectCallback(
    url: string = window.location.href
  ): Promise<RedirectLoginResult> {
    const queryStringFragments = url.split('?').slice(1);
    if (queryStringFragments.length === 0) {
      throw new Error('There are no query params available for parsing.');
    }
    const { state, code, error, error_description } = parseQueryResult(
      queryStringFragments.join('')
    );

    const transaction = this.transactionManager.get(state);

    if (!transaction) {
      throw new Error('Invalid state');
    }

    if (error) {
      await this.transactionManager.remove(state);

      throw new AuthenticationError(
        error,
        error_description,
        state,
        transaction.appState
      );
    }

    await this.transactionManager.remove(state);

    const tokenOptions = {
      baseUrl: this.domainUrl,
      client_id: this.options.client_id,
      code_verifier: transaction.code_verifier,
      grant_type: 'authorization_code',
      code
    } as OAuthTokenOptions;

    // some old versions of the SDK might not have added redirect_uri to the
    // transaction, we dont want the key to be set to undefined.
    if (undefined !== transaction.redirect_uri) {
      tokenOptions.redirect_uri = transaction.redirect_uri;
    }

    const authResult = await oauthToken(tokenOptions, this.worker);

    const decodedToken = this._verifyIdToken(
      authResult.id_token,
      transaction.nonce
    );

    const cacheEntry = {
      ...authResult,
      decodedToken,
      audience: transaction.audience,
      scope: transaction.scope,
      client_id: this.options.client_id
    };

    await this.cache.save(cacheEntry);

    await ClientStorage.save('auth0.is.authenticated', true);

    return {
      appState: transaction.appState
    };
  }

  /**
   * ```js
   * await auth0.checkSession();
   * ```
   *
   * Check if the user is logged in using `getTokenSilently`. The difference
   * with `getTokenSilently` is that this doesn't return a token, but it will
   * pre-fill the token cache.
   *
   * It should be used for silently logging in the user when you instantiate the
   * `Auth0Client` constructor. You should not need this if you are using the
   * `createAuth0Client` factory.
   *
   * @param options
   */
  public async checkSession(options?: GetTokenSilentlyOptions) {
    if (!(await ClientStorage.get('auth0.is.authenticated'))) {
      return;
    }

    try {
      await this.getTokenSilently(options);
    } catch (error) {
      if (!RECOVERABLE_ERRORS.includes(error.error)) {
        throw error;
      }
    }
  }

  /**
   * ```js
   * const token = await auth0.getTokenSilently(options);
   * ```
   *
   * If there's a valid token stored, return it. Otherwise, opens an
   * iframe with the `/authorize` URL using the parameters provided
   * as arguments. Random and secure `state` and `nonce` parameters
   * will be auto-generated. If the response is successful, results
   * will be valid according to their expiration times.
   *
   * If refresh tokens are used, the token endpoint is called directly with the
   * 'refresh_token' grant. If no refresh token is available to make this call,
   * the SDK falls back to using an iframe to the '/authorize' URL.
   *
   * This method may use a web worker to perform the token call if the in-memory
   * cache is used.
   *
   * If an `audience` value is given to this function, the SDK always falls
   * back to using an iframe to make the token exchange.
   *
   * Note that in all cases, falling back to an iframe requires access to
   * the `auth0` cookie.
   *
   * @param options
   */
  public async getTokenSilently(options: GetTokenSilentlyOptions = {}) {
    const { ignoreCache, ...getTokenOptions } = {
      audience: this.options.audience,
      ignoreCache: false,
      ...options,
      scope: getUniqueScopes(this.defaultScope, this.scope, options.scope)
    };

    try {
      if (!ignoreCache) {
        const cache = await this.cache.get(
          {
            scope: getTokenOptions.scope,
            audience: getTokenOptions.audience || 'default',
            client_id: this.options.client_id
          },
          60 // get a new token if within 60 seconds of expiring
        );

        if (cache && cache.access_token) {
          return cache.access_token;
        }
      }

      await lock.acquireLock(GET_TOKEN_SILENTLY_LOCK_KEY, 5000);

      // Only get an access token using a refresh token if:
      // * refresh tokens are enabled
      // * no audience has been specified to getTokenSilently (we can only get a token for a new audience when using an iframe)
      const authResult =
        this.options.useRefreshTokens && !options.audience
          ? await this._getTokenUsingRefreshToken(getTokenOptions)
          : Error('Could not refresh token');

      await this.cache.save({
        client_id: this.options.client_id,
        ...authResult
      });

      await ClientStorage.save('auth0.is.authenticated', true);

      return authResult.access_token;
    } catch (e) {
      throw e;
    } finally {
      await lock.releaseLock(GET_TOKEN_SILENTLY_LOCK_KEY);
    }
  }

  /**
   * ```js
   * const isAuthenticated = await auth0.isAuthenticated();
   * ```
   *
   * Returns `true` if there's valid information stored,
   * otherwise returns `false`.
   *
   */
  public async isAuthenticated() {
    const user = await this.getUser();
    return !!user;
  }

  /**
   * ```js
   * auth0.logout();
   * ```
   *
   * Clears the application session and performs a redirect to `/v2/logout`, using
   * the parameters provided as arguments, to clear the Auth0 session.
   * If the `federated` option is specified it also clears the Identity Provider session.
   * If the `localOnly` option is specified, it only clears the application session.
   * It is invalid to set both the `federated` and `localOnly` options to `true`,
   * and an error will be thrown if you do.
   * [Read more about how Logout works at Auth0](https://auth0.com/docs/logout).
   *
   * @param options
   */
  public async logout(options: LogoutOptions = {}): Promise<string> {
    if (options.client_id !== null) {
      options.client_id = options.client_id || this.options.client_id;
    } else {
      delete options.client_id;
    }

    const {
      federated,
      localOnly,
      logoutFromNative,
      ...logoutOptions
    } = options;

    if (localOnly && federated) {
      throw new Error(
        'It is invalid to set both the `federated` and `localOnly` options to `true`'
      );
    }

    await this.cache.clear();
    await ClientStorage.remove('auth0.is.authenticated');

    if (localOnly) {
      return null;
    }

    const federatedQuery = federated ? `&federated` : '';
    const url = this._url(`/v2/logout?${createQueryParams(logoutOptions)}`);

    const logoutUrl = `${url}${federatedQuery}`;
    if (logoutFromNative) {
      return logoutUrl;
    } else {
      window.location.assign(logoutUrl);
      return null;
    }
  }

  private async _getTokenUsingRefreshToken(
    options: GetTokenSilentlyOptions
  ): Promise<any> {
    options.scope = getUniqueScopes(
      this.defaultScope,
      this.options.scope,
      options.scope
    );

    const cache = await this.cache.get({
      scope: options.scope,
      audience: options.audience || 'default',
      client_id: this.options.client_id
    });

    if (!cache || !cache.refresh_token) {
      return;
    }

    const redirect_uri =
      options.redirect_uri ||
      this.options.redirect_uri ||
      window.location.origin;

    let tokenResult;

    const {
      scope,
      audience,
      ignoreCache,
      timeoutInSeconds,
      ...customOptions
    } = options;

    try {
      tokenResult = await oauthToken(
        {
          ...customOptions,
          baseUrl: this.domainUrl,
          client_id: this.options.client_id,
          grant_type: 'refresh_token',
          refresh_token: cache && cache.refresh_token,
          redirect_uri
        } as RefreshTokenOptions,
        this.worker
      );
    } catch (e) {
      throw e;
    }

    const decodedToken = this._verifyIdToken(tokenResult.id_token);

    return {
      ...tokenResult,
      decodedToken,
      scope: options.scope,
      audience: options.audience || 'default'
    };
  }

  async init() {
    await this.transactionManager.init();
  }
}
