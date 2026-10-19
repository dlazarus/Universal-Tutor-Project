/**
 * Universal Tutor Project — captura automática del LIBRO DEL CURSO
 * ==================================================================
 *
 * Vuelca literalmente en el capítulo correspondiente la teoría que el tutor
 * emite entre marcadores. La etiqueta solo delimita; los títulos van dentro
 * del bloque, escritos como deben quedar en el libro:
 *
 *   <<<LIBRO punto=5>>>
 *   # 5. Funciones
 *   ## 5.2 Argumentos por defecto
 *   ### 5.2.1 Valor por defecto y objeto mutable
 *   …teoría canónica…
 *   <<<LIBRO>>>
 *
 * Atributos del marcador de apertura:
 *   punto=<n>            punto del temario → capítulo <n> (si falta, se deduce
 *                        del `# <n>.` del propio bloque)
 *   seccion="<n.m Tit>"  formato antiguo (compatible): el bloque no trae títulos
 *   accion="reemplazar"  sustituye la sección (por defecto: añadir/ampliar)
 *   nota="<texto>"       comentario para el registro: aparece en el aviso
 *                        «📖 Libro · …» y en el log (/libro log); NUNCA en el capítulo.
 *
 * Qué hace:
 *   - Observa el turno (evento `turn_end`): si el propio tutor escribió el
 *     capítulo a mano (herramientas write/edit/bash sobre ese archivo), NO
 *     duplica: solo verifica que la sección quedó y, si falta, la vuelca.
 *   - Coloca cada `## n.m` del bloque en el orden del temario, no al final; un
 *     bloque puede traer una sección o el capítulo entero.
 *   - Normaliza los subapartados (`### n.m.k`) y respeta los títulos del modelo.
 *   - Idempotente: si ese contenido ya está en el capítulo, no lo repite.
 *   - Actualiza `00-indice.md` (estado + secciones, recalculadas desde el
 *     propio capítulo). El estado vive SOLO en el índice: los capítulos son
 *     teoría limpia, sin cabeceras de metadatos (y se limpian si las había).
 *   - NO toca el mensaje del chat: los marcadores quedan visibles para que el
 *     usuario pueda copiarlos a mano si esto falla.
 *
 * Inactivo fuera de sesiones del tutor: si el directorio de trabajo no tiene
 * archivos `tutor-*.md`, la extensión no hace nada (ni indicador en la barra).
 *
 * Indicador en la barra inferior (3ª línea del footer) y en el título del terminal:
 * `📖 LIBRO ON` / `📖 LIBRO OFF` (mínimo, para no desplazar otros estados). El detalle
 * (libro activo, progreso, última captura, incidencias) se consulta con /libro status y /libro check.
 *
 * TODAS las rutas del curso (archivo de progreso, carpeta del libro, capítulos)
 * son RELATIVAS al directorio de trabajo de pi: no hay ninguna ruta absoluta
 * grabada. Copiar la carpeta del curso a otra máquina o a otro sitio y abrir pi
 * dentro de ella basta para continuar.
 *
 * Comando:  /libro [status|check|backup|pdf|toggle|pin <archivo>|log]
 *   check  → índice↔capítulos + cobertura TEMARIO ACORDADO↔libro (puntos y subtópicos)
 *   backup → copia de libro/ + tutor-*.md en <cwd>/.libro-backups/ (rotación: 10 últimas)
 *   pdf    → libro completo en un PDF (weasyprint) en <cwd>/libro-<...>.pdf
 * Log (solo diagnóstico, NO forma parte del curso): <tmpdir>/utp-libro/libro.log
 */
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const execFileP = promisify(execFile);

// Nombre del proyecto en el título de la terminal (override: UTP_TITLE="OtroNombre").
const APP_TITLE = process.env.UTP_TITLE?.trim() || "UniversalTutor";
const LOG_FILE = path.join(os.tmpdir(), "utp-libro", "libro.log");
const OPEN_RE = /<<<LIBRO\b((?:(?!>>>)[\s\S])*)>>>/g;
const CLOSE_MARK = "<<<LIBRO>>>";
const SECTION_RE = /^## (\d+)\.(\d+)([^\n]*)$/;
const TUTOR_RE = /^tutor-.+\.md$/;

interface Block {
	punto: number;
	seccion: string;
	num: string; // "5.2" o ""
	accion: "anadir" | "reemplazar";
	nota: string;
	estado: string; // "completo" | "en curso" | ""
	content: string;
	error?: string;
}

interface IndexRow {
	cap: number;
	title: string;
	file: string;
	estado: string;
	secciones: string;
}

let enabled = true;
let pinned: string | undefined;
// Dos espacios de ancho cero: piden al dueño del footer (compaction-indicator.ts)
// que alinee este estado a la derecha. Constante duplicada a propósito: las
// extensiones no se importan entre sí.
const RIGHT_MARKER = "\u200B\u200B";

// El modelo no ve el footer ni las notificaciones: para que sepa si la captura del
// libro es automática hay que decírselo en su propio contexto. Se inyecta en
// `before_provider_request` (el último hook antes de la red) y no en
// `before_agent_start`: roles.ts sustituye el system prompt entero en ese hook y el
// orden de carga de las extensiones no depende de nosotros. Verificado end-to-end
// (el payload lleva role "developer", no "system", en OpenAI-compatible).
const NOTE_SENTINEL = "⚑ ESTADO DEL LIBRO (extensión)";
function notaLibro(): string {
	const aviso =
		" En un curso NUEVO el estado lo confirma el usuario: pregúntalo en la parada de arranque y no empieces el temario sin su respuesta (§3.0). Al retomar una materia ya iniciada, no preguntes: informa del estado registrado en una línea y sigue.";
	return enabled
		? `${NOTE_SENTINEL}: ACTIVA (señal de la extensión; la decisión la tiene el usuario). Al cerrar el turno, los marcadores <<<LIBRO ...>>> se vuelcan solos en su capítulo y actualizan 00-indice.md. Con el estado confirmado como automática, no leas los capítulos para comprobarlo ni escribas secciones a mano: la captura es responsabilidad de esta extensión, y si fallara se lo diríamos al usuario (él sí ve el aviso «📖 Libro · …» al cerrar el turno).${aviso} Salvo orden expresa del usuario, el estado no cambia en toda la sesión.`
		: `${NOTE_SENTINEL}: DESACTIVADA (la apagó el usuario con /libro toggle). El libro lo llevas tú: vuelca cada bloque siguiendo §3.2.${aviso}`;
}
let lastCapture = ""; // p. ej. "cap.5 §5.2 anadida"
let lastIncidents = -1; // -1 = /libro check no ejecutado en esta sesión

// --------------------------------------------------------- barra de estado

/**
 * Indicador en la barra inferior (3ª línea del footer) + título de terminal.
 * En el footer se mantiene mínimo (no desplaza al resto de estados, p. ej. el de /rol):
 * solo `📖 LIBRO ON` / `📖 LIBRO OFF`. El detalle va al título del terminal y a /libro status.
 * Desaparece si el directorio de trabajo no es de tutor (sin tutor-*.md).
 */
async function updateStatus(ctx: ExtensionContext): Promise<void> {
	try {
		const tutorPath = await findTutorFile(ctx.cwd);
		if (!tutorPath) {
			ctx.ui.setStatus("libro", undefined);
			return;
		}
		const th = ctx.ui.theme;
		// El marcador (dos espacios de ancho cero) pide al dueño del footer que alinee
		// este estado a la derecha. Lo interpreta extensions/compaction-indicator.ts;
		// si esa extensión no está cargada, el marcador es invisible y queda a la izquierda.
		ctx.ui.setStatus("libro", `${RIGHT_MARKER}${th.fg(enabled ? "accent" : "warning", `📖 LIBRO ${enabled ? "ON" : "OFF"}`)}`);
		const base = path.basename(await resolveBookDir(ctx.cwd, tutorPath));
		ctx.ui.setTitle(`${APP_TITLE} · ${base} · ${enabled ? "📖 LIBRO ON" : "📖 LIBRO OFF"}${pinned ? " (pin)" : ""}`);
	} catch {
		/* el indicador nunca interrumpe la sesión */
	}
}

// ---------------------------------------------------------------- utilidades

async function log(msg: string): Promise<void> {
	try {
		await fs.mkdir(path.dirname(LOG_FILE), { recursive: true });
		await fs.appendFile(LOG_FILE, `${msg}\n`, "utf8");
	} catch {
		/* el log nunca bloquea la captura */
	}
}

function say(ctx: ExtensionContext, msg: string, kind: "info" | "warning" | "error" = "info"): void {
	void log(`[libro] ${msg}`);
	if (ctx.hasUI) {
		try {
			ctx.ui.notify(msg, kind);
		} catch {
			/* sin UI disponible */
		}
	}
}

function attr(src: string, name: string): string {
	const q = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i").exec(src);
	if (q) return q[1].trim();
	const bare = new RegExp(`${name}\\s*=\\s*([^\\s"]+)`, "i").exec(src);
	return bare ? bare[1].trim() : "";
}

function secNum(seccion: string): string {
	const m = /^(\d+)\.(\d+)/.exec(seccion);
	return m ? `${m[1]}.${m[2]}` : "";
}

function cmpNum(a: string, b: string): number {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	return pa[0] !== pb[0] ? pa[0] - pb[0] : pa[1] - pb[1];
}

function parseBlocks(text: string): Block[] {
	const out: Block[] = [];
	OPEN_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = OPEN_RE.exec(text))) {
		const attrs = m[1];
		const rest = text.slice(m.index + m[0].length);
		const end = rest.indexOf(CLOSE_MARK);
		const seccion = attr(attrs, "seccion");
		const acc = attr(attrs, "accion").toLowerCase();
		const block: Block = {
			punto: Number(attr(attrs, "punto")),
			seccion,
			num: secNum(seccion),
			accion: acc === "reemplazar" || acc === "replace" ? "reemplazar" : "anadir",
			nota: attr(attrs, "nota"),
			estado: attr(attrs, "estado").toLowerCase(),
			content: end === -1 ? "" : rest.slice(0, end).replace(/^\s*\n|\s+$/g, ""),
		};
		// sin `punto=` en la etiqueta: se deduce del `# <n>. Título` del propio bloque
		if (!Number.isInteger(block.punto) || block.punto < 1) {
			const h1 = /^#\s+(\d+)\./.exec(block.content.trim());
			const n = Number(h1?.[1]);
			if (Number.isInteger(n) && n > 0) block.punto = n;
		}
		if (!Number.isInteger(block.punto) || block.punto < 1) block.error = "marcador sin punto=<n> válido";
		else if (end === -1) block.error = "marcador sin cerrar (falta <<<LIBRO>>>)";
		else if (!block.content) block.error = "bloque vacío";
		out.push(block);
		if (end !== -1) OPEN_RE.lastIndex = m.index + m[0].length + end + CLOSE_MARK.length;
	}
	return out;
}

// ------------------------------------------------------------- resolución

async function findTutorFile(cwd: string): Promise<string | undefined> {
	if (pinned) {
		const p = path.isAbsolute(pinned) ? pinned : path.join(cwd, pinned);
		try {
			await fs.access(p);
			return p;
		} catch {
			return undefined;
		}
	}
	let names: string[];
	try {
		names = await fs.readdir(cwd);
	} catch {
		return undefined;
	}
	const cands = names.filter((n) => TUTOR_RE.test(n) && !/\.bak\.md$/i.test(n));
	if (!cands.length) return undefined;
	const stats = await Promise.all(
		cands.map(async (n) => ({ n, t: (await fs.stat(path.join(cwd, n))).mtimeMs })),
	);
	stats.sort((a, b) => b.t - a.t);
	return path.join(cwd, stats[0].n);
}

async function resolveBookDir(cwd: string, tutorPath: string): Promise<string> {
	let dir = "";
	try {
		const txt = await fs.readFile(tutorPath, "utf8");
		const sec = /##\s+LIBRO\b([\s\S]*?)(?=\n##\s|\n#\s|$)/i.exec(txt);
		const car = sec && /\*\*Carpeta:\*\*\s*`?([^\s`]+)`.?/.exec(sec[1]);
		if (car) dir = car[1];
	} catch {
		/* sin sección LIBRO */
	}
	if (!dir) {
		const base = path.basename(tutorPath, ".md").replace(/^tutor-/, "");
		dir = `libro-${base}`;
	}
	return path.isAbsolute(dir) ? dir : path.join(cwd, dir);
}

async function readIndex(bookDir: string): Promise<IndexRow[]> {
	const rows: IndexRow[] = [];
	let txt: string;
	try {
		txt = await fs.readFile(path.join(bookDir, "00-indice.md"), "utf8");
	} catch {
		return rows;
	}
	for (const line of txt.split("\n")) {
		const m = /^\|\s*(\d+)\s*\|\s*([^|]*)\|\s*([^|]*)\|\s*([^|]*)\|\s*([^|]*)\|/.exec(line);
		if (!m) continue;
		rows.push({
			cap: Number(m[1]),
			title: m[2].trim(),
			file: m[3].trim().replace(/`/g, ""),
			estado: m[4].trim(),
			secciones: m[5].trim(),
		});
	}
	return rows;
}

async function chapterPath(bookDir: string, cap: number, rows: IndexRow[]): Promise<{ file: string; title: string }> {
	const row = rows.find((r) => r.cap === cap);
	if (row?.file && row.file !== "—") return { file: path.join(bookDir, row.file), title: row.title };
	const pad = String(cap).padStart(2, "0");
	let names: string[] = [];
	try {
		names = await fs.readdir(bookDir);
	} catch {
		/* la carpeta puede no existir todavía */
	}
	const hit = names.find((n) => new RegExp(`^${pad}-.*\\.md$`).test(n));
	const file = hit ? path.join(bookDir, hit) : path.join(bookDir, `${pad}-punto-${pad}.md`);
	return { file, title: row?.title || `Punto ${cap}` };
}

// ------------------------------------------------------------- escritura

function sectionsIn(txt: string): { num: string; line: number; head: string }[] {
	const out: { num: string; line: number; head: string }[] = [];
	txt.split("\n").forEach((line, i) => {
		const m = SECTION_RE.exec(line);
		if (m) out.push({ num: `${m[1]}.${m[2]}`, line: i, head: line });
	});
	return out;
}

// --- subapartados: dentro de una sección «n.m» los encabezados van numerados
// como «### n.m.k Título». El modelo a veces los suelta sin número o los baja
// a «####»; aquí se normalizan, que es lo que se ve luego en el libro y en el PDF.
const SUB_RE = /^#{3,6}\s+(.+?)\s*$/;

function fixSubLine(line: string, sec: string, k: { v: number }): string | null {
	if (!sec) return null;
	const m = SUB_RE.exec(line);
	if (!m) return null;
	const t = m[1];
	const nm = /^(\d+(?:\.\d+)+)\s+(.*)$/.exec(t);
	if (nm && nm[1].startsWith(`${sec}.`)) {
		const kk = Number(nm[1].slice(sec.length + 1).split(".")[0]);
		if (Number.isFinite(kk)) k.v = Math.max(k.v, kk);
		const fixed = `### ${nm[1]} ${nm[2]}`.replace(/\s+$/, "");
		return fixed === line ? null : fixed;
	}
	// el subapartado trae un número de OTRA sección (p. ej. `### 2.1.1` dentro de 1.1):
	// se sustituye por el que corresponde, no se antepone (si no, quedaría `1.1.1 2.1.1 Título`)
	k.v += 1;
	return `### ${sec}.${k.v} ${nm ? nm[2] : t}`.replace(/\s+$/, "");
}

function inFence(line: string, fence: string | null): { fence: string | null } {
	const f = /^\s*(```|~~~)/.exec(line);
	if (f) return { fence: fence ? null : f[1] };
	return { fence };
}

/** Mayor índice `k` ya numerado en `sec` dentro de estas líneas. */
function maxSubK(lines: string[], sec: string): number {
	if (!sec) return 0;
	const re = new RegExp(`^${sec.replace(/\./g, "\\.")}\\.(\\d+)(?:\\.|\\s)`);
	let max = 0;
	let fence: string | null = null;
	for (const line of lines) {
		const r = inFence(line, fence);
		fence = r.fence;
		if (fence) continue;
		const m = SUB_RE.exec(line);
		if (!m) continue;
		const nm = re.exec(m[1].trim());
		if (nm) max = Math.max(max, Number(nm[1]));
	}
	return max;
}

/** Numerar los subapartados de un bloque de teoría recién capturado. */
function numberSubheads(body: string, sec: string): { body: string; count: number } {
	if (!sec) return { body, count: 0 };
	// se arranca desde el mayor índice ya presente: si un subapartado trae un número
	// ajeno y se le sustituye, no se duplica uno que ya existe más abajo de la sección
	const k = { v: maxSubK(body.split("\n"), sec) };
	let fence: string | null = null;
	let count = 0;
	const lines = body.split("\n").map((line) => {
		const r = inFence(line, fence);
		fence = r.fence;
		if (fence) return line;
		const fixed = fixSubLine(line, sec, k);
		if (fixed === null) return line;
		count++;
		return fixed;
	});
	return { body: lines.join("\n"), count };
}

/** Numerar los subapartados de un capítulo entero (lo usa `/libro fix`). */
function renumberSubheads(txt: string): { txt: string; count: number } {
	const lines = txt.split("\n");
	const out = lines.slice();
	let fence: string | null = null;
	let sec = "";
	const k = { v: 0 };
	let count = 0;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const r = inFence(line, fence);
		fence = r.fence;
		if (fence) continue;
		if (/^#\s/.test(line)) {
			// encabezado de capítulo: la numeración de secciones se reinicia (si no,
			// un `###` suelto antes de la primera `##` heredaba la sección del capítulo anterior)
			sec = "";
			k.v = 0;
			continue;
		}
		const sm = SECTION_RE.exec(line);
		if (sm) {
			sec = `${sm[1]}.${sm[2]}`;
			// fin del alcance de la sección (siguiente encabezado de nivel 1-2, fuera de código)
			let end = lines.length;
			let f2: string | null = null;
			for (let j = i + 1; j < lines.length; j++) {
				const rr = inFence(lines[j], f2);
				f2 = rr.fence;
				if (!f2 && /^#{1,2}\s/.test(lines[j])) {
					end = j;
					break;
				}
			}
			k.v = maxSubK(lines.slice(i + 1, end), sec);
			continue;
		}
		const fixed = fixSubLine(line, sec, k);
		if (fixed === null) continue;
		out[i] = fixed;
		count++;
	}
	return { txt: out.join("\n"), count };
}

type WriteResult = { action: "anadida" | "reemplazada" | "ampliada" | "omitida"; why?: string };
type Section = { num: string; head: string; body: string };

async function writeSection(
	chapFile: string,
	cap: number,
	title: string,
	block: Block,
): Promise<WriteResult> {
	let txt = "";
	let fresh = false;
	try {
		txt = await fs.readFile(chapFile, "utf8");
	} catch {
		fresh = true;
	}

	let body = block.content.trim();

	// Estilo antiguo: el título lo daba el atributo `seccion`. Si además el modelo
	// escribía su encabezado, se quitaba. Solo se quita un `## n.m`: un `### n.m.k`
	// es un subapartado y jamás es el título de la sección.
	const first = body.split("\n")[0]?.trim() ?? "";
	const hm = /^##\s+(?!#)(.+?)\s*$/.exec(first);
	if (hm) {
		const bt = hm[1];
		const bn = secNum(bt);
		const hn = secNum(block.seccion);
		const sameNum = !!bn && !!hn && bn === hn;
		const sameTitle = norm(bt) === norm(block.seccion);
		if (sameNum || sameTitle || !block.seccion) {
			if (!block.seccion) {
				block.seccion = bt;
				block.num = secNum(bt);
			} else if (bt.length > block.seccion.length && norm(bt) === norm(block.seccion)) {
				block.seccion = bt; // el del modelo trae formato (`input()`): se conserva
			}
			body = body.slice(first.length).replace(/^\s+/, "");
		}
	}

	if (txt && txt.includes(body)) return { action: "omitida", why: "el contenido ya constaba en el capítulo" };

	const heading = block.seccion
		? `## ${block.seccion}`
		: `## ${cap}.1 ${block.nota || title}`; // sin `seccion`: se renumera abajo si el capítulo ya tiene secciones
	const num = block.num || "";
	const secForSubs = num || secNum(block.seccion) || (fresh ? `${cap}.1` : "");
	if (secForSubs) body = numberSubheads(body, secForSubs).body;
	const lines = txt.split("\n");
	const heads = sectionsIn(txt);

	if (fresh) {
		const head = `# ${cap}. ${title}\n\n${heading}\n\n${body}\n`;
		await fs.mkdir(path.dirname(chapFile), { recursive: true });
		await fs.writeFile(chapFile, head, "utf8");
		return { action: "anadida", why: "capítulo creado" };
	}

	const insertAt = (idx: number, chunk: string[]): void => {
		lines.splice(idx, 0, ...chunk);
	};

	if (num) {
		const at = heads.findIndex((h) => h.num === num);
		if (at !== -1) {
			const start = heads[at].line;
			const stop = at + 1 < heads.length ? heads[at + 1].line : lines.length;
			if (block.accion === "reemplazar") {
				lines.splice(start, stop - start, heading, "", body, "");
				await fs.writeFile(chapFile, lines.join("\n").replace(/\n{3,}/g, "\n\n"), "utf8");
				return { action: "reemplazada" };
			}
			lines.splice(stop, 0, body, "");
			await fs.writeFile(chapFile, lines.join("\n").replace(/\n{3,}/g, "\n\n"), "utf8");
			return { action: "ampliada", why: `sección ${num} ya existía: se añade al final de esa sección` };
		}
		const after = heads.find((h) => cmpNum(h.num, num) > 0);
		const idx = after ? after.line : lines.length;
		insertAt(idx, [heading, "", body, ""]);
		await fs.writeFile(chapFile, lines.join("\n").replace(/\n{3,}/g, "\n\n"), "utf8");
		return { action: "anadida", why: `sección ${num} en orden` };
	}

	// sin número de sección: se crea una nueva al final, numerada
	const last = heads.filter((h) => h.num.startsWith(`${cap}.`)).pop();
	const autoNum = `${cap}.${last ? Number(last.num.split(".")[1]) + 1 : 1}`;
	body = numberSubheads(body, autoNum).body;
	lines.push("", `## ${autoNum} ${block.seccion || block.nota || title}`, "", body, "");
	await fs.writeFile(chapFile, lines.join("\n").replace(/\n{3,}/g, "\n\n"), "utf8");
	return { action: "anadida", why: `sección ${autoNum} (el marcador no traía número)` };
}

/**
 * Divide el cuerpo de un bloque por sus encabezados `## n.m`. Con el formato
 * nuevo, el modelo escribe `# n. Título`, `## n.m Título` y `### n.m.k Título`
 * tal cual van a quedar en el libro; la extensión solo los encaja en el capítulo.
 */
function splitBlock(body: string): { chapTitle: string; secs: Section[] } {
	let fence: string | null = null;
	let chapTitle = "";
	const secs: Section[] = [];
	let cur: Section | null = null;
	const pre: string[] = [];
	for (const line of body.split("\n")) {
		const r = inFence(line, fence);
		fence = r.fence;
		if (!fence) {
			if (/^#\s+\S/.test(line)) {
				// el `#` del capítulo solo alimenta el título; un segundo `#` en mitad del
				// bloque NO va al cuerpo: duplicaría el H1 del capítulo (y en el PDF corta la página)
				const t = line.replace(/^#+\s+/, "").trim();
				if (!cur && t.length > chapTitle.length) chapTitle = t;
				continue;
			}
			if (/^##\s+\S/.test(line)) {
				const head = line.trim();
				const m = SECTION_RE.exec(head);
				cur = { num: m ? `${m[1]}.${m[2]}` : "", head, body: "" };
				secs.push(cur);
				continue;
			}
		}
		if (cur) cur.body += `${line}\n`;
		else pre.push(line);
	}
	const preTxt = pre.join("\n").trim();
	if (preTxt && secs.length) secs[0].body = `${preTxt}\n\n${secs[0].body}`;
	return { chapTitle, secs };
}

/**
 * Vuelco de un bloque con sus propios encabezados (formato nuevo). Si el bloque
 * no trae ningún `## n.m`, se cae al estilo antiguo (writeSection + `seccion=`).
 */
async function writeBlock(
	chapFile: string,
	cap: number,
	title: string,
	block: Block,
): Promise<WriteResult> {
	const parsed = splitBlock(block.content.trim());
	if (!parsed.secs.length) return writeSection(chapFile, cap, title, block);

	let txt = "";
	try {
		txt = await fs.readFile(chapFile, "utf8");
	} catch {
		txt = "";
	}
	const chapTitle = parsed.chapTitle.replace(/^\d+\.\s*/, "");
	const chapHead = `# ${cap}. ${chapTitle || title}`;
	const lines = txt ? txt.split("\n") : [];

	// el título del capítulo: si el del bloque es más completo (formato), manda
	if (lines.length && /^#\s+/.test(lines[0]) && chapTitle) {
		const cur = lines[0].replace(/^#+\s+/, "").replace(/^\d+\.\s*/, "").trim();
		if (norm(chapTitle) === norm(cur) && chapTitle.length > cur.length) lines[0] = chapHead;
	}

	const acts: string[] = [];
	for (const s of parsed.secs) {
		let num = s.num;
		let head = s.head;
		let body = s.body.trim();
		if (!body) continue;
		if (!lines.length) lines.push(chapHead, "");
		if (!num) {
			const prev = sectionsIn(lines.join("\n")).filter((h) => h.num.startsWith(`${cap}.`)).pop();
			num = `${cap}.${prev ? Number(prev.num.split(".")[1]) + 1 : 1}`;
			head = `## ${num} ${s.head.replace(/^#+\s+/, "") || title}`;
		}
		body = numberSubheads(body, num).body;
		if (lines.join("\n").includes(body)) {
			acts.push(`§${num} ya estaba`);
			continue;
		}
		const heads = sectionsIn(lines.join("\n"));
		const at = heads.findIndex((h) => h.num === num);
		if (at !== -1) {
			const start = heads[at].line;
			const stop = at + 1 < heads.length ? heads[at + 1].line : lines.length;
			if (block.accion === "reemplazar") {
				lines.splice(start, stop - start, head, "", body, "");
				acts.push(`§${num} reemplazada`);
			} else {
				lines.splice(stop, 0, body, "");
				acts.push(`§${num} ampliada`);
			}
		} else {
			const after = heads.find((h) => cmpNum(h.num, num) > 0);
			lines.splice(after ? after.line : lines.length, 0, head, "", body, "");
			acts.push(`§${num} anadida`);
		}
	}

	if (!acts.length) return { action: "omitida", why: "el contenido ya constaba en el capítulo" };
	await fs.mkdir(path.dirname(chapFile), { recursive: true });
	let out = lines.join("\n").replace(/\n{3,}/g, "\n\n");
	if (!/^#\s/.test(out)) out = `${chapHead}\n\n${out}`;
	await fs.writeFile(chapFile, out, "utf8");
	const action: WriteResult["action"] = acts.some((a) => a.includes("reemplaz"))
		? "reemplazada"
		: acts.every((a) => a.includes("ampliada"))
			? "ampliada"
			: "anadida";
	return { action, why: acts.join(" · ") };
}

/**
 * Deja el capítulo en teoría limpia: quita la cabecera de metadatos que se
 * escribía antes (`> Punto n del temario…`, `> Estado: …`). El estado del
 * capítulo vive solo en `00-indice.md`.
 */
async function cleanChapterHeader(chapFile: string): Promise<void> {
	try {
		const txt = await fs.readFile(chapFile, "utf8");
		const kept = txt
			.split("\n")
			.filter((l) => !/^>\s*(Punto\s+\d+\s+del temario|Estado:)/i.test(l.trim()))
			.join("\n")
			.replace(/^(#\s+.+\n)\n+/, "$1\n")
			.replace(/\n{3,}/g, "\n\n");
		if (kept !== txt) await fs.writeFile(chapFile, kept, "utf8");
	} catch {
		/* no se pudo limpiar la cabecera */
	}
}

async function refreshIndex(bookDir: string, cap: number, tutorPath?: string, explicit = ""): Promise<void> {
	const idxFile = path.join(bookDir, "00-indice.md");
	let txt: string;
	try {
		txt = await fs.readFile(idxFile, "utf8");
	} catch {
		return;
	}
	const rows = await readIndex(bookDir);
	const row = rows.find((r) => r.cap === cap);
	let secs = "";
	let estado = "en curso";
	let nums: string[] = [];
	if (row?.file) {
		try {
			const chap = await fs.readFile(path.join(bookDir, row.file), "utf8");
			nums = [...new Set(sectionsIn(chap).map((s) => s.num))].sort(cmpNum);
		} catch {
			/* capítulo no legible */
		}
	}
	secs = nums.join(", ") || "—";
	// «completo»: lo declara el marcador (estado="completo") o se deduce del
	// temario cuando el capítulo ya tiene tantas secciones como subtópicos.
	let esperado = -1;
	if (tutorPath) {
		const pt = (await parseTemario(tutorPath)).find((p) => p.n === cap);
		if (pt) esperado = pt.subs.length;
	}
	if (explicit === "completo") estado = "completo";
	else if (explicit === "en curso") estado = "en curso";
	else if (esperado > 0 && nums.length >= esperado) estado = "completo";
	else if (row?.estado === "completo" && nums.length) estado = "completo"; // no se baja sin orden
	const out = txt.replace(
		new RegExp(`^(\\|\\s*${cap}\\s*\\|[^|]*\\|[^|]*\\|)\\s*[^|]*\\|\\s*[^|]*\\|`, "m"),
		`$1 ${estado} | ${secs} |`,
	);
	const completos = rows.filter((r) => (r.cap === cap ? estado === "completo" : r.estado === "completo")).length;
	const total = rows.length;
	const fixed = out.replace(
		/^(>\s*Estado del libro:\s*)\d+\s+de\s+\d+(.*)$/m,
		(_all, p1, p2) => `${p1}${completos} de ${total}${p2}`,
	);
	await fs.writeFile(idxFile, fixed, "utf8");
}

// ------------------------------------------------------------- turno

function touchedFiles(message: any): Set<string> {
	const out = new Set<string>();
	for (const c of message?.content ?? []) {
		if (c?.type !== "toolCall") continue;
		const a = c.arguments ?? {};
		for (const key of ["path", "file", "file_path"]) if (typeof a[key] === "string") out.add(a[key]);
		if (c.name === "bash" && typeof a.command === "string") out.add(`bash::${a.command}`);
	}
	return out;
}

// Un bash solo cuenta como «el tutor escribió aquí» si, además de nombrar el
// archivo, hay una señal de escritura (redirección, tee, cp, mv, sed -i...).
// Sin esto, un simple `cat`/`grep` del capítulo silenciaba el aviso de pérdida.
const BASH_WRITE_RE = /(>>|>[^&\d\s]|\btee\b|\bcp\b|\bmv\b|\bsed\s+-i\b|\bmkdir\b|\brm\b|\bdd\b|\btruncate\b|\bprintf\b|\bpython\b)/;

function modelWroteIt(touched: Set<string>, chapFile: string, cwd: string): boolean {
	const abs = path.resolve(cwd, chapFile);
	const base = path.basename(chapFile);
	for (const t of touched) {
		if (t.startsWith("bash::")) {
			if (t.includes(base) && BASH_WRITE_RE.test(t)) return true;
			continue;
		}
		if (path.resolve(cwd, t) === abs) return true;
	}
	return false;
}

let lastMissingWarn = 0;

/** Turno con pinta de teoría del libro (no pregunta, no repaso corto). */
function looksLikeTheory(text: string): boolean {
	if (/\[MODO\s+I\]/i.test(text)) return true;
	const heads = text.match(/^\s{0,3}#{1,3}\s+\d+(?:\.\d+)?[.\s]/gm) ?? [];
	return heads.length >= 1 && text.length >= 1500;
}

/** Red de seguridad: teoría en pantalla pero ningún marcador -> el libro no se escribió. */
async function warnMissingMarkers(text: string, msg: any, ctx: ExtensionContext): Promise<void> {
	if (!looksLikeTheory(text)) return;
	const tutorPath = await findTutorFile(ctx.cwd);
	if (!tutorPath) return;
	const bookDir = await resolveBookDir(ctx.cwd, tutorPath);
	try {
		if (!(await fs.stat(bookDir)).isDirectory()) return;
	} catch {
		return; // sin libro todavía
	}
	// si el tutor escribió él mismo dentro del libro, no hay pérdida
	const abs = path.resolve(bookDir) + path.sep;
	for (const t of touchedFiles(msg)) {
		if (t.startsWith("bash::")) {
			if (t.includes(path.basename(path.resolve(bookDir))) && BASH_WRITE_RE.test(t)) return;
			continue;
		}
		if (path.resolve(ctx.cwd, t).startsWith(abs)) return;
	}
	const now = Date.now();
	if (now - lastMissingWarn < 20000) return;
	lastMissingWarn = now;
	await log("[libro] ⚠️ turno con teoría sin marcadores <<<LIBRO: el libro NO se actualizó");
	say(
		ctx,
		"⚠️ El turno llevaba teoría pero no salió ningún marcador <<<LIBRO: el libro NO se ha actualizado. Pídele que reenvíe el bloque con marcadores (o escribe él la sección).",
		"warning",
	);
}

async function onTurnEnd(event: any, ctx: ExtensionContext): Promise<void> {
	if (!enabled) return;
	const msg = event?.message;
	if (!msg || msg.role !== "assistant") return;
	const text = (msg.content ?? [])
		.filter((c: any) => c?.type === "text")
		.map((c: any) => c.text ?? "")
		.join("\n");
	if (!text.includes("<<<LIBRO")) {
		await warnMissingMarkers(text, msg, ctx);
		return;
	}

	const cwd = ctx.cwd;
	const tutorPath = await findTutorFile(cwd);
	if (!tutorPath) return; // no es una sesión del tutor

	const blocks = parseBlocks(text);
	if (!blocks.length) {
		say(ctx, "Marcador <<<LIBRO sin bloque parseable (revisa `punto=<n>` y el cierre `<<<LIBRO>>>`)", "warning");
		return;
	}

	const bookDir = await resolveBookDir(cwd, tutorPath);
	const rows = await readIndex(bookDir);
	const touched = touchedFiles(msg);
	const done: string[] = [];
	const warns: string[] = [];
	const caps = new Set<number>();
	const states = new Map<number, string>();
	let ultimo = "";

	for (const b of blocks) {
		if (b.error) {
			warns.push(`punto ${b.punto || "?"}: ${b.error}`);
			continue;
		}
		const { file, title } = await chapterPath(bookDir, b.punto, rows);
		if (modelWroteIt(touched, file, cwd)) {
			let chap = "";
			try {
				chap = await fs.readFile(file, "utf8");
			} catch {
				/* no existe */
			}
			if (chap.includes(b.content.trim())) {
				done.push(`cap.${b.punto}${b.num ? ` §${b.num}` : ""} ya escrito por el tutor`);
				caps.add(b.punto);
				continue;
			}
			warns.push(`cap.${b.punto}: el tutor tocó el capítulo pero la sección no quedó → se vuelca`);
		}
		const r = await writeBlock(file, b.punto, title, b);
		// `nota="…"` del marcador: comentario para el registro. Va al aviso y al log
		// (nunca al capítulo: los capítulos son teoría limpia, §1.2 del prompt).
		const nota = b.nota ? ` · nota: ${b.nota.replace(/\s+/g, " ").slice(0, 90)}` : "";
		if (r.action === "omitida") {
			done.push(`cap.${b.punto}${b.num ? ` §${b.num}` : ""} ya estaba (${r.why})${nota}`);
			caps.add(b.punto);
		} else {
			done.push(
				`cap.${b.punto} ${r.why || `§${b.num || "nueva"} ${r.action}`} (${b.content.trim().length} car.)${nota}`,
			);
			caps.add(b.punto);
		}
		if (b.estado === "completo" || b.estado === "en curso") states.set(b.punto, b.estado);
		if (caps.has(b.punto)) await cleanChapterHeader(file);
		ultimo = done[done.length - 1] ?? ultimo;
	}

	for (const c of caps) await refreshIndex(bookDir, c, tutorPath, states.get(c) ?? "");

	if (done.length) {
		lastCapture = ultimo
			.replace(/ ya estaba.*$/, "")
			.replace(/ · nota: .*$/, "")
			.replace(/ \(\d+ car\.\)$/, "")
			.trim();
		say(ctx, `📖 Libro · ${done.join(" · ")}`);
	}
	if (warns.length) say(ctx, `⚠️ Libro · ${warns.join(" · ")}`, "warning");
}

// ------------------------------------------------------------- comando

async function statusText(cwd: string): Promise<string> {
	const tutorPath = await findTutorFile(cwd);
	if (!tutorPath) return `Sin archivo tutor-*.md en ${cwd} → captura inactiva.`;
	const bookDir = await resolveBookDir(cwd, tutorPath);
	const rows = await readIndex(bookDir);
	const lines = [
		`Tutor: ${path.basename(tutorPath)}${pinned ? " (fijado con /libro pin)" : " (el tutor-*.md modificado más recientemente)"}`,
		`Libro: ${bookDir}`,
		`Captura: ${enabled ? "activa" : "DESACTIVADA"} · log (solo diagnóstico): ${LOG_FILE}`,
	];
	if (lastCapture) lines.push(`Última captura en esta sesión: ${lastCapture}`);
	if (lastIncidents >= 0) lines.push(`Último /libro check en esta sesión: ${lastIncidents} incidencias`);
	if (!rows.length) lines.push("Sin 00-indice.md (o sin filas de tabla): escribe las secciones y crea el índice a mano.");
	else
		for (const r of rows.filter((x) => x.estado !== "no escrito"))
			lines.push(`  cap.${r.cap} ${r.title} — ${r.estado} · ${r.secciones}`);
	return lines.join("\n");
}

async function checkText(cwd: string): Promise<string> {
	const tutorPath = await findTutorFile(cwd);
	if (!tutorPath) return "Sin tutor-*.md en el directorio de trabajo.";
	const bookDir = await resolveBookDir(cwd, tutorPath);
	const rows = await readIndex(bookDir);
	const out: string[] = [`Comprobación de ${bookDir}:`];
	if (!rows.length) return `${out[0]} no hay índice legible.`;
	for (const r of rows) {
		if (!r.file) {
			out.push(`  cap.${r.cap}: el índice no indica archivo`);
			continue;
		}
		const p = path.join(bookDir, r.file);
		try {
			const chap = await fs.readFile(p, "utf8");
			const nums = [...new Set(sectionsIn(chap).map((s) => s.num))].sort(cmpNum);
			const h1 = /^#\s+(.+)$/m.exec(chap);
			const h1num = h1 ? /^(\d+)\s*[.·—-]?\s/.exec(h1[1].trim()) : null;
			if (!h1) out.push(`  cap.${r.cap}: el capítulo no tiene encabezado «# <n>. Título»`);
			else if (!h1num || Number(h1num[1]) !== r.cap)
				out.push(`  cap.${r.cap}: su encabezado «${h1[1].trim()}» no lleva el número ${r.cap}. (el índice del PDF no lo puede enlazar)`);
			if (r.estado === "no escrito" && nums.length)
				out.push(`  cap.${r.cap}: índice dice "no escrito" pero hay ${nums.length} secciones`);
			if (r.estado !== "no escrito" && !nums.length) out.push(`  cap.${r.cap}: índice dice "${r.estado}" pero el capítulo no tiene secciones`);
			const declared = (r.secciones || "").split(",").map((s) => s.trim()).filter((s) => /^\d+\.\d+$/.test(s));
			const missing = declared.filter((s) => !nums.includes(s));
			const extra = nums.filter((s) => !declared.includes(s));
			if (missing.length) out.push(`  cap.${r.cap}: en el índice pero no en el capítulo: ${missing.join(", ")}`);
			if (extra.length) out.push(`  cap.${r.cap}: en el capítulo pero no en el índice: ${extra.join(", ")}`);
		} catch {
			if (r.estado !== "no escrito") out.push(`  cap.${r.cap}: falta el archivo ${r.file} (índice dice "${r.estado}")`);
		}
	}
	// archivos .md de la carpeta sin fila en el índice
	try {
		const files = (await fs.readdir(bookDir)).filter((n) => n.endsWith(".md") && n !== "00-indice.md");
		for (const f of files) if (!rows.some((r) => r.file === f)) out.push(`  ${f}: existe en la carpeta pero no aparece en el índice`);
	} catch {
		/* sin carpeta */
	}
	const cov = await coverageText(tutorPath, bookDir, rows);
	if (out.length === 1 && cov.lines.length === 1) out.push("  sin incidencias de índice/capítulos.");
	lastIncidents = Math.max(0, out.length - 1 + cov.issues);
	return [...out, ...cov.lines].join("\n");
}

// ------------------------------------------------------- cobertura temario↔libro

function norm(s: string): string {
	return s
		.toLowerCase()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

interface TemarioPoint {
	n: number;
	title: string;
	subs: string[];
}

/** Lee `## TEMARIO ACORDADO` del archivo del tutor: puntos numerados + subtópicos con guion. */
async function parseTemario(tutorPath: string): Promise<TemarioPoint[]> {
	let txt = "";
	try {
		txt = await fs.readFile(tutorPath, "utf8");
	} catch {
		return [];
	}
	const sec = /##\s+TEMARIO ACORDADO\b([\s\S]*?)(?=\n##\s|\n#\s|$)/i.exec(txt);
	if (!sec) return [];
	const out: TemarioPoint[] = [];
	for (const line of sec[1].split("\n")) {
		if (/^#{1,6}\s/.test(line)) continue; // apartados (PARTE I, …): no cuentan como punto
		const pt = /^\s{0,3}\**\s*(\d{1,3})\.\s*\**\s*(.+?)\s*$/.exec(line);
		if (pt) {
			out.push({ n: Number(pt[1]), title: pt[2].replace(/\*\*/g, "").trim(), subs: [] });
			continue;
		}
		const sub = /^\s{2,}[-*]\s+(.+)$/.exec(line);
		if (sub && out.length) out[out.length - 1].subs.push(sub[1].replace(/\*\*/g, "").trim());
	}
	return out;
}

async function coverageText(tutorPath: string, bookDir: string, rows: IndexRow[]): Promise<{ lines: string[]; issues: number }> {
	const pts = await parseTemario(tutorPath);
	const out: string[] = ["Cobertura temario ↔ libro:"];
	if (!pts.length) return { lines: [...out, "  no se pudo leer «TEMARIO ACORDADO» en el archivo del tutor."], issues: 1 };

	let conSecciones = 0;
	let subsTotales = 0;
	let subsCubiertos = 0;
	let sinEscribir = 0;

	for (const p of pts) {
		const row = rows.find((r) => r.cap === p.n);
		if (!row) {
			out.push(`  cap.${p.n} «${p.title}»: está en el temario pero no en el índice`);
			continue;
		}
		if (norm(row.title) !== norm(p.title))
			out.push(`  cap.${p.n}: título distinto → índice «${row.title}» / temario «${p.title}»`);

		let nums: string[] = [];
		if (row.file && row.file !== "—") {
			try {
				const chap = await fs.readFile(path.join(bookDir, row.file), "utf8");
				nums = [...new Set(sectionsIn(chap).map((s) => s.num))];
			} catch {
				/* ya lo avisa check() */
			}
		}
		if (nums.length) conSecciones++;
		else sinEscribir++;
		subsTotales += p.subs.length;
		subsCubiertos += Math.min(nums.length, p.subs.length);

		if (p.subs.length && nums.length < p.subs.length) {
			const secs = `${nums.length} ${nums.length === 1 ? "sección" : "secciones"}`;
			const subs = `${p.subs.length} ${p.subs.length === 1 ? "subtópico" : "subtópicos"}`;
			if (row.estado === "completo")
				out.push(`  cap.${p.n}: el índice dice "completo" con ${secs} y el temario pide ${subs}`);
			else if (nums.length) out.push(`  cap.${p.n}: ${nums.length}/${p.subs.length} subtópicos del temario tienen sección`);
		}
	}

	for (const r of rows) if (!pts.some((p) => p.n === r.cap)) out.push(`  cap.${r.cap} «${r.title}»: está en el índice pero no en el temario`);

	out.push(`  resumen: ${conSecciones}/${pts.length} puntos con secciones escritas (${sinEscribir} sin empezar) · subtópicos con sección: ${subsCubiertos}/${subsTotales}`);
	const limit = 24;
	const uniq = [...new Set(out)];
	const issues = uniq.filter((l) => l.startsWith("  ") && !l.startsWith("  resumen:")).length;
	if (uniq.length > limit + 1) return { lines: [...uniq.slice(0, limit), `  … y ${uniq.length - limit} incidencias más.`], issues };
	return { lines: uniq, issues };
}

// ------------------------------------------------------------- respaldo

/**
 * Repara capítulos ya escritos: quita la cabecera de metadatos antigua y los
 * títulos de sección duplicados (el que escribía el modelo dentro del bloque +
 * el que escribía esta extensión).
 */
async function fixChapters(bookDir: string, rows: IndexRow[], tutorPath?: string): Promise<string[]> {
	const out: string[] = [];
	const head = (l: string) => /^(#{2,6})\s+(\d+)\.(\d+)(\s|$)/.exec(l);
	for (const r of rows) {
		if (!r.file) continue;
		const p = path.join(bookDir, r.file);
		let txt = "";
		try {
			txt = await fs.readFile(p, "utf8");
		} catch {
			continue;
		}
		const lines = txt.split("\n");
		const drop = new Set<number>();
		let meta = 0;
		for (let i = 0; i < lines.length; i++) {
			if (drop.has(i)) continue;
			if (/^>\s*(Punto\s+\d+\s+del temario|Estado:)/i.test(lines[i].trim())) {
				drop.add(i);
				meta++;
				continue;
			}
			const m = head(lines[i]);
			if (!m) continue;
			let j = i + 1;
			while (j < lines.length && !lines[j].trim()) j++;
			const m2 = j < lines.length ? head(lines[j]) : null;
			if (m2 && m2[2] === m[2] && m2[3] === m[3]) {
				// mismo número en dos encabezados seguidos: sobra uno. Si dicen lo mismo, se
				// conserva el que tenga formato (p. ej. `print()` con backticks) subido a nivel «##».
				if (norm(lines[i]) === norm(lines[j]) && lines[j].length > lines[i].length) {
					lines[i] = `## ${lines[j].replace(/^#{2,6}\s+/, "")}`;
					drop.add(j);
				} else {
					const keepFirst = m[1] === "##" || m2[1] !== "##";
					drop.add(keepFirst ? j : i);
				}
			}
		}
		if (!drop.size) {
			// sin duplicados ni metadatos: queda la renumeración de subapartados
			const rn0 = renumberSubheads(lines.join("\n"));
			if (!rn0.count) continue;
			await fs.writeFile(p, rn0.txt, "utf8");
			out.push(`  ${r.file}: ${rn0.count} subapartado(s) renumerado(s) a ### n.m.k`);
			await refreshIndex(bookDir, r.cap, tutorPath, "");
			continue;
		}
		let kept = lines
			.filter((_l, i) => !drop.has(i))
			.join("\n")
			.replace(/^(#\s+.+\n)\n+/, "$1\n")
			.replace(/\n{3,}/g, "\n\n");
		const rn = renumberSubheads(kept);
		kept = rn.txt;
		await fs.writeFile(p, kept, "utf8");
		const partes: string[] = [];
		if (meta) partes.push(`${meta} línea(s) de metadatos`);
		if (drop.size - meta) partes.push(`${drop.size - meta} título(s) duplicado(s)`);
		if (rn.count) partes.push(`${rn.count} subapartado(s) renumerado(s) a ### n.m.k`);
		out.push(`  ${r.file}: ${partes.join(" · ")}`);
		await refreshIndex(bookDir, r.cap, tutorPath, "");
	}
	return out;
}

async function backupCourse(cwd: string, tutorPath: string, bookDir: string): Promise<string> {
	const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12); // AAAAMMDDHHMM
	const base = path.basename(bookDir);
	const root = path.join(cwd, ".libro-backups");
	const dest = path.join(root, `${base}-${stamp}`);
	await fs.mkdir(dest, { recursive: true });
	try {
		await fs.cp(bookDir, path.join(dest, base), { recursive: true });
	} catch (err: any) {
		await fs.rm(dest, { recursive: true, force: true });
		return `No se pudo copiar ${bookDir}: ${err?.message ?? err}`;
	}
	await fs.copyFile(tutorPath, path.join(dest, path.basename(tutorPath)));

	let podados = 0;
	const olds = (await fs.readdir(root)).filter((n) => n.startsWith(`${base}-`)).sort().slice(0, -10);
	for (const n of olds) {
		await fs.rm(path.join(root, n), { recursive: true, force: true });
		podados++;
	}
	const n = (await fs.readdir(path.join(dest, base))).filter((f) => f.endsWith(".md")).length;
	return `Copia en ${dest}\n  ${n} archivos .md + ${path.basename(tutorPath)}${podados ? ` · rotación: ${podados} copias antiguas borradas (se guardan las 10 últimas)` : ""}`;
}

// ------------------------------------------------------------- exportar PDF

function esc(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function inlineMd(s: string): string {
	return esc(s)
		.replace(/`([^`]+)`/g, "<code>$1</code>")
		.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
		.replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
		.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}

// id estable para cada encabezado numerado: sirve para los enlaces del índice
function headingId(text: string): string {
	const sec = /^(\d+)\.(\d+)(?:\.(\d+))?\s/.exec(text.trim());
	if (sec) return `s-${sec[1]}-${sec[2]}-${sec[3] ?? "0"}`;
	const cap = /^(\d+)\.\s/.exec(text.trim());
	return cap ? `c-${cap[1]}` : "";
}

function mdToHtml(md: string): string {
	const lines = md.split("\n");
	const out: string[] = [];
	const usedIds = new Set<string>();
	let inCode = false;
	let list: "ul" | "ol" | null = null;
	let para: string[] = [];
	const flushPara = () => {
		if (para.length) {
			out.push(`<p>${inlineMd(para.join(" "))}</p>`);
			para = [];
		}
	};
	const closeList = () => {
		if (list) {
			out.push(`</${list}>`);
			list = null;
		}
	};
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].replace(/\s+$/g, "");
		if (/^\s*```/.test(line)) {
			flushPara();
			closeList();
			out.push(inCode ? "</code></pre>" : "<pre><code>");
			inCode = !inCode;
			continue;
		}
		if (inCode) {
			out.push(esc(line));
			continue;
		}
		if (!line.trim()) {
			flushPara();
			closeList();
			continue;
		}
		const h = /^(#{1,6})\s+(.*)$/.exec(line);
		if (h) {
			flushPara();
			closeList();
			const lvl = h[1].length;
			let id = headingId(h[2]);
			if (id) {
				// ids únicos: dos encabezados con la misma numeración partirían el enlace del índice
				const base = id;
				for (let n = 2; usedIds.has(id); n++) id = `${base}-${n}`;
				usedIds.add(id);
			}
			out.push(`<h${lvl}${id ? ` id="${id}"` : ""}>${inlineMd(h[2])}</h${lvl}>`);
			continue;
		}
		if (/^\s*(-{3,}|\*{3,})$/.test(line)) {
			flushPara();
			closeList();
			out.push("<hr>");
			continue;
		}
		if (/^\s*>\s?/.test(line)) {
			flushPara();
			closeList();
			out.push(`<blockquote>${inlineMd(line.replace(/^\s*>\s?/, ""))}</blockquote>`);
			continue;
		}
		if (/^\s*\|.*\|\s*$/.test(line)) {
			flushPara();
			closeList();
			const rows: string[][] = [];
			while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
				const cells = lines[i]
					.trim()
					.replace(/^\|/, "")
					.replace(/\|$/, "")
					.split("|")
					.map((c) => c.trim());
				if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells);
				i++;
			}
			i--;
			out.push("<table>");
			rows.forEach((r, k) => {
				const tag = k === 0 ? "th" : "td";
				out.push(`<tr>${r.map((c) => `<${tag}>${inlineMd(c)}</${tag}>`).join("")}</tr>`);
			});
			out.push("</table>");
			continue;
		}
		const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
		const ol = /^\s*\d+\.\s+(.*)$/.exec(line);
		if (ul || ol) {
			flushPara();
			const want: "ul" | "ol" = ul ? "ul" : "ol";
			if (list !== want) {
				closeList();
				out.push(`<${want}>`);
				list = want;
			}
			out.push(`<li>${inlineMd((ul ?? ol)![1])}</li>`);
			continue;
		}
		para.push(line.trim());
	}
	if (inCode) out.push("</code></pre>");
	flushPara();
	closeList();
	return out.join("\n");
}

const PDF_CSS = `@page { size: A4; margin: 25mm 25mm 27mm; @bottom-center { content: counter(page); font-size: 9pt; color: #666; } }
@page cover { margin: 25mm; @bottom-center { content: "Generado por Universal_Tutor_Project"; font-size: 9pt; color: #666; } }
@page :blank { @bottom-center { content: ""; } }
.cover { page: cover; break-after: page; height: 241mm; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; }
.cover .kicker { font-size: 11pt; letter-spacing: 0.18em; text-transform: uppercase; color: #666; margin-bottom: 1.4em; }
.cover h1 { font-size: 26pt; line-height: 1.25; margin: 0; break-before: auto; }
.cover .sub { margin-top: 1.6em; font-size: 11pt; color: #555; font-style: italic; }
body { font-family: Georgia, "DejaVu Serif", serif; font-size: 12pt; line-height: 1.3; text-align: justify; hyphens: auto; }
h1 { font-size: 19pt; break-before: recto; margin-top: 0; } /* cada punto del temario arranca en página impar (recto) */
.toc .ch { font-weight: bold; font-size: 13.5pt; margin: 1.1em 0 0.2em; break-inside: avoid; }
.toc .sec { font-size: 11pt; padding-left: 7mm; margin: 0.12em 0; break-inside: avoid; color: #222; }
.toc a { color: inherit; text-decoration: none; }
.toc a::after { content: leader(dotted) " " target-counter(attr(href url), page); color: #555; font-weight: normal; }
h2 { font-size: 14.5pt; margin-top: 1.2em; }
h3 { font-size: 12.5pt; margin-top: 1.1em; }
blockquote { border-left: 2px solid #999; margin: 0.6em 0; padding-left: 0.8em; color: #444; font-style: italic; }
table { border-collapse: collapse; width: 100%; font-size: 10pt; }
th, td { border: 1px solid #bbb; padding: 3px 5px; text-align: left; }
pre { background: #f3f3f3; padding: 6px; font-size: 10pt; white-space: pre-wrap; }
code { font-family: "DejaVu Sans Mono", monospace; }
hr { border: 0; border-top: 1px solid #bbb; margin: 1em 0; }`;

async function pdfBook(cwd: string, bookDir: string, rows: IndexRow[]): Promise<string> {
	let title = path.basename(bookDir);
	try {
		const idx = await fs.readFile(path.join(bookDir, "00-indice.md"), "utf8");
		const t = /^#\s+(.+)$/m.exec(idx);
		if (t) title = t[1].replace(/^LIBRO:\s*/i, "").trim();
	} catch {
		/* sin índice */
	}
	const parts: string[] = [""];
	const toc: { cap: number; title: string; secs: string[][] }[] = [];
	let caps = 0;
	for (const r of [...rows].sort((a, b) => a.cap - b.cap)) {
		if (!r.file || r.file === "—") continue;
		try {
			const chap0 = await fs.readFile(path.join(bookDir, r.file), "utf8");
			if (!sectionsIn(chap0).length) continue;
			// El enlace del índice apunta a `#c-<cap>` y el id lo da el número escrito en el H1.
			// Si el H1 no lleva el número del índice (o lleva otro), se lo ponemos aquí: solo en
			// el HTML del PDF, el archivo del usuario no se toca. Evita enlaces muertos.
			let chap = chap0;
			const h0 = /^#\s+(.+)$/m.exec(chap0);
			if (h0 && !new RegExp(`^\\s*${r.cap}\\s*[.·—-]?\\s`).test(h0[1])) {
				const clean = h0[1].replace(/^\s*\d+\s*[.·—-]?\s*/, "").trim();
				chap = chap.replace(/^#\s+.*$/m, `# ${r.cap}. ${clean}`);
			}
			parts.push(chap.trim(), "");
			caps++;
			const h1 = /^#\s+(.+)$/m.exec(chap);
			const secs: string[][] = [];
			for (const m of chap.matchAll(/^##\s+(\d+)\.(\d+)\s+(.+)$/gm)) secs.push([m[1], m[2], m[3].trim()]);
			toc.push({ cap: r.cap, title: (h1?.[1] ?? r.title ?? "").trim(), secs });
		} catch {
			/* capítulo ausente */
		}
	}
	if (!caps) return `Ningún capítulo con secciones en ${bookDir}: nada que exportar.`;

	const base = path.basename(bookDir);
	const htmlPath = path.join(cwd, `${base}.html`);
	const pdfPath = path.join(cwd, `${base}.pdf`);
	const sub = new Date().toLocaleDateString("es-ES", { year: "numeric", month: "long", day: "numeric" });
	const cover = `<div class="cover"><div class="kicker">Libro del curso</div><h1>${esc(title)}</h1><div class="sub">${esc(sub)}</div></div>`;
	// Índice: los números de página los calcula weasyprint con target-counter(), así que
	// salen correctos aunque el propio índice desplace la paginación (no hace falta 2ª pasada).
	const tocHtml = toc.length
		? `<nav class="toc"><h1>Índice de contenidos</h1>` +
			toc
				.map(
					(t) =>
						`<div class="ch"><a href="#c-${t.cap}">${inlineMd(t.title)}</a></div>` +
						t.secs
							.map((s) => `<div class="sec"><a href="#s-${s[0]}-${s[1]}-0">${inlineMd(`${s[0]}.${s[1]} ${s[2]}`)}</a></div>`)
							.join(""),
				)
				.join("") +
				`</nav>`
		: "";
	const html = `<!doctype html>\n<html lang="es">\n<head>\n<meta charset="utf-8">\n<title>${esc(title)}</title>\n<style>${PDF_CSS}</style>\n</head>\n<body>\n${cover}\n${tocHtml}\n${mdToHtml(parts.join("\n"))}\n</body>\n</html>\n`;
	await fs.writeFile(htmlPath, html, "utf8");

	try {
		await execFileP("weasyprint", [htmlPath, pdfPath], { timeout: 300000 });
		const kb = Math.round((await fs.stat(pdfPath)).size / 1024);
		return `📄 PDF: ${pdfPath} (${caps} capítulos, ${kb} KB). HTML intermedio: ${htmlPath}`;
	} catch (err: any) {
		if (err?.code === "ENOENT")
			return `HTML en ${htmlPath}. Falta weasyprint para el PDF (pacman -S weasyprint, o usa pandoc sobre ese HTML).`;
		return `HTML en ${htmlPath}. weasyprint falló: ${String(err?.message ?? err).split("\n").slice(-2).join(" · ")}`;
	}
}

// ------------------------------------------------------------- registro

export default function (pi: ExtensionAPI) {
	pi.on("before_provider_request", async (event: any, ctx: ExtensionContext) => {
		// Declara el estado de la extensión en el prompt de sistema del modelo.
		try {
			if (!(await findTutorFile(ctx.cwd))) return; // no es una sesión del tutor
			const p = event?.payload;
			if (!p) return;
			const nota = notaLibro();
			// OpenAI-compatible: el prompt viaja en messages[0] con role "developer"/"system".
			const msg = (Array.isArray(p.messages) ? p.messages : []).find(
				(m: any) => (m?.role === "system" || m?.role === "developer") && typeof m?.content === "string",
			);
			if (msg) {
				if (msg.content.startsWith(NOTE_SENTINEL)) return; // idempotente (ojo: el prompt cita el literal)
				// Al PRINCIPIO del prompt: con el rol del tutor (≈60k chars) al final el
				// modelo no lo percibía; prependido, lo detecta y lo acata.
				msg.content = `${nota}\n\n${msg.content}`;
				return;
			}
			// Otros proveedores: el prompt va aparte (string o bloques de texto).
			if (typeof p.system === "string") {
				if (!p.system.startsWith(NOTE_SENTINEL)) p.system = `${nota}\n\n${p.system}`;
			} else if (Array.isArray(p.system) && !String(p.system[0]?.text ?? "").startsWith(NOTE_SENTINEL)) {
				p.system.unshift({ type: "text", text: nota });
			}
		} catch {
			/* nunca rompe una petición */
		}
	});

	pi.on("turn_end", async (event, ctx) => {
		try {
			await onTurnEnd(event, ctx);
		} catch (err: any) {
			say(ctx, `Libro: error al capturar (${err?.message ?? err})`, "error");
		}
		// El indicador se refresca en TODOS los turnos (aunque no lleven marcadores):
		// así aparece nada más crearse los archivos del curso, en el turno de arranque.
		try {
			await updateStatus(ctx);
		} catch {
			/* nada */
		}
	});

	pi.on("session_start", async (event, ctx) => {
		pinned = undefined;
		lastCapture = "";
		lastIncidents = -1;
		void log(`[libro] session_start ${event.reason} en ${ctx.cwd}`);
		await updateStatus(ctx);
	});

	pi.registerCommand("libro", {
		description: "Libro del curso: status | check | fix | backup | pdf | toggle | pin <archivo> | log",
		handler: async (args, ctx) => {
			const sub = (args ?? "").trim().split(/\s+/)[0]?.toLowerCase();
			const rest = (args ?? "").trim().slice(sub?.length ?? 0).trim();
			if (!sub || sub === "status") {
				ctx.ui.notify(await statusText(ctx.cwd), "info");
				return;
			}
			if (sub === "check") {
				ctx.ui.notify(await checkText(ctx.cwd), "info");
				await updateStatus(ctx);
				return;
			}
			if (sub === "fix") {
				const tutorPath = await findTutorFile(ctx.cwd);
				if (!tutorPath) {
					ctx.ui.notify(`Sin archivo tutor-*.md en ${ctx.cwd}: no hay libro que reparar.`, "warning");
					return;
				}
				const bookDir = await resolveBookDir(ctx.cwd, tutorPath);
				const fixed = await fixChapters(bookDir, await readIndex(bookDir), tutorPath);
				ctx.ui.notify(fixed.length ? `Reparado en ${bookDir}:\n${fixed.join("\n")}` : `Sin defectos que reparar en ${bookDir}.`, "info");
				await updateStatus(ctx);
				return;
			}
			if (sub === "backup" || sub === "pdf") {
				const tutorPath = await findTutorFile(ctx.cwd);
				if (!tutorPath) {
					ctx.ui.notify(`Sin archivo tutor-*.md en ${ctx.cwd}: no hay curso que respaldar o exportar.`, "warning");
					return;
				}
				const bookDir = await resolveBookDir(ctx.cwd, tutorPath);
				try {
					if (sub === "backup") ctx.ui.notify(await backupCourse(ctx.cwd, tutorPath, bookDir), "info");
					else ctx.ui.notify(await pdfBook(ctx.cwd, bookDir, await readIndex(bookDir)), "info");
				} catch (err: any) {
					ctx.ui.notify(`Libro: ${err?.message ?? err}`, "error");
				}
				return;
			}
			if (sub === "toggle") {
				enabled = !enabled;
				say(ctx, `Captura del libro: ${enabled ? "activa" : "desactivada"}`);
				await updateStatus(ctx);
				return;
			}
			if (sub === "pin") {
				if (!rest || rest === "clear") {
					pinned = undefined;
					say(ctx, "Archivo de tutor fijado: ninguno (se usa el tutor-*.md modificado más recientemente)");
					await updateStatus(ctx);
					return;
				}
				pinned = rest;
				say(ctx, `Archivo de tutor fijado: ${rest}`);
				await updateStatus(ctx);
				return;
			}
			if (sub === "log") {
				try {
					const txt = await fs.readFile(LOG_FILE, "utf8");
					ctx.ui.notify(txt.split("\n").slice(-25).join("\n"), "info");
				} catch {
					ctx.ui.notify(`Sin log en ${LOG_FILE}`, "info");
				}
				return;
			}
			ctx.ui.notify("Uso: /libro [status|check|fix|backup|pdf|toggle|pin <archivo>|log]", "info");
		},
	});
}
