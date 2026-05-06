import { apiCall, ApiNetworkError } from '../lib/api';

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

interface PollPendingResponse {
  error: 'authorization_pending' | 'slow_down' | 'expired_token' | 'access_denied';
}

interface PollSuccessResponse {
  access_token: string;
}

export async function requestDeviceCode(): Promise<DeviceCodeResponse> {
  const result = await apiCall<DeviceCodeResponse>('/cli/auth/device', {
    method: 'POST',
    json: {},
  });

  if (!result.ok) {
    throw new Error(`Device code request failed: HTTP ${result.status}`);
  }

  return result.body;
}

export type PollResult =
  | { kind: 'pending' }
  | { kind: 'slow_down' }
  | { kind: 'expired' }
  | { kind: 'denied' }
  | { kind: 'token'; accessToken: string };

/**
 * Poll the backend once. Returns a discriminated union; the loop policy
 * (sleep, give up after expiry) lives in the caller so tests can verify
 * the policy independently of the network call.
 */
export async function pollOnce(deviceCode: string): Promise<PollResult> {
  const result = await apiCall<PollPendingResponse | PollSuccessResponse>(
    '/cli/auth/token',
    {
      method: 'POST',
      json: { device_code: deviceCode },
    },
  );

  if (result.ok) {
    const success = result.body as PollSuccessResponse;
    return { kind: 'token', accessToken: success.access_token };
  }

  if (result.status === 400) {
    const pending = result.body as PollPendingResponse;
    switch (pending.error) {
      case 'authorization_pending':
        return { kind: 'pending' };
      case 'slow_down':
        return { kind: 'slow_down' };
      case 'expired_token':
        return { kind: 'expired' };
      case 'access_denied':
      default:
        return { kind: 'denied' };
    }
  }

  throw new ApiNetworkError(
    `Unexpected status ${result.status} from /cli/auth/token`,
  );
}

/**
 * Sleep for the given milliseconds, but bail early if the AbortSignal fires.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
