import { useState, type FormEvent } from 'react';
import { useSupabase } from './lib/SupabaseProvider';
import { useProjects, useSession } from './hooks';
import { TaskBoard } from './components/TaskBoard';

export default function App() {
  const supabase = useSupabase();
  const { user, loading: sessionLoading } = useSession();
  const { projects, loading, error, createProject } = useProjects(Boolean(user));
  const [selected, setSelected] = useState<string | null>(null);
  const [newProject, setNewProject] = useState('');

  if (sessionLoading) return <p className="muted">Cargando…</p>;
  if (!user) return <Login onLogin={(email) => supabase.auth.signInWithOtp({ email })} />;

  const projectId = selected ?? projects[0]?.id ?? null;

  async function handleCreateProject(e: FormEvent) {
    e.preventDefault();
    const result = await createProject(newProject);
    if (result.data) {
      setSelected(result.data.id);
      setNewProject('');
    }
  }

  return (
    <main>
      <header className="row">
        <h1>TaskMaster AI</h1>
        <button type="button" onClick={() => void supabase.auth.signOut()}>
          Salir
        </button>
      </header>

      {error && <p className="error">{error.message}</p>}
      <div className="row">
        <select
          value={projectId ?? ''}
          onChange={(e) => setSelected(e.target.value)}
          disabled={loading || projects.length === 0}
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <form onSubmit={handleCreateProject} className="row">
          <input value={newProject} onChange={(e) => setNewProject(e.target.value)} placeholder="Nuevo proyecto" />
          <button type="submit" disabled={!newProject.trim()}>
            Crear
          </button>
        </form>
      </div>

      {/* key={projectId}: cambiar de proyecto desmonta el tablero y su canal. */}
      {projectId && <TaskBoard key={projectId} projectId={projectId} userId={user.id} />}
    </main>
  );
}

function Login({ onLogin }: { onLogin: (email: string) => Promise<{ error: Error | null }> }) {
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const { error } = await onLogin(email);
    setMessage(error ? error.message : 'Revisa tu correo: te enviamos un enlace de acceso.');
  }

  return (
    <main>
      <h1>TaskMaster AI</h1>
      <form onSubmit={handleSubmit} className="row">
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="tu@correo.com" />
        <button type="submit">Entrar</button>
      </form>
      {message && <p className="muted">{message}</p>}
    </main>
  );
}
