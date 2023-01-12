// Copyright 2020 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

/* eslint-disable no-param-reassign */
/* eslint-disable guard-for-in */
/* eslint-disable no-restricted-syntax */
/* eslint-disable @typescript-eslint/no-explicit-any */

import type { Response } from 'node-fetch';
import fetch from 'node-fetch';
import ProxyAgent from 'proxy-agent';
import { Agent } from 'https';
import { escapeRegExp, isNumber, isString, isObject } from 'lodash';
import PQueue from 'p-queue';
import { v4 as getGuid } from 'uuid';
import { z } from 'zod';
import type { Readable } from 'stream';

import { assertDev, strictAssert } from '../util/assert';
import { isRecord } from '../util/isRecord';
import * as durations from '../util/durations';
import type { ExplodePromiseResultType } from '../util/explodePromise';
import { explodePromise } from '../util/explodePromise';
import { getUserAgent } from '../util/getUserAgent';
import { getStreamWithTimeout } from '../util/getStreamWithTimeout';
import { formatAcceptLanguageHeader } from '../util/userLanguages';
import { toWebSafeBase64 } from '../util/webSafeBase64';
import { getBasicAuth } from '../util/getBasicAuth';
import { isPnpEnabled } from '../util/isPnpEnabled';
import type { SocketStatus } from '../types/SocketStatus';
import { toLogFormat } from '../types/errors';
import { isPackIdValid, redactPackId } from '../types/Stickers';
import type { UUID, UUIDStringType } from '../types/UUID';
import { UUIDKind } from '../types/UUID';
import type { DirectoryConfigType } from '../types/RendererConfig';
import * as Bytes from '../Bytes';
import { randomInt } from '../Crypto';
import * as linkPreviewFetch from '../linkPreviews/linkPreviewFetch';
import { isBadgeImageFileUrlValid } from '../badges/isBadgeImageFileUrlValid';

import { SocketManager } from './SocketManager';
import type { CDSAuthType, CDSResponseType } from './cds/Types.d';
import { CDSI } from './cds/CDSI';
import type WebSocketResource from './WebsocketResources';
import { SignalService as Proto } from '../protobuf';

import { HTTPError } from './Errors';
import type MessageSender from './SendMessage';
import type {
  WebAPICredentials,
  IRequestHandler,
  StorageServiceCallOptionsType,
  StorageServiceCredentials,
} from './Types.d';
import { handleStatusCode, translateError } from './Utils';
import * as log from '../logging/log';
import { maybeParseUrl } from '../util/url';

// Note: this will break some code that expects to be able to use err.response when a
//   web request fails, because it will force it to text. But it is very useful for
//   debugging failed requests.
const DEBUG = false;

function _createRedactor(
  ...toReplace: ReadonlyArray<string | undefined>
): RedactUrl {
  // NOTE: It would be nice to remove this cast, but TypeScript doesn't support
  //   it. However, there is [an issue][0] that discusses this in more detail.
  // [0]: https://github.com/Microsoft/TypeScript/issues/16069
  const stringsToReplace = toReplace.filter(Boolean) as Array<string>;
  return href =>
    stringsToReplace.reduce((result: string, stringToReplace: string) => {
      const pattern = RegExp(escapeRegExp(stringToReplace), 'g');
      const replacement = `[REDACTED]${stringToReplace.slice(-3)}`;
      return result.replace(pattern, replacement);
    }, href);
}

function _validateResponse(response: any, schema: any) {
  try {
    for (const i in schema) {
      switch (schema[i]) {
        case 'object':
        case 'string':
        case 'number':
          if (typeof response[i] !== schema[i]) {
            return false;
          }
          break;
        default:
      }
    }
  } catch (ex) {
    return false;
  }

  return true;
}

const FIVE_MINUTES = 5 * durations.MINUTE;
const GET_ATTACHMENT_CHUNK_TIMEOUT = 10 * durations.SECOND;

type AgentCacheType = {
  [name: string]: {
    timestamp: number;
    agent: ReturnType<typeof ProxyAgent> | Agent;
  };
};
const agents: AgentCacheType = {};

function getContentType(response: Response) {
  if (response.headers && response.headers.get) {
    return response.headers.get('content-type');
  }

  return null;
}

type FetchHeaderListType = { [name: string]: string };
export type HeaderListType = { [name: string]: string | ReadonlyArray<string> };
type HTTPCodeType = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD';

type RedactUrl = (url: string) => string;

type PromiseAjaxOptionsType = {
  socketManager?: SocketManager;
  basicAuth?: string;
  certificateAuthority?: string;
  contentType?: string;
  data?: Uint8Array | string;
  disableSessionResumption?: boolean;
  headers?: HeaderListType;
  host?: string;
  password?: string;
  path?: string;
  proxyUrl?: string;
  redactUrl?: RedactUrl;
  redirect?: 'error' | 'follow' | 'manual';
  responseType?:
    | 'json'
    | 'jsonwithdetails'
    | 'bytes'
    | 'byteswithdetails'
    | 'stream';
  serverUrl?: string;
  stack?: string;
  timeout?: number;
  type: HTTPCodeType;
  user?: string;
  validateResponse?: any;
  version: string;
  abortSignal?: AbortSignal;
} & (
  | {
      unauthenticated?: false;
      accessKey?: string;
    }
  | {
      unauthenticated: true;
      accessKey: undefined | string;
    }
);

type JSONWithDetailsType<Data = unknown> = {
  data: Data;
  contentType: string | null;
  response: Response;
};
type BytesWithDetailsType = {
  data: Uint8Array;
  contentType: string | null;
  response: Response;
};

export const multiRecipient200ResponseSchema = z.object({
  uuids404: z.array(z.string()).optional(),
  needsSync: z.boolean().optional(),
});
export type MultiRecipient200ResponseType = z.infer<
  typeof multiRecipient200ResponseSchema
>;

export const multiRecipient409ResponseSchema = z.array(
  z.object({
    uuid: z.string(),
    devices: z.object({
      missingDevices: z.array(z.number()).optional(),
      extraDevices: z.array(z.number()).optional(),
    }),
  })
);
export type MultiRecipient409ResponseType = z.infer<
  typeof multiRecipient409ResponseSchema
>;

export const multiRecipient410ResponseSchema = z.array(
  z.object({
    uuid: z.string(),
    devices: z.object({
      staleDevices: z.array(z.number()).optional(),
    }),
  })
);
export type MultiRecipient410ResponseType = z.infer<
  typeof multiRecipient410ResponseSchema
>;

function isSuccess(status: number): boolean {
  return status >= 0 && status < 400;
}

function getHostname(url: string): string {
  const urlObject = new URL(url);
  return urlObject.hostname;
}

async function _promiseAjax(
  providedUrl: string | null,
  options: PromiseAjaxOptionsType
): Promise<unknown> {
  const { proxyUrl, socketManager } = options;

  const url = providedUrl || `${options.host}/${options.path}`;
  const logType = socketManager ? '(WS)' : '(REST)';
  const redactedURL = options.redactUrl ? options.redactUrl(url) : url;

  const unauthLabel = options.unauthenticated ? ' (unauth)' : '';
  const logId = `${options.type} ${logType} ${redactedURL}${unauthLabel}`;
  log.info(logId);

  const timeout = typeof options.timeout === 'number' ? options.timeout : 10000;

  const agentType = options.unauthenticated ? 'unauth' : 'auth';
  const cacheKey = `${proxyUrl}-${agentType}`;

  const { timestamp } = agents[cacheKey] || { timestamp: null };
  if (!timestamp || timestamp + FIVE_MINUTES < Date.now()) {
    if (timestamp) {
      log.info(`Cycling agent for type ${cacheKey}`);
    }
    agents[cacheKey] = {
      agent: proxyUrl
        ? new ProxyAgent(proxyUrl)
        : new Agent({
            keepAlive: !options.disableSessionResumption,
            maxCachedSessions: options.disableSessionResumption ? 0 : undefined,
          }),
      timestamp: Date.now(),
    };
  }
  const { agent } = agents[cacheKey];

  const fetchOptions = {
    method: options.type,
    body: options.data,
    headers: {
      'User-Agent': getUserAgent(options.version),
      'X-Signal-Agent': 'OWD',
      ...options.headers,
    } as FetchHeaderListType,
    redirect: options.redirect,
    agent,
    ca: options.certificateAuthority,
    timeout,
    abortSignal: options.abortSignal,
  };

  if (fetchOptions.body instanceof Uint8Array) {
    // node-fetch doesn't support Uint8Array, only node Buffer
    const contentLength = fetchOptions.body.byteLength;
    fetchOptions.body = Buffer.from(fetchOptions.body);

    // node-fetch doesn't set content-length like S3 requires
    fetchOptions.headers['Content-Length'] = contentLength.toString();
  }

  const { accessKey, basicAuth, unauthenticated } = options;
  if (basicAuth) {
    fetchOptions.headers.Authorization = `Basic ${basicAuth}`;
  } else if (unauthenticated) {
    if (accessKey) {
      // Access key is already a Base64 string
      fetchOptions.headers['Unidentified-Access-Key'] = accessKey;
    }
  } else if (options.user && options.password) {
    fetchOptions.headers.Authorization = getBasicAuth({
      username: options.user,
      password: options.password,
    });
  }

  if (options.contentType) {
    fetchOptions.headers['Content-Type'] = options.contentType;
  }

  let response: Response;
  let result: string | Uint8Array | Readable | unknown;
  try {
    response = socketManager
      ? await socketManager.fetch(url, fetchOptions)
      : await fetch(url, fetchOptions);

    if (
      options.serverUrl &&
      getHostname(options.serverUrl) === getHostname(url)
    ) {
      await handleStatusCode(response.status);

      if (!unauthenticated && response.status === 401) {
        log.error('Got 401 from Signal Server. We might be unlinked.');
        window.Whisper.events.trigger('mightBeUnlinked');
      }
    }

    if (DEBUG && !isSuccess(response.status)) {
      result = await response.text();
    } else if (
      (options.responseType === 'json' ||
        options.responseType === 'jsonwithdetails') &&
      /^application\/json(;.*)?$/.test(
        response.headers.get('Content-Type') || ''
      )
    ) {
      result = await response.json();
    } else if (
      options.responseType === 'bytes' ||
      options.responseType === 'byteswithdetails'
    ) {
      result = await response.buffer();
    } else if (options.responseType === 'stream') {
      result = response.body;
    } else {
      result = await response.textConverted();
    }
  } catch (e) {
    log.error(logId, 0, 'Error');
    const stack = `${e.stack}\nInitial stack:\n${options.stack}`;
    throw makeHTTPError('promiseAjax catch', 0, {}, e.toString(), stack);
  }

  if (!isSuccess(response.status)) {
    log.error(logId, response.status, 'Error');

    throw makeHTTPError(
      'promiseAjax: error response',
      response.status,
      response.headers.raw(),
      result,
      options.stack
    );
  }

  if (
    options.responseType === 'json' ||
    options.responseType === 'jsonwithdetails'
  ) {
    if (options.validateResponse) {
      if (!_validateResponse(result, options.validateResponse)) {
        log.error(logId, response.status, 'Error');
        throw makeHTTPError(
          'promiseAjax: invalid response',
          response.status,
          response.headers.raw(),
          result,
          options.stack
        );
      }
    }
  }

  log.info(logId, response.status, 'Success');

  if (options.responseType === 'byteswithdetails') {
    assertDev(result instanceof Uint8Array, 'Expected Uint8Array result');
    const fullResult: BytesWithDetailsType = {
      data: result,
      contentType: getContentType(response),
      response,
    };

    return fullResult;
  }

  if (options.responseType === 'jsonwithdetails') {
    const fullResult: JSONWithDetailsType = {
      data: result,
      contentType: getContentType(response),
      response,
    };

    return fullResult;
  }

  return result;
}

async function _retryAjax(
  url: string | null,
  options: PromiseAjaxOptionsType,
  providedLimit?: number,
  providedCount?: number
): Promise<unknown> {
  const count = (providedCount || 0) + 1;
  const limit = providedLimit || 3;

  try {
    return await _promiseAjax(url, options);
  } catch (e) {
    if (e instanceof HTTPError && e.code === -1 && count < limit) {
      return new Promise(resolve => {
        setTimeout(() => {
          resolve(_retryAjax(url, options, limit, count));
        }, 1000);
      });
    }
    throw e;
  }
}

function _outerAjax(
  providedUrl: string | null,
  options: PromiseAjaxOptionsType & { responseType: 'json' }
): Promise<unknown>;
function _outerAjax(
  providedUrl: string | null,
  options: PromiseAjaxOptionsType & { responseType: 'jsonwithdetails' }
): Promise<JSONWithDetailsType>;
function _outerAjax(
  providedUrl: string | null,
  options: PromiseAjaxOptionsType & { responseType?: 'bytes' }
): Promise<Uint8Array>;
function _outerAjax(
  providedUrl: string | null,
  options: PromiseAjaxOptionsType & { responseType: 'byteswithdetails' }
): Promise<BytesWithDetailsType>;
function _outerAjax(
  providedUrl: string | null,
  options: PromiseAjaxOptionsType & { responseType?: 'stream' }
): Promise<Readable>;
function _outerAjax(
  providedUrl: string | null,
  options: PromiseAjaxOptionsType
): Promise<unknown>;

async function _outerAjax(
  url: string | null,
  options: PromiseAjaxOptionsType
): Promise<unknown> {
  options.stack = new Error().stack; // just in case, save stack here.

  return _retryAjax(url, options);
}

function makeHTTPError(
  message: string,
  providedCode: number,
  headers: HeaderListType,
  response: unknown,
  stack?: string
) {
  return new HTTPError(message, {
    code: providedCode,
    headers,
    response,
    stack,
  });
}

const URL_CALLS = {
  accounts: 'v1/accounts',
  accountExistence: 'v1/accounts/account',
  attachmentId: 'v2/attachments/form/upload',
  attestation: 'v1/attestation',
  batchIdentityCheck: 'v1/profile/identity_check/batch',
  boostBadges: 'v1/subscription/boost/badges',
  challenge: 'v1/challenge',
  config: 'v1/config',
  deliveryCert: 'v1/certificate/delivery',
  devices: 'v1/devices',
  directoryAuth: 'v1/directory/auth',
  directoryAuthV2: 'v2/directory/auth',
  discovery: 'v1/discovery',
  getGroupAvatarUpload: 'v1/groups/avatar/form',
  getGroupCredentials: 'v1/certificate/auth/group',
  getIceServers: 'v1/accounts/turn',
  getOnboardingStoryManifest:
    'dynamic/desktop/stories/onboarding/manifest.json',
  getStickerPackUpload: 'v1/sticker/pack/form',
  groupLog: 'v1/groups/logs',
  groupJoinedAtVersion: 'v1/groups/joined_at_version',
  groups: 'v1/groups',
  groupsViaLink: 'v1/groups/join/',
  groupToken: 'v1/groups/token',
  keys: 'v2/keys',
  messages: 'v1/messages',
  multiRecipient: 'v1/messages/multi_recipient',
  profile: 'v1/profile',
  registerCapabilities: 'v1/devices/capabilities',
  reportMessage: 'v1/messages/report',
  signed: 'v2/keys/signed',
  storageManifest: 'v1/storage/manifest',
  storageModify: 'v1/storage/',
  storageRead: 'v1/storage/read',
  storageToken: 'v1/storage/auth',
  subscriptions: 'v1/subscription',
  supportUnauthenticatedDelivery: 'v1/devices/unauthenticated_delivery',
  updateDeviceName: 'v1/accounts/name',
  username: 'v1/accounts/username',
  reservedUsername: 'v1/accounts/username/reserved',
  confirmUsername: 'v1/accounts/username/confirm',
  whoami: 'v1/accounts/whoami',
};

const WEBSOCKET_CALLS = new Set<keyof typeof URL_CALLS>([
  // MessageController
  'messages',
  'multiRecipient',
  'reportMessage',

  // ProfileController
  'profile',

  // AttachmentControllerV2
  'attachmentId',

  // RemoteConfigController
  'config',

  // Certificate
  'deliveryCert',
  'getGroupCredentials',

  // Devices
  'devices',
  'registerCapabilities',
  'supportUnauthenticatedDelivery',

  // Directory
  'directoryAuth',
  'directoryAuthV2',

  // Storage
  'storageToken',
]);

type InitializeOptionsType = {
  url: string;
  storageUrl: string;
  updatesUrl: string;
  resourcesUrl: string;
  cdnUrlObject: {
    readonly '0': string;
    readonly [propName: string]: string;
  };
  certificateAuthority: string;
  contentProxyUrl: string;
  proxyUrl: string | undefined;
  version: string;
  directoryConfig: DirectoryConfigType;
};

export type MessageType = Readonly<{
  type: number;
  destinationDeviceId: number;
  destinationRegistrationId: number;
  content: string;
}>;

type AjaxOptionsType = {
  basicAuth?: string;
  call: keyof typeof URL_CALLS;
  contentType?: string;
  data?: Uint8Array | Buffer | Uint8Array | string;
  disableSessionResumption?: boolean;
  headers?: HeaderListType;
  host?: string;
  httpType: HTTPCodeType;
  jsonData?: unknown;
  password?: string;
  redactUrl?: RedactUrl;
  responseType?: 'json' | 'bytes' | 'byteswithdetails' | 'stream';
  schema?: unknown;
  timeout?: number;
  urlParameters?: string;
  username?: string;
  validateResponse?: any;
  isRegistration?: true;
  abortSignal?: AbortSignal;
} & (
  | {
      unauthenticated?: false;
      accessKey?: string;
    }
  | {
      unauthenticated: true;
      accessKey: undefined | string;
    }
);

export type WebAPIConnectOptionsType = WebAPICredentials & {
  useWebSocket?: boolean;
  hasStoriesDisabled: boolean;
};

export type WebAPIConnectType = {
  connect: (options: WebAPIConnectOptionsType) => WebAPIType;
};

export type CapabilitiesType = {
  announcementGroup: boolean;
  giftBadges: boolean;
  senderKey: boolean;
  changeNumber: boolean;
  stories: boolean;
  pni: boolean;
};
export type CapabilitiesUploadType = {
  announcementGroup: true;
  giftBadges: true;
  'gv2-3': true;
  senderKey: true;
  changeNumber: true;
  stories: true;

  // true in staging, false in production
  pni: boolean;
};

type StickerPackManifestType = Uint8Array;

export type GroupCredentialType = {
  credential: string;
  redemptionTime: number;
};
export type GroupCredentialsType = {
  groupPublicParamsHex: string;
  authCredentialPresentationHex: string;
};
export type GetGroupLogOptionsType = Readonly<{
  startVersion: number | undefined;
  includeFirstState: boolean;
  includeLastState: boolean;
  maxSupportedChangeEpoch: number;
}>;
export type GroupLogResponseType = {
  currentRevision?: number;
  start?: number;
  end?: number;
  changes: Proto.GroupChanges;
};

export type ProfileRequestDataType = {
  about: string | null;
  aboutEmoji: string | null;
  avatar: boolean;
  sameAvatar: boolean;
  commitment: string;
  name: string;
  paymentAddress: string | null;
  version: string;
};

const uploadAvatarHeadersZod = z.object({
  acl: z.string(),
  algorithm: z.string(),
  credential: z.string(),
  date: z.string(),
  key: z.string(),
  policy: z.string(),
  signature: z.string(),
});
export type UploadAvatarHeadersType = z.infer<typeof uploadAvatarHeadersZod>;

export type ProfileType = Readonly<{
  identityKey?: string;
  name?: string;
  about?: string;
  aboutEmoji?: string;
  avatar?: string;
  unidentifiedAccess?: string;
  unrestrictedUnidentifiedAccess?: string;
  uuid?: string;
  credential?: string;

  capabilities?: CapabilitiesType;
  paymentAddress?: string;
  badges?: unknown;
}>;

export type AccountType = Readonly<{
  uuid?: string;
}>;

export type GetIceServersResultType = Readonly<{
  username: string;
  password: string;
  urls: ReadonlyArray<string>;
}>;

export type GetDevicesResultType = ReadonlyArray<
  Readonly<{
    id: number;
    name: string;
    lastSeen: number;
    created: number;
  }>
>;

export type GetSenderCertificateResultType = Readonly<{ certificate: string }>;

export type MakeProxiedRequestResultType =
  | Uint8Array
  | {
      result: BytesWithDetailsType;
      totalSize: number;
    };

const whoamiResultZod = z.object({
  uuid: z.string(),
  pni: z.string(),
  number: z.string(),
  username: z.string().or(z.null()).optional(),
});
export type WhoamiResultType = z.infer<typeof whoamiResultZod>;

export type ConfirmCodeResultType = Readonly<{
  uuid: UUIDStringType;
  pni: UUIDStringType;
  deviceId?: number;
}>;

export type CdsLookupOptionsType = Readonly<{
  e164s: ReadonlyArray<string>;
  acis?: ReadonlyArray<UUIDStringType>;
  accessKeys?: ReadonlyArray<string>;
  returnAcisWithoutUaks?: boolean;
}>;

type GetProfileCommonOptionsType = Readonly<
  {
    userLanguages: ReadonlyArray<string>;
  } & (
    | {
        profileKeyVersion?: undefined;
        profileKeyCredentialRequest?: undefined;
      }
    | {
        profileKeyVersion: string;
        profileKeyCredentialRequest?: string;
      }
  )
>;

export type GetProfileOptionsType = GetProfileCommonOptionsType &
  Readonly<{
    accessKey?: undefined;
  }>;

export type GetProfileUnauthOptionsType = GetProfileCommonOptionsType &
  Readonly<{
    accessKey: string;
  }>;

export type GetGroupCredentialsOptionsType = Readonly<{
  startDayInMs: number;
  endDayInMs: number;
}>;

export type GetGroupCredentialsResultType = Readonly<{
  pni?: string | null;
  credentials: ReadonlyArray<GroupCredentialType>;
}>;

const verifyAciResponse = z.object({
  elements: z.array(
    z.object({
      aci: z.string(),
      identityKey: z.string(),
    })
  ),
});

export type VerifyAciRequestType = Array<{ aci: string; fingerprint: string }>;
export type VerifyAciResponseType = z.infer<typeof verifyAciResponse>;

export type ReserveUsernameOptionsType = Readonly<{
  nickname: string;
  abortSignal?: AbortSignal;
}>;

export type ConfirmUsernameOptionsType = Readonly<{
  usernameToConfirm: string;
  reservationToken: string;
  abortSignal?: AbortSignal;
}>;

const reserveUsernameResultZod = z.object({
  username: z.string(),
  reservationToken: z.string(),
});
export type ReserveUsernameResultType = z.infer<
  typeof reserveUsernameResultZod
>;

export type ConfirmCodeOptionsType = Readonly<{
  number: string;
  code: string;
  newPassword: string;
  registrationId: number;
  pniRegistrationId: number;
  deviceName?: string | null;
  accessKey?: Uint8Array;
}>;

export type WebAPIType = {
  startRegistration(): unknown;
  finishRegistration(baton: unknown): void;
  cdsLookup: (options: CdsLookupOptionsType) => Promise<CDSResponseType>;
  confirmCode: (
    options: ConfirmCodeOptionsType
  ) => Promise<ConfirmCodeResultType>;
  createGroup: (
    group: Proto.IGroup,
    options: GroupCredentialsType
  ) => Promise<void>;
  deleteUsername: (abortSignal?: AbortSignal) => Promise<void>;
  downloadOnboardingStories: (
    version: string,
    imageFiles: Array<string>
  ) => Promise<Array<Uint8Array>>;
  getAttachment: (cdnKey: string, cdnNumber?: number) => Promise<Uint8Array>;
  getAvatar: (path: string) => Promise<Uint8Array>;
  getDevices: () => Promise<GetDevicesResultType>;
  getHasSubscription: (subscriberId: Uint8Array) => Promise<boolean>;
  getGroup: (options: GroupCredentialsType) => Promise<Proto.Group>;
  getGroupFromLink: (
    inviteLinkPassword: string | undefined,
    auth: GroupCredentialsType
  ) => Promise<Proto.GroupJoinInfo>;
  getGroupAvatar: (key: string) => Promise<Uint8Array>;
  getGroupCredentials: (
    options: GetGroupCredentialsOptionsType
  ) => Promise<GetGroupCredentialsResultType>;
  getGroupExternalCredential: (
    options: GroupCredentialsType
  ) => Promise<Proto.GroupExternalCredential>;
  getGroupLog: (
    options: GetGroupLogOptionsType,
    credentials: GroupCredentialsType
  ) => Promise<GroupLogResponseType>;
  getIceServers: () => Promise<GetIceServersResultType>;
  getKeysForIdentifier: (
    identifier: string,
    deviceId?: number
  ) => Promise<ServerKeysType>;
  getKeysForIdentifierUnauth: (
    identifier: string,
    deviceId?: number,
    options?: { accessKey?: string }
  ) => Promise<ServerKeysType>;
  getMyKeys: (uuidKind: UUIDKind) => Promise<number>;
  getOnboardingStoryManifest: () => Promise<{
    version: string;
    languages: Record<string, Array<string>>;
  }>;
  getProfile: (
    identifier: string,
    options: GetProfileOptionsType
  ) => Promise<ProfileType>;
  getAccountForUsername: (username: string) => Promise<AccountType>;
  getProfileUnauth: (
    identifier: string,
    options: GetProfileUnauthOptionsType
  ) => Promise<ProfileType>;
  getBadgeImageFile: (imageUrl: string) => Promise<Uint8Array>;
  getBoostBadgesFromServer: (
    userLanguages: ReadonlyArray<string>
  ) => Promise<unknown>;
  getProvisioningResource: (
    handler: IRequestHandler
  ) => Promise<WebSocketResource>;
  getSenderCertificate: (
    withUuid?: boolean
  ) => Promise<GetSenderCertificateResultType>;
  getSticker: (packId: string, stickerId: number) => Promise<Uint8Array>;
  getStickerPackManifest: (packId: string) => Promise<StickerPackManifestType>;
  getStorageCredentials: MessageSender['getStorageCredentials'];
  getStorageManifest: MessageSender['getStorageManifest'];
  getStorageRecords: MessageSender['getStorageRecords'];
  fetchLinkPreviewMetadata: (
    href: string,
    abortSignal: AbortSignal
  ) => Promise<null | linkPreviewFetch.LinkPreviewMetadata>;
  fetchLinkPreviewImage: (
    href: string,
    abortSignal: AbortSignal
  ) => Promise<null | linkPreviewFetch.LinkPreviewImage>;
  makeProxiedRequest: (
    targetUrl: string,
    options?: ProxiedRequestOptionsType
  ) => Promise<MakeProxiedRequestResultType>;
  makeSfuRequest: (
    targetUrl: string,
    type: HTTPCodeType,
    headers: HeaderListType,
    body: Uint8Array | undefined
  ) => Promise<BytesWithDetailsType>;
  modifyGroup: (
    changes: Proto.GroupChange.IActions,
    options: GroupCredentialsType,
    inviteLinkBase64?: string
  ) => Promise<Proto.IGroupChange>;
  modifyStorageRecords: MessageSender['modifyStorageRecords'];
  postBatchIdentityCheck: (
    elements: VerifyAciRequestType
  ) => Promise<VerifyAciResponseType>;
  putAttachment: (encryptedBin: Uint8Array) => Promise<string>;
  putProfile: (
    jsonData: ProfileRequestDataType
  ) => Promise<UploadAvatarHeadersType | undefined>;
  putStickers: (
    encryptedManifest: Uint8Array,
    encryptedStickers: Array<Uint8Array>,
    onProgress?: () => void
  ) => Promise<string>;
  reserveUsername: (
    options: ReserveUsernameOptionsType
  ) => Promise<ReserveUsernameResultType>;
  confirmUsername(options: ConfirmUsernameOptionsType): Promise<void>;
  registerCapabilities: (capabilities: CapabilitiesUploadType) => Promise<void>;
  registerKeys: (genKeys: KeysType, uuidKind: UUIDKind) => Promise<void>;
  registerSupportForUnauthenticatedDelivery: () => Promise<void>;
  reportMessage: (senderUuid: string, serverGuid: string) => Promise<void>;
  requestVerificationSMS: (number: string, token: string) => Promise<void>;
  requestVerificationVoice: (number: string, token: string) => Promise<void>;
  checkAccountExistence: (uuid: UUID) => Promise<boolean>;
  sendMessages: (
    destination: string,
    messageArray: ReadonlyArray<MessageType>,
    timestamp: number,
    options: { online?: boolean; story?: boolean; urgent?: boolean }
  ) => Promise<void>;
  sendMessagesUnauth: (
    destination: string,
    messageArray: ReadonlyArray<MessageType>,
    timestamp: number,
    options: {
      accessKey?: string;
      online?: boolean;
      story?: boolean;
      urgent?: boolean;
    }
  ) => Promise<void>;
  sendWithSenderKey: (
    payload: Uint8Array,
    accessKeys: Uint8Array,
    timestamp: number,
    options: {
      online?: boolean;
      story?: boolean;
      urgent?: boolean;
    }
  ) => Promise<MultiRecipient200ResponseType>;
  setSignedPreKey: (
    signedPreKey: SignedPreKeyType,
    uuidKind: UUIDKind
  ) => Promise<void>;
  updateDeviceName: (deviceName: string) => Promise<void>;
  uploadAvatar: (
    uploadAvatarRequestHeaders: UploadAvatarHeadersType,
    avatarData: Uint8Array
  ) => Promise<string>;
  uploadGroupAvatar: (
    avatarData: Uint8Array,
    options: GroupCredentialsType
  ) => Promise<string>;
  whoami: () => Promise<WhoamiResultType>;
  sendChallengeResponse: (challengeResponse: ChallengeType) => Promise<void>;
  getConfig: () => Promise<
    Array<{ name: string; enabled: boolean; value: string | null }>
  >;
  authenticate: (credentials: WebAPICredentials) => Promise<void>;
  logout: () => Promise<void>;
  getSocketStatus: () => SocketStatus;
  registerRequestHandler: (handler: IRequestHandler) => void;
  unregisterRequestHandler: (handler: IRequestHandler) => void;
  onHasStoriesDisabledChange: (newValue: boolean) => void;
  checkSockets: () => void;
  onOnline: () => Promise<void>;
  onOffline: () => void;
  reconnect: () => Promise<void>;
};

export type SignedPreKeyType = {
  keyId: number;
  publicKey: Uint8Array;
  signature: Uint8Array;
};

export type KeysType = {
  identityKey: Uint8Array;
  signedPreKey: SignedPreKeyType;
  preKeys: Array<{
    keyId: number;
    publicKey: Uint8Array;
  }>;
};

export type ServerKeysType = {
  devices: Array<{
    deviceId: number;
    registrationId: number;
    signedPreKey: {
      keyId: number;
      publicKey: Uint8Array;
      signature: Uint8Array;
    };
    preKey?: {
      keyId: number;
      publicKey: Uint8Array;
    };
  }>;
  identityKey: Uint8Array;
};

export type ChallengeType = {
  readonly type: 'recaptcha';
  readonly token: string;
  readonly captcha: string;
};

export type ProxiedRequestOptionsType = {
  returnUint8Array?: boolean;
  start?: number;
  end?: number;
};

export type TopLevelType = {
  multiRecipient200ResponseSchema: typeof multiRecipient200ResponseSchema;
  multiRecipient409ResponseSchema: typeof multiRecipient409ResponseSchema;
  multiRecipient410ResponseSchema: typeof multiRecipient410ResponseSchema;
  initialize: (options: InitializeOptionsType) => WebAPIConnectType;
};

// We first set up the data that won't change during this session of the app
export function initialize({
  url,
  storageUrl,
  updatesUrl,
  resourcesUrl,
  directoryConfig,
  cdnUrlObject,
  certificateAuthority,
  contentProxyUrl,
  proxyUrl,
  version,
}: InitializeOptionsType): WebAPIConnectType {
  if (!isString(url)) {
    throw new Error('WebAPI.initialize: Invalid server url');
  }
  if (!isString(storageUrl)) {
    throw new Error('WebAPI.initialize: Invalid storageUrl');
  }
  if (!isString(updatesUrl)) {
    throw new Error('WebAPI.initialize: Invalid updatesUrl');
  }
  if (!isString(resourcesUrl)) {
    throw new Error('WebAPI.initialize: Invalid updatesUrl (general)');
  }
  if (!isObject(cdnUrlObject)) {
    throw new Error('WebAPI.initialize: Invalid cdnUrlObject');
  }
  if (!isString(cdnUrlObject['0'])) {
    throw new Error('WebAPI.initialize: Missing CDN 0 configuration');
  }
  if (!isString(cdnUrlObject['2'])) {
    throw new Error('WebAPI.initialize: Missing CDN 2 configuration');
  }
  if (!isString(certificateAuthority)) {
    throw new Error('WebAPI.initialize: Invalid certificateAuthority');
  }
  if (!isString(contentProxyUrl)) {
    throw new Error('WebAPI.initialize: Invalid contentProxyUrl');
  }
  if (proxyUrl && !isString(proxyUrl)) {
    throw new Error('WebAPI.initialize: Invalid proxyUrl');
  }
  if (!isString(version)) {
    throw new Error('WebAPI.initialize: Invalid version');
  }

  // Thanks to function-hoisting, we can put this return statement before all of the
  //   below function definitions.
  return {
    connect,
  };

  // Then we connect to the server with user-specific information. This is the only API
  //   exposed to the browser context, ensuring that it can't connect to arbitrary
  //   locations.
  function connect({
    username: initialUsername,
    password: initialPassword,
    useWebSocket = true,
    hasStoriesDisabled,
  }: WebAPIConnectOptionsType) {
    let username = initialUsername;
    let password = initialPassword;
    const PARSE_RANGE_HEADER = /\/(\d+)$/;
    const PARSE_GROUP_LOG_RANGE_HEADER =
      /^versions\s+(\d{1,10})-(\d{1,10})\/(\d{1,10})/;

    let activeRegistration: ExplodePromiseResultType<void> | undefined;

    const socketManager = new SocketManager({
      url,
      certificateAuthority,
      version,
      proxyUrl,
      hasStoriesDisabled,
    });

    socketManager.on('statusChange', () => {
      window.Whisper.events.trigger('socketStatusChange');
    });

    socketManager.on('authError', () => {
      window.Whisper.events.trigger('unlinkAndDisconnect');
    });

    if (useWebSocket) {
      void socketManager.authenticate({ username, password });
    }

    const { directoryUrl, directoryMRENCLAVE } = directoryConfig;

    const cds = new CDSI({
      logger: log,
      proxyUrl,

      url: directoryUrl,
      mrenclave: directoryMRENCLAVE,
      certificateAuthority,
      version,

      async getAuth() {
        return (await _ajax({
          call: 'directoryAuthV2',
          httpType: 'GET',
          responseType: 'json',
        })) as CDSAuthType;
      },
    });

    let fetchForLinkPreviews: linkPreviewFetch.FetchFn;
    if (proxyUrl) {
      const agent = new ProxyAgent(proxyUrl);
      fetchForLinkPreviews = (href, init) => fetch(href, { ...init, agent });
    } else {
      fetchForLinkPreviews = fetch;
    }

    // Thanks, function hoisting!
    return {
      authenticate,
      cdsLookup,
      checkAccountExistence,
      checkSockets,
      confirmCode,
      confirmUsername,
      createGroup,
      deleteUsername,
      downloadOnboardingStories,
      fetchLinkPreviewImage,
      fetchLinkPreviewMetadata,
      finishRegistration,
      getAccountForUsername,
      getAttachment,
      getAvatar,
      getBadgeImageFile,
      getBoostBadgesFromServer,
      getConfig,
      getDevices,
      getGroup,
      getGroupAvatar,
      getGroupCredentials,
      getGroupExternalCredential,
      getGroupFromLink,
      getGroupLog,
      getHasSubscription,
      getIceServers,
      getKeysForIdentifier,
      getKeysForIdentifierUnauth,
      getMyKeys,
      getOnboardingStoryManifest,
      getProfile,
      getProfileUnauth,
      getProvisioningResource,
      getSenderCertificate,
      getSocketStatus,
      getSticker,
      getStickerPackManifest,
      getStorageCredentials,
      getStorageManifest,
      getStorageRecords,
      logout,
      makeProxiedRequest,
      makeSfuRequest,
      modifyGroup,
      modifyStorageRecords,
      onHasStoriesDisabledChange,
      onOffline,
      onOnline,
      postBatchIdentityCheck,
      putAttachment,
      putProfile,
      putStickers,
      reconnect,
      registerCapabilities,
      registerKeys,
      registerRequestHandler,
      registerSupportForUnauthenticatedDelivery,
      reportMessage,
      requestVerificationSMS,
      requestVerificationVoice,
      reserveUsername,
      sendChallengeResponse,
      sendMessages,
      sendMessagesUnauth,
      sendWithSenderKey,
      setSignedPreKey,
      startRegistration,
      unregisterRequestHandler,
      updateDeviceName,
      uploadAvatar,
      uploadGroupAvatar,
      whoami,
    };

    function _ajax(
      param: AjaxOptionsType & { responseType?: 'bytes' }
    ): Promise<Uint8Array>;
    function _ajax(
      param: AjaxOptionsType & { responseType: 'byteswithdetails' }
    ): Promise<BytesWithDetailsType>;
    function _ajax(
      param: AjaxOptionsType & { responseType: 'stream' }
    ): Promise<Readable>;
    function _ajax(
      param: AjaxOptionsType & { responseType: 'json' }
    ): Promise<unknown>;

    async function _ajax(param: AjaxOptionsType): Promise<unknown> {
      if (
        !param.unauthenticated &&
        activeRegistration &&
        !param.isRegistration
      ) {
        log.info('WebAPI: request blocked by active registration');
        const start = Date.now();
        await activeRegistration.promise;
        const duration = Date.now() - start;
        log.info(`WebAPI: request unblocked after ${duration}ms`);
      }

      if (!param.urlParameters) {
        param.urlParameters = '';
      }

      const useWebSocketForEndpoint =
        useWebSocket && WEBSOCKET_CALLS.has(param.call);

      const outerParams = {
        socketManager: useWebSocketForEndpoint ? socketManager : undefined,
        basicAuth: param.basicAuth,
        certificateAuthority,
        contentType: param.contentType || 'application/json; charset=utf-8',
        data:
          param.data ||
          (param.jsonData ? JSON.stringify(param.jsonData) : undefined),
        headers: param.headers,
        host: param.host || url,
        password: param.password ?? password,
        path: URL_CALLS[param.call] + param.urlParameters,
        proxyUrl,
        responseType: param.responseType,
        timeout: param.timeout,
        type: param.httpType,
        user: param.username ?? username,
        redactUrl: param.redactUrl,
        serverUrl: url,
        validateResponse: param.validateResponse,
        version,
        unauthenticated: param.unauthenticated,
        accessKey: param.accessKey,
        abortSignal: param.abortSignal,
      };

      try {
        return await _outerAjax(null, outerParams);
      } catch (e) {
        if (!(e instanceof HTTPError)) {
          throw e;
        }
        const translatedError = translateError(e);
        if (translatedError) {
          throw translatedError;
        }
        throw e;
      }
    }

    function uuidKindToQuery(kind: UUIDKind): string {
      let value: string;
      if (kind === UUIDKind.ACI) {
        value = 'aci';
      } else if (kind === UUIDKind.PNI) {
        value = 'pni';
      } else {
        throw new Error(`Unsupported UUIDKind: ${kind}`);
      }
      return `identity=${value}`;
    }

    async function whoami(): Promise<WhoamiResultType> {
      const response = await _ajax({
        call: 'whoami',
        httpType: 'GET',
        responseType: 'json',
      });

      return whoamiResultZod.parse(response);
    }

    async function sendChallengeResponse(challengeResponse: ChallengeType) {
      await _ajax({
        call: 'challenge',
        httpType: 'PUT',
        jsonData: challengeResponse,
      });
    }

    async function authenticate({
      username: newUsername,
      password: newPassword,
    }: WebAPICredentials) {
      username = newUsername;
      password = newPassword;

      if (useWebSocket) {
        await socketManager.authenticate({ username, password });
      }
    }

    async function logout() {
      username = '';
      password = '';

      if (useWebSocket) {
        await socketManager.logout();
      }
    }

    function getSocketStatus(): SocketStatus {
      return socketManager.getStatus();
    }

    function checkSockets(): void {
      // Intentionally not awaiting
      void socketManager.check();
    }

    async function onOnline(): Promise<void> {
      await socketManager.onOnline();
    }

    function onOffline(): void {
      socketManager.onOffline();
    }

    async function reconnect(): Promise<void> {
      await socketManager.reconnect();
    }

    function registerRequestHandler(handler: IRequestHandler): void {
      socketManager.registerRequestHandler(handler);
    }

    function unregisterRequestHandler(handler: IRequestHandler): void {
      socketManager.unregisterRequestHandler(handler);
    }

    function onHasStoriesDisabledChange(newValue: boolean): void {
      void socketManager.onHasStoriesDisabledChange(newValue);
    }

    async function getConfig() {
      type ResType = {
        config: Array<{ name: string; enabled: boolean; value: string | null }>;
      };
      const res = (await _ajax({
        call: 'config',
        httpType: 'GET',
        responseType: 'json',
      })) as ResType;

      return res.config.filter(
        ({ name }: { name: string }) =>
          name.startsWith('desktop.') || name.startsWith('global.')
      );
    }

    async function getSenderCertificate(omitE164?: boolean) {
      return (await _ajax({
        call: 'deliveryCert',
        httpType: 'GET',
        responseType: 'json',
        validateResponse: { certificate: 'string' },
        ...(omitE164 ? { urlParameters: '?includeE164=false' } : {}),
      })) as GetSenderCertificateResultType;
    }

    async function getStorageCredentials(): Promise<StorageServiceCredentials> {
      return (await _ajax({
        call: 'storageToken',
        httpType: 'GET',
        responseType: 'json',
        schema: { username: 'string', password: 'string' },
      })) as StorageServiceCredentials;
    }

    async function getOnboardingStoryManifest() {
      const res = await _ajax({
        call: 'getOnboardingStoryManifest',
        host: resourcesUrl,
        httpType: 'GET',
        responseType: 'json',
      });

      return res as {
        version: string;
        languages: Record<string, Array<string>>;
      };
    }

    async function getStorageManifest(
      options: StorageServiceCallOptionsType = {}
    ): Promise<Uint8Array> {
      const { credentials, greaterThanVersion } = options;

      const { data, response } = await _ajax({
        call: 'storageManifest',
        contentType: 'application/x-protobuf',
        host: storageUrl,
        httpType: 'GET',
        responseType: 'byteswithdetails',
        urlParameters: greaterThanVersion
          ? `/version/${greaterThanVersion}`
          : '',
        ...credentials,
      });

      if (response.status === 204) {
        throw makeHTTPError(
          'promiseAjax: error response',
          response.status,
          response.headers.raw(),
          data,
          new Error().stack
        );
      }

      return data;
    }

    async function getStorageRecords(
      data: Uint8Array,
      options: StorageServiceCallOptionsType = {}
    ): Promise<Uint8Array> {
      const { credentials } = options;

      return _ajax({
        call: 'storageRead',
        contentType: 'application/x-protobuf',
        data,
        host: storageUrl,
        httpType: 'PUT',
        responseType: 'bytes',
        ...credentials,
      });
    }

    async function modifyStorageRecords(
      data: Uint8Array,
      options: StorageServiceCallOptionsType = {}
    ): Promise<Uint8Array> {
      const { credentials } = options;

      return _ajax({
        call: 'storageModify',
        contentType: 'application/x-protobuf',
        data,
        host: storageUrl,
        httpType: 'PUT',
        // If we run into a conflict, the current manifest is returned -
        //   it will will be an Uint8Array at the response key on the Error
        responseType: 'bytes',
        ...credentials,
      });
    }

    async function registerSupportForUnauthenticatedDelivery() {
      await _ajax({
        call: 'supportUnauthenticatedDelivery',
        httpType: 'PUT',
        responseType: 'json',
      });
    }

    async function registerCapabilities(capabilities: CapabilitiesUploadType) {
      await _ajax({
        call: 'registerCapabilities',
        httpType: 'PUT',
        jsonData: capabilities,
      });
    }

    async function postBatchIdentityCheck(elements: VerifyAciRequestType) {
      const res = await _ajax({
        data: JSON.stringify({ elements }),
        call: 'batchIdentityCheck',
        httpType: 'POST',
        responseType: 'json',
      });

      const result = verifyAciResponse.safeParse(res);

      if (result.success) {
        return result.data;
      }

      log.warn(
        'WebAPI: invalid response from postBatchIdentityCheck',
        toLogFormat(result.error)
      );

      throw result.error;
    }

    function getProfileUrl(
      identifier: string,
      {
        profileKeyVersion,
        profileKeyCredentialRequest,
      }: GetProfileCommonOptionsType
    ) {
      let profileUrl = `/${identifier}`;
      if (profileKeyVersion !== undefined) {
        profileUrl += `/${profileKeyVersion}`;
        if (profileKeyCredentialRequest !== undefined) {
          profileUrl +=
            `/${profileKeyCredentialRequest}` +
            '?credentialType=expiringProfileKey';
        }
      } else {
        strictAssert(
          profileKeyCredentialRequest === undefined,
          'getProfileUrl called without version, but with request'
        );
      }

      return profileUrl;
    }

    async function getProfile(
      identifier: string,
      options: GetProfileOptionsType
    ) {
      const { profileKeyVersion, profileKeyCredentialRequest, userLanguages } =
        options;

      return (await _ajax({
        call: 'profile',
        httpType: 'GET',
        urlParameters: getProfileUrl(identifier, options),
        headers: {
          'Accept-Language': formatAcceptLanguageHeader(userLanguages),
        },
        responseType: 'json',
        redactUrl: _createRedactor(
          identifier,
          profileKeyVersion,
          profileKeyCredentialRequest
        ),
      })) as ProfileType;
    }

    async function getAccountForUsername(usernameToFetch: string) {
      return (await _ajax({
        call: 'username',
        httpType: 'GET',
        urlParameters: `/${encodeURIComponent(usernameToFetch)}`,
        responseType: 'json',
        redactUrl: _createRedactor(usernameToFetch),
        unauthenticated: true,
        accessKey: undefined,
      })) as ProfileType;
    }

    async function putProfile(
      jsonData: ProfileRequestDataType
    ): Promise<UploadAvatarHeadersType | undefined> {
      const res = await _ajax({
        call: 'profile',
        httpType: 'PUT',
        responseType: 'json',
        jsonData,
      });

      if (!res) {
        return;
      }

      return uploadAvatarHeadersZod.parse(res);
    }

    async function getProfileUnauth(
      identifier: string,
      options: GetProfileUnauthOptionsType
    ) {
      const {
        accessKey,
        profileKeyVersion,
        profileKeyCredentialRequest,
        userLanguages,
      } = options;

      return (await _ajax({
        call: 'profile',
        httpType: 'GET',
        urlParameters: getProfileUrl(identifier, options),
        headers: {
          'Accept-Language': formatAcceptLanguageHeader(userLanguages),
        },
        responseType: 'json',
        unauthenticated: true,
        accessKey,
        redactUrl: _createRedactor(
          identifier,
          profileKeyVersion,
          profileKeyCredentialRequest
        ),
      })) as ProfileType;
    }

    async function getBadgeImageFile(
      imageFileUrl: string
    ): Promise<Uint8Array> {
      strictAssert(
        isBadgeImageFileUrlValid(imageFileUrl, updatesUrl),
        'getBadgeImageFile got an invalid URL. Was bad data saved?'
      );

      return _outerAjax(imageFileUrl, {
        certificateAuthority,
        contentType: 'application/octet-stream',
        proxyUrl,
        responseType: 'bytes',
        timeout: 0,
        type: 'GET',
        redactUrl: (href: string) => {
          const parsedUrl = maybeParseUrl(href);
          if (!parsedUrl) {
            return href;
          }
          const { pathname } = parsedUrl;
          const pattern = RegExp(escapeRegExp(pathname), 'g');
          return href.replace(pattern, `[REDACTED]${pathname.slice(-3)}`);
        },
        version,
      });
    }

    async function downloadOnboardingStories(
      manifestVersion: string,
      imageFiles: Array<string>
    ): Promise<Array<Uint8Array>> {
      return Promise.all(
        imageFiles.map(fileName =>
          _outerAjax(
            `${resourcesUrl}/static/desktop/stories/onboarding/${manifestVersion}/${fileName}.jpg`,
            {
              certificateAuthority,
              contentType: 'application/octet-stream',
              proxyUrl,
              responseType: 'bytes',
              timeout: 0,
              type: 'GET',
              version,
            }
          )
        )
      );
    }

    async function getBoostBadgesFromServer(
      userLanguages: ReadonlyArray<string>
    ): Promise<unknown> {
      return _ajax({
        call: 'boostBadges',
        httpType: 'GET',
        headers: {
          'Accept-Language': formatAcceptLanguageHeader(userLanguages),
        },
        responseType: 'json',
      });
    }

    async function getAvatar(path: string) {
      // Using _outerAJAX, since it's not hardcoded to the Signal Server. Unlike our
      //   attachment CDN, it uses our self-signed certificate, so we pass it in.
      return _outerAjax(`${cdnUrlObject['0']}/${path}`, {
        certificateAuthority,
        contentType: 'application/octet-stream',
        proxyUrl,
        responseType: 'bytes',
        timeout: 0,
        type: 'GET',
        redactUrl: (href: string) => {
          const pattern = RegExp(escapeRegExp(path), 'g');
          return href.replace(pattern, `[REDACTED]${path.slice(-3)}`);
        },
        version,
      });
    }

    async function deleteUsername(abortSignal?: AbortSignal) {
      await _ajax({
        call: 'username',
        httpType: 'DELETE',
        abortSignal,
      });
    }
    async function reserveUsername({
      nickname,
      abortSignal,
    }: ReserveUsernameOptionsType) {
      const response = await _ajax({
        call: 'reservedUsername',
        httpType: 'PUT',
        jsonData: {
          nickname,
        },
        responseType: 'json',
        abortSignal,
      });

      return reserveUsernameResultZod.parse(response);
    }
    async function confirmUsername({
      usernameToConfirm,
      reservationToken,
      abortSignal,
    }: ConfirmUsernameOptionsType) {
      await _ajax({
        call: 'confirmUsername',
        httpType: 'PUT',
        jsonData: {
          usernameToConfirm,
          reservationToken,
        },
        abortSignal,
      });
    }

    async function reportMessage(
      senderUuid: string,
      serverGuid: string
    ): Promise<void> {
      await _ajax({
        call: 'reportMessage',
        httpType: 'POST',
        urlParameters: `/${senderUuid}/${serverGuid}`,
        responseType: 'bytes',
      });
    }

    async function requestVerificationSMS(number: string, token: string) {
      await _ajax({
        call: 'accounts',
        httpType: 'GET',
        urlParameters: `/sms/code/${number}?captcha=${token}`,
      });
    }

    async function requestVerificationVoice(number: string, token: string) {
      await _ajax({
        call: 'accounts',
        httpType: 'GET',
        urlParameters: `/voice/code/${number}?captcha=${token}`,
      });
    }

    async function checkAccountExistence(uuid: UUID) {
      try {
        await _ajax({
          httpType: 'HEAD',
          call: 'accountExistence',
          urlParameters: `/${uuid.toString()}`,
          unauthenticated: true,
          accessKey: undefined,
        });
        return true;
      } catch (error) {
        if (error instanceof HTTPError && error.code === 404) {
          return false;
        }

        throw error;
      }
    }

    function startRegistration() {
      strictAssert(
        activeRegistration === undefined,
        'Registration already in progress'
      );

      activeRegistration = explodePromise<void>();
      log.info('WebAPI: starting registration');

      return activeRegistration;
    }

    function finishRegistration(registration: unknown) {
      strictAssert(activeRegistration !== undefined, 'No active registration');
      strictAssert(
        activeRegistration === registration,
        'Invalid registration baton'
      );

      log.info('WebAPI: finishing registration');
      const current = activeRegistration;
      activeRegistration = undefined;
      current.resolve();
    }

    async function confirmCode({
      number,
      code,
      newPassword,
      registrationId,
      pniRegistrationId,
      deviceName,
      accessKey,
    }: ConfirmCodeOptionsType) {
      const capabilities: CapabilitiesUploadType = {
        announcementGroup: true,
        giftBadges: true,
        'gv2-3': true,
        senderKey: true,
        changeNumber: true,
        stories: true,
        pni: isPnpEnabled(),
      };

      const jsonData = {
        capabilities,
        fetchesMessages: true,
        name: deviceName || undefined,
        registrationId,
        pniRegistrationId,
        supportsSms: false,
        unidentifiedAccessKey: accessKey
          ? Bytes.toBase64(accessKey)
          : undefined,
        unrestrictedUnidentifiedAccess: false,
      };

      const call = deviceName ? 'devices' : 'accounts';
      const urlPrefix = deviceName ? '/' : '/code/';

      // Reset old websocket credentials and disconnect.
      // AccountManager is our only caller and it will trigger
      // `registration_done` which will update credentials.
      await logout();

      // Update REST credentials, though. We need them for the call below
      username = number;
      password = newPassword;

      const response = (await _ajax({
        isRegistration: true,
        call,
        httpType: 'PUT',
        responseType: 'json',
        urlParameters: urlPrefix + code,
        jsonData,
      })) as ConfirmCodeResultType;

      // Set final REST credentials to let `registerKeys` succeed.
      username = `${response.uuid || number}.${response.deviceId || 1}`;
      password = newPassword;

      return response;
    }

    async function updateDeviceName(deviceName: string) {
      await _ajax({
        call: 'updateDeviceName',
        httpType: 'PUT',
        jsonData: {
          deviceName,
        },
      });
    }

    async function getIceServers() {
      return (await _ajax({
        call: 'getIceServers',
        httpType: 'GET',
        responseType: 'json',
      })) as GetIceServersResultType;
    }

    async function getDevices() {
      return (await _ajax({
        call: 'devices',
        httpType: 'GET',
        responseType: 'json',
      })) as GetDevicesResultType;
    }

    type JSONSignedPreKeyType = {
      keyId: number;
      publicKey: string;
      signature: string;
    };

    type JSONKeysType = {
      identityKey: string;
      signedPreKey: JSONSignedPreKeyType;
      preKeys: Array<{
        keyId: number;
        publicKey: string;
      }>;
    };

    async function registerKeys(genKeys: KeysType, uuidKind: UUIDKind) {
      const preKeys = genKeys.preKeys.map(key => ({
        keyId: key.keyId,
        publicKey: Bytes.toBase64(key.publicKey),
      }));

      const keys: JSONKeysType = {
        identityKey: Bytes.toBase64(genKeys.identityKey),
        signedPreKey: {
          keyId: genKeys.signedPreKey.keyId,
          publicKey: Bytes.toBase64(genKeys.signedPreKey.publicKey),
          signature: Bytes.toBase64(genKeys.signedPreKey.signature),
        },
        preKeys,
      };

      await _ajax({
        isRegistration: true,
        call: 'keys',
        urlParameters: `?${uuidKindToQuery(uuidKind)}`,
        httpType: 'PUT',
        jsonData: keys,
      });
    }

    async function setSignedPreKey(
      signedPreKey: SignedPreKeyType,
      uuidKind: UUIDKind
    ) {
      await _ajax({
        call: 'signed',
        urlParameters: `?${uuidKindToQuery(uuidKind)}`,
        httpType: 'PUT',
        jsonData: {
          keyId: signedPreKey.keyId,
          publicKey: Bytes.toBase64(signedPreKey.publicKey),
          signature: Bytes.toBase64(signedPreKey.signature),
        },
      });
    }

    type ServerKeyCountType = {
      count: number;
    };

    async function getMyKeys(uuidKind: UUIDKind): Promise<number> {
      const result = (await _ajax({
        call: 'keys',
        urlParameters: `?${uuidKindToQuery(uuidKind)}`,
        httpType: 'GET',
        responseType: 'json',
        validateResponse: { count: 'number' },
      })) as ServerKeyCountType;

      return result.count;
    }

    type ServerKeyResponseType = {
      devices: Array<{
        deviceId: number;
        registrationId: number;
        signedPreKey: {
          keyId: number;
          publicKey: string;
          signature: string;
        };
        preKey?: {
          keyId: number;
          publicKey: string;
        };
      }>;
      identityKey: string;
    };

    function handleKeys(res: ServerKeyResponseType): ServerKeysType {
      if (!Array.isArray(res.devices)) {
        throw new Error('Invalid response');
      }

      const devices = res.devices.map(device => {
        if (
          !_validateResponse(device, { signedPreKey: 'object' }) ||
          !_validateResponse(device.signedPreKey, {
            publicKey: 'string',
            signature: 'string',
          })
        ) {
          throw new Error('Invalid signedPreKey');
        }

        let preKey;
        if (device.preKey) {
          if (
            !_validateResponse(device, { preKey: 'object' }) ||
            !_validateResponse(device.preKey, { publicKey: 'string' })
          ) {
            throw new Error('Invalid preKey');
          }

          preKey = {
            keyId: device.preKey.keyId,
            publicKey: Bytes.fromBase64(device.preKey.publicKey),
          };
        }

        return {
          deviceId: device.deviceId,
          registrationId: device.registrationId,
          preKey,
          signedPreKey: {
            keyId: device.signedPreKey.keyId,
            publicKey: Bytes.fromBase64(device.signedPreKey.publicKey),
            signature: Bytes.fromBase64(device.signedPreKey.signature),
          },
        };
      });

      return {
        devices,
        identityKey: Bytes.fromBase64(res.identityKey),
      };
    }

    async function getKeysForIdentifier(identifier: string, deviceId?: number) {
      const keys = (await _ajax({
        call: 'keys',
        httpType: 'GET',
        urlParameters: `/${identifier}/${deviceId || '*'}`,
        responseType: 'json',
        validateResponse: { identityKey: 'string', devices: 'object' },
      })) as ServerKeyResponseType;
      return handleKeys(keys);
    }

    async function getKeysForIdentifierUnauth(
      identifier: string,
      deviceId?: number,
      { accessKey }: { accessKey?: string } = {}
    ) {
      const keys = (await _ajax({
        call: 'keys',
        httpType: 'GET',
        urlParameters: `/${identifier}/${deviceId || '*'}`,
        responseType: 'json',
        validateResponse: { identityKey: 'string', devices: 'object' },
        unauthenticated: true,
        accessKey,
      })) as ServerKeyResponseType;
      return handleKeys(keys);
    }

    async function sendMessagesUnauth(
      destination: string,
      messages: ReadonlyArray<MessageType>,
      timestamp: number,
      {
        accessKey,
        online,
        urgent = true,
        story = false,
      }: {
        accessKey?: string;
        online?: boolean;
        story?: boolean;
        urgent?: boolean;
      }
    ) {
      const jsonData = {
        messages,
        timestamp,
        online: Boolean(online),
        urgent,
      };

      await _ajax({
        call: 'messages',
        httpType: 'PUT',
        urlParameters: `/${destination}?story=${booleanToString(story)}`,
        jsonData,
        responseType: 'json',
        unauthenticated: true,
        accessKey,
      });
    }

    async function sendMessages(
      destination: string,
      messages: ReadonlyArray<MessageType>,
      timestamp: number,
      {
        online,
        urgent = true,
        story = false,
      }: { online?: boolean; story?: boolean; urgent?: boolean }
    ) {
      const jsonData = {
        messages,
        timestamp,
        online: Boolean(online),
        urgent,
      };

      await _ajax({
        call: 'messages',
        httpType: 'PUT',
        urlParameters: `/${destination}?story=${booleanToString(story)}`,
        jsonData,
        responseType: 'json',
      });
    }

    function booleanToString(value: boolean | undefined): string {
      return value ? 'true' : 'false';
    }

    async function sendWithSenderKey(
      data: Uint8Array,
      accessKeys: Uint8Array,
      timestamp: number,
      {
        online,
        urgent = true,
        story = false,
      }: {
        online?: boolean;
        story?: boolean;
        urgent?: boolean;
      }
    ): Promise<MultiRecipient200ResponseType> {
      const onlineParam = `&online=${booleanToString(online)}`;
      const urgentParam = `&urgent=${booleanToString(urgent)}`;
      const storyParam = `&story=${booleanToString(story)}`;

      const response = await _ajax({
        call: 'multiRecipient',
        httpType: 'PUT',
        contentType: 'application/vnd.signal-messenger.mrm',
        data,
        urlParameters: `?ts=${timestamp}${onlineParam}${urgentParam}${storyParam}`,
        responseType: 'json',
        unauthenticated: true,
        accessKey: Bytes.toBase64(accessKeys),
      });
      const parseResult = multiRecipient200ResponseSchema.safeParse(response);
      if (parseResult.success) {
        return parseResult.data;
      }

      log.warn(
        'WebAPI: invalid response from sendWithSenderKey',
        toLogFormat(parseResult.error)
      );
      return response as MultiRecipient200ResponseType;
    }

    function redactStickerUrl(stickerUrl: string) {
      return stickerUrl.replace(
        /(\/stickers\/)([^/]+)(\/)/,
        (_, begin: string, packId: string, end: string) =>
          `${begin}${redactPackId(packId)}${end}`
      );
    }

    async function getSticker(packId: string, stickerId: number) {
      if (!isPackIdValid(packId)) {
        throw new Error('getSticker: pack ID was invalid');
      }
      return _outerAjax(
        `${cdnUrlObject['0']}/stickers/${packId}/full/${stickerId}`,
        {
          certificateAuthority,
          proxyUrl,
          responseType: 'bytes',
          type: 'GET',
          redactUrl: redactStickerUrl,
          version,
        }
      );
    }

    async function getStickerPackManifest(packId: string) {
      if (!isPackIdValid(packId)) {
        throw new Error('getStickerPackManifest: pack ID was invalid');
      }
      return _outerAjax(
        `${cdnUrlObject['0']}/stickers/${packId}/manifest.proto`,
        {
          certificateAuthority,
          proxyUrl,
          responseType: 'bytes',
          type: 'GET',
          redactUrl: redactStickerUrl,
          version,
        }
      );
    }

    type ServerAttachmentType = {
      key: string;
      credential: string;
      acl: string;
      algorithm: string;
      date: string;
      policy: string;
      signature: string;
    };

    function makePutParams(
      {
        key,
        credential,
        acl,
        algorithm,
        date,
        policy,
        signature,
      }: ServerAttachmentType,
      encryptedBin: Uint8Array
    ) {
      // Note: when using the boundary string in the POST body, it needs to be prefixed by
      //   an extra --, and the final boundary string at the end gets a -- prefix and a --
      //   suffix.
      const boundaryString = `----------------${getGuid().replace(/-/g, '')}`;
      const CRLF = '\r\n';
      const getSection = (name: string, value: string) =>
        [
          `--${boundaryString}`,
          `Content-Disposition: form-data; name="${name}"${CRLF}`,
          value,
        ].join(CRLF);

      const start = [
        getSection('key', key),
        getSection('x-amz-credential', credential),
        getSection('acl', acl),
        getSection('x-amz-algorithm', algorithm),
        getSection('x-amz-date', date),
        getSection('policy', policy),
        getSection('x-amz-signature', signature),
        getSection('Content-Type', 'application/octet-stream'),
        `--${boundaryString}`,
        'Content-Disposition: form-data; name="file"',
        `Content-Type: application/octet-stream${CRLF}${CRLF}`,
      ].join(CRLF);
      const end = `${CRLF}--${boundaryString}--${CRLF}`;

      const startBuffer = Buffer.from(start, 'utf8');
      const attachmentBuffer = Buffer.from(encryptedBin);
      const endBuffer = Buffer.from(end, 'utf8');

      const contentLength =
        startBuffer.length + attachmentBuffer.length + endBuffer.length;
      const data = Buffer.concat(
        [startBuffer, attachmentBuffer, endBuffer],
        contentLength
      );

      return {
        data,
        contentType: `multipart/form-data; boundary=${boundaryString}`,
        headers: {
          'Content-Length': contentLength.toString(),
        },
      };
    }

    async function putStickers(
      encryptedManifest: Uint8Array,
      encryptedStickers: Array<Uint8Array>,
      onProgress?: () => void
    ) {
      // Get manifest and sticker upload parameters
      const { packId, manifest, stickers } = (await _ajax({
        call: 'getStickerPackUpload',
        responseType: 'json',
        httpType: 'GET',
        urlParameters: `/${encryptedStickers.length}`,
      })) as {
        packId: string;
        manifest: ServerAttachmentType;
        stickers: ReadonlyArray<ServerAttachmentType>;
      };

      // Upload manifest
      const manifestParams = makePutParams(manifest, encryptedManifest);
      // This is going to the CDN, not the service, so we use _outerAjax
      await _outerAjax(`${cdnUrlObject['0']}/`, {
        ...manifestParams,
        certificateAuthority,
        proxyUrl,
        timeout: 0,
        type: 'POST',
        version,
      });

      // Upload stickers
      const queue = new PQueue({
        concurrency: 3,
        timeout: durations.MINUTE * 30,
        throwOnTimeout: true,
      });
      await Promise.all(
        stickers.map(async (sticker: ServerAttachmentType, index: number) => {
          const stickerParams = makePutParams(
            sticker,
            encryptedStickers[index]
          );
          await queue.add(async () =>
            _outerAjax(`${cdnUrlObject['0']}/`, {
              ...stickerParams,
              certificateAuthority,
              proxyUrl,
              timeout: 0,
              type: 'POST',
              version,
            })
          );
          if (onProgress) {
            onProgress();
          }
        })
      );

      // Done!
      return packId;
    }

    async function getAttachment(cdnKey: string, cdnNumber?: number) {
      const abortController = new AbortController();

      const cdnUrl = isNumber(cdnNumber)
        ? cdnUrlObject[cdnNumber] || cdnUrlObject['0']
        : cdnUrlObject['0'];
      // This is going to the CDN, not the service, so we use _outerAjax
      const stream = await _outerAjax(`${cdnUrl}/attachments/${cdnKey}`, {
        certificateAuthority,
        proxyUrl,
        responseType: 'stream',
        timeout: 0,
        type: 'GET',
        redactUrl: _createRedactor(cdnKey),
        version,
        abortSignal: abortController.signal,
      });

      return getStreamWithTimeout(stream, {
        name: `getAttachment(${cdnKey})`,
        timeout: GET_ATTACHMENT_CHUNK_TIMEOUT,
        abortController,
      });
    }

    type PutAttachmentResponseType = ServerAttachmentType & {
      attachmentIdString: string;
    };

    async function putAttachment(encryptedBin: Uint8Array) {
      const response = (await _ajax({
        call: 'attachmentId',
        httpType: 'GET',
        responseType: 'json',
      })) as PutAttachmentResponseType;

      const { attachmentIdString } = response;

      const params = makePutParams(response, encryptedBin);

      // This is going to the CDN, not the service, so we use _outerAjax
      await _outerAjax(`${cdnUrlObject['0']}/attachments/`, {
        ...params,
        certificateAuthority,
        proxyUrl,
        timeout: 0,
        type: 'POST',
        version,
      });

      return attachmentIdString;
    }

    function getHeaderPadding() {
      const max = randomInt(1, 64);
      let characters = '';

      for (let i = 0; i < max; i += 1) {
        characters += String.fromCharCode(randomInt(65, 122));
      }

      return characters;
    }

    async function fetchLinkPreviewMetadata(
      href: string,
      abortSignal: AbortSignal
    ) {
      return linkPreviewFetch.fetchLinkPreviewMetadata(
        fetchForLinkPreviews,
        href,
        abortSignal
      );
    }

    async function fetchLinkPreviewImage(
      href: string,
      abortSignal: AbortSignal
    ) {
      return linkPreviewFetch.fetchLinkPreviewImage(
        fetchForLinkPreviews,
        href,
        abortSignal
      );
    }

    async function makeProxiedRequest(
      targetUrl: string,
      options: ProxiedRequestOptionsType = {}
    ): Promise<MakeProxiedRequestResultType> {
      const { returnUint8Array, start, end } = options;
      const headers: HeaderListType = {
        'X-SignalPadding': getHeaderPadding(),
      };

      if (isNumber(start) && isNumber(end)) {
        headers.Range = `bytes=${start}-${end}`;
      }

      const result = await _outerAjax(targetUrl, {
        responseType: returnUint8Array ? 'byteswithdetails' : undefined,
        proxyUrl: contentProxyUrl,
        type: 'GET',
        redirect: 'follow',
        redactUrl: () => '[REDACTED_URL]',
        headers,
        version,
      });

      if (!returnUint8Array) {
        return result as Uint8Array;
      }

      const { response } = result as BytesWithDetailsType;
      if (!response.headers || !response.headers.get) {
        throw new Error('makeProxiedRequest: Problem retrieving header value');
      }

      const range = response.headers.get('content-range');
      const match = PARSE_RANGE_HEADER.exec(range || '');

      if (!match || !match[1]) {
        throw new Error(
          `makeProxiedRequest: Unable to parse total size from ${range}`
        );
      }

      const totalSize = parseInt(match[1], 10);

      return {
        totalSize,
        result: result as BytesWithDetailsType,
      };
    }

    async function makeSfuRequest(
      targetUrl: string,
      type: HTTPCodeType,
      headers: HeaderListType,
      body: Uint8Array | undefined
    ): Promise<BytesWithDetailsType> {
      return _outerAjax(targetUrl, {
        certificateAuthority,
        data: body,
        headers,
        proxyUrl,
        responseType: 'byteswithdetails',
        timeout: 0,
        type,
        version,
      });
    }

    // Groups

    function generateGroupAuth(
      groupPublicParamsHex: string,
      authCredentialPresentationHex: string
    ) {
      return Bytes.toBase64(
        Bytes.fromString(
          `${groupPublicParamsHex}:${authCredentialPresentationHex}`
        )
      );
    }

    type CredentialResponseType = {
      credentials: Array<GroupCredentialType>;
    };

    async function getGroupCredentials({
      startDayInMs,
      endDayInMs,
    }: GetGroupCredentialsOptionsType): Promise<GetGroupCredentialsResultType> {
      const startDayInSeconds = startDayInMs / durations.SECOND;
      const endDayInSeconds = endDayInMs / durations.SECOND;
      const response = (await _ajax({
        call: 'getGroupCredentials',
        urlParameters:
          `?redemptionStartSeconds=${startDayInSeconds}&` +
          `redemptionEndSeconds=${endDayInSeconds}`,
        httpType: 'GET',
        responseType: 'json',
      })) as CredentialResponseType;

      return response;
    }

    async function getGroupExternalCredential(
      options: GroupCredentialsType
    ): Promise<Proto.GroupExternalCredential> {
      const basicAuth = generateGroupAuth(
        options.groupPublicParamsHex,
        options.authCredentialPresentationHex
      );

      const response = await _ajax({
        basicAuth,
        call: 'groupToken',
        httpType: 'GET',
        contentType: 'application/x-protobuf',
        responseType: 'bytes',
        host: storageUrl,
        disableSessionResumption: true,
      });

      return Proto.GroupExternalCredential.decode(response);
    }

    function verifyAttributes(attributes: Proto.IAvatarUploadAttributes) {
      const { key, credential, acl, algorithm, date, policy, signature } =
        attributes;

      if (
        !key ||
        !credential ||
        !acl ||
        !algorithm ||
        !date ||
        !policy ||
        !signature
      ) {
        throw new Error(
          'verifyAttributes: Missing value from AvatarUploadAttributes'
        );
      }

      return {
        key,
        credential,
        acl,
        algorithm,
        date,
        policy,
        signature,
      };
    }

    async function uploadAvatar(
      uploadAvatarRequestHeaders: UploadAvatarHeadersType,
      avatarData: Uint8Array
    ): Promise<string> {
      const verified = verifyAttributes(uploadAvatarRequestHeaders);
      const { key } = verified;

      const manifestParams = makePutParams(verified, avatarData);

      await _outerAjax(`${cdnUrlObject['0']}/`, {
        ...manifestParams,
        certificateAuthority,
        proxyUrl,
        timeout: 0,
        type: 'POST',
        version,
      });

      return key;
    }

    async function uploadGroupAvatar(
      avatarData: Uint8Array,
      options: GroupCredentialsType
    ): Promise<string> {
      const basicAuth = generateGroupAuth(
        options.groupPublicParamsHex,
        options.authCredentialPresentationHex
      );

      const response = await _ajax({
        basicAuth,
        call: 'getGroupAvatarUpload',
        httpType: 'GET',
        responseType: 'bytes',
        host: storageUrl,
        disableSessionResumption: true,
      });
      const attributes = Proto.AvatarUploadAttributes.decode(response);

      const verified = verifyAttributes(attributes);
      const { key } = verified;

      const manifestParams = makePutParams(verified, avatarData);

      await _outerAjax(`${cdnUrlObject['0']}/`, {
        ...manifestParams,
        certificateAuthority,
        proxyUrl,
        timeout: 0,
        type: 'POST',
        version,
      });

      return key;
    }

    async function getGroupAvatar(key: string): Promise<Uint8Array> {
      return _outerAjax(`${cdnUrlObject['0']}/${key}`, {
        certificateAuthority,
        proxyUrl,
        responseType: 'bytes',
        timeout: 0,
        type: 'GET',
        version,
        redactUrl: _createRedactor(key),
      });
    }

    async function createGroup(
      group: Proto.IGroup,
      options: GroupCredentialsType
    ): Promise<void> {
      const basicAuth = generateGroupAuth(
        options.groupPublicParamsHex,
        options.authCredentialPresentationHex
      );
      const data = Proto.Group.encode(group).finish();

      await _ajax({
        basicAuth,
        call: 'groups',
        contentType: 'application/x-protobuf',
        data,
        host: storageUrl,
        disableSessionResumption: true,
        httpType: 'PUT',
      });
    }

    async function getGroup(
      options: GroupCredentialsType
    ): Promise<Proto.Group> {
      const basicAuth = generateGroupAuth(
        options.groupPublicParamsHex,
        options.authCredentialPresentationHex
      );

      const response = await _ajax({
        basicAuth,
        call: 'groups',
        contentType: 'application/x-protobuf',
        host: storageUrl,
        disableSessionResumption: true,
        httpType: 'GET',
        responseType: 'bytes',
      });

      return Proto.Group.decode(response);
    }

    async function getGroupFromLink(
      inviteLinkPassword: string | undefined,
      auth: GroupCredentialsType
    ): Promise<Proto.GroupJoinInfo> {
      const basicAuth = generateGroupAuth(
        auth.groupPublicParamsHex,
        auth.authCredentialPresentationHex
      );
      const safeInviteLinkPassword = inviteLinkPassword
        ? toWebSafeBase64(inviteLinkPassword)
        : undefined;

      const response = await _ajax({
        basicAuth,
        call: 'groupsViaLink',
        contentType: 'application/x-protobuf',
        host: storageUrl,
        disableSessionResumption: true,
        httpType: 'GET',
        responseType: 'bytes',
        urlParameters: safeInviteLinkPassword
          ? `${safeInviteLinkPassword}`
          : undefined,
        redactUrl: _createRedactor(safeInviteLinkPassword),
      });

      return Proto.GroupJoinInfo.decode(response);
    }

    async function modifyGroup(
      changes: Proto.GroupChange.IActions,
      options: GroupCredentialsType,
      inviteLinkBase64?: string
    ): Promise<Proto.IGroupChange> {
      const basicAuth = generateGroupAuth(
        options.groupPublicParamsHex,
        options.authCredentialPresentationHex
      );
      const data = Proto.GroupChange.Actions.encode(changes).finish();
      const safeInviteLinkPassword = inviteLinkBase64
        ? toWebSafeBase64(inviteLinkBase64)
        : undefined;

      const response = await _ajax({
        basicAuth,
        call: 'groups',
        contentType: 'application/x-protobuf',
        data,
        host: storageUrl,
        disableSessionResumption: true,
        httpType: 'PATCH',
        responseType: 'bytes',
        urlParameters: safeInviteLinkPassword
          ? `?inviteLinkPassword=${safeInviteLinkPassword}`
          : undefined,
        redactUrl: safeInviteLinkPassword
          ? _createRedactor(safeInviteLinkPassword)
          : undefined,
      });

      return Proto.GroupChange.decode(response);
    }

    async function getGroupLog(
      options: GetGroupLogOptionsType,
      credentials: GroupCredentialsType
    ): Promise<GroupLogResponseType> {
      const basicAuth = generateGroupAuth(
        credentials.groupPublicParamsHex,
        credentials.authCredentialPresentationHex
      );

      const {
        startVersion,
        includeFirstState,
        includeLastState,
        maxSupportedChangeEpoch,
      } = options;

      // If we don't know starting revision - fetch it from the server
      if (startVersion === undefined) {
        const { data: joinedData } = await _ajax({
          basicAuth,
          call: 'groupJoinedAtVersion',
          contentType: 'application/x-protobuf',
          host: storageUrl,
          disableSessionResumption: true,
          httpType: 'GET',
          responseType: 'byteswithdetails',
        });

        const { joinedAtVersion } = Proto.Member.decode(joinedData);

        return getGroupLog(
          {
            ...options,
            startVersion: joinedAtVersion,
          },
          credentials
        );
      }

      const withDetails = await _ajax({
        basicAuth,
        call: 'groupLog',
        contentType: 'application/x-protobuf',
        host: storageUrl,
        disableSessionResumption: true,
        httpType: 'GET',
        responseType: 'byteswithdetails',
        urlParameters:
          `/${startVersion}?` +
          `includeFirstState=${Boolean(includeFirstState)}&` +
          `includeLastState=${Boolean(includeLastState)}&` +
          `maxSupportedChangeEpoch=${Number(maxSupportedChangeEpoch)}`,
      });
      const { data, response } = withDetails;
      const changes = Proto.GroupChanges.decode(data);

      if (response && response.status === 206) {
        const range = response.headers.get('Content-Range');
        const match = PARSE_GROUP_LOG_RANGE_HEADER.exec(range || '');

        const start = match ? parseInt(match[1], 10) : undefined;
        const end = match ? parseInt(match[2], 10) : undefined;
        const currentRevision = match ? parseInt(match[3], 10) : undefined;

        if (
          match &&
          isNumber(start) &&
          isNumber(end) &&
          isNumber(currentRevision)
        ) {
          return {
            changes,
            start,
            end,
            currentRevision,
          };
        }
      }

      return {
        changes,
      };
    }

    async function getHasSubscription(
      subscriberId: Uint8Array
    ): Promise<boolean> {
      const formattedId = toWebSafeBase64(Bytes.toBase64(subscriberId));
      const data = await _ajax({
        call: 'subscriptions',
        httpType: 'GET',
        urlParameters: `/${formattedId}`,
        responseType: 'json',
        unauthenticated: true,
        accessKey: undefined,
        redactUrl: _createRedactor(formattedId),
      });

      return (
        isRecord(data) &&
        isRecord(data.subscription) &&
        Boolean(data.subscription.active)
      );
    }

    function getProvisioningResource(
      handler: IRequestHandler
    ): Promise<WebSocketResource> {
      return socketManager.getProvisioningResource(handler);
    }

    async function cdsLookup({
      e164s,
      acis = [],
      accessKeys = [],
      returnAcisWithoutUaks,
    }: CdsLookupOptionsType): Promise<CDSResponseType> {
      return cds.request({
        e164s,
        acis,
        accessKeys,
        returnAcisWithoutUaks,
      });
    }
  }
}
