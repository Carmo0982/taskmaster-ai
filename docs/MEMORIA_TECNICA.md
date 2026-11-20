# Memoria técnica — Capa de persistencia de TaskMaster AI

**Estructura.** Separé la aplicación en tres capas. Los componentes (`TaskBoard`, `TaskComments`) solo pintan y llaman funciones; no importan `supabase-js`. Los hooks por entidad (`useTasks`, `useComments`, `useProjectMembers`, `useSession`) encapsulan consultas, mutaciones y suscripciones, y exponen una interfaz estable: `data`, `loading`, `error` y funciones que devuelven `{ data, error }`. Debajo, un reductor puro y genérico (`realtimeCollection`) concentra las reglas de consistencia; `useTasks` y `useComments` lo reutilizan con distinta configuración. El cliente se inyecta con `SupabaseProvider`, lo que permite probar los hooks con un cliente simulado.

**Consistencia en tiempo real.** La lista recibe datos por tres vías que compiten (*snapshot*, eventos `postgres_changes` y mutaciones propias):

1. *Last-write-wins* por `updated_at`, que fija un *trigger* del servidor, no el reloj del cliente. Los eventos atrasados o duplicados se descartan.
2. Mientras un *fetch* está en vuelo, los eventos se aplican y además se guardan en un *buffer* que se reaplica sobre el *snapshot*, de modo que no se pierde nada.
3. Cada vez que el canal pasa a `SUBSCRIBED` (conexión o reconexión) se resincroniza la lista.
4. Mutaciones optimistas con UUID generado en el cliente: el eco de Realtime trae el mismo id y se deduplica solo. Si llega un evento ajeno durante la mutación, solo actualiza la "base confirmada", que es la que se restaura si hay *rollback*.

**Seguridad.** Solo se usa la *anon key*; RLS decide qué filas existen para cada usuario, también en Realtime. Con RLS, un UPDATE o DELETE no autorizado no devuelve error sino 0 filas, así que los hooks lo detectan y revierten. Los DELETE llegan sin filtro y solo con la clave primaria, por lo que se aplican por id.

**Ciclo de vida.** Cada efecto devuelve una limpieza que aborta la petición en curso (`AbortController`), llama a `removeChannel` y activa una bandera `active` que ignora los *callbacks* tardíos. `StrictMode` y las pruebas verifican que no queden canales huérfanos.
