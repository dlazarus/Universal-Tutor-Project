# Universal Tutor Project

Un tutor personal de IA para aprender **cualquier materia** (programación, matemáticas,
idiomas, historia, música, cocina, filosofía…), montado sobre [pi coding agent](https://pi.dev).

Dos piezas que trabajan juntas:

| Pieza | Qué hace |
| --- | --- |
| **Rol `UniversalTutor`** (`roles/Universal_Tutor_Project.md`) | El system prompt del tutor: modos de trabajo ([MODO I] explicación, [MODO II] socrático, [MODO III] práctica, [EXAMEN]), técnicas de aprendizaje con respaldo empírico (recuperación activa, espaciado, intercalado, andamiaje), temario, seguimiento del progreso y criterio de dominio. |
| **Extensión `libro-tutor`** (`extensions/libro-tutor.ts`) | Escribe **sola** el *libro del curso*: la teoría que el tutor explica queda volcada en capítulos `.md` ordenados según el temario, con índice automático, comprobaciones y exportación a PDF. Sin que el tutor tenga que hacerlo a mano ni gastar tokens comprobándolo. |
| **Extensión `tutor-role`** (`extensions/tutor-role.ts`) | Carga el rol desde dentro del paquete y lo activa con `/tutor` (o `pi --tutor`). |

**Invariante del sistema:** todo lo que se examina está escrito en el libro, y todo lo que
está en el libro se puede examinar. El libro es a la vez tus apuntes, la base de los exámenes
y el inventario de la materia.

---

## Requisitos

- **pi coding agent** instalado (`pi` en el PATH).
- **Un modelo a tu elección**: el proyecto no fija provider ni modelo. Configura el tuyo en pi
  (API remota, u Ollama/llama.cpp local) como harías normalmente.
- **Opcional, para `/libro pdf`**: [weasyprint](https://weasyprint.readthedocs.io). Sin él la
  extensión genera el `.html` y avisa; todo lo demás funciona igual.
  - Arch Linux: `sudo pacman -S weasyprint`
  - Python: `pip install weasyprint` (o en un entorno `micromamba`/`venv` propio)

---

## Instalación

### Vía recomendada (instalar el paquete desde GitHub)

```bash
pi install git:github.com/dlazarus/Universal-Tutor-Project
```

Para fijar una versión concreta (recomendado si quieres estabilidad):

```bash
pi install git:github.com/dlazarus/Universal-Tutor-Project@v0.1.0
```

Se instala en tu agente personal (`~/.pi/agent/settings.json`) y queda disponible en
**cualquier** carpeta en la que abras pi. Para actualizar: `pi update --extensions`.
Para quitarlo: `pi remove git:github.com/dlazarus/Universal-Tutor-Project`.

### Otras vías

```bash
# Probarlo una sola vez sin instalarlo
pi -e git:github.com/dlazarus/Universal-Tutor-Project

# Desde una copia local (útil para desarrollar: editas y /reload)
git clone https://github.com/dlazarus/Universal-Tutor-Project
pi install ./Universal-Tutor-Project
```

> ⚠️ Las extensiones ejecutan código dentro del proceso de pi, con tus permisos. Revisa el
> código antes de instalar un paquete de terceros; si abres pi dentro de una carpeta con
> `.pi/`, pi te preguntará si confías en ese proyecto (*project trust*).

---

## Uso

### Empezar un curso nuevo

```bash
mkdir mi-curso && cd mi-curso
pi --tutor          # o bien: pi  y luego  /tutor
```

El tutor te preguntará la materia, tu nivel, tu objetivo y el tiempo disponible, propondrá un
**temario** y no empezará la teoría hasta que lo apruebes. También te preguntará quién escribe
el libro (la extensión automáticamente, o él a mano) — responde y queda registrado.

### Retomar un curso

```bash
cd mi-curso
pi
```

Si la carpeta ya contiene `tutor-*.md` o `libro-*/`, el rol del tutor se **activa solo**. El
tutor retoma donde lo dejaste: repaso espaciado, punto siguiente o examen, según el registro.

### Cómo se escribe el libro

El tutor emite la teoría entre marcadores y la extensión la coloca en su capítulo al cerrar el
turno:

```
<<<LIBRO punto=2>>>
# 2. Datos y variables

## 2.3 Pedir datos al usuario

(teoría desarrollada)
<<<LIBRO>>>
```

Tú lo ves así en la barra inferior de pi: `📖 LIBRO ON`. El detalle está en `/libro status`.

| Orden | Para qué |
| --- | --- |
| `/libro` o `/libro status` | Curso usado, ruta del libro, estado de la captura, progreso de cada capítulo |
| `/libro check` | Coteja índice ↔ capítulos ↔ temario: qué falta, qué sobra, qué está mal encabezado |
| `/libro fix` | Repara capítulos escritos a mano: metadatos sobrantes, títulos duplicados, subapartados sin numerar |
| `/libro backup` | Copia el libro y el archivo de progreso a `.libro-backups/` (guarda las 10 últimas) |
| `/libro pdf` | Genera el libro completo en PDF (portada, índice con páginas reales, maquetación tipo libro) |
| `/libro toggle` | Apagar/encender la captura automática (el tutor pasa a escribir el libro él mismo) |
| `/libro pin <archivo>` / `pin clear` | Fijar qué `tutor-*.md` usar si hay varios cursos en la carpeta |
| `/libro log` | Últimas líneas del log de diagnóstico (`/tmp/utp-libro/libro.log`) |

Manual completo de la extensión: [`docs/README-libro.md`](docs/README-libro.md).

---

## Configuración

El rol admite **frontmatter** opcional al principio de `roles/Universal_Tutor_Project.md`:

```markdown
---
pensamiento: high              # off|minimal|low|medium|high|xhigh|max
herramientas: read,write,edit  # vacío = sin herramientas; si se omite, se conservan las de pi
modo: reemplazar               # reemplazar (por defecto) | agregar (conserva la identidad de pi)
---
```

Variables de entorno opcionales:

| Variable | Efecto |
| --- | --- |
| `UTP_ROLE=<archivo>` | Usar un archivo de rol concreto en lugar de los de `roles/` |
| `UTP_ROLES_DIR=<carpeta>` | Carpeta de roles alternativa |
| `UTP_TITLE=<nombre>` | Nombre que aparece en el título de la terminal (`UniversalTutor` por defecto) |

---

## Estructura del repositorio

```
Universal-Tutor-Project/
├── package.json                  # manifiesto del paquete de pi
├── extensions/
│   ├── tutor-role.ts             # /tutor  ·  carga el rol desde roles/
│   └── libro-tutor.ts            # /libro  ·  escribe el libro del curso
├── roles/
│   └── Universal_Tutor_Project.md
├── docs/
│   └── README-libro.md           # manual detallado de la extensión del libro
├── scripts/
│   └── sync-role.sh              # (mantenimiento) sincronizar el rol desde su origen
├── CHANGELOG.md
└── LICENSE                       # AGPL-3.0
```

### Qué NO hay aquí, a propósito

Los **cursos son datos personales del usuario**, no parte de la herramienta. El `.gitignore`
deja fuera `tutor-*.md`, `libro-*/`, `.libro-backups/` y los PDF/HTML generados. Cada quien
guarda su progreso donde quiera (o en un repositorio privado propio).

---

## Licencia

AGPL-3.0. Ver [`LICENSE`](LICENSE).
