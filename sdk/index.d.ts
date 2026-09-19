// Type declarations for signal98 (hand-written; the library itself is plain ESM JavaScript).

export type Properties = Record<string, unknown>;

export interface SignalEvent {
  uuid: string;
  event: string;
  timestamp: string;
  distinct_id: string;
  properties: Properties;
}

export interface AutoCaptureOptions {
  /** window "error" / process "uncaughtException". Default true. */
  errors?: boolean;
  /** "unhandledrejection". Default true. */
  rejections?: boolean;
  /** Report console.error calls as handled exceptions, and console.warn as breadcrumbs. Default false. */
  console?: boolean;
  /** Breadcrumbs ("steps") for clicks, navigation and network. Default true. */
  steps?: boolean;
  /** $pageview / $pageleave, History API aware. Default true. */
  pageviews?: boolean;
  /** $autocapture for click / submit / change. Input values are never captured. Default true. */
  clicks?: boolean;
  rageClicks?: boolean;
  deadClicks?: boolean;
  /** LCP, CLS, INP, FCP, TTFB. Default true. */
  webVitals?: boolean;
  /** $network_error for failed (>= 500, status 0) and slow fetch/XHR requests. Default true. */
  network?: boolean;
}

export interface InitOptions {
  /** Base URL of your signal98 server, e.g. "https://signal98.example.com". */
  host?: string;
  /** Legacy: full ingest URL. Prefer `host`. */
  endpoint?: string;
  apiKey?: string;
  /** Logical application name shown in the monitor. Defaults to the host name. */
  service?: string;
  release?: string;
  /** Default "production". */
  environment?: string;
  /** 0–1. Default 1. */
  sampleRate?: number;
  /** Inspect or mutate an event; return null to drop it. A throwing hook is ignored. */
  beforeSend?: (event: SignalEvent) => SignalEvent | null | undefined;
  /** Errors whose "Type: message" matches are dropped. */
  ignoreErrors?: Array<string | RegExp>;
  /** Default 500. Oldest events are dropped first. */
  maxQueue?: number;
  /** Milliseconds. Default 3000. */
  flushInterval?: number;
  /** Flush as soon as this many events are queued. Default 20. */
  flushAt?: number;
  /** Requests slower than this are reported with `$slow: true`. Default 4000. */
  slowRequestMs?: number;
  /** Capture nothing when the browser sends Do Not Track. */
  respectDNT?: boolean;
  /** Where identity and the unsent queue live. Default "localStorage". */
  persistence?: "localStorage" | "memory";
  /** `false` disables every automatic hook. */
  autoCapture?: AutoCaptureOptions | false;
  /** Log SDK internals to the console. */
  debug?: boolean;
}

export interface Logger {
  debug(message: string, properties?: Properties): void;
  info(message: string, properties?: Properties): void;
  warn(message: string, properties?: Properties): void;
  error(message: string, properties?: Properties): void;
}

export interface Client {
  capture(event: string, properties?: Properties): void;
  captureException(error: unknown, properties?: Properties): void;
  /** Breadcrumb attached to the next exception. */
  addStep(message: string, properties?: Properties): void;
  identify(distinctId: string, $set?: Properties, $set_once?: Properties): void;
  /** Call on logout: new anonymous id, new session. */
  reset(): void;
  /** Super-properties sent with every event. */
  register(properties: Properties): void;
  unregister(key: string): void;
  getDistinctId(): string | undefined;
  getSessionId(): string | undefined;
  isFeatureEnabled(key: string): boolean;
  getFeatureFlag(key: string): boolean | string | undefined;
  /** Returns an unsubscribe function. */
  onFeatureFlags(callback: (flags: Record<string, boolean | string>) => void): () => void;
  reloadFeatureFlags(): Promise<Record<string, boolean | string>>;
  flush(): Promise<void>;
  close(): Promise<void>;
  log: Logger;
}

/** Idempotent. Never throws: on failure it returns an inert client. */
export function init(options?: InitOptions): Client;
/** The client created by init(), or an inert stand-in before init(). */
export function getClient(): Client;
export function createClient(options: InitOptions): Client;
export function close(): Promise<void>;

export const capture: Client["capture"];
export const captureException: Client["captureException"];
export const addStep: Client["addStep"];
export const identify: Client["identify"];
export const reset: Client["reset"];
export const register: Client["register"];
export const unregister: Client["unregister"];
export const getDistinctId: Client["getDistinctId"];
export const getSessionId: Client["getSessionId"];
export const isFeatureEnabled: Client["isFeatureEnabled"];
export const getFeatureFlag: Client["getFeatureFlag"];
export const onFeatureFlags: Client["onFeatureFlags"];
export const reloadFeatureFlags: Client["reloadFeatureFlags"];
export const flush: Client["flush"];
export const log: Logger;

/** Reports anything `fn` throws (sync or async), then rethrows — behaviour is unchanged. */
export function wrap<F extends (...args: any[]) => any>(fn: F, options?: { name?: string; properties?: Properties }): F;

/** Returns an uninstall function. */
export function installBrowser(client: Client, options?: AutoCaptureOptions): () => void;
export function installNode(client: Client, options?: Pick<AutoCaptureOptions, "errors" | "rejections">): () => void;

type Next = (err?: unknown) => void;
/** Express-style: first middleware. Adds one breadcrumb per request. */
export function requestHandler(client?: Client): (req: any, res: any, next: Next) => void;
/** Express-style: after all routes. Reports 5xx errors and passes them on. */
export function errorHandler(client?: Client): (err: any, req: any, res: any, next: Next) => void;
