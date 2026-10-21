# CHANGELOG

## v0.1.0 — 2026-10-19

Primera versión publicable del proyecto. Empaqueta como **paquete de pi** las dos
piezas que hasta ahora vivían sueltas en el agente personal:

- **Rol `UniversalTutor`** (`roles/Universal_Tutor_Project.md`): system prompt del
  tutor (modos de trabajo, técnicas de aprendizaje, temario, exámenes, libro).
  Es la versión compacta de iteraciones anteriores del prompt.
- **Extensión `libro-tutor`** (`extensions/libro-tutor.ts`): escribe automáticamente el
  **libro del curso** a partir de los marcadores `<<<LIBRO …>>>` que emite el tutor y
  mantiene `00-indice.md`, además de `/libro status|check|fix|backup|pdf|toggle|pin|log`.
- **Extensión `tutor-role`** (`extensions/tutor-role.ts`): cargador mínimo del rol, que
  lee `roles/` desde dentro del paquete (sin rutas personales) y registra `/tutor` y
  `--tutor`.

Cambios de portabilidad sobre las versiones originales:

- El rol ya no se carga desde `~/Apolo/RPG`, sino desde `roles/` del paquete
  (override: `UTP_ROLES_DIR` o `UTP_ROLE=<archivo>`).
- El log de diagnóstico pasa de `<tmpdir>/apolo-libro/` a `<tmpdir>/utp-libro/`.
- El título de la terminal pasa de `Apolo · …` a `UniversalTutor · …`
  (override: `UTP_TITLE`).
- El rol no fija provider ni modelo: cada usuario usa el modelo que tenga configurado.
