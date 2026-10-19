# Extensión `libro-tutor` — manual breve

Guarda automáticamente **el libro del curso** que escribe UniversalTutor: la teoría canónica
que el tutor explica en `[MODO I]` queda escrita en archivos `.md` sin que el tutor tenga que
hacerlo a mano (y sin que gaste tokens comprobándolo).

Archivo: `extensions/libro-tutor.ts` (dentro del paquete) · sin dependencias externas (salvo
`weasyprint` para el PDF, opcional).

---

## 1. Cuándo se activa

La extensión **solo** trabaja si en el directorio de trabajo de pi hay un archivo
`tutor-*.md` (minúsculas, con guion). Si no lo hay, está inerte: no escribe nada y no
muestra indicador.

- El archivo de progreso del curso es `tutor-<alias>-<materia>.md`.
- La carpeta del libro se lee de la sección `## LIBRO` → `**Carpeta:**` de ese archivo; si no
  figura, se asume `libro-<alias>-<materia>/` junto al tutor.
- Si hay varios `tutor-*.md`, se usa el **modificado más recientemente**. Para fijar uno:
  `/libro pin tutor-dani-python.md` (y `/libro pin clear` para soltarlo).

## 2. Qué captura

El tutor emite la teoría entre marcadores, y **dentro del bloque escribe los títulos tal y como
deben quedar en el libro** (`#`, `##`, `###` con su numeración):

```
<<<LIBRO punto=2>>>
# 2. Datos y variables

## 2.3 Pedir datos al usuario

### 2.3.1 `input()` y su cadena vacía

(teoría canónica del bloque)
<<<LIBRO>>>
```

Al **cerrar el turno**, la extensión lee el mensaje del asistente y:

1. Coloca cada sección (`## n.m`) del bloque **en el orden del temario**, no al final. Si la
   sección ya existía, añade el texto al final de esa sección (con `accion="reemplazar"`, la
   sustituye entera). Un bloque puede traer una sección o el capítulo entero.
2. **Respeta los títulos del modelo**: no los inventa ni reescribe su redacción; solo los encaja
   en el capítulo y quita duplicados exactos.
3. **Normaliza los subapartados:** dentro de la sección, cualquier título de nivel 3+ sin número
   (o escrito como `#### Título`) pasa a `### n.m.k Título`, numerado seguidos (`1.1.1`, `1.1.2`…).
   Los que ya traen su número correcto se respetan. No toca lo que hay dentro de bloques de código.
4. Crea el capítulo si no existía (`# 2. Datos y variables` + secciones, sin metadatos).
5. Actualiza `00-indice.md`: estado del capítulo y lista de secciones escritas.
6. Confirma al usuario con un aviso: `📖 Libro · cap.2 §2.3 anadida · §2.4 anadida (1360 car.)`.
**No duplica:** si ese contenido ya estaba en el capítulo, lo omite. Si el tutor escribió la
sección a mano, la extensión lo detecta y no repite el texto.

Compatibilidad: la forma antigua `<<<LIBRO punto=2 seccion="2.3 Pedir datos">>>` (el título en la
etiqueta) sigue funcionando; en ese caso el encabezado lo escribe la extensión.

Atributos opcionales del marcador:

| Atributo | Efecto |
| --- | --- |
| `accion="reemplazar"` | Sustituye la sección existente con el mismo número (por defecto: añadir al final de esa sección). |
| `nota="…"` | Comentario para el registro: aparece en el aviso `📖 Libro · …` y en el log (`/libro log`); no se escribe en el capítulo. (En la forma antigua, si el bloque no trae encabezados, sirve también de título.) |
| `estado="completo"` | Marca el capítulo como `completo` en el índice (`estado="en curso"` lo reabre). |

Un capítulo también pasa a `completo` **solo** cuando ya tiene tantas secciones como subtópicos
le pide el temario del archivo del tutor.

## 3. Cómo sabes que está activa

- **Barra de estado de pi**, alineado a la derecha: `📖 LIBRO ON` / `📖 LIBRO OFF`.
- **Título de la terminal**: `UniversalTutor · <curso> · 📖 LIBRO ON` (y `(pin)` si fijaste el tutor; el nombre se cambia con `UTP_TITLE`).
- **El tutor lo pregunta al empezar un curso nuevo.** La extensión antepone a su prompt la línea
  `⚑ ESTADO DEL LIBRO (extensión): ACTIVA …`, pero eso es solo una pista: en un curso nuevo el
  tutor **debe** preguntártelo en la parada de arranque y no empieza el temario hasta que
  respondas. Su respuesta queda en `**Captura:**` del archivo de progreso.
- **Al retomar un curso ya iniciado** no pregunta: informa en una línea («el libro lo sigue
  gestionando la extensión automática»). Si no dices nada, el estado sigue igual; cámbialo solo a
  propósito (`/libro toggle`, y se lo dices al tutor).
- **Aviso de teoría perdida**: si un turno lleva teoría (bloque `[MODO I]` o títulos `## n.m`) y
  **no** sale ningún marcador, la extensión te avisa:
  `⚠️ El turno llevaba teoría pero no salió ningún marcador <<<LIBRO: el libro NO se ha actualizado.`
  El modelo no ve ese aviso: es para ti. Se repite como mucho una vez cada 20 s. No salta si el
  tutor escribió la sección él mismo con sus herramientas.

## 4. Comando `/libro`

| Orden | Para qué |
| --- | --- |
| `/libro` o `/libro status` | Tutor usado, ruta del libro, captura on/off, última captura, incidencias del último check y estado de cada capítulo. |
| `/libro check` | Coteja índice ↔ capítulos ↔ temario: capítulos sin escribir, secciones que faltan o sobran, archivos sueltos, encabezados `#` sin el número del índice (el PDF no podría enlazarlos) y cobertura de subtópicos. |
| `/libro fix` | Repara capítulos ya escritos: quita cabeceras de metadatos antiguas (`> Estado: …`), títulos de sección duplicados y **renumera los subapartados** a `### n.m.k`. Refresca el índice. |
| `/libro backup` | Copia la carpeta del libro + el `tutor-*.md` a `.libro-backups/libro-<curso>-<fecha-hora>/`. Guarda las 10 últimas copias. |
| `/libro pdf` | Genera `<cwd>/libro-<curso>.pdf` (y el `.html` intermedio) con weasyprint. |
| `/libro toggle` | Apaga/enciende la captura automática (el tutor se entera y cambia de modo). |
| `/libro pin <archivo>` / `pin clear` | Fija qué `tutor-*.md` usar. |
| `/libro log` | Últimas líneas del log de diagnóstico (`/tmp/utp-libro/libro.log`). |

## 5. El PDF

Convertidor Markdown→HTML propio (sin pandoc) + `weasyprint`. Página **A4** (márgenes
25/25/27mm), texto justificado, salto de página por capítulo, numeración. Tamaños: cuerpo
`12pt` (Georgia, interlineado 1.3), `h1` 19pt, `h2` 14.5pt, `h3` 12.5pt, tablas y código 10pt.

**Portada** (página 1, sin numerar): título del libro sacado de `00-indice.md` centrado en la
página, con la rúbrica "Libro del curso" encima y la fecha de generación debajo; al pie, en una
línea centrada, `Generado por Universal_Tutor_Project` (sin número de versión: la versión del tutor cambia sin que cambie la extensión).

**Índice de contenidos** (página impar tras la portada): generado a partir de los capítulos y de
las secciones `## n.m` de cada capítulo. Título del punto en **negrita y más grande**, secciones
en tamaño normal e indentadas; título a la izquierda y número de página a la derecha, unidos con
punteado. Los números los calcula weasyprint en el mismo renderizado (`target-counter`), así que
**siempre salen correctos** aunque el propio índice desplace la paginación: no hay que
comprobarlos a mano. Los enlaces del índice son clicables y el PDF lleva marcadores (outline).

**Maquetación tipo libro**: cada punto del temario (`h1`) arranca en **página impar** (`break-before:
recto`); si el punto anterior terminaba en impar, se interpone una página en blanco sin numerar.
Así, en vista de doble página, cada tema cae siempre a la derecha como en un libro impreso.
Si falta weasyprint, deja el HTML y avisa.

Si el encabezado `#` de un capítulo no lleva el número que le da el índice, el PDF **se lo
añade solo en la versión impresa** (tu `.md` no se toca); así el enlace del índice apunta a
una página real en vez de quedar muerto.

## 6. Reglas y límites

- La extensión **no toca el chat**: los marcadores quedan visibles para copiarlos a mano si falla.
- Los avisos `📖 Libro · …` los ve **el usuario**, no el modelo.
- Con captura activa, el tutor **no lee capítulos para comprobar** ni escribe secciones: eso
  ahorra tokens y evita duplicados.
- `/libro toggle` y `pin` son por sesión (se reinician en `session_start`).
- Si el modelo escribe la sección a mano y el texto coincide, la extensión no duplica; si el
  marcador va sin cerrar (`<<<LIBRO>>>` ausente) avisa y no escribe nada.
