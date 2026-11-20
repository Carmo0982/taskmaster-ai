# TaskMaster AI: arquitectura de persistencia con Custom Hooks

En este proyecto refactoricé la capa de datos de TaskMaster AI (React 19 + Supabase): toda la lógica de `supabase-js` quedó en hooks reutilizables, con mutaciones optimistas y sincronización en tiempo real.

## Entregables

| Entregable | Archivo |
|---|---|
| Hook principal (fetching, mutaciones y suscripción) | [`src/hooks/useTasks.ts`](src/hooks/useTasks.ts) |
| Ejemplo de consumo en un componente | [`src/components/TaskBoard.tsx`](src/components/TaskBoard.tsx) (fragmento abajo) |
| Memoria técnica (~300 palabras) | [`docs/MEMORIA_TECNICA.md`](docs/MEMORIA_TECNICA.md) |
| Esquema, políticas RLS y publicación Realtime | [`supabase/migrations/0001_schema_rls_realtime.sql`](supabase/migrations/0001_schema_rls_realtime.sql) |
| Pruebas (consistencia, ciclo de vida y rollback) | [`src/hooks/core/realtimeCollection.test.ts`](src/hooks/core/realtimeCollection.test.ts), [`src/hooks/useTasks.test.tsx`](src/hooks/useTasks.test.tsx) |

## Diseño de abstracción

```
Componentes (UI pura) ──► Hooks por entidad ──► Reductor genérico (puro) ──► supabase-js (vía contexto)
TaskBoard, TaskComments   useTasks              realtimeCollection           SupabaseProvider
                          useComments           (LWW, buffer, optimismo)
                          useProjectMembers
                          useProjects, useSession
```

| Entidad | Hook | Responsabilidad |
|---|---|---|
| Tareas | `useTasks(projectId)` | Lectura filtrada por proyecto, `createTask` / `updateTask` / `deleteTask` optimistas, Realtime INSERT/UPDATE/DELETE |
| Comentarios | `useComments(taskId)` | Lectura, `addComment` / `deleteComment`, Realtime |
| Usuarios | `useSession()`, `useProjectMembers(projectId, userId)` | Sesión (`onAuthStateChange`), miembros del proyecto y presencia en línea |
| Proyectos | `useProjects()` | Lista y creación (con refresco coherente) |

## Ejemplo de consumo

```tsx
import { useTasks } from '../hooks/useTasks';

export function TaskBoard({ projectId }: { projectId: string }) {
  const { tasks, loading, error, realtimeStatus, isPending, createTask, updateTask, deleteTask } =
    useTasks(projectId);

  if (loading) return <p>Cargando tareas…</p>;
  if (error) return <p className="error">{error.message}</p>;

  return (
    <>
      <span>{realtimeStatus === 'SUBSCRIBED' ? '● En vivo' : '○ Reconectando…'}</span>
      <button onClick={() => createTask({ title: 'Nueva tarea' })}>Añadir</button>
      <ul>
        {tasks.map((t) => (
          <li key={t.id} style={{ opacity: isPending(t.id) ? 0.5 : 1 }}>
            {t.title}
            <button onClick={() => updateTask(t.id, { status: 'done' })}>✓</button>
            <button
              onClick={async () => {
                const { error } = await deleteTask(t.id); // si RLS lo bloquea → rollback automático
                if (error) alert(error.message);
              }}
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
```

## Cómo ejecutarlo

1. Crea un proyecto en Supabase y ejecuta `supabase/migrations/0001_schema_rls_realtime.sql` en el SQL Editor.
2. Copia `.env.example` a `.env.local` y completa la URL y la **anon key** del proyecto.
3. Instala las dependencias y arranca la app:

```bash
npm install
```

```bash
npm run dev
```

Verificaciones:

```bash
npm run typecheck
```

```bash
npm test
```

Para ver el tiempo real, abre la app en dos navegadores con usuarios distintos que sean miembros del mismo proyecto. Para agregar un miembro, inserta en `project_members` como dueño del proyecto.
