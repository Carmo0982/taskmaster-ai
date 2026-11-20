import { useCallback, useEffect, useState } from 'react';
import { useSupabase } from '../lib/SupabaseProvider';
import type { Project } from '../types/database';
import { fail, ok, toError, type MutationResult } from './core/result';

/** Proyectos del usuario (RLS devuelve solo aquellos de los que es miembro). */
export function useProjects(enabled = true) {
  const supabase = useSupabase();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<Error | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setLoading(true);

    void supabase
      .from('projects')
      .select('id, name, owner_id, created_at')
      .order('created_at', { ascending: true })
      .abortSignal(controller.signal)
      .then(({ data, error: err }) => {
        if (controller.signal.aborted) return;
        if (err) setError(toError(err));
        else {
          setProjects(data);
          setError(null);
        }
        setLoading(false);
      });

    return () => controller.abort();
  }, [supabase, enabled, version]);

  const createProject = useCallback(
    async (name: string): Promise<MutationResult<Project>> => {
      const { data, error: err } = await supabase
        .from('projects')
        .insert({ name: name.trim() })
        .select('id, name, owner_id, created_at')
        .single();
      if (err) return fail(err);
      setVersion((v) => v + 1); // refresco coherente tras la mutación
      return ok(data);
    },
    [supabase],
  );

  return { projects, loading, error, createProject, refetch: () => setVersion((v) => v + 1) };
}
