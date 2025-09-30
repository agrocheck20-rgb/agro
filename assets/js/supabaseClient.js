// Inicializa Supabase Client (usa ENV del frontend)
const { createClient } = supabase;
const SUPABASE_URL = window.ENV?.SUPABASE_URL;
const SUPABASE_ANON_KEY = window.ENV?.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  alert("Faltan credenciales de Supabase. Edita assets/js/env.js");
}
window.sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true }
});
