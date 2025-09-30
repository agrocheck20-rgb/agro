# AgroCheck (auth fix)
- Incluye diagnósticos de conexión y manejo robusto de login.
- Si el login falla, abre la consola del navegador: verás el mensaje exacto de Supabase.

## Importante en Supabase
- Authentication → Providers → Email: para pruebas, desactiva "Confirm email".
- Authentication → URL Configuration: agrega la URL pública de Netlify en Redirect URLs.

## Netlify
- Publica la **raíz** del repo o ajusta Publish directory.
- Incluye `/_redirects` o `netlify.toml` para SPA.
