import type { ValidateFunction } from 'ajv';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
export type Env = Record<string, string | undefined>;
export type Fetcher = (url: URL, init: RequestInit) => Promise<Response>;
export type Log = (event: Record<string, unknown>) => void;

/** OpenAPI documents are user-supplied and loosely typed. */
// biome-ignore lint/suspicious/noExplicitAny: OpenAPI input is arbitrary JSON.
export type Spec = any;

export interface Parameter {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  argument: string;
  style?: string;
  explode?: boolean;
  required?: boolean;
  'x-mcp-omit-path-values'?: unknown[];
}

export interface RequestBody {
  media: string;
  originalSchema: Spec;
}

export interface Operation {
  name: string;
  path: string;
  method: string;
  security?: Record<string, string[]>[];
  parameters: Parameter[];
  body: RequestBody | null;
  validate: ValidateFunction;
}

export interface SecurityBinding {
  sourceHeader?: string;
  stripBearer?: boolean;
}

export interface ApiDefinition {
  name: string;
  baseUrl?: string;
  headers?: Record<string, string | { env: string }>;
  forwardHeaders?: string[];
  securityBindings?: Record<string, SecurityBinding>;
  wrapResponse?: boolean;
  responseHeaders?: Record<string, string>;
  responseHeadersKey?: string;
  instructions?: string;
  spec: Spec;
}

export interface Api {
  name: string;
  base: URL;
  basePath: string;
  headers: [string, string][];
  forwardHeaders: string[];
  securityBindings: Record<string, SecurityBinding>;
  securitySchemes: Record<string, Spec>;
  defaultSecurity: Record<string, string[]>[];
  wrap: { key: string; headers: [string, string][] } | null;
  operations: Map<string, Operation>;
  tools: Tool[];
  /** Pre-serialised JSON responses, built once at startup. */
  toolsJson: string;
  instructions: string;
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: Spec;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
}

export interface Limits {
  requestBytes: number;
  responseBytes: number;
  timeoutMs: number;
}
