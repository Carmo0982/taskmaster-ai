import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { useSupabase } from '../lib/SupabaseProvider';
import type { Comment } from '../types/database';
import { createCollectionReducer, initialCollectionState } from './core/realtimeCollection';
import {
  channelName,
  fail,
  ok,
  toError,
  type MutationResult,
  type RealtimeStatus,
} from './core/result';

/**
 * Comentarios de una tarea. Reutiliza el mismo reductor genérico que
 * useTasks (misma estrategia de consistencia) con otra configuración:
 * ámbito = task_id y versión = created_at (los comentarios son inmutables).
 */
const commentsReducer = createCollectionReducer<Comment>({
  getScope: (c) => c.task_id,
  getVersion: (c) => c.created_at,
  compare: (a, b) => a.created_at.localeCompare(b.created_at),
});

export function useComments(taskId: string | null) {
  const supabase = useSupabase();
  const [state, dispatch] = useReducer(commentsReducer, taskId, initialCollectionState<Comment>);
  const [realtimeStatus, setRealtimeStatus] = useState<RealtimeStatus>('idle');
  const syncCounter = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  if (state.scopeId !== taskId) dispatch({ type: 'reset', scopeId: taskId });

  const fetchComments = useCallback(async () => {
    if (!taskId) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const syncId = ++syncCounter.current;
    dispatch({ type: 'sync/start', syncId });

    const { data, error } = await supabase
      .from('comments')
      .select('id, task_id, project_id, author_id, body, created_at')
      .eq('task_id', taskId)
      .order('created_at', { ascending: true })
      .abortSignal(controller.signal);

    if (controller.signal.aborted) return;
    if (error) dispatch({ type: 'sync/error', syncId, error: toError(error) });
    else dispatch({ type: 'sync/success', syncId, rows: data });
  }, [supabase, taskId]);

  useEffect(() => {
    if (!taskId) return;
    let active = true;
    void fetchComments();

    const channel = supabase
      .channel(channelName(`comments:task:${taskId}`))
      .on<Comment>(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'comments', filter: `task_id=eq.${taskId}` },
        (payload) => {
          if (active) dispatch({ type: 'server/change', change: { type: 'upsert', row: payload.new } });
        },
      )
      .on<Comment>(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'comments' },
        (payload) => {
          const id = payload.old.id;
          if (active && id) dispatch({ type: 'server/change', change: { type: 'delete', id } });
        },
      )
      .subscribe((status) => {
        if (!active) return;
        setRealtimeStatus(status);
        if (status === 'SUBSCRIBED') void fetchComments();
      });

    return () => {
      active = false;
      abortRef.current?.abort();
      void supabase.removeChannel(channel);
      setRealtimeStatus('idle');
    };
  }, [supabase, taskId, fetchComments]);

  const addComment = useCallback(
    async (body: string): Promise<MutationResult<Comment>> => {
      const text = body.trim();
      if (!taskId || !text) return fail('El comentario está vacío.');
      const { data: auth } = await supabase.auth.getSession();
      const userId = auth.session?.user.id;
      if (!userId) return fail('Debes iniciar sesión.');

      const now = new Date().toISOString();
      const optimistic: Comment = {
        id: crypto.randomUUID(),
        task_id: taskId,
        project_id: '', // lo completa el trigger del servidor
        author_id: userId,
        body: text,
        created_at: now,
      };
      dispatch({ type: 'optimistic/upsert', row: optimistic });

      const { data, error } = await supabase
        .from('comments')
        .insert({ id: optimistic.id, task_id: taskId, body: text })
        .select('id, task_id, project_id, author_id, body, created_at')
        .single();

      if (error) {
        dispatch({ type: 'mutation/rollback', id: optimistic.id });
        return fail(error);
      }
      dispatch({ type: 'mutation/confirm', id: optimistic.id, row: data });
      return ok(data);
    },
    [supabase, taskId],
  );

  const deleteComment = useCallback(
    async (commentId: string): Promise<MutationResult<null>> => {
      dispatch({ type: 'optimistic/delete', id: commentId });
      const { data, error } = await supabase.from('comments').delete().eq('id', commentId).select('id');
      if (error || data.length === 0) {
        dispatch({ type: 'mutation/rollback', id: commentId });
        return fail(error ?? 'Solo el autor puede eliminar su comentario.');
      }
      dispatch({ type: 'mutation/confirm', id: commentId, row: null });
      return ok(null);
    },
    [supabase],
  );

  return {
    comments: state.items,
    loading: state.status === 'loading',
    error: state.error,
    realtimeStatus,
    refetch: fetchComments,
    addComment,
    deleteComment,
  };
}
