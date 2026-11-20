import { createContext, useContext, type ReactNode } from 'react';
import type { TypedSupabaseClient } from './supabaseClient';

/**
 * Inyección de dependencias del cliente. Los hooks no importan el singleton
 * directamente: lo leen del contexto. Así se pueden probar con un cliente
 * simulado y reutilizar contra otro proyecto de Supabase sin tocar su código.
 */
const SupabaseContext = createContext<TypedSupabaseClient | null>(null);

export function SupabaseProvider({
  client,
  children,
}: {
  client: TypedSupabaseClient;
  children: ReactNode;
}) {
  return <SupabaseContext.Provider value={client}>{children}</SupabaseContext.Provider>;
}

export function useSupabase(): TypedSupabaseClient {
  const client = useContext(SupabaseContext);
  if (!client) throw new Error('useSupabase debe usarse dentro de <SupabaseProvider>.');
  return client;
}
