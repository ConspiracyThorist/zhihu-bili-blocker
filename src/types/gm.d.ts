declare function GM_getValue<T = unknown>(key: string, defaultValue?: T): T;
declare function GM_setValue(key: string, value: unknown): void;
declare function GM_registerMenuCommand(name: string, callback: () => void): void;
declare function GM_xmlhttpRequest(details: {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  timeout?: number;
  data?: string;
  onload?: (response: {
    status: number;
    statusText: string;
    responseText: string;
    responseHeaders: string;
  }) => void;
  onerror?: (error: unknown) => void;
  ontimeout?: () => void;
}): { abort: () => void };

declare const unsafeWindow: (Window & typeof globalThis) | undefined;
