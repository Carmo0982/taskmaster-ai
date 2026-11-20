import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { SupabaseProvider } from '../lib/SupabaseProvider';
import type { TypedSupabaseClient } from '../lib/supabaseClient';
import type { Task } from '../types/database';
import { useTasks } from './useTasks';

// ---------------------------------------------------------------------------
// Cliente de Supabase simulado: query builder "thenable" + canales Realtime.
// ---------------------------------------------------------------------------
type Op = 'select' | 'insert' | 'update' | 'delete';
type Responder = (op: Op, table: string, payload?: unknown) => { data: unknown; error: unknown };

interface MockChannel {
  name: string;
  removed: boolean;
  bindings: { event: string; cb: (payload: unknown) => void }[];
}

function createMockClient(respond: Responder) {
  const channels: MockChannel[] = [];

  const from = (table: string) => {
    let op: Op = 'select';
    let payload: unknown;
    const builder: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'order', 'abortSignal', 'single', 'maybeSingle']) {
      builder[m] = () => builder;
    }
    for (const m of ['insert', 'update', 'delete'] as const) {
      builder[m] = (body?: unknown) => {
        op = m;
        payload = body;
        return builder;
      };
    }
    builder.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(respond(op, table, payload)).then(res, rej);
    return builder;
  };

  const channel = (name: string) => {
    const ch: MockChannel = { name, removed: false, bindings: [] };
    channels.push(ch);
    const api = {
      on: (_type: string, filter: { event: string }, cb: (p: unknown) => void) => {
        ch.bindings.push({ event: filter.event, cb });
        return api;
      },
      subscribe: (cb: (status: string) => void) => {
        queueMicrotask(() => {
          if (!ch.removed) cb('SUBSCRIBED');
        });
        return api;
      },
      __mock: ch,
    };
    return api;
  };

  const removeChannel = vi.fn(async (api: { __mock: MockChannel }) => {
    api.__mock.removed = true;
    return 'ok';
  });

  const client = {
    from,
    channel,
    removeChannel,
    auth: { getSession: async () => ({ data: { session: { user: { id: 'u1' } } } }) },
  } as unknown as TypedSupabaseClient;

  const emit = (event: 'INSERT' | 'UPDATE' | 'DELETE', payload: unknown) => {
    for (const ch of channels) {
      if (ch.removed) continue;
      for (const b of ch.bindings) if (b.event === event) b.cb(payload);
    }
  };

  return { client, channels, removeChannel, emit };
}

const task = (id: string, project_id = 'p1', extra: Partial<Task> = {}): Task => ({
  id,
  project_id,
  title: `Tarea ${id}`,
  description: null,
  status: 'todo',
  priority: 'medium',
  assignee_id: null,
  due_date: null,
  position: 0,
  created_by: 'u1',
  created_at: '2026-11-20T10:00:00.000Z',
  updated_at: '2026-11-20T10:00:00.000Z',
  ...extra,
});

const wrapperFor = (client: TypedSupabaseClient) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return <SupabaseProvider client={client}>{children}</SupabaseProvider>;
  };

// ---------------------------------------------------------------------------

describe('useTasks', () => {
  it('carga las tareas del proyecto y maneja loading', async () => {
    const mock = createMockClient(() => ({ data: [task('a')], error: null }));
    const { result } = renderHook(() => useTasks('p1'), { wrapper: wrapperFor(mock.client) });

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.tasks.map((t) => t.id)).toEqual(['a']);
    await waitFor(() => expect(result.current.realtimeStatus).toBe('SUBSCRIBED'));
  });

  it('expone el error de lectura', async () => {
    const mock = createMockClient(() => ({ data: null, error: { message: 'permission denied' } }));
    const { result } = renderHook(() => useTasks('p1'), { wrapper: wrapperFor(mock.client) });
    await waitFor(() => expect(result.current.error?.message).toBe('permission denied'));
  });

  it('aplica INSERT / UPDATE / DELETE recibidos por Realtime', async () => {
    const mock = createMockClient(() => ({ data: [task('a')], error: null }));
    const { result } = renderHook(() => useTasks('p1'), { wrapper: wrapperFor(mock.client) });
    await waitFor(() => expect(result.current.realtimeStatus).toBe('SUBSCRIBED'));
    await waitFor(() => expect(result.current.tasks).toHaveLength(1));

    act(() => mock.emit('INSERT', { new: task('b', 'p1', { position: 1 }) }));
    expect(result.current.tasks.map((t) => t.id)).toEqual(['a', 'b']);

    act(() =>
      mock.emit('UPDATE', {
        new: task('a', 'p1', { status: 'done', updated_at: '2026-11-20T11:00:00.000Z' }),
      }),
    );
    expect(result.current.tasks.find((t) => t.id === 'a')?.status).toBe('done');

    act(() => mock.emit('DELETE', { old: { id: 'b' } }));
    expect(result.current.tasks.map((t) => t.id)).toEqual(['a']);
  });

  it('cierra el canal al desmontar y al cambiar de proyecto (sin fugas)', async () => {
    const mock = createMockClient(() => ({ data: [], error: null }));
    const { rerender, unmount } = renderHook(({ id }) => useTasks(id), {
      wrapper: wrapperFor(mock.client),
      initialProps: { id: 'p1' },
    });
    await waitFor(() => expect(mock.channels).toHaveLength(1));

    rerender({ id: 'p2' });
    expect(mock.removeChannel).toHaveBeenCalledTimes(1);
    expect(mock.channels[0]?.removed).toBe(true);

    unmount();
    expect(mock.removeChannel).toHaveBeenCalledTimes(2);
    expect(mock.channels.every((c) => c.removed)).toBe(true);
  });

  it('ignora tareas de otro proyecto que lleguen por Realtime', async () => {
    const mock = createMockClient(() => ({ data: [], error: null }));
    const { result } = renderHook(() => useTasks('p1'), { wrapper: wrapperFor(mock.client) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => mock.emit('INSERT', { new: task('x', 'otro-proyecto') }));
    expect(result.current.tasks).toEqual([]);
  });

  it('actualización optimista con rollback cuando RLS bloquea (0 filas)', async () => {
    // Con RLS, un UPDATE no autorizado no da error: devuelve 0 filas.
    const mock = createMockClient((op) =>
      op === 'update' ? { data: null, error: null } : { data: [task('a')], error: null },
    );
    const { result } = renderHook(() => useTasks('p1'), { wrapper: wrapperFor(mock.client) });
    await waitFor(() => expect(result.current.tasks).toHaveLength(1));

    let promise!: ReturnType<typeof result.current.updateTask>;
    act(() => {
      promise = result.current.updateTask('a', { status: 'done' });
    });
    // UI optimista inmediata
    expect(result.current.tasks[0]?.status).toBe('done');
    expect(result.current.isPending('a')).toBe(true);

    const res = await act(() => promise);
    expect(res.error?.message).toMatch(/permiso/);
    expect(result.current.tasks[0]?.status).toBe('todo');
    expect(result.current.isPending('a')).toBe(false);
  });

  it('crear tarea: optimista + confirmación del servidor sin duplicar con el eco Realtime', async () => {
    const mock = createMockClient((op, _table, payload) => {
      if (op === 'insert') {
        // el servidor respeta el id generado en el cliente
        const body = payload as Task;
        return { data: task(body.id, 'p1', { title: body.title }), error: null };
      }
      return { data: [], error: null };
    });
    const { result } = renderHook(() => useTasks('p1'), { wrapper: wrapperFor(mock.client) });
    await waitFor(() => expect(result.current.loading).toBe(false));

    const res = await act(() => result.current.createTask({ title: 'Nueva' }));
    expect(res.error).toBeNull();
    act(() => mock.emit('INSERT', { new: res.data }));
    expect(result.current.tasks.filter((t) => t.title === 'Nueva')).toHaveLength(1);
  });
});
