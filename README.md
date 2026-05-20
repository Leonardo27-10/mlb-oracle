# ⚾ MLB Oracle — Predictor de Béisbol

Modelo sabermétr ico para pronosticar juegos MLB con datos en tiempo real.

## Stack
- React 18 + Vite
- MLB Stats API (statsapi.mlb.com) — gratuita y oficial
- Vercel proxy para CORS

## Despliegue en Vercel (3 pasos)

1. Sube este proyecto a GitHub
2. Entra a vercel.com → "New Project" → importa el repo
3. Click "Deploy" — ¡listo!

## Features
- Juegos del día con probabilidades (Log5 + Pitagórico)
- Pitcher probable, marcador proyectado, momios americanos
- 10 parleys de 10 selecciones (ML + Run Lines + O/U)
- Auto-refresh cada hora
- Fallback a modo demo si no hay juegos

## Fórmulas
- Expectativa Pitagórica (exp=1.83)
- Log5 (Bill James)
- Win% real de standings actuales
- Ventaja de local (+4%)
