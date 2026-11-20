import { describe, expect, it } from 'vitest';
import {
  createCollectionReducer,
  initialCollectionState,
  type CollectionAction,
  type CollectionState,
} from './realtimeCollection';

interface Row {
  id: string;
  scope: string;
  v: string; // versión ISO
  title: string;
}

const reducer = createCollectionReducer<Row>({
  getScope: (r) => r.scope,
  getVersion: (r) => r.v,
  compare: (a, b) => a.id.localeCompare(b.id),
});

const row = (id: string, minute: number, title = id, scope = 'p1'): Row => ({
  id,
  scope,
  title,
  v: `2026-11-20T10:${String(minute).padStart(2, '0')}:00.000Z`,
});

const run = (actions: CollectionAction<Row>[], start = initialCollectionState<Row>('p1')) =>
  actions.reduce<CollectionState<Row>>(reducer, start);

describe('realtimeCollection', () => {
  it('carga el snapshot y descarta respuestas de fetch obsoletas', () => {
    const s = run([
      { type: 'sync/start', syncId: 1 },
      { type: 'sync/start', syncId: 2 },
      { type: 'sync/success', syncId: 1, rows: [row('old', 0)] }, // obsoleta
      { type: 'sync/success', syncId: 2, rows: [row('a', 0)] },
    ]);
    expect(s.items.map((r) => r.id)).toEqual(['a']);
    expect(s.status).toBe('ready');
  });

  it('no pierde eventos que llegan mientras el fetch está en vuelo', () => {
    const s = run([
      { type: 'sync/start', syncId: 1 },
      { type: 'server/change', change: { type: 'upsert', row: row('b', 5) } },
      { type: 'server/change', change: { type: 'delete', id: 'a' } },
      // el snapshot se leyó antes de esos eventos
      { type: 'sync/success', syncId: 1, rows: [row('a', 0)] },
    ]);
    expect(s.items.map((r) => r.id)).toEqual(['b']);
  });

  it('last-write-wins: ignora eventos más viejos y duplicados', () => {
    const s = run([
      { type: 'sync/start', syncId: 1 },
      { type: 'sync/success', syncId: 1, rows: [row('a', 5, 'nuevo')] },
      { type: 'server/change', change: { type: 'upsert', row: row('a', 1, 'viejo') } },
    ]);
    expect(s.items[0]?.title).toBe('nuevo');
  });

  it('saca la fila si se mueve a otro ámbito (proyecto)', () => {
    const s = run([
      { type: 'sync/start', syncId: 1 },
      { type: 'sync/success', syncId: 1, rows: [row('a', 0)] },
      { type: 'server/change', change: { type: 'upsert', row: row('a', 1, 'a', 'p2') } },
    ]);
    expect(s.items).toEqual([]);
  });

  it('rollback restaura la versión confirmada, incluso si cambió por Realtime', () => {
    const s = run([
      { type: 'sync/start', syncId: 1 },
      { type: 'sync/success', syncId: 1, rows: [row('a', 0, 'original')] },
      { type: 'optimistic/upsert', row: { ...row('a', 0), title: 'optimista' } },
      // otro usuario edita mientras nuestra mutación está en vuelo
      { type: 'server/change', change: { type: 'upsert', row: row('a', 3, 'de otro usuario') } },
    ]);
    expect(s.items[0]?.title).toBe('optimista'); // no se pisa la UI
    const rolledBack = reducer(s, { type: 'mutation/rollback', id: 'a' });
    expect(rolledBack.items[0]?.title).toBe('de otro usuario');
    expect(rolledBack.pending).toEqual({});
  });

  it('confirmación aplica la versión del servidor y limpia el pendiente', () => {
    const s = run([
      { type: 'sync/start', syncId: 1 },
      { type: 'sync/success', syncId: 1, rows: [] },
      { type: 'optimistic/upsert', row: row('n', 0, 'optimista') },
      { type: 'server/change', change: { type: 'upsert', row: row('n', 1, 'eco') } }, // eco Realtime
      { type: 'mutation/confirm', id: 'n', row: row('n', 1, 'eco') },
    ]);
    expect(s.items).toEqual([row('n', 1, 'eco')]);
    expect(s.pending).toEqual({});
  });

  it('borrado optimista fallido reinserta la fila', () => {
    const s = run([
      { type: 'sync/start', syncId: 1 },
      { type: 'sync/success', syncId: 1, rows: [row('a', 0)] },
      { type: 'optimistic/delete', id: 'a' },
    ]);
    expect(s.items).toEqual([]);
    expect(reducer(s, { type: 'mutation/rollback', id: 'a' }).items).toEqual([row('a', 0)]);
  });

  it('un resync conserva las filas optimistas aún no confirmadas', () => {
    const s = run([
      { type: 'sync/start', syncId: 1 },
      { type: 'sync/success', syncId: 1, rows: [row('a', 0)] },
      { type: 'optimistic/upsert', row: row('nuevo', 0) },
      { type: 'sync/start', syncId: 2 },
      { type: 'sync/success', syncId: 2, rows: [row('a', 0)] },
    ]);
    expect(s.items.map((r) => r.id)).toEqual(['a', 'nuevo']);
  });
});
