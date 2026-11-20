import { useEffect, useState } from 'react';
import { useSupabase } from '../lib/SupabaseProvider';
import type { MemberRole, Profile } from '../types/database';
import { toError } from './core/result';

export interface Member {
  role: MemberRole;
  profile: Pick<Profile, 'id' | 'full_name' | 'avatar_url'>;
}

/**
 * Usuarios de un proyecto (para asignar tareas) + quién está conectado ahora
 * (Realtime Presence). Ambos se limpian al desmontar o cambiar de proyecto.
 */
export function useProjectMembers(projectId: string | null, currentUserId: string | null) {
  const supabase = useSupabase();
  const [members, setMembers] = useState<Member[]>([]);
  const [onlineIds, setOnlineIds] = useState<ReadonlySet<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // Lectura (RLS: solo miembros ven a otros miembros).
  useEffect(() => {
    if (!projectId) {
      setMembers([]);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    void supabase
      .from('project_members')
      .select('role, profile:profiles(id, full_name, avatar_url)')
      .eq('project_id', projectId)
      .abortSignal(controller.signal)
      .then(({ data, error: err }) => {
        if (controller.signal.aborted) return;
        if (err) setError(toError(err));
        else setMembers(data.filter((m): m is Member => m.profile !== null));
        setLoading(false);
      });

    return () => controller.abort();
  }, [supabase, projectId]);

  // Presencia: cada cliente anuncia su user_id en el canal del proyecto.
  useEffect(() => {
    if (!projectId || !currentUserId) return;
    let active = true;

    // A diferencia de postgres_changes, Presence agrupa a los clientes por
    // topic: aquí el nombre del canal debe ser el mismo para todos.
    const presence = supabase
      .channel(`presence:project:${projectId}`, { config: { presence: { key: currentUserId } } })
      .on('presence', { event: 'sync' }, () => {
        if (active) setOnlineIds(new Set(Object.keys(presence.presenceState())));
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') void presence.track({ online_at: new Date().toISOString() });
      });

    return () => {
      active = false;
      setOnlineIds(new Set());
      void presence.untrack();
      void supabase.removeChannel(presence);
    };
  }, [supabase, projectId, currentUserId]);

  return { members, onlineIds, loading, error };
}
