import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { useSupabase } from '../lib/SupabaseProvider';

/**
 * Usuario autenticado. Escucha onAuthStateChange (login, logout, refresh del
 * token) y se desuscribe al desmontar.
 */
export function useSession() {
  const supabase = useSupabase();
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    void supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data.session);
      setLoading(false);
    });

    const { data } = supabase.auth.onAuthStateChange((_event, next) => {
      if (!active) return;
      setSession(next);
      setLoading(false);
    });

    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, [supabase]);

  return { session, user: session?.user ?? null, loading };
}
