import { useState, type FormEvent } from 'react';
import { useComments } from '../hooks/useComments';

export function TaskComments({ taskId }: { taskId: string }) {
  const { comments, loading, error, addComment } = useComments(taskId);
  const [body, setBody] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const result = await addComment(body);
    if (result.error) setSendError(result.error.message);
    else {
      setBody('');
      setSendError(null);
    }
  }

  if (loading) return <p className="muted">Cargando comentarios…</p>;

  return (
    <div className="comments">
      {error && <p className="error">{error.message}</p>}
      {comments.map((c) => (
        <p key={c.id}>{c.body}</p>
      ))}
      <form onSubmit={handleSubmit} className="row">
        <input value={body} onChange={(e) => setBody(e.target.value)} placeholder="Comentar…" />
        <button type="submit" disabled={!body.trim()}>
          Enviar
        </button>
      </form>
      {sendError && <p className="error">{sendError}</p>}
    </div>
  );
}
