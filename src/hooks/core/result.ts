/** Resultado de una mutación: el componente decide cómo reaccionar sin try/catch. */
export type MutationResult<T> = { data: T; error: null } | { data: null; error: Error };

export const ok = <T,>(data: T): MutationResult<T> => ({ data, error: null });
export const fail = <T,>(error: unknown): MutationResult<T> => ({ data: null, error: toError(error) });

/** PostgrestError / AuthError / string → Error con mensaje legible. */
export function toError(e: unknown): Error {
  if (e instanceof Error) return e;
  if (typeof e === 'object' && e !== null && 'message' in e) {
    return new Error(String((e as { message: unknown }).message));
  }
  return new Error(String(e));
}

/** Estados de suscripción que reporta `channel.subscribe()`. */
export type RealtimeStatus = 'idle' | 'SUBSCRIBED' | 'TIMED_OUT' | 'CLOSED' | 'CHANNEL_ERROR';

/** Sufijo único: dos componentes con el mismo hook no comparten (ni cierran) el canal del otro. */
export const channelName = (base: string) => `${base}:${crypto.randomUUID()}`;
