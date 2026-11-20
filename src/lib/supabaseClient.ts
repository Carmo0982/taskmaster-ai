import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../types/database';

/**
 * Cliente único de Supabase (singleton). Usa SOLO la anon key: la seguridad la
 * aplica RLS en Postgres con el JWT del usuario, que supabase-js adjunta
 * automáticamente tanto a las consultas REST como al socket de Realtime.
 * La service_role key jamás debe llegar al navegador.
 */
export type TypedSupabaseClient = SupabaseClient<Database>;

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error(
    'Faltan VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. Copia .env.example a .env.local.',
  );
}

export const supabase: TypedSupabaseClient = createClient<Database>(url, anonKey, {
  auth: { persistSession: true, autoRefreshToken: true },
  realtime: { params: { eventsPerSecond: 10 } },
});
