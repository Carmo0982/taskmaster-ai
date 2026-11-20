import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type {
  RealtimePostgresDeletePayload,
  RealtimePostgresInsertPayload,
  RealtimePostgresUpdatePayload,
} from '@supabase/supabase-js';
import { useSupabase } from '../lib/SupabaseProvider';
import type { Task, TaskPriority, TaskStatus, TaskUpdate } from '../types/database';
import {
  createCollectionReducer,
  initialCollectionState,
  type CollectionState,
} from './core/realtimeCollection';
import {
  channelName,
  fail,
  ok,
  toError,
  type MutationResult,
  type RealtimeStatus,
} from './core/result';

// -----------------------------------------------------------------------------
// API pública
// -----------------------------------------------------------------------------

export interface NewTaskInput {
  title: string;
  description?: string | null;
  status?: TaskStatus;
  priority?: TaskPriority;
  assignee_id?: string | null;
  due_date?: string | null;
  position?: number;
}

export type TaskPatch = TaskUpdate;

export interface UseTasksOptions {
  /** Desactiva la suscripción (p. ej. vistas de solo lectura o exportaciones). */
  realtime?: boolean;
}

export interface UseTasksResult {
  tasks: Task[];
  /** true solo durante la PRIMERA carga del proyecto (los resync son silenciosos). */
  loading: boolean;
  /** Último error de lectura (el de mutaciones lo devuelve cada función). */
  error: Error | null;
  realtimeStatus: RealtimeStatus;
  /** La fila tiene una mutación optimista sin confirmar. */
  isPending: (taskId: string) => boolean;
  refetch: () => Promise<void>;
  createTask: (input: NewTaskInput) => Promise<MutationResult<Task>>;
  updateTask: (taskId: string, patch: TaskPatch) => Promise<MutationResult<Task>>;
  deleteTask: (taskId: string) => Promise<MutationResult<null>>;
}

// -----------------------------------------------------------------------------
// Estado: reductor genérico configurado para tareas
// -----------------------------------------------------------------------------

const byPosition = (a: Task, b: Task) =>
  a.position - b.position || a.created_at.localeCompare(b.created_at);

const tasksReducer = createCollectionReducer<Task>({
  getScope: (t) => t.project_id,
  getVersion: (t) => t.updated_at, // lo fija un trigger en el servidor
  compare: byPosition,
});

const TASK_COLUMNS =
  'id, project_id, title, description, status, priority, assignee_id, due_date, position, created_by, created_at, updated_at';

// -----------------------------------------------------------------------------
// Hook
// -----------------------------------------------------------------------------

/**
 * Tareas de un proyecto: lectura filtrada, CRUD optimista y sincronización en
 * tiempo real. El componente que lo usa no conoce Supabase.
 *
 * Seguridad: la consulta filtra por `project_id` por rendimiento, pero quien
 * decide qué filas se ven es RLS (`tasks_select_member`). Si el usuario no es
 * miembro, el fetch devuelve [] y las mutaciones fallan → rollback.
 */
export function useTasks(projectId: string | null, options: UseTasksOptions = {}): UseTasksResult {
  const { realtime = true } = options;
  const supabase = useSupabase();

  const [state, dispatch] = useReducer(
    tasksReducer,
    projectId,
    initialCollectionState<Task>,
  );
  const [realtimeStatus, setRealtimeStatus] = useState<RealtimeStatus>('idle');

  // Cambio de proyecto: se resetea DURANTE el render (patrón recomendado por
  // React para "ajustar estado cuando cambia una prop"), así nunca se pinta
  // un frame con las tareas del proyecto anterior.
  if (state.scopeId !== projectId) {
    dispatch({ type: 'reset', scopeId: projectId });
  }

  // Lecturas síncronas del estado más reciente desde callbacks estables.
  const stateRef = useRef<CollectionState<Task>>(state);
  useEffect(() => {
    stateRef.current = state;
  });

  const syncCounter = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  // ---------------------------------------------------------------- fetching
  const fetchTasks = useCallback(async () => {
    if (!projectId) return;

    abortRef.current?.abort(); // una sola lectura en vuelo: la última gana
    const controller = new AbortController();
    abortRef.current = controller;
    const syncId = ++syncCounter.current;
    dispatch({ type: 'sync/start', syncId });

    const { data, error } = await supabase
      .from('tasks')
      .select(TASK_COLUMNS)
      .eq('project_id', projectId)
      .order('position', { ascending: true })
      .order('created_at', { ascending: true })
      .abortSignal(controller.signal);

    if (controller.signal.aborted) return; // desmontado o reemplazado
    if (error) dispatch({ type: 'sync/error', syncId, error: toError(error) });
    else dispatch({ type: 'sync/success', syncId, rows: data });
  }, [supabase, projectId]);

  // ---------------------------------------------- suscripción en tiempo real
  useEffect(() => {
    if (!projectId) return;

    // `active` protege contra callbacks que lleguen tras la limpieza
    // (eventos en tránsito o el CLOSED que emite removeChannel).
    let active = true;
    void fetchTasks();

    if (!realtime) {
      return () => {
        active = false;
        abortRef.current?.abort();
      };
    }

    const filter = `project_id=eq.${projectId}`;
    const channel = supabase
      .channel(channelName(`tasks:project:${projectId}`))
      .on<Task>(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'tasks', filter },
        (payload: RealtimePostgresInsertPayload<Task>) => {
          if (active) dispatch({ type: 'server/change', change: { type: 'upsert', row: payload.new } });
        },
      )
      .on<Task>(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'tasks', filter },
        (payload: RealtimePostgresUpdatePayload<Task>) => {
          // Si la tarea se movió a otro proyecto, el reductor la saca de la lista.
          if (active) dispatch({ type: 'server/change', change: { type: 'upsert', row: payload.new } });
        },
      )
      // Los DELETE no admiten filtro y, con RLS, solo traen la PK: se escucha
      // sin filtro y se borra por id (ids ajenos no están en la lista → no-op).
      .on<Task>(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'tasks' },
        (payload: RealtimePostgresDeletePayload<Task>) => {
          const id = payload.old.id;
          if (active && id) dispatch({ type: 'server/change', change: { type: 'delete', id } });
        },
      )
      .subscribe((status, err) => {
        if (!active) return;
        setRealtimeStatus(status);
        // Cada (re)conexión re-sincroniza: cubre la ventana entre el snapshot
        // inicial y la activación del canal, y los eventos perdidos mientras
        // el socket estuvo caído.
        if (status === 'SUBSCRIBED') void fetchTasks();
        if (err) console.warn('[useTasks] realtime:', err.message);
      });

    // Limpieza: corta la petición en vuelo y cierra el canal (evita fugas de
    // memoria y sockets huérfanos al desmontar o cambiar de proyecto).
    return () => {
      active = false;
      abortRef.current?.abort();
      void supabase.removeChannel(channel);
      setRealtimeStatus('idle');
    };
  }, [supabase, projectId, realtime, fetchTasks]);

  // --------------------------------------------------------------- mutaciones
  const createTask = useCallback(
    async (input: NewTaskInput): Promise<MutationResult<Task>> => {
      if (!projectId) return fail('No hay un proyecto seleccionado.');
      const title = input.title.trim();
      if (!title) return fail('El título es obligatorio.');

      const { data: auth } = await supabase.auth.getSession();
      const userId = auth.session?.user.id;
      if (!userId) return fail('Debes iniciar sesión.');

      const items = stateRef.current.items;
      const now = new Date().toISOString();
      // El id se genera en el cliente: la fila optimista y el eco de Realtime
      // comparten id, así que se deduplican solas (operación idempotente).
      const optimistic: Task = {
        id: crypto.randomUUID(),
        project_id: projectId,
        title,
        description: input.description ?? null,
        status: input.status ?? 'todo',
        priority: input.priority ?? 'medium',
        assignee_id: input.assignee_id ?? null,
        due_date: input.due_date ?? null,
        position: input.position ?? (items.length ? Math.max(...items.map((t) => t.position)) + 1 : 0),
        created_by: userId,
        created_at: now,
        updated_at: now,
      };
      dispatch({ type: 'optimistic/upsert', row: optimistic });

      // created_by/created_at/updated_at los pone la BD; RLS valida
      // created_by = auth.uid() y la membresía al proyecto.
      const { data, error } = await supabase
        .from('tasks')
        .insert({
          id: optimistic.id,
          project_id: optimistic.project_id,
          title: optimistic.title,
          description: optimistic.description,
          status: optimistic.status,
          priority: optimistic.priority,
          assignee_id: optimistic.assignee_id,
          due_date: optimistic.due_date,
          position: optimistic.position,
        })
        .select(TASK_COLUMNS)
        .single();

      if (error) {
        dispatch({ type: 'mutation/rollback', id: optimistic.id });
        return fail(error);
      }
      dispatch({ type: 'mutation/confirm', id: optimistic.id, row: data });
      return ok(data);
    },
    [supabase, projectId],
  );

  const updateTask = useCallback(
    async (taskId: string, patch: TaskPatch): Promise<MutationResult<Task>> => {
      const current = stateRef.current.items.find((t) => t.id === taskId);
      if (!current) return fail('La tarea no existe en este proyecto.');

      dispatch({ type: 'optimistic/upsert', row: { ...current, ...patch } });

      const { data, error } = await supabase
        .from('tasks')
        .update(patch)
        .eq('id', taskId)
        .select(TASK_COLUMNS)
        .maybeSingle();

      if (error || !data) {
        dispatch({ type: 'mutation/rollback', id: taskId });
        // Con RLS, un UPDATE no autorizado no lanza error: afecta 0 filas.
        return fail(error ?? 'No tienes permiso o la tarea fue eliminada por otro usuario.');
      }
      dispatch({ type: 'mutation/confirm', id: taskId, row: data });
      return ok(data);
    },
    [supabase],
  );

  const deleteTask = useCallback(
    async (taskId: string): Promise<MutationResult<null>> => {
      if (!stateRef.current.items.some((t) => t.id === taskId)) {
        return fail('La tarea no existe en este proyecto.');
      }
      dispatch({ type: 'optimistic/delete', id: taskId });

      const { data, error } = await supabase
        .from('tasks')
        .delete()
        .eq('id', taskId)
        .select('id');

      if (error || data.length === 0) {
        dispatch({ type: 'mutation/rollback', id: taskId });
        return fail(error ?? 'No tienes permiso para eliminar esta tarea.');
      }
      dispatch({ type: 'mutation/confirm', id: taskId, row: null });
      return ok(null);
    },
    [supabase],
  );

  const isPending = useCallback((taskId: string) => taskId in state.pending, [state.pending]);

  return {
    tasks: state.items,
    loading: state.status === 'loading',
    error: state.error,
    realtimeStatus,
    isPending,
    refetch: fetchTasks,
    createTask,
    updateTask,
    deleteTask,
  };
}
