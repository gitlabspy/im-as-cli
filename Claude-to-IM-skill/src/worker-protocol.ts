import type { StreamChatParams } from 'remote-agent-control-core/src/lib/bridge/host.js';

export type WorkerState = 'running' | 'starting' | 'stopping' | 'stopped' | 'exited' | 'unhealthy';

export interface WorkerStatusFile {
  state: WorkerState;
  pid?: number;
  port?: number;
  generation?: string;
  startedAt?: string;
  stoppedAt?: string;
  lastHeartbeat?: string;
  lastExitReason?: string;
  lastError?: string;
}

export interface WorkerHealth {
  ok: boolean;
  state: WorkerState;
  pid?: number;
  port?: number;
  generation?: string;
  startedAt?: string;
  uptimeMs?: number;
  error?: string;
}

export interface WorkerControlResult {
  ok: boolean;
  message: string;
  status: WorkerStatusFile;
}

export type SerializableStreamChatParams = Omit<StreamChatParams, 'abortController' | 'onRuntimeStatusChange'>;

export interface PermissionResolutionPayload {
  permissionRequestId: string;
  resolution: {
    behavior: 'allow' | 'deny';
    message?: string;
  };
}

export function serializeStreamChatParams(params: StreamChatParams): SerializableStreamChatParams {
  const { abortController: _abortController, onRuntimeStatusChange: _onRuntimeStatusChange, ...serializable } = params;
  return serializable;
}

export function isAuthorizedRequest(authHeader: string | string[] | undefined, token: string): boolean {
  const value = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  return value === `Bearer ${token}`;
}
