import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { supabase } from './lib/supabaseClient';
import { SupabaseProvider } from './lib/SupabaseProvider';
import App from './App';
import './index.css';

// StrictMode monta → desmonta → monta cada efecto en desarrollo: es la prueba
// más rápida de que los hooks limpian sus canales (no se duplican eventos).
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SupabaseProvider client={supabase}>
      <App />
    </SupabaseProvider>
  </StrictMode>,
);
