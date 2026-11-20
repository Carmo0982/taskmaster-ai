/**
 * Máquina de estado genérica para una colección sincronizada con Supabase.
 *
 * Es un reductor PURO (sin React ni Supabase) que resuelve los tres problemas
 * de consistencia de una lista que recibe datos por tres vías a la vez:
 *
 *  1. Snapshot (fetch inicial / resync)  →  `sync/*`
 *  2. Eventos Realtime de otros usuarios  →  `server/change`
 *  3. Mutaciones optimistas propias       →  `optimistic/*` + `mutation/*`
 *
 * Reglas:
 *  - Last-write-wins por versión del servidor (`updated_at`): un evento más
 *    viejo que lo que ya tenemos se descarta (los eventos pueden llegar
 *    desordenados o duplicados; aplicar el mismo evento dos veces es inocuo).
 *  - Mientras hay un fetch en curso, los eventos se aplican Y se guardan en un
 *    buffer que se re-aplica sobre el snapshot. Así no se pierde nada que
 *    ocurra entre que Postgres lee la tabla y llega la respuesta.
 *  - Una fila con mutación optimista pendiente no se pisa con eventos: el
 *    evento actualiza su "base" (la última versión confirmada por el servidor),
 *    que es la que se muestra si la mutación falla (rollback) o al confirmar.
 */

export interface Entity {
  id: string;
}

export type ServerChange<T> = { type: 'upsert'; row: T } | { type: 'delete'; id: string };

interface PendingEntry<T> {
  /** Última versión confirmada por el servidor (null = no existe en BD). */
  base: T | null;
  /** Mutaciones en vuelo sobre esta fila. */
  count: number;
}

export type CollectionStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface CollectionState<T extends Entity> {
  /** Ámbito actual (p. ej. project_id). Filas de otro ámbito se ignoran. */
  scopeId: string | null;
  items: T[];
  status: CollectionStatus;
  error: Error | null;
  /** Id del fetch en curso (0 = ninguno). Respuestas de fetch viejos se descartan. */
  syncId: number;
  buffer: ServerChange<T>[];
  pending: Record<string, PendingEntry<T>>;
}

export type CollectionAction<T> =
  | { type: 'reset'; scopeId: string | null }
  | { type: 'sync/start'; syncId: number }
  | { type: 'sync/success'; syncId: number; rows: T[] }
  | { type: 'sync/error'; syncId: number; error: Error }
  | { type: 'server/change'; change: ServerChange<T> }
  | { type: 'optimistic/upsert'; row: T }
  | { type: 'optimistic/delete'; id: string }
  /** `row: null` confirma un borrado. */
  | { type: 'mutation/confirm'; id: string; row: T | null }
  | { type: 'mutation/rollback'; id: string };

export interface CollectionConfig<T> {
  getScope: (row: T) => string;
  /** Marca temporal ISO asignada por el servidor. */
  getVersion: (row: T) => string;
  compare: (a: T, b: T) => number;
}

export function initialCollectionState<T extends Entity>(
  scopeId: string | null,
): CollectionState<T> {
  return {
    scopeId,
    items: [],
    status: scopeId ? 'loading' : 'idle',
    error: null,
    syncId: 0,
    buffer: [],
    pending: {},
  };
}

export function createCollectionReducer<T extends Entity>(config: CollectionConfig<T>) {
  const { getScope, getVersion, compare } = config;

  const isAtLeastAsNew = (incoming: T, current: T | null) =>
    current === null || Date.parse(getVersion(incoming)) >= Date.parse(getVersion(current));

  const put = (items: T[], row: T) =>
    [...items.filter((i) => i.id !== row.id), row].sort(compare);

  const drop = (items: T[], id: string) =>
    items.some((i) => i.id === id) ? items.filter((i) => i.id !== id) : items;

  const withoutKey = (pending: Record<string, PendingEntry<T>>, id: string) => {
    const next = { ...pending };
    delete next[id];
    return next;
  };

  /** Aplica una verdad del servidor (evento Realtime o replay del buffer). */
  function applyServerChange(state: CollectionState<T>, change: ServerChange<T>) {
    if (change.type === 'delete') {
      const p = state.pending[change.id];
      return {
        ...state,
        items: drop(state.items, change.id),
        pending: p ? { ...state.pending, [change.id]: { ...p, base: null } } : state.pending,
      };
    }

    const row = change.row;
    const inScope = getScope(row) === state.scopeId;
    const p = state.pending[row.id];

    if (p) {
      // Fila con mutación propia en vuelo: solo avanza la base confirmada.
      const base = !inScope ? null : isAtLeastAsNew(row, p.base) ? row : p.base;
      return { ...state, pending: { ...state.pending, [row.id]: { ...p, base } } };
    }

    const current = state.items.find((i) => i.id === row.id) ?? null;
    if (!inScope) {
      // p. ej. la tarea se movió a otro proyecto: sale de la lista.
      return current ? { ...state, items: drop(state.items, row.id) } : state;
    }
    if (!isAtLeastAsNew(row, current)) return state; // evento obsoleto
    return { ...state, items: put(state.items, row) };
  }

  return function collectionReducer(
    state: CollectionState<T>,
    action: CollectionAction<T>,
  ): CollectionState<T> {
    switch (action.type) {
      case 'reset':
        return initialCollectionState<T>(action.scopeId);

      case 'sync/start':
        return {
          ...state,
          syncId: action.syncId,
          buffer: [],
          // Un resync con datos en pantalla es silencioso (sin spinner).
          status: state.status === 'ready' ? 'ready' : 'loading',
        };

      case 'sync/success': {
        if (action.syncId !== state.syncId) return state; // respuesta obsoleta

        let items = action.rows.filter((r) => getScope(r) === state.scopeId).sort(compare);
        const pending: Record<string, PendingEntry<T>> = {};

        // Las filas con mutación pendiente mantienen su versión optimista en
        // pantalla; el snapshot pasa a ser su nueva base confirmada.
        for (const [id, p] of Object.entries(state.pending)) {
          const base = items.find((i) => i.id === id) ?? null;
          pending[id] = { ...p, base };
          items = drop(items, id);
          const optimistic = state.items.find((i) => i.id === id);
          if (optimistic) items = put(items, optimistic);
        }

        let next: CollectionState<T> = {
          ...state,
          items,
          pending,
          status: 'ready',
          error: null,
          syncId: 0,
          buffer: [],
        };
        // Replay de lo que llegó por Realtime mientras el fetch estaba en vuelo.
        for (const change of state.buffer) next = applyServerChange(next, change);
        return next;
      }

      case 'sync/error':
        if (action.syncId !== state.syncId) return state;
        return {
          ...state,
          syncId: 0,
          buffer: [],
          error: action.error,
          // Si ya había datos se conservan; solo se expone el error.
          status: state.status === 'ready' ? 'ready' : 'error',
        };

      case 'server/change': {
        const next = applyServerChange(state, action.change);
        return state.syncId !== 0 ? { ...next, buffer: [...state.buffer, action.change] } : next;
      }

      case 'optimistic/upsert':
      case 'optimistic/delete': {
        const id = action.type === 'optimistic/upsert' ? action.row.id : action.id;
        const p = state.pending[id];
        const current = state.items.find((i) => i.id === id) ?? null;
        return {
          ...state,
          items:
            action.type === 'optimistic/upsert'
              ? put(state.items, action.row)
              : drop(state.items, id),
          pending: {
            ...state.pending,
            [id]: p ? { ...p, count: p.count + 1 } : { base: current, count: 1 },
          },
        };
      }

      case 'mutation/confirm': {
        const p = state.pending[action.id];
        if (!p) {
          // La lista se reseteó (cambio de proyecto) o no había optimismo.
          return action.row
            ? applyServerChange(state, { type: 'upsert', row: action.row })
            : applyServerChange(state, { type: 'delete', id: action.id });
        }
        const base =
          action.row === null ? null : isAtLeastAsNew(action.row, p.base) ? action.row : p.base;
        if (p.count > 1) {
          return { ...state, pending: { ...state.pending, [action.id]: { base, count: p.count - 1 } } };
        }
        return {
          ...state,
          pending: withoutKey(state.pending, action.id),
          items:
            base && getScope(base) === state.scopeId
              ? put(state.items, base)
              : drop(state.items, action.id),
        };
      }

      case 'mutation/rollback': {
        const p = state.pending[action.id];
        if (!p) return state;
        if (p.count > 1) {
          return { ...state, pending: { ...state.pending, [action.id]: { ...p, count: p.count - 1 } } };
        }
        return {
          ...state,
          pending: withoutKey(state.pending, action.id),
          items: p.base ? put(state.items, p.base) : drop(state.items, action.id),
        };
      }
    }
  };
}
