import { useState, type FormEvent } from 'react';
import { useTasks } from '../hooks/useTasks';
import { useProjectMembers } from '../hooks/useProjectMembers';
import type { Task, TaskStatus } from '../types/database';
import { TaskComments } from './TaskComments';

const COLUMNS: { status: TaskStatus; label: string }[] = [
  { status: 'todo', label: 'Por hacer' },
  { status: 'in_progress', label: 'En progreso' },
  { status: 'done', label: 'Hecho' },
];

/**
 * Componente 100 % de presentación: no importa supabase-js. Toda la lógica de
 * datos (carga, errores, mutaciones optimistas, tiempo real) vive en useTasks.
 */
export function TaskBoard({ projectId, userId }: { projectId: string; userId: string }) {
  const { tasks, loading, error, realtimeStatus, isPending, createTask, updateTask, deleteTask } =
    useTasks(projectId);
  const { members, onlineIds } = useProjectMembers(projectId, userId);

  const [title, setTitle] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    const result = await createTask({ title });
    if (result.error) setActionError(result.error.message);
    else {
      setTitle('');
      setActionError(null);
    }
  }

  async function run(action: Promise<{ error: Error | null }>) {
    const { error: err } = await action;
    setActionError(err ? err.message : null);
  }

  if (loading) return <p className="muted">Cargando tareas…</p>;

  return (
    <section>
      <header className="board-header">
        <span className={`badge ${realtimeStatus === 'SUBSCRIBED' ? 'ok' : 'warn'}`}>
          {realtimeStatus === 'SUBSCRIBED' ? '● En vivo' : '○ Reconectando…'}
        </span>
        <span className="muted">
          {members.map((m) => (
            <span key={m.profile.id} className={onlineIds.has(m.profile.id) ? 'online' : ''}>
              {m.profile.full_name ?? 'Usuario'}{' '}
            </span>
          ))}
        </span>
      </header>

      {error && <p className="error">No se pudieron cargar las tareas: {error.message}</p>}
      {actionError && <p className="error">{actionError}</p>}

      <form onSubmit={handleCreate} className="row">
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Nueva tarea…" />
        <button type="submit" disabled={!title.trim()}>
          Añadir
        </button>
      </form>

      <div className="columns">
        {COLUMNS.map((col) => (
          <div key={col.status} className="column">
            <h3>{col.label}</h3>
            {tasks
              .filter((t) => t.status === col.status)
              .map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  pending={isPending(task.id)}
                  assigneeOptions={members.map((m) => m.profile)}
                  onStatus={(status) => run(updateTask(task.id, { status }))}
                  onAssign={(assignee_id) => run(updateTask(task.id, { assignee_id }))}
                  onDelete={() => run(deleteTask(task.id))}
                  onOpen={() => setOpenTaskId(openTaskId === task.id ? null : task.id)}
                  open={openTaskId === task.id}
                />
              ))}
          </div>
        ))}
      </div>
    </section>
  );
}

function TaskCard(props: {
  task: Task;
  pending: boolean;
  open: boolean;
  assigneeOptions: { id: string; full_name: string | null }[];
  onStatus: (s: TaskStatus) => void;
  onAssign: (id: string | null) => void;
  onDelete: () => void;
  onOpen: () => void;
}) {
  const { task, pending, open } = props;
  return (
    <article className={`card ${pending ? 'pending' : ''}`} aria-busy={pending}>
      <strong>{task.title}</strong>
      <div className="row">
        <select value={task.status} onChange={(e) => props.onStatus(e.target.value as TaskStatus)}>
          {COLUMNS.map((c) => (
            <option key={c.status} value={c.status}>
              {c.label}
            </option>
          ))}
        </select>
        <select
          value={task.assignee_id ?? ''}
          onChange={(e) => props.onAssign(e.target.value || null)}
        >
          <option value="">Sin asignar</option>
          {props.assigneeOptions.map((p) => (
            <option key={p.id} value={p.id}>
              {p.full_name ?? p.id.slice(0, 8)}
            </option>
          ))}
        </select>
      </div>
      <div className="row">
        <button type="button" onClick={props.onOpen}>
          {open ? 'Ocultar' : 'Comentarios'}
        </button>
        <button type="button" className="danger" onClick={props.onDelete}>
          Eliminar
        </button>
      </div>
      {/* Montar/desmontar este bloque abre/cierra su canal de Realtime. */}
      {open && <TaskComments taskId={task.id} />}
    </article>
  );
}
